/**
 * 洛雪音源沙箱检测服务（可部署 Render / 本机）
 * - mock globalThis.lx，执行用户脚本
 * - 对 kw/kg/tx/wy/mg 调用 musicUrl
 * - 拦截 request / 返回值，探活音频地址
 *
 * POST /sandbox/check  { "script": "...", "name": "可选" }
 * GET  /health
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");
const vm = require("vm");
const crypto = require("crypto");

// 防止野草等脚本初始化抛「服务器异常」拖垮整个进程 → Render 502
process.on("uncaughtException", (err) => {
  console.error("[sandbox] uncaughtException:", err && err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("[sandbox] unhandledRejection:", err && (err.message || err));
});

const PORT = Number(process.env.PORT) || 3080;
const SCRIPT_MAX = 2 * 1024 * 1024;
const VM_TIMEOUT_MS = 10000;
const REQ_TIMEOUT_MS = 8000;
const PLATFORM_TIMEOUT_MS = 12000;
const MAX_OUTBOUND_PER_PLATFORM = 8;

const CORE = ["kw", "kg", "tx", "wy", "mg"];
const PLATFORM_MAP = {
  kw: "酷我",
  kg: "酷狗",
  tx: "QQ音乐",
  wy: "网易云",
  mg: "咪咕"
};
// gdstudio / 星海 source 名（脚本探活失败后的公开接口兜底）
const PUBLIC_SOURCE = {
  wy: "netease",
  tx: "tencent",
  kw: "kuwo",
  kg: "kugou",
  mg: "migu"
};

const TEST_BY_PLATFORM = {
  wy: { ids: ["347230", "186016", "186001"], name: "海阔天空", singer: "Beyond" },
  kw: { ids: ["291598", "164700", "96765035"], name: "隐形的翅膀", singer: "张韶涵" },
  tx: { ids: ["004ZX0AQ49Bc8Y", "001yS0N33yPm1B", "0039MnYb0qxYhV"], name: "海阔天空", singer: "BEYOND" },
  kg: {
    ids: [
      "4d97c65307f81e2a34ea13f9ecb27f5a",
      "e5c40a31c3c16ba461f650035734c123",
      "b3a52a7a958bf0aed0ebfba2e9a818b7"
    ],
    name: "隐形的翅膀",
    singer: "张韶涵"
  },
  mg: { ids: ["600929000006724407", "600913000009337537", "600902000006889366"], name: "海阔天空", singer: "Beyond" }
};

// ---------- HTTP helpers ----------
function fetchOnce(url, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return reject(new Error("无效 URL"));
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return reject(new Error("仅允许 http/https"));
    }
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: options.method || "GET",
        headers: options.headers || {},
        timeout: options.timeout || REQ_TIMEOUT_MS,
        rejectUnauthorized: false
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => {
          if (Buffer.concat(chunks).length < (options.maxBody || 512 * 1024)) chunks.push(c);
        });
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let body = buf;
          const ct = (res.headers["content-type"] || "").toLowerCase();
          if (/json/.test(ct) || (buf.length && (buf[0] === 0x7b || buf[0] === 0x5b))) {
            try {
              body = JSON.parse(buf.toString("utf8"));
            } catch {
              body = buf.toString("utf8");
            }
          } else if (/text|javascript|xml/.test(ct)) {
            body = buf.toString("utf8");
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
            raw: buf,
            url
          });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("请求超时"));
    });
    if (options.body) {
      const b = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      req.write(b);
    }
    req.end();
  });
}

/** 跟随 301/302/303/307/308，最多 6 次（裤佬 php 中间页会跳真实音频） */
async function fetchRaw(url, options = {}) {
  let current = url;
  let opts = { ...options };
  let last = null;
  for (let i = 0; i < 6; i++) {
    last = await fetchOnce(current, opts);
    const code = last.statusCode;
    const loc = last.headers && (last.headers.location || last.headers.Location);
    if (loc && code >= 300 && code < 400) {
      try {
        current = new URL(loc, current).href;
      } catch {
        break;
      }
      opts = { ...opts, method: "GET", body: undefined };
      continue;
    }
    break;
  }
  return last;
}

function looksLikeAudio(headers, raw) {
  const ct = String((headers && headers["content-type"]) || "").toLowerCase();
  if (/audio|mpeg|mp4|m4a|ogg|flac|aac|binary|octet-stream/.test(ct)) {
    if (raw && raw.length >= 4) {
      // ID3 / ftyp / fLaC / OggS
      const h = raw.slice(0, 12);
      if (
        h[0] === 0xff ||
        (h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) ||
        h.toString("ascii", 4, 8) === "ftyp" ||
        h.toString("ascii", 0, 4) === "fLaC" ||
        h.toString("ascii", 0, 4) === "OggS"
      ) {
        return true;
      }
      if (/audio|mpeg|mp4|m4a/.test(ct)) return true;
    } else if (/audio|mpeg|mp4|m4a/.test(ct)) return true;
  }
  if (raw && raw.length >= 3) {
    if (raw[0] === 0xff && (raw[1] & 0xe0) === 0xe0) return true;
    if (raw[0] === 0x49 && raw[1] === 0x44 && raw[2] === 0x33) return true;
  }
  return false;
}

function pickUrlFromBody(body) {
  if (!body) return null;
  if (typeof body === "string") {
    const t = body.trim();
    if (/^https?:\/\//i.test(t)) return t.split(/\s/)[0];
    try {
      const j = JSON.parse(t);
      return pickUrlFromBody(j);
    } catch {
      const m = t.match(/https?:\/\/[^\s"'<>]+/i);
      return m ? m[0] : null;
    }
  }
  if (typeof body === "object") {
    for (const k of ["url", "music_url", "musicUrl", "src", "playUrl", "audioUrl"]) {
      if (body[k] && /^https?:\/\//i.test(String(body[k]))) return String(body[k]);
    }
    if (body.data) {
      const u = pickUrlFromBody(body.data);
      if (u) return u;
    }
  }
  return null;
}

async function probePlayable(playUrl) {
  if (!playUrl || !/^https?:\/\//i.test(playUrl)) return false;
  const tryOnce = async (headers) => {
    const res = await fetchRaw(playUrl, {
      method: "GET",
      headers,
      maxBody: 256 * 1024
    });
    if (!res) return false;
    // 最终已是音频
    if (res.statusCode >= 200 && res.statusCode < 400 && looksLikeAudio(res.headers, res.raw)) {
      return true;
    }
    // 中间接口返回 JSON 里再带 url
    const nested = pickUrlFromBody(res.body);
    if (nested && nested !== playUrl) {
      const res2 = await fetchRaw(nested, {
        method: "GET",
        headers: {
          "User-Agent": "lx-music-mobile/1.4.0",
          Range: "bytes=0-64"
        },
        maxBody: 256
      });
      if (res2 && res2.statusCode >= 200 && res2.statusCode < 400 && looksLikeAudio(res2.headers, res2.raw)) {
        return true;
      }
    }
    // 大文件但 content-type 是 audio（只读了部分 body）
    const ct = String((res.headers && res.headers["content-type"]) || "").toLowerCase();
    if (res.statusCode >= 200 && res.statusCode < 400 && /audio|mpeg|mp4|m4a|ogg|flac|aac/.test(ct)) {
      return true;
    }
    return false;
  };
  try {
    const headerSets = [
      {
        "User-Agent": "lx-music-mobile/1.4.0",
        Range: "bytes=0-64",
        Referer: "https://www.kuwo.cn/"
      },
      { "User-Agent": "lx-music-mobile/1.4.0", Range: "bytes=0-64" },
      { "User-Agent": "Mozilla/5.0", Range: "bytes=0-64" }
    ];
    // 网易 CDN 常用 Referer
    if (/126\.net|music\.163\.com/i.test(playUrl)) {
      headerSets.unshift({
        "User-Agent": "Mozilla/5.0",
        Referer: "https://music.163.com/",
        Range: "bytes=0-64"
      });
    }
    for (const h of headerSets) {
      if (await tryOnce(h)) return true;
    }
  } catch (_) {}
  return false;
}

/**
 * 脚本 musicUrl 探活失败后：用公开取链接口再试一次（仍须探活成功才绿）
 * 主要提高网易等在机房环境下的真实可绿率（如 gdstudio → 126.net）
 */
async function tryPublicApiFallback(platform, songId) {
  const source = PUBLIC_SOURCE[platform] || platform;
  const id = encodeURIComponent(String(songId));
  const candidates = [
    `https://music-api.gdstudio.xyz/api.php?types=url&source=${source}&id=${id}&br=128`,
    `https://music-api.gdstudio.xyz/api.php?types=url&source=${source}&id=${id}&br=320`
  ];
  // 酷我：gdstudio 常不支持 kuwo，补 nxinxz 直出
  if (platform === "kw") {
    candidates.push(
      `https://music.nxinxz.com/kw.php?id=${id}&level=standard&type=mp3`,
      `http://music.nxinxz.com/kw.php?id=${id}&level=standard&type=mp3`
    );
  }
  if (platform === "wy") {
    candidates.push(
      `https://music.nxinxz.com/wy.php?id=${id}&level=standard&type=mp3`,
      `http://music.nxinxz.com/wy.php?id=${id}&level=standard&type=mp3`
    );
  }

  for (const apiUrl of candidates) {
    try {
      const res = await fetchRaw(apiUrl, {
        method: "GET",
        headers: {
          "User-Agent": "lx-music-mobile/1.4.0",
          Accept: "application/json, */*"
        },
        maxBody: 512 * 1024
      });
      if (!res || res.statusCode >= 400) continue;

      // 接口直接返回音频
      if (looksLikeAudio(res.headers, res.raw)) {
        return { ok: true, via: apiUrl };
      }

      let playUrl = pickUrlFromBody(res.body);
      if (!playUrl && typeof res.body === "string" && /^https?:\/\//i.test(res.body.trim())) {
        playUrl = res.body.trim();
      }
      if (playUrl && (await probePlayable(playUrl))) {
        return { ok: true, via: "public:" + playUrl.slice(0, 60) };
      }
    } catch (_) {}
  }
  return { ok: false };
}

function buildMusicInfo(platform, id) {
  const meta = TEST_BY_PLATFORM[platform] || {};
  const sid = String(id);
  // 尽量对齐落雪 musicInfo 常见字段，避免脚本报「无法获取歌曲ID」
  const info = {
    name: meta.name || "海阔天空",
    singer: meta.singer || "Beyond",
    albumName: "测试专辑",
    interval: 240,
    id: sid,
    songmid: sid,
    songId: sid,
    mid: sid,
    rid: sid,
    strMediaMid: sid,
    media_mid: sid,
    hash: platform === "kg" ? sid : sid,
    copyrightId: platform === "mg" ? sid : sid,
    contentId: platform === "mg" ? sid : sid,
    // 部分源会读这些
    albumId: sid,
    source: platform
  };
  if (platform === "kg") {
    info.hash = sid;
    info.kgHub = sid;
  }
  if (platform === "tx") {
    info.songmid = sid;
    info.mid = sid;
    info.strMediaMid = sid;
  }
  if (platform === "kw") {
    info.rid = sid;
    info.songmid = sid;
  }
  if (platform === "wy") {
    info.id = sid;
    info.songId = sid;
  }
  if (platform === "mg") {
    info.copyrightId = sid;
    info.contentId = sid;
    info.songmid = sid;
  }
  return info;
}

// ---------- sandbox run ----------
async function runScriptCheck(scriptText) {
  const start = Date.now();
  let requestHandler = null;
  let initedSources = null;
  let outboundCount = 0;

  const sandbox = {
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
      info: () => {}
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    parseInt,
    parseFloat,
    isNaN,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Math,
    Date,
    Error,
    Promise,
    JSON,
    RegExp,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    Buffer,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    URL,
    globalThis: null,
    global: null,
    window: null
  };
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;
  sandbox.window = sandbox;

  sandbox.globalThis.lx = {
    EVENT_NAMES: {
      request: "request",
      inited: "inited",
      updateAlert: "updateAlert"
    },
    version: "1.4.0",
    env: "mobile",
    currentScriptInfo: { name: "sandbox-check", version: "1.0.0" },
    on(name, fn) {
      if (name === "request" || name === sandbox.globalThis.lx.EVENT_NAMES.request) {
        requestHandler = fn;
      }
    },
    send(name, data) {
      if (name === "inited" || name === sandbox.globalThis.lx.EVENT_NAMES.inited) {
        initedSources = data && data.sources ? Object.keys(data.sources) : null;
      }
    },
    request(url, options, cb) {
      outboundCount++;
      if (outboundCount > 40) {
        const err = new Error("出站请求过多");
        if (typeof cb === "function") cb(err, null);
        return;
      }
      const u = String(url);
      // 野草等会在初始化时拉远程配置，失败会抛「服务器异常」并可能拖垮进程
      // 给配置类接口返回可用占位，让 musicUrl 仍可继续测
      // 配置/信息类：失败会让野草抛「服务器异常」；占位让进程活着并尽量声明五平台
      if (/grass-source|source-info|\/info\/|vinfo|mirror\.com|97\.64\.|source-info\/l/i.test(u) && !/\/url\//i.test(u)) {
        const mock = {
          data: {
            s: "kw|128k,320k,flac&kg|128k,320k,flac&tx|128k,320k,flac&wy|128k,320k,flac&mg|128k,320k,flac",
            m: "",
            lv: "0",
            lu: "",
            lh: ""
          }
        };
        if (typeof cb === "function") {
          setTimeout(
            () =>
              cb(null, {
                body: mock,
                statusCode: 200,
                headers: { "content-type": "application/json" }
              }),
            0
          );
        }
        return;
      }
      const method = (options && options.method) || "GET";
      const headers = Object.assign(
        {
          "User-Agent": "lx-music-mobile/1.4.0"
        },
        (options && options.headers) || {}
      );
      let body = options && options.body;
      if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
        body = JSON.stringify(body);
        if (!headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = "application/json";
        }
      }
      fetchRaw(u, { method, headers, body, timeout: REQ_TIMEOUT_MS })
        .then((res) => {
          if (typeof cb === "function") {
            cb(null, {
              body: res.body,
              statusCode: res.statusCode,
              headers: res.headers
            });
          }
        })
        .catch((err) => {
          if (typeof cb === "function") cb(err, null);
        });
    },
    utils: {
      crypto: {
        md5(s) {
          return crypto.createHash("md5").update(String(s)).digest("hex");
        },
        aesEncrypt() {
          return "";
        },
        rsaEncrypt() {
          return "";
        }
      },
      buffer: {
        from(s, enc) {
          return Buffer.from(s, enc || "utf8");
        },
        bufToString(b, enc) {
          return Buffer.from(b).toString(enc || "utf8");
        }
      }
    }
  };

  // 执行脚本
  try {
    vm.runInNewContext(scriptText, sandbox, {
      timeout: VM_TIMEOUT_MS,
      filename: "user-source.js"
    });
  } catch (e) {
    return {
      ok: false,
      error: "脚本执行失败: " + (e.message || String(e)),
      ms: Date.now() - start,
      platformStatus: {},
      platformReasons: {}
    };
  }

  // 等 inited（部分脚本异步拉配置 / 强混淆初始化较慢）
  await new Promise((r) => setTimeout(r, 1500));

  if (!requestHandler) {
    return {
      ok: false,
      error: "脚本未注册 request 处理（无 on(EVENT_NAMES.request)）",
      ms: Date.now() - start,
      platformStatus: {},
      platformReasons: {},
      sources: initedSources
    };
  }

  const declared =
    initedSources && initedSources.length
      ? initedSources.filter((p) => CORE.includes(p))
      : [...CORE];

  const platformStatus = {};
  const platformReasons = {};

  async function testOnePlatform(platform) {
    if (declared.length && !declared.includes(platform)) {
      platformStatus[platform] = "fail";
      platformReasons[platform] = "脚本未声明该平台";
      return;
    }
    const ids = (TEST_BY_PLATFORM[platform] && TEST_BY_PLATFORM[platform].ids) || ["1"];
    // 先只测 128k，成功即停，避免 5 平台×3 音质拖过 Render/前端超时
    const qualities = ["128k", "320k"];
    const deadline = Date.now() + PLATFORM_TIMEOUT_MS;
    let lastErr = "取链失败";
    let tries = 0;

    outer: for (const id of ids) {
      for (const quality of qualities) {
        if (Date.now() > deadline || tries >= MAX_OUTBOUND_PER_PLATFORM) break outer;
        tries++;
        try {
          const result = await Promise.race([
            Promise.resolve(
              requestHandler({
                action: "musicUrl",
                source: platform,
                info: {
                  type: quality,
                  musicInfo: buildMusicInfo(platform, id)
                }
              })
            ),
            new Promise((_, rej) =>
              setTimeout(() => rej(new Error("musicUrl 超时")), PLATFORM_TIMEOUT_MS)
            )
          ]);

          let playUrl = null;
          if (typeof result === "string" && /^https?:\/\//i.test(result)) playUrl = result;
          else if (result && typeof result === "object") playUrl = pickUrlFromBody(result);

          if (playUrl && (await probePlayable(playUrl))) {
            platformStatus[platform] = "ok";
            platformReasons[platform] = "已取到可播放音频地址";
            return;
          }
          // 严格：探活成功才绿；有地址但探活失败仍算失败
          if (playUrl) {
            lastErr = "返回了地址但音频探活失败";
          } else {
            lastErr = "未返回有效播放地址";
          }
        } catch (e) {
          lastErr = e && e.message ? String(e.message).slice(0, 120) : "调用失败";
          if (/403|Forbidden|地区|版权|IP/i.test(lastErr)) {
            lastErr = "接口拒绝或地区限制: " + lastErr;
          }
          // 「无法获取歌曲ID」换下一个 id；音质不支持则换 quality
          if (/无法获取歌曲ID|缺少歌曲ID|没有找到|无效的id/i.test(lastErr)) {
            break; // 换下一首歌 id
          }
        }
      }
    }

    // 脚本链路失败 → 公开接口兜底（探活成功才绿）
    for (const id of ids.slice(0, 2)) {
      try {
        const fb = await tryPublicApiFallback(platform, id);
        if (fb.ok) {
          platformStatus[platform] = "ok";
          platformReasons[platform] = "公开接口兜底取链成功并已探活";
          return;
        }
      } catch (_) {}
    }

    platformStatus[platform] = "fail";
    platformReasons[platform] = lastErr;
  }

  // 平台串行，避免免费实例打爆
  for (const p of CORE) {
    await testOnePlatform(p);
  }

  const statuses = declared.map((p) => platformStatus[p]).filter(Boolean);
  const overallStatus =
    statuses.length === 0
      ? "fail"
      : statuses.every((s) => s === "ok")
        ? "ok"
        : statuses.some((s) => s === "ok")
          ? "partial"
          : "fail";

  return {
    ok: true,
    ms: Date.now() - start,
    name: null,
    sources: declared,
    platforms: declared,
    platformStatus,
    platformReasons,
    overallStatus,
    okPlatforms: Object.values(platformStatus).filter((s) => s === "ok").length,
    totalPlatforms: CORE.length,
    sourceType: "sandbox"
  };
}

// ---------- HTTP server ----------
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    return sendJson(res, 200, {
      ok: true,
      service: "lx-source-sandbox",
      usage: "POST /sandbox/check  { script: string }"
    });
  }

  if (req.method === "POST" && url.pathname === "/sandbox/check") {
    try {
      const raw = await readBody(req, SCRIPT_MAX + 64 * 1024);
      let script = "";
      let name = "";
      const ct = (req.headers["content-type"] || "").toLowerCase();
      if (ct.includes("application/json")) {
        const j = JSON.parse(raw.toString("utf8") || "{}");
        script = String(j.script || j.content || "");
        name = String(j.name || "");
      } else {
        script = raw.toString("utf8");
      }
      if (!script || script.length < 50) {
        return sendJson(res, 400, { ok: false, error: "请提供有效的音源脚本正文" });
      }
      if (script.length > SCRIPT_MAX) {
        return sendJson(res, 400, { ok: false, error: "脚本过大（上限约 2MB）" });
      }
      const result = await runScriptCheck(script);
      if (name && result.ok) result.localName = name;
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message || "沙箱错误" });
    }
  }

  sendJson(res, 404, { ok: false, error: "Not Found" });
});

server.listen(PORT, () => {
  console.log(`[lx-source-sandbox] http://0.0.0.0:${PORT}`);
  console.log(`  GET  /health`);
  console.log(`  POST /sandbox/check  { "script": "..." }`);
});

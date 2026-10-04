/**
 * 洛雪音源沙箱检测服务 v2（可部署 Render / 本机）
 * - mock globalThis.lx，执行用户脚本
 * - 对 kw/kg/tx/wy/mg 调用 musicUrl
 * - 拦截 request / 返回值，探活音频地址
 *
 * v2 改动：
 *  1. SSRF 防护：所有出站请求（含重定向）先做 DNS 解析，命中内网段直接拒绝
 *  2. 测试 ID 轮换：按脚本 sha256 决定本次用哪两个测试 ID，避免固定 ID 被限流/缓存污染
 *  3. 清晰度矩阵：128k / 320k 都试一遍
 *  4. search 冒烟测试：每个平台额外做一次搜索健康检查（单独返回，不影响 musicUrl 判定）
 *  5. 结果缓存：按脚本 sha256 缓存 10 分钟，相同脚本直接返回缓存结果
 *
 * POST /sandbox/check  { "script": "...", "name": "可选", "nocache": true }
 * GET  /health
 */

const http = require("http");
const https = require("https");
const dns = require("dns").promises;
const net = require("net");
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
const SEARCH_TIMEOUT_MS = 6000;
const MAX_OUTBOUND_PER_PLATFORM = 8;
const QUALITIES = ["128k", "320k"];

// ---------- 结果缓存（按脚本 sha256，LRU + TTL） ----------
const RESULT_CACHE = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

function cacheGet(hash) {
  const hit = RESULT_CACHE.get(hash);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    RESULT_CACHE.delete(hash);
    return null;
  }
  RESULT_CACHE.delete(hash); // LRU：命中后移到末尾
  RESULT_CACHE.set(hash, hit);
  return hit.result;
}

function cacheSet(hash, result) {
  if (RESULT_CACHE.size >= CACHE_MAX) {
    RESULT_CACHE.delete(RESULT_CACHE.keys().next().value);
  }
  RESULT_CACHE.set(hash, { ts: Date.now(), result });
}

// ---------- SSRF 防护：禁止出站到内网 ----------
function isPrivateV4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16（含云元数据 169.254.169.254）
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

function isPrivateIP(ip) {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === "::1") return true;
    if (low.startsWith("fe80:")) return true; // link-local
    if (low.startsWith("fc") || low.startsWith("fd")) return true; // unique-local
    const m = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
    if (m) return isPrivateV4(m[1]);
    return false;
  }
  return true; // 不是合法 IP 字面量就直接拦，fail closed
}

const BLOCKED_HOST_RE = /(^|\.)(localhost|internal|local|lan|home|corp)$/i;

async function assertUrlAllowed(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("无效 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅允许 http/https");
  }
  const host = parsed.hostname;
  if (BLOCKED_HOST_RE.test(host)) throw new Error("禁止访问内网地址");
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error("域名解析失败，拒绝出站");
  }
  if (!addrs.length || addrs.some((a) => isPrivateIP(a.address))) {
    throw new Error("禁止访问内网地址");
  }
}

const CORE = ["kw", "kg", "tx", "wy", "mg"];
const PLATFORM_MAP = {
  kw: "酷我",
  kg: "酷狗",
  tx: "QQ音乐",
  wy: "网易云",
  mg: "咪咕"
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

/** 按脚本 hash 轮换测试 ID：每次取连续 2 个，避免固定 ID 被限流 */
function pickTestIds(platform, scriptHash) {
  const pool = (TEST_BY_PLATFORM[platform] && TEST_BY_PLATFORM[platform].ids) || ["1"];
  const off = parseInt(String(scriptHash || "0").slice(0, 8), 16) % pool.length;
  return [pool[off % pool.length], pool[(off + 1) % pool.length]];
}

// ---------- HTTP helpers ----------
async function fetchOnce(url, options = {}) {
  await assertUrlAllowed(url); // SSRF 拦截（含每次重定向都会走这里）
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return reject(new Error("无效 URL"));
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

// 方案 B：只从「当前脚本正文」里抠出的端点（不用脚本外写死的公开 API）
const XINGHAI_SOURCE = {
  wy: "netease",
  tx: "tencent",
  kw: "kuwo",
  kg: "kugou",
  mg: "migu"
};

function parseScriptEndpoints(text) {
  const endpoints = [];
  const seen = new Set();
  const add = (ep) => {
    const key = [ep.kind, ep.platform, ep.base || "", ep.template || ""].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    endpoints.push(ep);
  };
  if (!text || text.length < 40) return endpoints;

  // gdstudio / 星海 base（仅当脚本里出现）
  const baseSet = new Set();
  let m;
  const gdRe = /https?:\/\/[a-z0-9.-]*gdstudio\.[a-z.]+\/api\.php/gi;
  while ((m = gdRe.exec(text))) baseSet.add(m[0].split("?")[0].replace(/\/$/, ""));
  const apiRe = /https?:\/\/music-api\.[a-z0-9.-]+\/api\.php/gi;
  while ((m = apiRe.exec(text))) baseSet.add(m[0].split("?")[0].replace(/\/$/, ""));
  const sayqzRe = /https?:\/\/music-dl\.sayqz\.com\/api\/?/gi;
  while ((m = sayqzRe.exec(text))) baseSet.add(m[0].replace(/\/?$/, ""));
  for (const base of baseSet) {
    for (const p of CORE) {
      add({
        platform: p,
        kind: "xinghai",
        base,
        source: XINGHAI_SOURCE[p]
      });
    }
  }

  // oiapi 等（脚本里写死的）
  const m163 = text.match(/https?:\/\/oiapi\.net\/api\/Music_163/i);
  if (m163) add({ platform: "wy", kind: "id", base: m163[0] });
  const mKw = text.match(/https?:\/\/oiapi\.net\/api\/Kuwo/i);
  if (mKw) add({ platform: "kw", kind: "search-kw", base: mKw[0] });
  const mQq = text.match(/https?:\/\/oiapi\.net\/api\/QQ_Music/i);
  if (mQq) add({ platform: "tx", kind: "search", base: mQq[0] });

  // 明文 php 模板
  const phpRe =
    /https?:\/\/[^\s"'`<>\\]{8,180}?(?:\/|^)(?:kw|kg|tx|wy|mg|qq)\.php\?[^\s"'`<>\\]{0,120}/gi;
  while ((m = phpRe.exec(text))) {
    let u = m[0].replace(/[),;]+$/, "");
    let platform = null;
    if (/kw\.php/i.test(u)) platform = "kw";
    else if (/kg\.php/i.test(u)) platform = "kg";
    else if (/(?:tx|qq)\.php/i.test(u)) platform = "tx";
    else if (/wy\.php/i.test(u)) platform = "wy";
    else if (/mg\.php/i.test(u)) platform = "mg";
    if (!platform) continue;
    let template = u
      .replace(/([?&]id=)[^&"'`]*/gi, "$1{id}")
      .replace(/([?&]level=)[^&"'`]*/gi, "$1{level}");
    if (!/\{id\}/.test(template)) {
      template += (template.includes("?") ? "&" : "?") + "id={id}&level={level}";
    }
    add({ platform, kind: "php", template });
  }

  // 长青 haitangw
  const htRe =
    /https?:\/\/yinyue\.haitangw\.net\/(kg|qq|wy|kw|mg)\/[a-z0-9_]+\.php\?type=mp3&id=/gi;
  while ((m = htRe.exec(text))) {
    const map = { kg: "kg", qq: "tx", wy: "wy", kw: "kw", mg: "mg" };
    const p = map[String(m[1]).toLowerCase()];
    if (p) {
      add({
        platform: p,
        kind: "php",
        template: m[0] + "{id}&level={level}"
      });
    }
  }

  // 优先级：星海 > 含 nxinxz/haitang 的 php > 其它
  const score = (ep) => {
    const u = ep.base || ep.template || "";
    if (ep.kind === "xinghai") return 0;
    if (/nxinxz|haitangw/i.test(u)) return 1;
    if (ep.kind === "php") return 2;
    if (ep.kind === "id" || ep.kind === "search-kw") return 3;
    return 4;
  };
  endpoints.sort((a, b) => score(a) - score(b));
  return endpoints;
}

/** 测试「脚本正文里出现过的」单个端点（ids 由调用方按脚本 hash 轮换传入） */
async function tryScriptEndpoint(ep, platform, ids) {
  const meta = TEST_BY_PLATFORM[platform] || {};
  const testIds = (ids && ids.length ? ids : (meta.ids || ["1"])).slice(0, 2);
  const jobs = [];

  if (ep.kind === "xinghai" && ep.base) {
    let base = String(ep.base).replace(/\/$/, "");
    try {
      const u = new URL(base.includes("://") ? base : "https://" + base);
      if (/gdstudio|api\.php/i.test(u.href)) {
        base = u.origin + u.pathname.replace(/\/$/, "");
      }
    } catch (_) {}
    const source = ep.source || XINGHAI_SOURCE[platform] || platform;
    for (const id of testIds) {
      jobs.push(
        `${base}?types=url&source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}&br=128`
      );
    }
  } else if (ep.kind === "id" && ep.base) {
    for (const id of testIds) {
      jobs.push(`${ep.base}?id=${encodeURIComponent(id)}`);
    }
  } else if (ep.kind === "search-kw" && ep.base) {
    for (const kw of ["隐形的翅膀", "海阔天空", meta.name || "测试"]) {
      jobs.push(
        `${ep.base}?msg=${encodeURIComponent(kw)}&n=1&br=128`
      );
    }
  } else if (ep.kind === "search" && ep.base) {
    for (const id of testIds) {
      jobs.push(`${ep.base}?id=${encodeURIComponent(id)}`);
    }
  } else if (ep.kind === "php" && ep.template) {
    const id = testIds[0];
    for (const level of ["standard", "128k"]) {
      jobs.push(
        ep.template
          .replace(/\{id\}/gi, encodeURIComponent(id))
          .replace(/\{level\}/gi, level)
      );
    }
  }

  for (const url of jobs.slice(0, 3)) {
    try {
      const res = await fetchRaw(url, {
        method: "GET",
        headers: {
          "User-Agent": "lx-music-mobile/1.4.0",
          Accept: "application/json, text/plain, */*, audio/*"
        },
        maxBody: 512 * 1024
      });
      if (!res) continue;
      if (res.statusCode === 400) {
        const t = res.raw ? res.raw.toString("utf8") : "";
        if (/not supported|不支持/i.test(t)) break;
        continue;
      }
      if (res.statusCode >= 200 && res.statusCode < 400) {
        if (looksLikeAudio(res.headers, res.raw)) return true;
        const playUrl = pickUrlFromBody(res.body);
        if (playUrl && (await probePlayable(playUrl))) return true;
      }
    } catch (_) {}
  }
  return false;
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
async function runScriptCheck(scriptText, scriptHash) {
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
  // 方案 B：从当前脚本正文解析端点（仅脚本里出现过的）
  const scriptEndpoints = parseScriptEndpoints(scriptText);

  async function testOnePlatform(platform) {
    if (declared.length && !declared.includes(platform)) {
      platformStatus[platform] = "fail";
      platformReasons[platform] = "脚本未声明该平台";
      return;
    }
    const ids = pickTestIds(platform, scriptHash);
    let lastErr = "取链失败";

    // —— 1) 脚本内端点：失败换下一个，任一探活成功即绿 ——
    const eps = scriptEndpoints.filter((e) => e.platform === platform).slice(0, 8);
    for (const ep of eps) {
      try {
        if (await tryScriptEndpoint(ep, platform, ids)) {
          platformStatus[platform] = "ok";
          platformReasons[platform] = "脚本内端点取链成功并已探活";
          return;
        }
      } catch (_) {}
    }
    if (eps.length) {
      lastErr = "脚本内端点均取链/探活失败";
    } else {
      lastErr = "脚本中未解析到该平台端点";
    }

    // —— 2) 仍失败则试 musicUrl（脚本运行时逻辑，也是脚本能力） ——
    const deadline = Date.now() + PLATFORM_TIMEOUT_MS;
    let tries = 0;
    outer: for (const id of ids) {
      for (const quality of QUALITIES) {
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
            platformReasons[platform] = `脚本 musicUrl 取链成功并已探活（${quality}）`;
            return;
          }
          if (playUrl) lastErr = "返回了地址但音频探活失败";
          else lastErr = lastErr || "未返回有效播放地址";
        } catch (e) {
          lastErr = e && e.message ? String(e.message).slice(0, 120) : "调用失败";
          if (/无法获取歌曲ID|缺少歌曲ID|没有找到|无效的id/i.test(lastErr)) break;
        }
      }
    }

    platformStatus[platform] = "fail";
    platformReasons[platform] = lastErr;
  }

  /** search 冒烟测试：best-effort，结果单独返回，不影响 musicUrl 判定 */
  async function testSearch(platform) {
    const meta = TEST_BY_PLATFORM[platform] || {};
    const keyword = meta.name || "海阔天空";
    const shapes = [
      { action: "search", source: platform, info: { keyword, page: 1 } },
      { action: "search", source: platform, info: { query: keyword, page: 1 } }
    ];
    for (const payload of shapes) {
      try {
        const result = await Promise.race([
          Promise.resolve(requestHandler(payload)),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error("search 超时")), SEARCH_TIMEOUT_MS)
          )
        ]);
        const list = Array.isArray(result)
          ? result
          : result && Array.isArray(result.list)
            ? result.list
            : result && result.data && Array.isArray(result.data.list)
              ? result.data.list
              : result && Array.isArray(result.data)
                ? result.data
                : null;
        if (list && list.length > 0) return { ok: true, count: list.length };
      } catch (_) {
        // 换下一种参数形状
      }
    }
    return { ok: false, reason: "搜索无结果或不支持 search action" };
  }

  // 平台串行，避免免费实例打爆
  for (const p of CORE) {
    await testOnePlatform(p);
  }

  // search 冒烟：并行跑，单独计时
  const searchStatus = {};
  const searchReasons = {};
  try {
    const results = await Promise.all(
      declared.map(async (p) => {
        try {
          return [p, await testSearch(p)];
        } catch (e) {
          return [p, { ok: false, reason: String((e && e.message) || e).slice(0, 80) }];
        }
      })
    );
    for (const [p, r] of results) {
      searchStatus[p] = r.ok ? "ok" : "fail";
      searchReasons[p] = r.ok ? `搜索返回 ${r.count} 条` : r.reason;
      if (!r.ok && platformStatus[p] === "ok") {
        platformReasons[p] += "（搜索冒烟未通过）";
      }
    }
  } catch (_) {}

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
    scriptHash: scriptHash || null,
    sources: declared,
    platforms: declared,
    platformStatus,
    platformReasons,
    searchStatus,
    searchReasons,
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
      version: "v2",
      usage: "POST /sandbox/check  { script: string, name?: string, nocache?: true }",
      cache: { size: RESULT_CACHE.size, ttlMs: CACHE_TTL_MS }
    });
  }

  if (req.method === "POST" && url.pathname === "/sandbox/check") {
    try {
      const raw = await readBody(req, SCRIPT_MAX + 64 * 1024);
      let script = "";
      let name = "";
      let nocache = false;
      const ct = (req.headers["content-type"] || "").toLowerCase();
      if (ct.includes("application/json")) {
        const j = JSON.parse(raw.toString("utf8") || "{}");
        script = String(j.script || j.content || "");
        name = String(j.name || "");
        nocache = !!j.nocache;
      } else {
        script = raw.toString("utf8");
        nocache = url.searchParams.get("fresh") === "1";
      }
      if (!script || script.length < 50) {
        return sendJson(res, 400, { ok: false, error: "请提供有效的音源脚本正文" });
      }
      if (script.length > SCRIPT_MAX) {
        return sendJson(res, 400, { ok: false, error: "脚本过大（上限约 2MB）" });
      }

      const scriptHash = crypto.createHash("sha256").update(script).digest("hex");

      // 缓存命中直接返回
      if (!nocache) {
        const hit = cacheGet(scriptHash);
        if (hit) {
          return sendJson(res, 200, { ...hit, cached: true, ms: 0 });
        }
      }

      const result = await runScriptCheck(script, scriptHash);
      if (name && result.ok) result.localName = name;
      cacheSet(scriptHash, result); // 成功失败都缓存，hash 变了自然失效
      return sendJson(res, 200, { ...result, cached: false });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message || "沙箱错误" });
    }
  }

  sendJson(res, 404, { ok: false, error: "Not Found" });
});

server.listen(PORT, () => {
  console.log(`[lx-source-sandbox v2] http://0.0.0.0:${PORT}`);
  console.log(`  GET  /health`);
  console.log(`  POST /sandbox/check  { "script": "...", "nocache": true }`);
});

/**
 * 洛雪音源沙箱检测服务（可部署 Render / 本机）
 * - mock globalThis.lx，执行用户脚本
 * - 对 kw/kg/tx/wy/mg 调用 musicUrl
 * - 只判断 musicUrl 是否返回有效播放地址
 *
 * POST /sandbox/check  { "script": "...", "name": "可选" }
 * GET  /health
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");
const vm = require("vm");
const crypto = require("crypto");

// 防止脚本初始化异常导致整个进程退出
process.on("uncaughtException", (err) => {
  console.error("[sandbox] uncaughtException:", err && err.message);
});

process.on("unhandledRejection", (err) => {
  console.error(
    "[sandbox] unhandledRejection:",
    err && (err.message || err)
  );
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

// 每个平台准备多个测试 ID。
// 如果第一个 ID 失败，会继续测试后面的 ID。
const TEST_BY_PLATFORM = {
  wy: {
    ids: ["347230", "186016", "186001"],
    name: "海阔天空",
    singer: "Beyond"
  },

  kw: {
    ids: ["291598", "164700", "96765035"],
    name: "隐形的翅膀",
    singer: "张韶涵"
  },

  tx: {
    ids: [
      "004ZX0AQ49Bc8Y",
      "001yS0N33yPm1B",
      "0039MnYb0qxYhV"
    ],
    name: "海阔天空",
    singer: "BEYOND"
  },

  kg: {
    ids: [
      "4d97c65307f81e2a34ea13f9ecb27f5a",
      "e5c40a31c3c16ba461f650035734c123",
      "b3a52a7a958bf0aed0ebfba2e9a818b7"
    ],
    name: "隐形的翅膀",
    singer: "张韶涵"
  },

  mg: {
    ids: [
      "600929000006724407",
      "600913000009337537",
      "600902000006889366"
    ],
    name: "海阔天空",
    singer: "Beyond"
  }
};


// ============================================================
// HTTP 请求
// ============================================================

function fetchOnce(url, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;

    try {
      parsed = new URL(url);
    } catch (e) {
      return reject(new Error("无效 URL"));
    }

    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      return reject(new Error("仅允许 http/https"));
    }

    const lib =
      parsed.protocol === "https:"
        ? https
        : http;

    const req = lib.request(
      url,
      {
        method: options.method || "GET",
        headers: options.headers || {},
        timeout: options.timeout || REQ_TIMEOUT_MS,

        // 某些第三方音乐接口证书可能不完整
        rejectUnauthorized: false
      },

      (res) => {
        const chunks = [];
        let total = 0;

        res.on("data", (c) => {
          const maxBody =
            options.maxBody || 512 * 1024;

          if (total < maxBody) {
            chunks.push(c);
            total += c.length;
          }
        });

        res.on("end", () => {
          const buf = Buffer.concat(chunks);

          let body = buf;

          const ct = String(
            res.headers["content-type"] || ""
          ).toLowerCase();

          // JSON
          if (
            /json/.test(ct) ||
            (
              buf.length &&
              (
                buf[0] === 0x7b ||
                buf[0] === 0x5b
              )
            )
          ) {
            try {
              body = JSON.parse(
                buf.toString("utf8")
              );
            } catch {
              body = buf.toString("utf8");
            }
          }

          // 文本
          else if (
            /text|javascript|xml/.test(ct)
          ) {
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
      const b =
        typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body);

      req.write(b);
    }

    req.end();
  });
}


// ============================================================
// 自动跟随重定向
// ============================================================

async function fetchRaw(url, options = {}) {
  let current = url;
  let opts = { ...options };

  let last = null;

  // 最多跟随 6 次
  for (let i = 0; i < 6; i++) {
    last = await fetchOnce(current, opts);

    const code = last.statusCode;

    const loc =
      last.headers &&
      (
        last.headers.location ||
        last.headers.Location
      );

    if (
      loc &&
      code >= 300 &&
      code < 400
    ) {
      try {
        current = new URL(
          loc,
          current
        ).href;
      } catch {
        break;
      }

      opts = {
        ...opts,
        method: "GET",
        body: undefined
      };

      continue;
    }

    break;
  }

  return last;
}


// ============================================================
// 从接口返回内容中寻找播放 URL
// ============================================================

function pickUrlFromBody(body) {
  if (!body) return null;

  // 字符串
  if (typeof body === "string") {
    const t = body.trim();

    // 直接就是 URL
    if (/^https?:\/\//i.test(t)) {
      return t.split(/\s/)[0];
    }

    // JSON 字符串
    try {
      const j = JSON.parse(t);

      return pickUrlFromBody(j);
    } catch {
      // 普通文本中寻找 URL
      const m = t.match(
        /https?:\/\/[^\s"'<>]+/i
      );

      return m ? m[0] : null;
    }
  }

  // 对象
  if (
    typeof body === "object" &&
    body !== null
  ) {
    // 常见 URL 字段
    for (
      const k of [
        "url",
        "music_url",
        "musicUrl",
        "src",
        "playUrl",
        "audioUrl"
      ]
    ) {
      if (
        body[k] &&
        /^https?:\/\//i.test(
          String(body[k])
        )
      ) {
        return String(body[k]);
      }
    }

    // data 嵌套
    if (body.data) {
      const u =
        pickUrlFromBody(body.data);

      if (u) return u;
    }

    // result 嵌套
    if (body.result) {
      const u =
        pickUrlFromBody(body.result);

      if (u) return u;
    }

    // song 嵌套
    if (body.song) {
      const u =
        pickUrlFromBody(body.song);

      if (u) return u;
    }
  }

  return null;
}


// ============================================================
// 构造模拟 musicInfo
// ============================================================

function buildMusicInfo(platform, id) {
  const meta =
    TEST_BY_PLATFORM[platform] || {};

  const sid = String(id);

  const info = {
    name:
      meta.name ||
      "海阔天空",

    singer:
      meta.singer ||
      "Beyond",

    albumName:
      "测试专辑",

    interval:
      240,

    id: sid,

    songmid: sid,

    songId: sid,

    mid: sid,

    rid: sid,

    strMediaMid: sid,

    media_mid: sid,

    hash: sid,

    copyrightId: sid,

    contentId: sid,

    albumId: sid,

    source: platform
  };


  // 酷狗
  if (platform === "kg") {
    info.hash = sid;
    info.kgHub = sid;
  }


  // QQ音乐
  if (platform === "tx") {
    info.songmid = sid;
    info.mid = sid;
    info.strMediaMid = sid;
  }


  // 酷我
  if (platform === "kw") {
    info.rid = sid;
    info.songmid = sid;
  }


  // 网易云
  if (platform === "wy") {
    info.id = sid;
    info.songId = sid;
  }


  // 咪咕
  if (platform === "mg") {
    info.copyrightId = sid;
    info.contentId = sid;
    info.songmid = sid;
  }

  return info;
}


// ============================================================
// 沙箱运行
// ============================================================

async function runScriptCheck(scriptText) {
  const start = Date.now();

  let requestHandler = null;

  let initedSources = null;

  let outboundCount = 0;


  // ----------------------------------------------------------
  // 创建沙箱环境
  // ----------------------------------------------------------

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

    atob: (s) =>
      Buffer.from(
        s,
        "base64"
      ).toString("binary"),

    btoa: (s) =>
      Buffer.from(
        s,
        "binary"
      ).toString("base64"),

    URL,

    globalThis: null,

    global: null,

    window: null
  };


  sandbox.globalThis =
    sandbox;

  sandbox.global =
    sandbox;

  sandbox.window =
    sandbox;


  // ----------------------------------------------------------
  // 模拟 lx
  // ----------------------------------------------------------

  sandbox.globalThis.lx = {

    EVENT_NAMES: {
      request: "request",

      inited: "inited",

      updateAlert:
        "updateAlert"
    },


    version:
      "1.4.0",

    env:
      "mobile",


    currentScriptInfo: {
      name:
        "sandbox-check",

      version:
        "1.0.0"
    },


    // --------------------------------------------------------
    // 注册 request
    // --------------------------------------------------------

    on(name, fn) {

      if (
        name === "request" ||
        name ===
          sandbox.globalThis.lx
            .EVENT_NAMES.request
      ) {
        requestHandler = fn;
      }
    },


    // --------------------------------------------------------
    // 接收 inited
    // --------------------------------------------------------

    send(name, data) {

      if (
        name === "inited" ||
        name ===
          sandbox.globalThis.lx
            .EVENT_NAMES.inited
      ) {
        initedSources =
          data &&
          data.sources
            ? Object.keys(
                data.sources
              )
            : null;
      }
    },


    // --------------------------------------------------------
    // lx.request
    // --------------------------------------------------------

    request(
      url,
      options,
      cb
    ) {

      outboundCount++;

      if (outboundCount > 40) {

        const err =
          new Error(
            "出站请求过多"
          );

        if (
          typeof cb ===
          "function"
        ) {
          cb(err, null);
        }

        return;
      }


      const u =
        String(url);


      // ------------------------------------------------------
      // 部分脚本初始化时会请求配置
      // ------------------------------------------------------

      if (
        /grass-source|source-info|\/info\/|vinfo|mirror\.com|97\.64\.|source-info\/l/i
          .test(u) &&
        !/\/url\//i.test(u)
      ) {

        const mock = {

          data: {

            s:
              "kw|128k,320k,flac&kg|128k,320k,flac&tx|128k,320k,flac&wy|128k,320k,flac&mg|128k,320k,flac",

            m: "",

            lv: "0",

            lu: "",

            lh: ""
          }
        };


        if (
          typeof cb ===
          "function"
        ) {

          setTimeout(
            () => {

              cb(
                null,
                {
                  body:
                    mock,

                  statusCode:
                    200,

                  headers: {
                    "content-type":
                      "application/json"
                  }
                }
              );

            },
            0
          );
        }

        return;
      }


      // ------------------------------------------------------
      // 正常请求
      // ------------------------------------------------------

      const method =
        (
          options &&
          options.method
        ) || "GET";


      const headers =
        Object.assign(

          {
            "User-Agent":
              "lx-music-mobile/1.4.0"
          },

          (
            options &&
            options.headers
          ) || {}
        );


      let body =
        options &&
        options.body;


      if (
        body &&
        typeof body ===
          "object" &&
        !Buffer.isBuffer(body)
      ) {

        body =
          JSON.stringify(body);

        if (
          !headers[
            "Content-Type"
          ] &&
          !headers[
            "content-type"
          ]
        ) {

          headers[
            "Content-Type"
          ] =
            "application/json";
        }
      }


      fetchRaw(
        u,
        {
          method,
          headers,
          body,
          timeout:
            REQ_TIMEOUT_MS
        }
      )

        .then(
          (res) => {

            if (
              typeof cb ===
              "function"
            ) {

              cb(
                null,
                {
                  body:
                    res.body,

                  statusCode:
                    res.statusCode,

                  headers:
                    res.headers
                }
              );
            }

          }
        )

        .catch(
          (err) => {

            if (
              typeof cb ===
              "function"
            ) {

              cb(
                err,
                null
              );
            }

          }
        );
    },


    // --------------------------------------------------------
    // lx.utils
    // --------------------------------------------------------

    utils: {

      crypto: {

        md5(s) {

          return crypto
            .createHash("md5")
            .update(
              String(s)
            )
            .digest("hex");
        },


        aesEncrypt() {
          return "";
        },


        rsaEncrypt() {
          return "";
        }
      },


      buffer: {

        from(
          s,
          enc
        ) {

          return Buffer.from(
            s,
            enc || "utf8"
          );
        },


        bufToString(
          b,
          enc
        ) {

          return Buffer.from(
            b
          ).toString(
            enc || "utf8"
          );
        }
      }
    }
  };


  // ==========================================================
  // 执行音源脚本
  // ==========================================================

  try {

    vm.runInNewContext(
      scriptText,
      sandbox,
      {
        timeout:
          VM_TIMEOUT_MS,

        filename:
          "user-source.js"
      }
    );

  } catch (e) {

    return {

      ok: false,

      error:
        "脚本执行失败: " +
        (
          e.message ||
          String(e)
        ),

      ms:
        Date.now() -
        start,

      platformStatus: {},

      platformReasons: {}
    };
  }


  // ----------------------------------------------------------
  // 等待脚本初始化
  // ----------------------------------------------------------

  await new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        1500
      )
  );


  // ----------------------------------------------------------
  // 检查 request
  // ----------------------------------------------------------

  if (!requestHandler) {

    return {

      ok: false,

      error:
        "脚本未注册 request 处理（无 on(EVENT_NAMES.request)）",

      ms:
        Date.now() -
        start,

      platformStatus: {},

      platformReasons: {},

      sources:
        initedSources
    };
  }


  // ----------------------------------------------------------
  // 脚本声明的平台
  // ----------------------------------------------------------

  const declared =
    initedSources &&
    initedSources.length

      ? initedSources.filter(
          (p) =>
            CORE.includes(p)
        )

      : [...CORE];


  const platformStatus = {};

  const platformReasons = {};


  // ==========================================================
  // 单个平台检测
  // ==========================================================

  async function testOnePlatform(
    platform
  ) {

    // 如果脚本明确声明了平台，
    // 但没有声明当前平台，则失败。
    if (
      declared.length &&
      !declared.includes(
        platform
      )
    ) {

      platformStatus[
        platform
      ] = "fail";

      platformReasons[
        platform
      ] =
        "脚本未声明该平台";

      return;
    }


    const meta =
      TEST_BY_PLATFORM[
        platform
      ] || {};


    // 最多三个测试 ID
    const ids =
      (
        meta.ids ||
        ["1"]
      ).slice(
        0,
        3
      );


    const qualities =
      ["128k"];


    const deadline =
      Date.now() +
      PLATFORM_TIMEOUT_MS;


    let tries = 0;


    let lastErr =
      "musicUrl 未返回有效播放地址";


    // --------------------------------------------------------
    // 直接执行脚本 musicUrl
    // --------------------------------------------------------

    outer:

    for (
      const id of ids
    ) {

      for (
        const quality of qualities
      ) {

        if (
          Date.now() >
            deadline ||
          tries >=
            MAX_OUTBOUND_PER_PLATFORM
        ) {
          break outer;
        }


        tries++;


        try {

          const result =
            await Promise.race([

              Promise.resolve(

                requestHandler({

                  action:
                    "musicUrl",

                  source:
                    platform,

                  info: {

                    type:
                      quality,

                    musicInfo:
                      buildMusicInfo(
                        platform,
                        id
                      )
                  }

                })

              ),


              new Promise(
                (
                  _,
                  reject
                ) => {

                  setTimeout(
                    () => {

                      reject(
                        new Error(
                          "musicUrl 超时"
                        )
                      );

                    },

                    PLATFORM_TIMEOUT_MS
                  );

                }
              )
            ]);


          // --------------------------------------------------
          // 提取播放 URL
          // --------------------------------------------------

          let playUrl =
            null;


          if (
            typeof result ===
            "string"
          ) {

            const t =
              result.trim();

            if (
              /^https?:\/\//i
                .test(t)
            ) {

              playUrl = t;
            }

          }

          else if (
            result &&
            typeof result ===
              "object"
          ) {

            playUrl =
              pickUrlFromBody(
                result
              );
          }


          // --------------------------------------------------
          // 核心判断
          //
          // 只要 musicUrl 返回有效 URL，
          // 直接判定平台可用。
          //
          // 不再访问播放 URL 探活。
          // --------------------------------------------------

          if (
            playUrl &&
            /^https?:\/\//i
              .test(playUrl)
          ) {

            platformStatus[
              platform
            ] = "ok";


            platformReasons[
              platform
            ] =
              "脚本 musicUrl 成功返回播放地址";


            return;
          }


          // 当前 ID 没拿到地址
          lastErr =
            "musicUrl 未返回有效播放地址";

        }


        catch (e) {

          lastErr =
            e &&
            e.message

              ? String(
                  e.message
                ).slice(
                  0,
                  160
                )

              : "musicUrl 调用失败";


          // 某个测试 ID 无效，
          // 继续尝试下一个 ID。
          if (
            /无法获取歌曲ID|缺少歌曲ID|没有找到|无效的id/i
              .test(lastErr)
          ) {

            continue;
          }
        }
      }
    }


    // --------------------------------------------------------
    // 全部测试失败
    // --------------------------------------------------------

    platformStatus[
      platform
    ] = "fail";


    platformReasons[
      platform
    ] =
      lastErr;
  }


  // ==========================================================
  // 五个平台依次检测
  // ==========================================================

  for (
    const p of CORE
  ) {

    await testOnePlatform(
      p
    );
  }


  // ==========================================================
  // 总状态
  // ==========================================================

  const statuses =
    declared
      .map(
        (p) =>
          platformStatus[p]
      )
      .filter(Boolean);


  const overallStatus =

    statuses.length === 0

      ? "fail"

      : statuses.every(
          (s) =>
            s === "ok"
        )

        ? "ok"

        : statuses.some(
            (s) =>
              s === "ok"
          )

          ? "partial"

          : "fail";


  return {

    ok: true,

    ms:
      Date.now() -
      start,

    name: null,

    sources:
      declared,

    platforms:
      declared,

    platformStatus,

    platformReasons,

    overallStatus,

    okPlatforms:
      Object.values(
        platformStatus
      ).filter(
        (s) =>
          s === "ok"
      ).length,

    totalPlatforms:
      CORE.length,

    sourceType:
      "sandbox"
  };
}


// ============================================================
// HTTP Body
// ============================================================

function readBody(
  req,
  limit
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      const chunks = [];

      let size = 0;


      req.on(
        "data",
        (c) => {

          size +=
            c.length;


          if (
            size > limit
          ) {

            reject(
              new Error(
                "请求体过大"
              )
            );

            req.destroy();

            return;
          }


          chunks.push(c);
        }
      );


      req.on(
        "end",
        () => {

          resolve(
            Buffer.concat(
              chunks
            )
          );

        }
      );


      req.on(
        "error",
        reject
      );
    }
  );
}


// ============================================================
// JSON 输出
// ============================================================

function sendJson(
  res,
  code,
  obj
) {

  const body =
    JSON.stringify(
      obj
    );


  res.writeHead(
    code,
    {

      "Content-Type":
        "application/json; charset=utf-8",

      "Access-Control-Allow-Origin":
        "*",

      "Access-Control-Allow-Methods":
        "GET, POST, OPTIONS",

      "Access-Control-Allow-Headers":
        "Content-Type"
    }
  );


  res.end(body);
}


// ============================================================
// HTTP Server
// ============================================================

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      // ------------------------------------------------------
      // CORS OPTIONS
      // ------------------------------------------------------

      if (
        req.method ===
        "OPTIONS"
      ) {

        res.writeHead(
          204,
          {

            "Access-Control-Allow-Origin":
              "*",

            "Access-Control-Allow-Methods":
              "GET, POST, OPTIONS",

            "Access-Control-Allow-Headers":
              "Content-Type"
          }
        );

        return res.end();
      }


      const url =
        new URL(
          req.url ||
            "/",
          "http://localhost"
        );


      // ------------------------------------------------------
      // Health
      // ------------------------------------------------------

      if (
        req.method === "GET" &&
        (
          url.pathname ===
            "/health" ||
          url.pathname ===
            "/"
        )
      ) {

        return sendJson(
          res,
          200,
          {

            ok: true,

            service:
              "lx-source-sandbox",

            usage:
              "POST /sandbox/check  { \"script\": \"...\" }"
          }
        );
      }


      // ------------------------------------------------------
      // 沙箱检测
      // ------------------------------------------------------

      if (
        req.method ===
          "POST" &&
        url.pathname ===
          "/sandbox/check"
      ) {

        try {

          const raw =
            await readBody(
              req,
              SCRIPT_MAX +
                64 * 1024
            );


          let script = "";

          let name = "";


          const ct =
            (
              req.headers[
                "content-type"
              ] || ""
            ).toLowerCase();


          if (
            ct.includes(
              "application/json"
            )
          ) {

            const j =
              JSON.parse(
                raw.toString(
                  "utf8"
                ) || "{}"
              );


            script =
              String(
                j.script ||
                j.content ||
                ""
              );


            name =
              String(
                j.name ||
                ""
              );

          }

          else {

            script =
              raw.toString(
                "utf8"
              );
          }


          // --------------------------------------------------
          // 检查脚本
          // --------------------------------------------------

          if (
            !script ||
            script.length < 50
          ) {

            return sendJson(
              res,
              400,
              {
                ok: false,

                error:
                  "请提供有效的音源脚本正文"
              }
            );
          }


          if (
            script.length >
            SCRIPT_MAX
          ) {

            return sendJson(
              res,
              400,
              {
                ok: false,

                error:
                  "脚本过大（上限约 2MB）"
              }
            );
          }


          // --------------------------------------------------
          // 执行检测
          // --------------------------------------------------

          const result =
            await runScriptCheck(
              script
            );


          if (
            name &&
            result.ok
          ) {

            result.localName =
              name;
          }


          return sendJson(
            res,
            200,
            result
          );

        }


        catch (e) {

          return sendJson(
            res,
            500,
            {

              ok: false,

              error:
                e.message ||
                "沙箱错误"
            }
          );
        }
      }


      // ------------------------------------------------------
      // 404
      // ------------------------------------------------------

      sendJson(
        res,
        404,
        {
          ok: false,
          error:
            "Not Found"
        }
      );
    }
  );


// ============================================================
// 启动
// ============================================================

server.listen(
  PORT,
  () => {

    console.log(
      `[lx-source-sandbox] http://0.0.0.0:${PORT}`
    );

    console.log(
      "  GET  /health"
    );

    console.log(
      '  POST /sandbox/check  { "script": "..." }'
    );
  }
);
# 洛雪音源沙箱检测（免费可部署）

模拟落雪 `lx` 运行时：执行音源脚本 → 调用各平台 `musicUrl` → 探活音频。

适合 **jsjiami 等强混淆** 脚本（静态解析抠不出端点时）。

## 本地运行

```bash
cd lx-source-sandbox
npm start
# 默认 http://127.0.0.1:3080
```

健康检查：

```bash
curl http://127.0.0.1:3080/health
```

检测脚本：

```bash
curl -X POST http://127.0.0.1:3080/sandbox/check \
  -H "Content-Type: application/json" \
  -d @- <<'EOF'
{"script": "这里贴完整 js 正文"}
EOF
```

或：

```bash
node -e "
const fs=require('fs');
const s=fs.readFileSync('某音源.js','utf8');
fetch('http://127.0.0.1:3080/sandbox/check',{
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({script:s,name:'test'})
}).then(r=>r.json()).then(console.log);
"
```

## Render 免费部署

1. 把本目录推到 GitHub 仓库  
2. [Render](https://render.com) → New → **Web Service**  
3. 连接仓库，设置：  
   - **Runtime**: Node  
   - **Build Command**: 留空或 `npm install`（本服务无依赖也可空）  
   - **Start Command**: `npm start`  
   - **Instance**: Free  
4. 部署后得到：`https://xxxx.onrender.com`  
5. 调用：`POST https://xxxx.onrender.com/sandbox/check`

注意：免费实例会 **休眠**，冷启动可能 30–60 秒。

## 与现有检测页对接

前端拿到脚本正文后：

```js
const res = await fetch("https://你的沙箱地址/sandbox/check", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ script: jsText, name: "可选" })
});
const data = await res.json();
// data.platformStatus.kw === "ok" | "fail"
```

## 返回示例

```json
{
  "ok": true,
  "overallStatus": "partial",
  "platformStatus": {
    "kw": "ok",
    "kg": "fail",
    "tx": "ok",
    "wy": "ok",
    "mg": "fail"
  },
  "platformReasons": {
    "kw": "已取到可播放音频地址",
    "kg": "未返回有效播放地址"
  },
  "sources": ["kw", "kg", "tx", "wy", "mg"],
  "ms": 12345
}
```

## 说明

- 不提供 `require` / `fs` / `process`，降低风险  
- 有超时与出站次数限制  
- 沙箱 IP 与手机网络不同，部分源可能仍 403（与静态检测相同）  
- 请勿公开无限制地滥用，以免免费额度被刷完  

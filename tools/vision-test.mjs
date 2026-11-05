// 图片识别（视觉模型）链路测试：浏览器内画一张含代码文字的图，发给 /api/chat
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const URL_ = process.argv[2] || "http://127.0.0.1:8080/";
const port = 9600 + Math.floor(Math.random() * 200);
const profile = path.join(os.tmpdir(), "cr-img-" + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=" + profile, "--remote-debugging-port=" + port, "--window-size=1440,900", "about:blank",
], { stdio: "ignore" });

let target = null;
for (let i = 0; i < 80; i += 1) {
  await sleep(200);
  try {
    const list = await fetch("http://127.0.0.1:" + port + "/json/list").then((r) => r.json());
    target = list.find((t) => t.type === "page");
    if (target) break;
  } catch { /* retry */ }
}
if (!target) { console.error("no target"); chrome.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params) => new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
async function js(expression, awaitPromise = false) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description };
  return r.result?.value;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: URL_ });
await sleep(5000);

// 登录
const login = await js(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({username:'testuser',password:'testpass'})}).then(r=>r.status)`);
console.log("LOGIN " + login);

// 在页面里画一张带代码文字的图，转 dataURL
const dataUrl = await js(`(function(){
  const c = document.createElement('canvas');
  c.width = 760; c.height = 260;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.fillRect(0,0,760,260);
  x.fillStyle = '#111'; x.font = 'bold 34px monospace';
  x.fillText('SELECT * FROM users', 28, 74);
  x.fillText('WHERE id = 1', 28, 132);
  x.fillStyle = '#c00'; x.font = 'bold 30px monospace';
  x.fillText('API_KEY = testpass', 28, 200);
  return c.toDataURL('image/png');
})()`);
console.log("IMAGE_LEN " + (dataUrl ? dataUrl.length : 0));

// 发给后端（带图片）
const t0 = Date.now();
const reply = await js(`(function(){
  return fetch('/api/chat', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    credentials:'same-origin',
    body: JSON.stringify({
      messages:[{role:'user',content:'这张图里有几行文字？把第一行原样念出来，不要解释。'}],
      language:'python', code:'',
      images:[${JSON.stringify(dataUrl)}]
    })
  }).then(async r => {
    const rd = r.body.getReader(); const dec = new TextDecoder();
    let all = '';
    while(true){ const {done,value} = await rd.read(); if(done) break; all += dec.decode(value,{stream:true}); }
    return r.status + '||' + all;
  }).catch(e => 'ERR ' + e.message);
})()`, true);
const ms = Date.now() - t0;
const raw = String(reply || "");
const [status, body] = raw.split("||");
console.log("HTTP " + status + " 用时 " + ms + "ms");
console.log("原始流前 400 字: " + (body || "").slice(0, 400));

let text = "";
for (const line of (body || "").split("\n")) {
  if (line.startsWith("data: ")) {
    try { const o = JSON.parse(line.slice(6)); if (o.text) text += o.text; } catch { /* ignore */ }
  }
}
console.log("\n模型回复: " + text.replace(/\s+/g, " ").trim().slice(0, 300));
const ok = status === "200" && text.length > 0;
const sawSelect = /SELECT/i.test(text);
console.log("\n结果: " + (ok ? "PASS 图片识别链路可用" : "FAIL 图片识别无回复"));
console.log("是否读出 SQL 关键字: " + (sawSelect ? "是" : "否（模型可能只描述图片）"));

ws.close();
chrome.kill();

// 移动端视口截图：用 CDP Emulation 模拟 iPhone 尺寸
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const [url, outPath, wArg, hArg, waitArg] = process.argv.slice(2);
const W = Number(wArg || 390);
const H = Number(hArg || 844);
const waitMs = Number(waitArg || 6000);
const port = 9300 + Math.floor(Math.random() * 400);
const profile = path.join(os.tmpdir(), "cr-mshot-" + Date.now());
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=" + profile,
  "--remote-debugging-port=" + port,
  "about:blank",
], { stdio: "ignore" });

let target = null;
for (let i = 0; i < 60; i += 1) {
  await sleep(200);
  try {
    const list = await fetch("http://127.0.0.1:" + port + "/json/list").then((r) => r.json());
    target = list.find((t) => t.type === "page");
    if (target) break;
  } catch { /* retry */ }
}
if (!target) {
  console.error("no devtools target");
  chrome.kill();
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
};
function send(method, params) {
  const mid = ++id;
  return new Promise((resolve) => {
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
}

await send("Page.enable");
// 关键：模拟移动设备，含 deviceScaleFactor 与 mobile 标记
await send("Emulation.setDeviceMetricsOverride", {
  width: W, height: H, deviceScaleFactor: 1, mobile: false,
});
await send("Page.navigate", { url });
await sleep(waitMs);

// 需要登录态时：先调登录接口拿 cookie，再重新加载页面
if (process.env.LOGIN === "1") {
  const r = await send("Runtime.evaluate", {
    expression: `fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
      credentials:'same-origin',body:JSON.stringify({username:'testuser',password:'testpass'})})
      .then(r=>r.text())`,
    awaitPromise: true, returnByValue: true,
  });
  console.log("LOGIN " + (r.result && r.result.value));
  await send("Page.reload", { ignoreCache: true });
  // reload 后 emulation 可能被重置，重新声明一次，保证视口尺寸准确
  await send("Emulation.setDeviceMetricsOverride", {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(waitMs);
}

// 顺带把布局关键尺寸打出来，方便判断是否溢出
const probe = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    innerW: innerWidth,
    innerH: innerHeight,
    docW: document.documentElement.scrollWidth,
    docH: document.documentElement.scrollHeight,
    bodyOverflowX: getComputedStyle(document.body).overflowX,
    mainCols: getComputedStyle(document.querySelector('.main')||document.body).gridTemplateColumns,
    editorH: Math.round((document.querySelector('.editor-card')||{getBoundingClientRect:()=>({height:0})}).getBoundingClientRect().height),
    rightW: Math.round((document.querySelector('.right')||{getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width),
    rightH: Math.round((document.querySelector('.right')||{getBoundingClientRect:()=>({height:0})}).getBoundingClientRect().height)
  })`,
  returnByValue: true,
});
console.log("PROBE " + (probe.result && probe.result.value));

const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: !!process.env.FULL });
writeFileSync(outPath, Buffer.from(result.data, "base64"));
ws.close();
chrome.kill();
console.log("saved " + outPath);

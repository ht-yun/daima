// 代码雨效果图渲染：加载本地 render.html，按不同风格出图
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "./_preview/rain";
const OUT = ROOT;
mkdirSync(OUT, { recursive: true });

const port = 9760 + Math.floor(Math.random() * 90);
const profile = path.join(os.tmpdir(), "cr-rain-" + Date.now());
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1440;
const H = 900;

const JOBS = [
  { style: "A", base: "overview", file: "方案A-参考图还原" },
  { style: "B", base: "overview", file: "方案B-克制版" },
  { style: "C", base: "overview", file: "方案C-冷青版" },
  { style: "D", base: "overview", file: "方案D-细线流" },
  { style: "A", base: "desk", file: "方案A-审阅台效果" },
];

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--no-default-browser-check", "--disable-extensions", "--window-size=" + W + "," + H,
  "--allow-file-access-from-files",
  "--user-data-dir=" + profile, "--remote-debugging-port=" + port, "about:blank",
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
if (!target) { console.error("no devtools"); chrome.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pend = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
};
function send(method, params) {
  const i = ++id;
  return new Promise((r) => { pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

const js = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return "ERR " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};

for (const job of JOBS) {
  const url = "file:///" + ROOT.replace(/\\/g, "/") + "/render.html?style=" + job.style + "&base=" + job.base;
  await send("Page.navigate", { url });
  await sleep(700);

  let ok = false;
  for (let i = 0; i < 60; i += 1) {
    await sleep(200);
    const st = await js("(window.__ready===true) ? 'READY' : (window.__err || 'WAIT')");
    if (st === "READY") { ok = true; break; }
    if (typeof st === "string" && st.indexOf("IMG_LOAD_FAIL") === 0) { console.error("  底图加载失败"); break; }
  }
  if (!ok) { console.error("  渲染超时 " + job.file); continue; }

  const r = await send("Page.captureScreenshot", { format: "png" });
  const p = path.join(OUT, job.file + ".png");
  writeFileSync(p, Buffer.from(r.data, "base64"));
  console.log("  出图 " + job.file + ".png");
}

ws.close();
chrome.kill();
console.log("完成");
process.exit(0);

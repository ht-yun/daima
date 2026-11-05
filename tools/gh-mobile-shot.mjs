// 移动端（390x844）GitHub 导入面板截图 + 布局探针
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const URL_ = process.argv[2] || "http://127.0.0.1:8099/";
const OUT = "./_shots/github";
const port = 9500 + Math.floor(Math.random() * 200);
const profile = path.join(os.tmpdir(), "cr-ghm-" + Date.now());
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--no-default-browser-check", "--window-size=390,844",
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
if (!target) { console.error("no devtools target"); chrome.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
function send(method, params) {
  const mid = ++id;
  return new Promise((r) => { pending.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
}
async function js(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result?.value;
}
async function waitFor(expr, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await js(expr);
    if (v) return v;
    await sleep(250);
  }
  return null;
}
async function shot(name) {
  const s = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(path.join(OUT, name + ".png"), Buffer.from(s.data, "base64"));
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: URL_ });
await sleep(2500);

if (await waitFor("!!document.querySelector('.login-gate')", 6000)) {
  await js(`(() => {
    const [u, p] = document.querySelectorAll('.login-card input');
    const set = (el, v) => {
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(u, 'testuser'); set(p, 'testpass');
    [...document.querySelectorAll('.login-card button')].find(b => b.textContent.includes('进入')).click();
  })()`);
  await sleep(3000);
}

await js(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === '打开文件').click()`);
await sleep(500);
await js(`[...document.querySelectorAll('.ftab')].find(b => b.textContent.includes('GitHub')).click()`);
await sleep(300);
await js(`(() => {
  const el = document.querySelector('.gh-input');
  const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  s.call(el, 'https://github.com/psf/requests');
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await js("document.querySelector('.gh-row .primary').click()");
await waitFor("document.querySelectorAll('.gh-fitem').length > 0", 60000);
await sleep(500);

const probe = await js(`(() => {
  const m = document.querySelector('.filemodal').getBoundingClientRect();
  const list = document.querySelector('.filelist');
  return {
    vw: innerWidth, docW: document.documentElement.clientWidth,
    modalW: Math.round(m.width), modalH: Math.round(m.height),
    left: Math.round(m.left), right: Math.round(m.right),
    overflowX: list ? getComputedStyle(list).overflowX : '',
    items: document.querySelectorAll('.gh-fitem').length,
    scrollH: list ? list.scrollHeight : 0,
  };
})()`);
console.log("LAYOUT " + JSON.stringify(probe));
await shot("05-移动端列表");

ws.close();
chrome.kill();

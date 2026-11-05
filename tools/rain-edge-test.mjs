// 边界检查：浅色主题、手机宽度、设置面板开关是否真正生效
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const BASE = (process.argv[2] || "http://127.0.0.1:8099").replace(/\/+$/, "");
const port = 9980 + Math.floor(Math.random() * 15);
const profile = path.join(os.tmpdir(), "cr-edge-" + Date.now());
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--no-default-browser-check", "--disable-extensions", "--no-proxy-server",
  "--window-size=1440,900", "--user-data-dir=" + profile,
  "--remote-debugging-port=" + port, "about:blank",
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
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pend = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
};
const send = (method, params) => new Promise((r) => {
  const i = ++id;
  pend.set(i, r);
  ws.send(JSON.stringify({ id: i, method, params: params || {} }));
});
await send("Page.enable");
await send("Runtime.enable");
const js = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return "ERR " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
async function setView(w, h) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 768 });
}
async function boot(theme, prefs) {
  await setView(1440, 900);
  await send("Page.navigate", { url: BASE + "/" });
  await sleep(3500);
  if (await js("!!document.querySelector('.login-gate')")) {
    await js(`(function(){
      const g=document.querySelector('.login-gate'); const ins=g.querySelectorAll('input');
      const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      s.call(ins[0],'testuser'); ins[0].dispatchEvent(new Event('input',{bubbles:true}));
      s.call(ins[1],'testpass'); ins[1].dispatchEvent(new Event('input',{bubbles:true}));
      g.querySelector('button.primary').click(); return 'ok';
    })()`);
    await sleep(3000);
  }
  await js(`(function(){
    localStorage.setItem('cr-theme','${theme}');
    localStorage.setItem('cr-prefs', JSON.stringify(${JSON.stringify(prefs)}));
    location.reload(); return 'ok';
  })()`);
  await sleep(4500);
}

const out = [];
function log(name, ok, detail) {
  out.push({ name, ok, detail });
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + " :: " + detail);
}

// 1. 浅色主题不应有雨
await boot("light", { rain: true, rainLevel: 2 });
log("浅色主题不渲染代码雨", (await js("document.querySelectorAll('.rain-layer').length")) === 0,
  "canvas=" + (await js("document.querySelectorAll('.rain-layer').length")));
log("浅色主题不设 data-rain", (await js("document.documentElement.dataset.rain || '-'")) === "-",
  "data-rain=" + (await js("document.documentElement.dataset.rain || '-'")));

// 2. 深色 + 开启，应有雨
await boot("dark", { rain: true, rainLevel: 2 });
const darkCv = await js("document.querySelectorAll('.rain-layer').length");
log("深色主题渲染两层画布", darkCv === 2, "canvas=" + darkCv);
log("深色主题设置 data-rain=on", (await js("document.documentElement.dataset.rain")) === "on",
  "data-rain=" + (await js("document.documentElement.dataset.rain")));

// 3. 深色 + 关闭，不应有雨
await boot("dark", { rain: false, rainLevel: 2 });
log("关闭开关后雨消失", (await js("document.querySelectorAll('.rain-layer').length")) === 0,
  "canvas=" + (await js("document.querySelectorAll('.rain-layer').length")));
log("关闭后移除 data-rain", (await js("document.documentElement.dataset.rain || '-'")) === "-",
  "data-rain=" + (await js("document.documentElement.dataset.rain || '-'")));

// 4. 手机宽度 + 深色 + 开启，不应有雨
await boot("dark", { rain: true, rainLevel: 2 });
await setView(390, 844);
await sleep(1200);
await js("window.dispatchEvent(new Event('resize'))");
await sleep(600);
log("手机宽度(<768)不渲染雨", (await js("document.querySelectorAll('.rain-layer').length")) === 0,
  "canvas=" + (await js("document.querySelectorAll('.rain-layer').length")) + " w=" + (await js("window.innerWidth")));

// 5. 画布不挡点击
await setView(1440, 900);
await sleep(1000);
await js("window.dispatchEvent(new Event('resize'))");
await sleep(800);
const hit = await js(`(function(){
  const el = document.elementFromPoint(720, 450);
  return el ? (el.className || el.tagName) : 'null';
})()`);
log("雨不遮挡内容点击", !/rain/i.test(String(hit)), "点击命中=" + hit);

const pass = out.filter((o) => o.ok).length;
console.log("\n===== " + pass + "/" + out.length + " 通过 =====");
ws.close();
chrome.kill();
process.exit(pass === out.length ? 0 : 1);

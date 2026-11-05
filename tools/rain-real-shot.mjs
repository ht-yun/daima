// 真实组件截图：不注入任何东西，看 MatrixRain 的实际效果
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.argv[2] || "http://127.0.0.1:8099").replace(/\/+$/, "");
const OUT = process.argv[3] || "./_preview/rain-real";
mkdirSync(OUT, { recursive: true });

const port = 9900 + Math.floor(Math.random() * 80);
const profile = path.join(os.tmpdir(), "cr-real-" + Date.now());
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1440;
const H = 900;

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--no-default-browser-check", "--disable-extensions", "--no-proxy-server",
  "--window-size=" + W + "," + H,
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
async function waitFor(expr, t = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { if (await js(expr)) return true; await sleep(250); }
  return false;
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.data, "base64"));
  console.log("  出图 " + name + ".png");
}

console.log("目标 " + BASE);
await send("Page.navigate", { url: BASE + "/" });
await sleep(4000);

const needLogin = (await js("!!document.querySelector('.login-gate')")) === true;
console.log("  需要登录: " + needLogin);
if (needLogin) {
  await js(`(function(){
    const g=document.querySelector('.login-gate'); const ins=g.querySelectorAll('input');
    const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    s.call(ins[0],'testuser'); ins[0].dispatchEvent(new Event('input',{bubbles:true}));
    s.call(ins[1],'testpass'); ins[1].dispatchEvent(new Event('input',{bubbles:true}));
    g.querySelector('button.primary').click(); return 'ok';
  })()`);
  await waitFor("!!document.querySelector('.ov')", 15000);
}

// 直接设 localStorage 切深色，避免依赖设置面板的点击路径
await js(`(function(){ localStorage.removeItem('cr-prefs'); localStorage.setItem('cr-theme','dark'); location.reload(); return 'ok'; })()`);
await sleep(4500);
await waitFor("!!document.querySelector('.ov')", 15000);
await sleep(2500);

console.log("  data-theme=" + (await js("document.documentElement.dataset.theme")));
console.log("  data-rain=" + (await js("document.documentElement.dataset.rain")));
console.log("  canvas=" + (await js("document.querySelectorAll('.rain-layer').length")));
await shot("真实-概览-2档");

// 审阅台
await js(`(function(){const b=[...document.querySelectorAll('.navitem')].find(x=>/审阅台/.test(x.textContent)); if(b) b.click();})()`);
await sleep(3000);
await shot("真实-审阅台-2档");

// 设置面板（看新控件）
await js(`(function(){const b=[...document.querySelectorAll('.navitem')].find(x=>/设置/.test(x.textContent)); if(b) b.click();})()`);
await sleep(1200);
await shot("真实-设置面板");

// 切 1 档 / 3 档看差异
if (await js("!!document.querySelector('.rain-lv')")) {
  await js(`(function(){document.querySelector('.settings-head .icon-btn').click();})()`);
  await sleep(700);
  await js(`(function(){const b=[...document.querySelectorAll('.navitem')].find(x=>/概览/.test(x.textContent)); if(b) b.click();})()`);
  await sleep(1200);
  for (const [lv, name] of [[1, "真实-概览-1档"], [3, "真实-概览-3档"]]) {
    await js(`(function(){
      const raw = JSON.parse(localStorage.getItem('cr-prefs')||'{}');
      raw.rain = true; raw.rainLevel = ${lv};
      localStorage.setItem('cr-prefs', JSON.stringify(raw));
      location.reload(); return 'ok';
    })()`);
    await sleep(4500);
    await waitFor("!!document.querySelector('.ov')", 15000);
    await sleep(2200);
    await shot(name);
  }
}

ws.close();
chrome.kill();
console.log("完成");
process.exit(0);

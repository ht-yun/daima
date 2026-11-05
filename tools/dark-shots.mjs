// 抓取深色主题下的干净界面截图，用作代码雨效果图的底图
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const OUT = process.argv[3] || "./_shots/rain-base";
mkdirSync(OUT, { recursive: true });

const port = 9900 + Math.floor(Math.random() * 90);
const profile = path.join(os.tmpdir(), "cr-dk-" + Date.now());
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1440;
const H = 900;

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--no-default-browser-check", "--disable-extensions", "--window-size=" + W + "," + H,
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
  if (r.exceptionDetails) return "ERR";
  return r.result?.value;
};
async function waitFor(expr, t = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { if (await js(expr)) return true; await sleep(250); }
  return false;
}
async function shot(n) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  const p = path.join(OUT, n + ".png");
  writeFileSync(p, Buffer.from(r.data, "base64"));
  console.log("  截图 " + p);
}

console.log("目标 " + BASE);
await send("Page.navigate", { url: BASE + "/" });
await sleep(4500);

const needLogin = (await js("!!document.querySelector('.login-gate')")) === true;
if (needLogin) {
  console.log("  需要登录");
  await js(`(function(){
    const g=document.querySelector('.login-gate'); const ins=g.querySelectorAll('input');
    const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    s.call(ins[0],'testuser'); ins[0].dispatchEvent(new Event('input',{bubbles:true}));
    s.call(ins[1],'testpass'); ins[1].dispatchEvent(new Event('input',{bubbles:true}));
    g.querySelector('button.primary').click(); return 'ok';
  })()`);
  await waitFor("!!document.querySelector('.ov') || !!document.querySelector('.editor-card')", 15000);
}

// 切深色
console.log("  切换深色主题");
await js(`(function(){const b=document.querySelector('.navitem[title="设置"]'); if(b) b.click();})()`);
await sleep(900);
const opened = await js("!!document.querySelector('.theme-card')");
if (!opened) {
  await js(`(function(){const b=document.querySelector('.model-chip'); if(b) b.click();})()`);
  await sleep(900);
}
await js(`(function(){
  const c=[...document.querySelectorAll('.theme-card')];
  const d=c.find(x=>/深色/.test(x.textContent));
  if(d) d.click();
})()`);
await sleep(1000);
await js(`(function(){const b=document.querySelector('.settings-head .icon-btn'); if(b) b.click(); else document.querySelector('.modal-mask')?.click();})()`);
await sleep(700);

const th = await js("document.documentElement.dataset.theme");
console.log("  当前主题 " + th);

// 概览页
await js(`(function(){const b=[...document.querySelectorAll('.navitem')].find(x=>/概览/.test(x.textContent)); if(b) b.click();})()`);
await sleep(1200);
await shot("概览-深色-底图");

// 审阅台
await js(`(function(){const b=[...document.querySelectorAll('.navitem')].find(x=>/审阅台/.test(x.textContent)); if(b) b.click();})()`);
await sleep(2500);
await shot("审阅台-深色-底图");

ws.close();
chrome.kill();
console.log("完成");
process.exit(0);

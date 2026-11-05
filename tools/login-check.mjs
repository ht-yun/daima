// 桌面浏览器真实登录流程复现：加载 -> 填表单 -> 点「进入」-> 检查结果
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const URL_ = process.argv[2] || "http://127.0.0.1:8080/";
const OUT = process.argv[3] || "./_login-test.png";
const port = 9800 + Math.floor(Math.random() * 150);
const profile = path.join(os.tmpdir(), "cr-login-" + Date.now());
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--no-default-browser-check", "--disable-extensions",
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
if (!target) { console.error("no devtools target"); chrome.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const consoleLogs = [];
const netFails = [];

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
  if (msg.method === "Runtime.consoleAPICalled") {
    consoleLogs.push("[console." + msg.params.type + "] " + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    consoleLogs.push("[EXCEPTION] " + (d.exception?.description || d.text));
  }
  if (msg.method === "Network.loadingFailed") {
    netFails.push(msg.params.errorText + (msg.params.blockedReason ? " blocked=" + msg.params.blockedReason : ""));
  }
  if (msg.method === "Network.responseReceived") {
    const r = msg.params.response;
    if (r.status >= 400) netFails.push("HTTP " + r.status + " " + r.url);
  }
};
function send(method, params) {
  const mid = ++id;
  return new Promise((resolve) => { pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
}

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: URL_ });
await sleep(6000);

const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result?.value;
};

// 1. 页面当前状态
console.log("STATE1 " + await evalJs(`JSON.stringify({
  title: document.title,
  rootChildren: document.getElementById('root')?.children.length ?? -1,
  hasLoginGate: !!document.querySelector('.login-gate'),
  bodyText: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,160)
})`));

// 2. /api/auth 真实返回
console.log("AUTH " + await evalJs(`fetch('/api/auth').then(r=>r.text()).catch(e=>'ERR '+e.message)`));

// 3. 填表单并点击进入
const clicked = await evalJs(`(function(){
  const gate = document.querySelector('.login-gate');
  if (!gate) return 'NO_LOGIN_GATE';
  const inputs = gate.querySelectorAll('input');
  if (inputs.length < 2) return 'NO_INPUTS';
  function setVal(el, v){
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
  }
  setVal(inputs[0],'testuser');
  setVal(inputs[1],'testpass');
  const btn = gate.querySelector('button.primary');
  if(!btn) return 'NO_BUTTON';
  btn.click();
  return 'CLICKED';
})()`);
console.log("CLICK " + clicked);

await sleep(6000);

console.log("STATE2 " + await evalJs(`JSON.stringify({
  url: location.href,
  hasLoginGate: !!document.querySelector('.login-gate'),
  hasMain: !!document.querySelector('.main'),
  loginErr: (document.querySelector('.login-err')||{}).innerText || '',
  bodyText: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,160)
})`));

const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
writeFileSync(OUT, Buffer.from(shot.data, "base64"));

console.log("--- console 日志 ---");
console.log(consoleLogs.length ? consoleLogs.join("\n") : "(无)");
console.log("--- 网络失败 ---");
console.log(netFails.length ? netFails.join("\n") : "(无)");
console.log("saved " + OUT);

ws.close();
chrome.kill();

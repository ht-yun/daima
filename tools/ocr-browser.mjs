import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
const [url] = process.argv.slice(2);
const port = 9700 + Math.floor(Math.random() * 200);
const profile = path.join(os.tmpdir(), "cr-ocr2-" + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn("C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=" + profile, "--remote-debugging-port=" + port, "--window-size=1440,900", "about:blank",
], { stdio: "ignore" });
let target = null;
for (let i = 0; i < 60; i += 1) {
  await sleep(200);
  try {
    const list = await fetch("http://127.0.0.1:" + port + "/json/list").then((r) => r.json());
    target = list.find((t) => t.type === "page");
    if (target) break;
  } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params) => new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
const evalJs = async (expr, awaitPromise) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: !!awaitPromise, returnByValue: true });
  return r && r.result ? r.result.value : null;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url });
await sleep(7000);

const start = await evalJs(`(() => {
  const c = document.createElement('canvas'); c.width = 700; c.height = 240;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 700, 240);
  ctx.fillStyle = '#000000'; ctx.font = '32px monospace';
  ctx.fillText('SELECT * FROM users', 24, 70);
  ctx.fillText('WHERE id = 1', 24, 130);
  ctx.fillText('def login():', 24, 190);
  c.toBlob((blob) => {
    const file = new File([blob], 'shot.png', { type: 'image/png' });
    window.__chatImage(file);
  }, 'image/png');
  return typeof window.__chatImage;
})()`);
await sleep(3000);

let state = null;
for (let i = 0; i < 25; i += 1) {
  state = await evalJs(`({ value: document.querySelector('.chat-input textarea').value, hint: (document.querySelector('.chat-hint') || {}).textContent })`);
  if (state && state.hint && !state.hint.includes('正在识别')) break;
  await sleep(3000);
}
console.log(JSON.stringify({ start, state }));
ws.close(); chrome.kill();

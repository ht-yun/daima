import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const [url, out] = process.argv.slice(2);
const port = 9870 + Math.floor(Math.random() * 25);
const profile = path.join(os.tmpdir(), "cr-empty-" + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn("C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=" + profile, "--remote-debugging-port=" + port,
  "--window-size=1440,900", "--force-device-scale-factor=1", "about:blank",
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
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  return r && r.result ? r.result.value : null;
};
await send("Page.enable"); await send("Runtime.enable");
await send("Page.navigate", { url });
await sleep(6000);
await evalJs(`(() => {
  const setV = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const inputs = document.querySelectorAll('.login-card input');
  if (inputs.length >= 2) { setV(inputs[0], 'testuser'); setV(inputs[1], 'testpass'); document.querySelector('.login-card button').click(); }
  return 'ok';
})()`);
await sleep(12000);
await evalJs("(() => { const t = [...document.querySelectorAll('.tab')].find(x => x.textContent.includes('对比')); if (t) t.click(); return !!t; })()");
await sleep(900);
const text = await evalJs("(document.querySelector('.pane-empty') || {}).textContent || ''");
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log(JSON.stringify({ text: text.trim() }));
ws.close(); chrome.kill();

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const [url, out] = process.argv.slice(2);
const port = 9800 + Math.floor(Math.random() * 150);
const profile = path.join(os.tmpdir(), "cr-vis-" + Date.now());
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
await sleep(7000);

await evalJs(`(async () => {
  const c = document.createElement('canvas');
  c.width = 620; c.height = 240;
  const x = c.getContext('2d');
  x.fillStyle = '#101317'; x.fillRect(0, 0, 620, 240);
  x.font = '20px Consolas, monospace';
  x.fillStyle = '#E6EAF2';
  x.fillText('Traceback (most recent call last):', 18, 44);
  x.fillStyle = '#8A93A6';
  x.fillText('  File "login.py", line 19, in load_users', 18, 84);
  x.fillText('    result.append(query_user(i))', 18, 116);
  x.fillStyle = '#FF7A5C';
  x.fillText("NameError: name 'query_user' is not defined", 18, 158);
  x.fillStyle = '#4C8DFF';
  x.fillText('[error] 2026-11-02 16:40:12', 18, 202);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'traceback.png', { type: 'image/png' });
  await window.__pickImage(file);
  return 'picked';
})()`);
await sleep(1200);
await evalJs(`document.querySelector('.send-btn').click()`);
await sleep(22000);
await evalJs("(document.querySelector('.chat-list') || {}).scrollTop = 0");
await sleep(400);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log("saved");
ws.close(); chrome.kill();

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const [url, out, f1, f2] = process.argv.slice(2);
const port = 9950 + Math.floor(Math.random() * 40);
const profile = path.join(os.tmpdir(), "cr-file2-" + Date.now());
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
await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable");
await send("Page.navigate", { url });
await sleep(9000);

const clickOpen = "(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '打开文件'); if (b) b.click(); return !!b; })()";
await evalJs(clickOpen);
await sleep(700);

const doc = await send("DOM.getDocument", { depth: -1 });
const q = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: '.filemodal input[type="file"]' });
let setOk = false;
if (q && q.nodeId) {
  await send("DOM.setFileInputFiles", { nodeId: q.nodeId, files: [f1, f2] });
  setOk = true;
}
await sleep(3500);
await evalJs(clickOpen);
await sleep(700);
const count = await evalJs("document.querySelectorAll('.fitem').length");
const names = await evalJs("[...document.querySelectorAll('.fitem b')].map(x => x.textContent).join(',')");
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log(JSON.stringify({ setOk, count, names }));
ws.close(); chrome.kill();

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
const [url, waitArg] = process.argv.slice(2);
const waitMs = Number(waitArg || 12000);
const port = 9600 + Math.floor(Math.random() * 200);
const profile = path.join(os.tmpdir(), "cr-probe-" + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn("C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
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
if (!target) { console.log("{}"); chrome.kill(); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params) => new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
await send("Page.enable");
await send("Page.navigate", { url });
await sleep(waitMs);
const expr = `(() => {
  const out = {};
  const kw = document.querySelector('.hljs-keyword');
  const str = document.querySelector('.hljs-string');
  out.hljsKeyword = kw ? getComputedStyle(kw).color : null;
  out.hljsString = str ? getComputedStyle(str).color : null;
  const cm = document.querySelector('.cm-content');
  if (cm) {
    const spans = [...cm.querySelectorAll('span')].slice(0, 40);
    out.cmColors = [...new Set(spans.map((s) => getComputedStyle(s).color))].slice(0, 6);
  }
  const rootStyle = getComputedStyle(document.documentElement);
  out.varKw = rootStyle.getPropertyValue('--code-kw').trim();
  out.varStr = rootStyle.getPropertyValue('--code-str').trim();
  return out;
})()`;
const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
console.log(JSON.stringify(r.result && r.result.value ? r.result.value : r));
ws.close();
chrome.kill();

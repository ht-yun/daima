import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const [url, outPath, waitArg] = process.argv.slice(2);
const waitMs = Number(waitArg || 6000);
const port = 9300 + Math.floor(Math.random() * 400);
const profile = path.join(os.tmpdir(), "cr-cdp-" + Date.now());
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=" + profile,
  "--remote-debugging-port=" + port,
  "--window-size=1440,900", "--force-device-scale-factor=1",
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
if (!target) {
  console.error("no devtools target");
  chrome.kill();
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
};
function send(method, params) {
  const mid = ++id;
  return new Promise((resolve) => {
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
}

await send("Page.enable");
await send("Page.navigate", { url });
await sleep(waitMs);
const result = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(outPath, Buffer.from(result.data, "base64"));
ws.close();
chrome.kill();
console.log("saved " + outPath);

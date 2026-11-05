// GitHub 导入边界用例：blob 直达、错误地址提示、搜索空态、页签来回切换
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const URL_ = process.argv[2] || "http://127.0.0.1:8099/";
const SHOT_DIR = "./_shots/github";
const port = 9900 + Math.floor(Math.random() * 90);
const profile = path.join(os.tmpdir(), "cr-ghe-" + Date.now());
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOT_DIR, { recursive: true });

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--no-default-browser-check", "--disable-extensions", "--window-size=1600,1000",
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
if (!target) { console.error("no devtools target"); chrome.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") {
    errors.push("[EXCEPTION] " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
};
function send(method, params) {
  const mid = ++id;
  return new Promise((resolve) => { pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
}
async function js(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value;
}
async function waitFor(expr, ms = 15000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await js(expr);
    if (v) return v;
    await sleep(step);
  }
  return null;
}
async function shot(name) {
  const s = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(path.join(SHOT_DIR, name + ".png"), Buffer.from(s.data, "base64"));
}

const results = [];
function check(name, pass, extra = "") {
  results.push({ name, pass: !!pass });
  console.log((pass ? "PASS " : "FAIL ") + name + (extra ? "  — " + extra : ""));
}

async function setInput(sel, value) {
  await js(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    s.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: URL_ });
await sleep(2500);

if (await waitFor("!!document.querySelector('.login-gate')", 6000)) {
  await js(`(() => {
    const [u, p] = document.querySelectorAll('.login-card input');
    const set = (el, v) => {
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      s.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(u, 'testuser'); set(p, 'testpass');
    [...document.querySelectorAll('.login-card button')].find(b => b.textContent.includes('进入')).click();
  })()`);
  await sleep(3000);
}

async function openPicker() {
  await js(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === '打开文件').click()`);
  await sleep(500);
  await js(`[...document.querySelectorAll('.ftab')].find(b => b.textContent.includes('GitHub')).click()`);
  await sleep(300);
}

// ---- 1. 页签来回切换不丢状态 ----
await openPicker();
await setInput(".gh-input", "https://github.com/psf/requests");
await js(`[...document.querySelectorAll('.ftab')].find(b => b.textContent.includes('本地')).click()`);
await sleep(250);
await js(`[...document.querySelectorAll('.ftab')].find(b => b.textContent.includes('GitHub')).click()`);
await sleep(250);
const keptUrl = await js("(document.querySelector('.gh-input')||{}).value||''");
check("页签来回切换后地址仍保留", keptUrl.includes("psf/requests"), keptUrl);

// ---- 2. 非 GitHub 地址 ----
await js(`[...document.querySelectorAll('.ftab')].find(b => b.textContent.includes('GitHub')).click()`);
await sleep(250);
await setInput(".gh-input", "https://gitlab.com/a/b");
await js("document.querySelector('.gh-row .primary').click()");
const err1 = await waitFor("(document.querySelector('.gh-err')||{}).textContent||''", 20000);
check("拒绝非 github 地址", /github\.com/.test(String(err1)), String(err1).slice(0, 60));

// ---- 3. 不存在的仓库 ----
await setInput(".gh-input", "https://github.com/this-owner-does-not-exist-xyz/nope");
await js("document.querySelector('.gh-row .primary').click()");
const err2 = await waitFor("(document.querySelector('.gh-err')||{}).textContent||''", 30000);
check("不存在仓库给出提示", String(err2).length > 6, String(err2).slice(0, 70));
await shot("03-错误提示");

// ---- 4. blob 直达文件 ----
await setInput(".gh-input", "https://github.com/psf/requests/blob/main/setup.py");
await js("document.querySelector('.gh-row .primary').click()");
const closed = await waitFor("!document.querySelector('.filemodal')", 60000);
check("文件链接一步载入（跳过列表）", closed);
await sleep(1000);
const title = await js("(document.querySelector('.title-chip')||{}).innerText||''");
const body = await js("(document.querySelector('.cm-content')||{}).innerText||''");
check("编辑器换成 setup.py", /setup\.py/.test(title) && body.length > 100, title.trim().slice(0, 40) + " · " + body.length + " 字符");

// ---- 5. 搜索空态 ----
await openPicker();
await setInput(".gh-input", "https://github.com/psf/requests");
await js("document.querySelector('.gh-row .primary').click()");
await waitFor("document.querySelectorAll('.gh-fitem').length > 0", 60000);
await setInput(".gh-search", "zzz-not-exists-zzz");
await sleep(400);
const emptyText = await js("(document.querySelector('.filelist .pane-empty')||{}).innerText||''");
check("搜索无结果显示空态", /没有匹配/.test(emptyText), emptyText.replace(/\\n/g, " ").slice(0, 40));
await shot("04-搜索空态");

check("无 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));

const failed = results.filter((r) => !r.pass);
console.log("\n===== " + (results.length - failed.length) + "/" + results.length + " 通过 =====");
if (failed.length) console.log("失败：" + failed.map((f) => f.name).join("、"));

ws.close();
chrome.kill();
process.exit(failed.length ? 1 : 0);

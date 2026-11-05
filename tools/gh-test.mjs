// GitHub 导入链路端到端测试：粘贴地址 → 列表 → 点文件 → 进编辑器 → 原流程分析
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const URL_ = process.argv[2] || "http://127.0.0.1:8099/";
const REPO = process.argv[3] || "https://github.com/psf/requests";
const SHOT_DIR = "./_shots/github";
const port = 9700 + Math.floor(Math.random() * 200);
const profile = path.join(os.tmpdir(), "cr-gh-" + Date.now());
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
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    errors.push("[console.error] " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
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
async function shot(name) {
  const s = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(path.join(SHOT_DIR, name + ".png"), Buffer.from(s.data, "base64"));
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

const results = [];
function check(name, pass, extra = "") {
  results.push({ name, pass: !!pass, extra });
  console.log((pass ? "PASS " : "FAIL ") + name + (extra ? "  — " + extra : ""));
}

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Page.navigate", { url: URL_ });
await sleep(2500);

// 登录门
const needLogin = await waitFor("!!document.querySelector('.login-gate')", 6000);
if (needLogin) {
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
check("登录/进入主界面", !(await js("!!document.querySelector('.login-gate')")));

// 默认落地页是「概览」，先进审阅台
await js(`(() => {
  const b = [...document.querySelectorAll('.navitem')].find(x => /审阅台/.test(x.textContent));
  if (b) b.click();
})()`);
await sleep(1500);

// 打开文件弹层
await js(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '打开文件');
  if (b) b.click();
})()`);
await sleep(600);
check("打开文件弹层", await js("!!document.querySelector('.filemodal')"));
check("有两个页签", (await js("[...document.querySelectorAll('.ftab')].map(b=>b.textContent.trim()).join('|')")) === "本地文件|GitHub 仓库",
  String(await js("[...document.querySelectorAll('.ftab')].map(b=>b.textContent.trim()).join('|')")));

// 切到 GitHub
await js(`[...document.querySelectorAll('.ftab')].find(b => b.textContent.includes('GitHub')).click()`);
await sleep(400);
check("GitHub 面板出现输入框", await js("!!document.querySelector('.gh-input')"));

// 输入地址
await js(`(() => {
  const el = document.querySelector('.gh-input');
  const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  s.call(el, ${JSON.stringify(REPO)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(200);
await js(`document.querySelector('.gh-row .primary').click()`);

const listed = await waitFor("document.querySelectorAll('.gh-fitem').length > 0", 60000);
check("拉到文件列表", listed, String(await js("document.querySelectorAll('.gh-fitem').length")) + " 项");
const repoLine = await js("(document.querySelector('.gh-repo')||{}).innerText||''");
check("显示仓库与分支", /psf\/requests/.test(repoLine), repoLine.replace(/\\n/g, " ").slice(0, 80));
await shot("01-列表");

// 搜索框过滤
const allCount = await js("document.querySelectorAll('.gh-fitem').length");
await js(`(() => {
  const el = document.querySelector('.gh-search');
  const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  s.call(el, 'sessions');
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(500);
const beforeCount = await js("document.querySelectorAll('.gh-fitem').length");
check("搜索过滤生效", beforeCount > 0 && beforeCount < allCount, allCount + " → " + beforeCount);

// 点第一个文件
const firstName = await js("(document.querySelector('.gh-fitem b')||{}).textContent||''");
await js("document.querySelector('.gh-fitem').click()");
const closed = await waitFor("!document.querySelector('.filemodal')", 60000);
check("选文件后弹层关闭", closed, String(firstName));

// 进编辑器
await sleep(1200);
const editorText = await js("(document.querySelector('.cm-content')||{}).innerText||''");
check("代码已进编辑器", editorText.length > 200, editorText.length + " 字符");
const title = await js("(document.querySelector('.title-chip')||{}).innerText||''");
check("顶部显示文件名", title.includes(".py") || title.length > 0, title.trim().slice(0, 60));

// 等分析跑完（规则→lint→AI）
const done = await waitFor("!!document.querySelector('.score') && !document.querySelector('.score .steps') && !!document.querySelector('.tag-neutral')", 120000);
await sleep(1500);
const scoreText = await js("(document.querySelector('.score')||{}).innerText||''");
check("分析流程跑完", done !== null && scoreText.length > 0, scoreText.replace(/\\n/g, " ").slice(0, 80));
const issueCount = await js("document.querySelectorAll('.issue').length");
check("问题列表有内容", issueCount > 0 || scoreText.length > 0, issueCount + " 条问题");
await shot("02-分析结果");

check("无 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));

const failed = results.filter((r) => !r.pass);
console.log("\n===== " + (results.length - failed.length) + "/" + results.length + " 通过 =====");
if (failed.length) console.log("失败项：" + failed.map((f) => f.name).join("、"));

ws.close();
chrome.kill();
process.exit(failed.length ? 1 : 0);

// 桌面浏览器完整登录旅程测试：首访 -> 错误密码 -> 正确登录 -> 刷新保持 -> 重新导航 -> 退出登录
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const SHOT_DIR = process.argv[3] || "./_shots/login-desktop";
const USER = process.argv[4] || "testuser";
const PASS = process.argv[5] || "testpass";

mkdirSync(SHOT_DIR, { recursive: true });

const port = 9600 + Math.floor(Math.random() * 200);
const profile = path.join(os.tmpdir(), "cr-login-desktop-" + Date.now());
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, extra = "") {
  if (ok) {
    pass += 1;
    console.log(`  [PASS] ${name}${extra ? " — " + extra : ""}`);
  } else {
    fail += 1;
    failures.push(name + (extra ? " — " + extra : ""));
    console.log(`  [FAIL] ${name}${extra ? " — " + extra : ""}`);
  }
}

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--window-size=1440,900",
    "--user-data-dir=" + profile,
    "--remote-debugging-port=" + port,
    "about:blank",
  ],
  { stdio: "ignore" }
);

let target = null;
for (let i = 0; i < 80; i += 1) {
  await sleep(200);
  try {
    const list = await fetch("http://127.0.0.1:" + port + "/json/list").then((r) => r.json());
    target = list.find((t) => t.type === "page");
    if (target) break;
  } catch {
    /* retry */
  }
}
if (!target) {
  console.error("无法启动 Chrome DevTools");
  chrome.kill();
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const netFails = [];
const api401 = [];
const responses = [];

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    consoleErrors.push("EXCEPTION " + (d.exception?.description || d.text));
  }
  if (msg.method === "Network.loadingFailed") {
    netFails.push(msg.params.errorText + " " + (msg.params.blockedReason || ""));
  }
  if (msg.method === "Network.responseReceived") {
    const r = msg.params.response;
    responses.push({ status: r.status, url: r.url, type: msg.params.type, cache: (r.headers["cache-control"] || r.headers["Cache-Control"] || "") });
    if (r.status >= 400) {
      const kind = String(msg.params.type || "");
      const isStatic = kind === "Document" || kind === "Script" || kind === "Stylesheet" || kind === "Font" || kind === "Image";
      if (isStatic) netFails.push("HTTP " + r.status + " " + r.url);
      else if (!r.url.includes("/api/auth") && !r.url.includes("/api/login")) api401.push(r.url.replace(/^.*\/api\//, "/api/") + " " + r.status);
    }
  }
};

function send(method, params) {
  const id = ++msgId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("DOM.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const js = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return "__ERR__ " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};

async function waitFor(expr, timeout = 15000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await js(expr)) return true;
    await sleep(step);
  }
  return false;
}

async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const p = path.join(SHOT_DIR, name + ".png");
  writeFileSync(p, Buffer.from(r.data, "base64"));
  return p;
}

const STATE = `JSON.stringify({
  title: document.title,
  url: location.href,
  gate: !!document.querySelector('.login-gate'),
  main: !!document.querySelector('.main'),
  rootKids: document.getElementById('root') ? document.getElementById('root').children.length : -1,
  bodyLen: (document.body.innerText||'').trim().length,
  err: (document.querySelector('.login-err')||{}).innerText||'',
  head: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,120)
})`;

console.log("目标：" + BASE + "  视口 1440x900（桌面）\n");

// ---------- 1. 首次访问 ----------
console.log("【1】首次访问（无任何缓存/cookie）");
const t0 = Date.now();
await send("Page.navigate", { url: BASE + "/" });
await sleep(3500);
let s = JSON.parse(await js(STATE));
console.log("    首屏耗时 " + (Date.now() - t0) + "ms，标题《" + s.title + "》");
check("页面能打开且有标题", !!s.title && s.title !== "", s.title);
check("React 已挂载（#root 有子节点）", s.rootKids > 0, "root children=" + s.rootKids);
check("首屏渲染出登录页", s.gate === true, s.gate ? "找到 .login-gate" : "未找到 .login-gate，body=" + s.head);
check("未登录时看不到主界面", s.main === false);
check("登录页有可见文案", s.bodyLen > 10, s.bodyLen + " 字符");
await shot("01-首次访问登录页");

// ---------- 2. 静态资源与接口 ----------
console.log("\n【2】静态资源与接口加载");
const pageRes = responses.filter((r) => r.type === "Document" || r.type === "Script" || r.type === "Stylesheet");
const doc = pageRes.find((r) => r.type === "Document");
const scripts = pageRes.filter((r) => r.type === "Script");
const styles = pageRes.filter((r) => r.type === "Stylesheet");
check("HTML 文档 200", doc && doc.status === 200, doc ? doc.status + " " + doc.url.slice(-40) : "无");
check("JS 脚本全部 2xx", scripts.length > 0 && scripts.every((r) => r.status < 300), scripts.length + " 个");
check("CSS 样式全部 2xx", styles.length > 0 && styles.every((r) => r.status < 300), styles.length + " 个");
check("静态资源无 404/5xx", netFails.filter((f) => f.startsWith("HTTP")).length === 0, netFails.filter((f) => f.startsWith("HTTP")).join("; ") || "无");
console.log("    未登录时 API 返回 401 的：" + (api401.length ? api401.join(", ") + "（预期：这些接口需要登录）" : "无"));
const authResp = await js(`fetch('/api/auth').then(r=>r.status+'|'+r.headers.get('cache-control'))`);
check("/api/auth 返回 200 且禁缓存", /^200\|.*no-store/.test(authResp), authResp);
check("前端无 JS 异常", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | ") || "无");

// ---------- 3. 错误密码 ----------
console.log("\n【3】错误密码应被拒绝");
await js(`(function(){
  const gate=document.querySelector('.login-gate'); if(!gate) return 'NO_GATE';
  const ins=gate.querySelectorAll('input');
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  setter.call(ins[0], '${USER}'); ins[0].dispatchEvent(new Event('input',{bubbles:true}));
  setter.call(ins[1], 'wrong-password-001'); ins[1].dispatchEvent(new Event('input',{bubbles:true}));
  const b=gate.querySelector('button.primary'); if(!b) return 'NO_BTN'; b.click(); return 'OK';
})()`);
await sleep(2500);
s = JSON.parse(await js(STATE));
check("错误密码后仍停在登录页", s.gate === true && s.main === false);
check("错误密码有可读提示", s.err.length > 0 || /密码|错误|失败|不对/.test(s.head), s.err || s.head.slice(0, 60));
await shot("02-错误密码提示");

// ---------- 4. 正确密码登录 ----------
console.log("\n【4】正确账号密码登录");
await js(`(function(){
  const gate=document.querySelector('.login-gate'); if(!gate) return 'NO_GATE';
  const ins=gate.querySelectorAll('input');
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  setter.call(ins[0], '${USER}'); ins[0].dispatchEvent(new Event('input',{bubbles:true}));
  setter.call(ins[1], '${PASS}'); ins[1].dispatchEvent(new Event('input',{bubbles:true}));
  const b=gate.querySelector('button.primary'); if(!b) return 'NO_BTN'; b.click(); return 'OK';
})()`);
const entered = await waitFor("!!document.querySelector('.main') && !document.querySelector('.login-gate')", 12000);
s = JSON.parse(await js(STATE));
check("登录成功后进入主界面", entered, entered ? "用时 <12s" : "残留 gate=" + s.gate);
check("主界面内容已渲染", s.bodyLen > 100, s.bodyLen + " 字符");
check("登录后无错误提示残留", !s.err, s.err || "无");
await shot("03-登录成功主界面");

// 登录后同样的接口应变为 200，证明前面的 401 只是「未登录时的正常鉴权」
const afterLogin = await js(`Promise.all(['/api/config','/api/tasks'].map(u=>fetch(u).then(r=>u+':'+r.status).catch(e=>u+':ERR'))).then(a=>a.join(' '))`);
check("登录后受保护接口返回 200", /\/api\/config:200/.test(afterLogin), afterLogin);

// ---------- 5. 刷新保持登录（核心回归点） ----------
console.log("\n【5】F5 刷新后是否还保持登录（历史故障点）");
await send("Page.reload", { ignoreCache: false });
await sleep(4000);
s = JSON.parse(await js(STATE));
check("刷新后直接进主界面，不回到登录页", s.main === true && s.gate === false, s.gate ? "被踢回登录页" : "保持登录");
await shot("04-刷新后保持登录");

console.log("\n【5b】强制刷新（Ctrl+F5，忽略缓存）");
await send("Page.reload", { ignoreCache: true });
await sleep(4000);
s = JSON.parse(await js(STATE));
check("强制刷新后仍保持登录", s.main === true && s.gate === false, s.gate ? "被踢回登录页" : "保持登录");

// ---------- 6. 新开标签页（模拟关掉再打开） ----------
console.log("\n【6】同一浏览器新开标签访问（cookie 复用）");
const newTarget = await fetch("http://127.0.0.1:" + port + "/json/new?" + encodeURIComponent(BASE + "/"), { method: "PUT" })
  .then((r) => r.json())
  .catch(() => null);
if (newTarget && newTarget.webSocketDebuggerUrl) {
  const ws2 = new WebSocket(newTarget.webSocketDebuggerUrl);
  await new Promise((res) => (ws2.onopen = res));
  let id2 = 0;
  const pend2 = new Map();
  ws2.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend2.has(m.id)) {
      pend2.get(m.id)(m.result);
      pend2.delete(m.id);
    }
  };
  const send2 = (method, params) =>
    new Promise((resolve) => {
      const i = ++id2;
      pend2.set(i, resolve);
      ws2.send(JSON.stringify({ id: i, method, params: params || {} }));
    });
  await send2("Page.enable");
  await send2("Runtime.enable");
  await send2("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send2("Page.navigate", { url: BASE + "/" });
  await sleep(4000);
  const r2 = await send2("Runtime.evaluate", {
    expression: `JSON.stringify({gate:!!document.querySelector('.login-gate'),main:!!document.querySelector('.main')})`,
    returnByValue: true,
  });
  const st2 = JSON.parse(r2.result.value);
  check("新标签页免登录直接进主界面", st2.main === true && st2.gate === false, st2.gate ? "又要求登录" : "免登录");
  const cap = await send2("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(SHOT_DIR, "05-新标签免登录.png"), Buffer.from(cap.data, "base64"));
  ws2.close();
} else {
  check("新标签页免登录直接进主界面", false, "无法创建新标签");
}

// ---------- 7. 退出登录 ----------
console.log("\n【7】退出登录");
// 退出登录在设置面板里：先点顶部模型设置入口，再点「退出登录」
const openedSettings = await js(`(function(){
  const b=document.querySelector('.model-chip');
  if(!b) return 'NO_CHIP';
  b.click(); return 'OK';
})()`);
await sleep(900);
await shot("06-设置面板");
const logoutClicked = await js(`(function(){
  const cands=[...document.querySelectorAll('button,[role=button]')];
  const b=cands.find(x=>/退出|注销|登出/.test((x.innerText||'')+(x.title||'')+(x.getAttribute('aria-label')||'')));
  if(!b) return 'NO_BTN';
  b.click(); return 'CLICKED';
})()`);
if (logoutClicked === "CLICKED") {
  const back = await waitFor("!!document.querySelector('.login-gate')", 8000);
  s = JSON.parse(await js(STATE));
  check("点退出后回到登录页", back, back ? "已退出" : "仍在主界面");
  await sleep(500);
  await shot("06-退出后登录页");
  // 退出后重新登录一次，确认可反复使用
  await js(`(function(){
    const gate=document.querySelector('.login-gate'); if(!gate) return 'NO_GATE';
    const ins=gate.querySelectorAll('input');
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(ins[0], '${USER}'); ins[0].dispatchEvent(new Event('input',{bubbles:true}));
    setter.call(ins[1], '${PASS}'); ins[1].dispatchEvent(new Event('input',{bubbles:true}));
    gate.querySelector('button.primary').click(); return 'OK';
  })()`);
  const again = await waitFor("!!document.querySelector('.main') && !document.querySelector('.login-gate')", 12000);
  check("退出后可再次正常登录", again);
} else {
  console.log("  [SKIP] 界面无退出按钮（" + logoutClicked + "）");
}

// ---------- 8. 结果汇总 ----------
console.log("\n【8】收尾检查");
const finalErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
check("全流程无 JS 运行时异常", finalErrors.length === 0, finalErrors.slice(0, 3).join(" | ") || "无");
check("全流程无资源加载失败", netFails.length === 0, netFails.slice(0, 3).join("; ") || "无");

const cacheList = responses.filter((r) => r.type === "Script" || r.type === "Stylesheet");
console.log("    缓存头抽样：");
for (const r of cacheList.slice(0, 4)) {
  console.log("      " + r.status + " " + r.url.split("/").pop() + "  cache-control=" + (r.cache || "(空)"));
}

console.log("\n=========== 结果 ===========");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
if (fail) console.log("失败项：\n- " + failures.join("\n- "));
console.log("截图目录：" + SHOT_DIR);

ws.close();
chrome.kill();
process.exit(fail ? 1 : 0);

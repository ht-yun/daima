// 前端交互全量回归：真实点击每个功能入口，检查 DOM 结果
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const URL_ = process.argv[2] || "http://127.0.0.1:8080/";
const SHOT_DIR = process.argv[3] || "./_shots/ui";
const port = 9400 + Math.floor(Math.random() * 300);
const profile = path.join(os.tmpdir(), "cr-ui-" + Date.now());
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
const consoleErrors = [];
const netFails = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") {
    consoleErrors.push("[EXCEPTION] " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    consoleErrors.push("[console.error] " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
  if (m.method === "Network.loadingFailed") netFails.push(m.params.errorText + " " + (m.params.blockedReason || ""));
  if (m.method === "Network.responseReceived" && m.params.response.status >= 400) {
    const u = m.params.response.url;
    if (!u.includes("/api/config") && !u.includes("/api/lint") && !u.includes("/api/analyze")) {
      netFails.push("HTTP " + m.params.response.status + " " + u);
    }
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

const results = [];
let n = 0;
function rec(name, pass, detail) {
  n += 1;
  results.push({ id: "U" + String(n).padStart(2, "0"), name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] U${String(n).padStart(2, "0")} ${name} :: ${detail}`);
}

// 通用点击：按可见文本找最内层可点击元素
const CLICK_HELPER = `
window.__clickText = function(text, scope){
  const root = scope ? document.querySelector(scope) : document;
  if (!root) return 'NO_SCOPE';
  const all = Array.from(root.querySelectorAll('button, .tab, .fchip, .navitem, .ghost, .chip, span, div'));
  const hits = all.filter(el => (el.innerText || '').trim() === text);
  if (!hits.length) return 'NOT_FOUND';
  hits.sort((a,b) => b.querySelectorAll('*').length - a.querySelectorAll('*').length ? -1 : 1);
  const el = hits[0];
  el.click();
  return 'OK';
};
window.__clickPrefix = function(prefix, scope){
  const root = scope ? document.querySelector(scope) : document;
  if (!root) return 'NO_SCOPE';
  const all = Array.from(root.querySelectorAll('button, .tab, .fchip, .navitem, .ghost, .chip, span, div'));
  const hits = all.filter(el => (el.innerText || '').trim().startsWith(prefix));
  if (!hits.length) return 'NOT_FOUND';
  hits.sort((a,b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
  hits[0].click();
  return 'OK';
};
window.__visible = function(sel){
  const el = document.querySelector(sel);
  if (!el) return false;
  const s = getComputedStyle(el);
  return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null;
};
'ready'`;

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: URL_ });
await sleep(5500);
await js(CLICK_HELPER);

// ---------- 登录 ----------
{
  const state = await js(`JSON.stringify({ gate: !!document.querySelector('.login-gate'), root: document.getElementById('root').children.length })`);
  rec("页面加载出登录界面", JSON.parse(state).gate === true, state);
  const r = await js(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({username:'testuser',password:'testpass'})}).then(r=>r.status)`);
  rec("登录接口调用", r === 200, "status=" + r);
  await send("Page.reload", { ignoreCache: true });
  await sleep(6000);
  await js(CLICK_HELPER);
  const st = await js(`JSON.stringify({ gate: !!document.querySelector('.login-gate'), main: !!document.querySelector('.main') })`);
  rec("登录后进入主界面", JSON.parse(st).main === true, st);
  await shot("01-主界面");
  // v2 改造后默认落地页是「概览」，先进审阅台再做后续断言
  await js(`(function(){const b=[...document.querySelectorAll('.navitem')].find(x=>/审阅台/.test(x.textContent)); if(b) b.click(); return 'ok';})()`);
  await sleep(1600);
}

// ---------- 核心区域 ----------
{
  const info = await js(`JSON.stringify({
    sidebar: !!document.querySelector('.sidebar'),
    nav: Array.from(document.querySelectorAll('.sidebar .navlabel')).map(e=>e.innerText),
    topbar: !!document.querySelector('.topbar'),
    editor: !!document.querySelector('.editor-card'),
    right: !!document.querySelector('.right'),
    tabs: Array.from(document.querySelectorAll('.tab')).map(e=>e.innerText.replace(/\\s+/g,' ').trim()),
    buttons: Array.from(document.querySelectorAll('.editor-foot button, .toolbar button')).map(e=>e.innerText.trim()),
    langSel: !!document.querySelector('select'),
    cmLines: document.querySelectorAll('.cm-line').length
  })`);
  const o = JSON.parse(info);
  rec("布局区域齐全", o.sidebar && o.topbar && o.editor && o.right, `侧栏=${o.sidebar} 顶栏=${o.topbar} 编辑器=${o.editor} 右栏=${o.right}`);
  rec("左侧导航项完整", o.nav.length === 5, o.nav.join(" / "));
  rec("右侧标签页完整", o.tabs.length === 3, o.tabs.join(" / "));
  rec("编辑区按钮齐全", o.buttons.length >= 4, o.buttons.join(" / "));
  rec("代码编辑器已渲染", o.cmLines > 0, `行数=${o.cmLines}`);
  rec("语言下拉存在", o.langSel === true, String(o.langSel));
}

// ---------- 语言切换 ----------
{
  const before = await js(`document.querySelector('select').value`);
  const r = await js(`(function(){
    const s = document.querySelector('select');
    if(!s) return 'NO_SELECT';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
    setter.call(s,'javascript');
    s.dispatchEvent(new Event('change',{bubbles:true}));
    return s.value;
  })()`);
  await sleep(1500);
  const after = await js(`JSON.stringify({ value: document.querySelector('select').value, file: (document.querySelector('.title-chip')||{}).innerText||'', lines: document.querySelectorAll('.cm-line').length })`);
  const a = JSON.parse(after);
  rec("切换到 JavaScript", a.value === "javascript", `之前=${before} 现在=${a.value} 文件=${a.file.replace(/\s+/g,' ')} 行数=${a.lines}`);
  await js(`(function(){const s=document.querySelector('select');const setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;setter.call(s,'java');s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(1200);
  const jv = await js(`document.querySelector('select').value`);
  rec("切换到 Java", jv === "java", "value=" + jv);
  await js(`(function(){const s=document.querySelector('select');const setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;setter.call(s,'python');s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(1200);
}

// ---------- 示例 ----------
{
  const beforeLen = await js(`document.querySelector('.cm-content')?.innerText.length || 0`);
  const r = await js(`window.__clickText('示例', '.editor-foot')`);
  await sleep(1800);
  const afterLen = await js(`document.querySelector('.cm-content')?.innerText.length || 0`);
  rec("点击「示例」加载示例代码", r === "OK" && afterLen > 50, `点击=${r} 长度 ${beforeLen}→${afterLen}`);
  await shot("02-示例代码");
}

// ---------- 格式化 ----------
{
  const before = await js(`document.querySelector('.cm-content')?.innerText || ''`);
  const r = await js(`window.__clickText('格式化', '.editor-foot')`);
  // toast 只显示 2.2 秒，必须尽快轮询
  let toast = "";
  for (let i = 0; i < 10; i += 1) {
    await sleep(400);
    toast = await js(`(document.querySelector('.toast')||{}).innerText || ''`);
    if (toast) break;
  }
  const after = await js(`document.querySelector('.cm-content')?.innerText || ''`);
  rec("点击「格式化」有结果反馈", r === "OK" && toast.length > 0, `点击=${r} 提示="${toast.slice(0, 40)}" 内容变化=${before !== after}`);
}

// ---------- 代码检查 ----------
{
  const r = await js(`(function(){
    const btns = Array.from(document.querySelectorAll('.editor-foot button'));
    const b = btns.find(x => /开始检查|分析中/.test(x.innerText));
    if(!b) return 'NOT_FOUND';
    b.click(); return 'OK';
  })()`);
  rec("点击「开始检查」", r === "OK", "点击=" + r);
  let issues = 0;
  let waited = 0;
  for (let i = 0; i < 40; i += 1) {
    await sleep(2000);
    waited += 2;
    issues = await js(`document.querySelectorAll('.list .issue, .list .row, .list [class*="issue"]').length || 0`);
    const busy = await js(`!!document.querySelector('.steps')`);
    if (issues > 0 && !busy) break;
    if (waited >= 80) break;
  }
  const st = await js(`JSON.stringify({
    issues: document.querySelectorAll('.list .issue, .list .row, .list [class*="issue"]').length,
    banner: (document.querySelector('.banner')||{}).innerText||'',
    busy: !!document.querySelector('.steps'),
    hasScore: !!document.querySelector('.score')
  })`);
  const o = JSON.parse(st);
  rec("代码检查产出结果", o.issues > 0 || o.banner.length > 0, `${waited}s 问题数=${o.issues} 提示="${(o.banner||'').replace(/\s+/g,' ').slice(0,50)}" 评分区=${o.hasScore}`);
  await shot("03-检查结果");
}

// ---------- 标签页 ----------
{
  // 问题标签带计数（"问题 6"），用前缀匹配
  const r = await js(`window.__clickPrefix('问题', '.tabs-card')`);
  await sleep(1500);
  const ok = await js(`!!document.querySelector('.list')`);
  rec("切换到「问题」标签", r === "OK" && ok === true, `点击=${r} 渲染=${ok}`);
  await shot("04-tab-问题");
  for (const [tab, marker] of [["对比", ".diff, [class*='diff']"], ["对话", ".chat"]]) {
    const rr = await js(`window.__clickText('${tab}', '.tabs-card')`);
    await sleep(1500);
    const okk = await js(`!!document.querySelector("${marker}")`);
    rec(`切换到「${tab}」标签`, rr === "OK" && okk === true, `点击=${rr} 渲染=${okk}`);
    await shot("04-tab-" + tab);
  }
}

// ---------- 对话（AI） ----------
{
  await js(`window.__clickText('对话', '.tabs-card')`);
  await sleep(1200);
  // 该面板没有发送按钮，靠 Enter 提交
  const sent = await js(`(function(){
    const box = document.querySelector('.chat-input textarea');
    if(!box) return 'NO_INPUT';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    setter.call(box,'只回复两个字：正常');
    box.dispatchEvent(new Event('input',{bubbles:true}));
    box.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));
    return 'OK';
  })()`);
  let reply = "";
  let count = 0;
  for (let i = 0; i < 25; i += 1) {
    await sleep(2000);
    reply = await js(`Array.from(document.querySelectorAll('.chat-list .msg.assistant .bubble')).map(e=>e.innerText).join(' | ')`);
    count = await js(`document.querySelectorAll('.chat-list .msg').length`);
    if (reply && !reply.includes("正在思考")) break;
  }
  const userMsg = await js(`Array.from(document.querySelectorAll('.chat-list .msg.user .bubble')).map(e=>e.innerText).join(' ')`);
  rec("对话标签页发送消息并获得回复", sent === "OK" && reply.length > 0 && count >= 2,
    `发送=${sent} 消息数=${count} 我问="${userMsg.slice(0,20)}" 回复="${reply.replace(/\s+/g,' ').slice(0,60)}"`);
  await shot("05-对话");
}

// ---------- 侧栏导航 ----------
{
  for (const c of [
    { key: "档案库", probe: ".filemodal" },
  ]) {
    const r = await js(`window.__clickText('${c.key}', '.sidebar')`);
    await sleep(1500);
    const ok = await js(`!!document.querySelector("${c.probe}")`);
    rec(`侧栏「${c.key}」可打开`, r === "OK" && ok === true, `点击=${r} 弹层=${ok}`);
    await shot("06-nav-" + c.key);
    await js(`(function(){const m=document.querySelector('.modal-mask'); m&&m.click();})()`);
    await sleep(600);
  }
  // 评审报告已从侧栏移走，改走顶栏历史图标
  {
    const r = await js(`(function(){
      const b=document.querySelector('.topbar .icon-btn[title="历史记录"]')
        || [...document.querySelectorAll('.topbar button')].find(x=>/历史/.test(x.title||''));
      if(!b) return 'NOT_FOUND'; b.click(); return 'OK';
    })()`);
    await sleep(1500);
    const ok = await js(`!!document.querySelector('.taskmodal')`);
    rec("顶栏历史图标打开评审记录", r === "OK" && ok === true, `点击=${r} 弹层=${ok}`);
    await shot("06-nav-评审报告");
    await js(`(function(){const m=document.querySelector('.modal-mask'); m&&m.click();})()`);
    await sleep(600);
  }
  // 审阅台内的「规则」按钮
  const r2 = await js(`window.__clickText('规则', '.editor-foot')`);
  await sleep(1500);
  const rulesOk = await js(`!!document.querySelector('.rulesmodal')`);
  rec("审阅台「规则」可打开", r2 === "OK" && rulesOk === true, `点击=${r2} 弹层=${rulesOk}`);
  await shot("06-nav-规则");
  await js(`(function(){const b=document.querySelector('.rulesmodal .icon-btn'); b&&b.click();})()`);
  await sleep(600);
}

// ---------- 设置 ----------
{
  const r = await js(`(function(){
    const b=[...document.querySelectorAll('.navitem')].find(x=>/设置/.test(x.textContent));
    if(!b) return 'NOT_FOUND'; b.click(); return 'OK';
  })()`);
  await sleep(1800);
  const st = await js(`JSON.stringify({
    modal: !!document.querySelector('.modal, [class*="modal"], [class*="settings"]'),
    inputs: document.querySelectorAll('.modal input, [class*="modal"] input').length,
    text: (document.body.innerText||'').includes('模型')
  })`);
  const o = JSON.parse(st);
  rec("侧栏「设置」打开设置面板", r === "OK" && o.modal === true, `点击=${r} 弹层=${o.modal} 输入框=${o.inputs} 含模型字样=${o.text}`);
  await shot("07-设置");
  const closed = await js(`(function(){
    const btns = Array.from(document.querySelectorAll('button')).filter(b=>/关闭|取消|完成|保存|×/.test(b.innerText));
    if (btns.length) { btns[0].click(); return 'CLICKED'; }
    const x = document.querySelector('[class*="modal"] [class*="close"]');
    if (x) { x.click(); return 'CLICKED_X'; }
    return 'NO_CLOSE';
  })()`);
  await sleep(1200);
  const stillModal = await js(`window.__visible('.modal')`);
  rec("设置面板可关闭", closed !== "NO_CLOSE" && stillModal === false, `关闭方式=${closed} 仍可见=${stillModal}`);
}

// ---------- 清空 ----------
{
  const r = await js(`window.__clickText('清空', '.editor-foot')`);
  await sleep(1800);
  const len = await js(`document.querySelector('.cm-content')?.innerText.trim().length || 0`);
  rec("点击「清空」清空编辑器", r === "OK" && len < 5, `点击=${r} 剩余字符=${len}`);
  await shot("08-清空");
}

// ---------- 顶栏：历史记录 ----------
{
  const r = await js(`(function(){
    const btn = document.querySelector('.topbar button[title="历史记录"]');
    if(!btn) return 'NOT_FOUND';
    btn.click(); return 'OK';
  })()`);
  await sleep(1800);
  const visible = await js(`window.__visible('.taskmodal')`);
  const head = await js(`(document.querySelector('.taskmodal')||{}).innerText || ''`);
  rec("顶栏「历史记录」可打开", r === "OK" && visible === true,
    `点击=${r} 面板=${visible} 标题="${head.split("\n")[0] || ""}"`);
  await shot("09-历史记录");
  const closed = await js(`(function(){
    const x = document.querySelector('.taskmodal .icon-btn');
    if (x) { x.click(); return 'X_BUTTON'; }
    const b = Array.from(document.querySelectorAll('.taskmodal button')).find(e=>/关闭|取消/.test(e.innerText));
    if (b) { b.click(); return 'BUTTON'; }
    const m = document.querySelector('.modal-mask');
    if (m) { m.click(); return 'MASK'; }
    return 'NO_CLOSE';
  })()`);
  let gone = false;
  for (let i = 0; i < 8; i += 1) {
    await sleep(400);
    gone = (await js(`window.__visible('.taskmodal')`)) === false;
    if (gone) break;
  }
  rec("历史记录面板可关闭", closed !== "NO_CLOSE" && gone === true, `关闭=${closed} 已消失=${gone}`);
}

// ---------- 汇总 ----------
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log("\n================ 前端汇总 ================");
console.log(`总计 ${results.length} 项：通过 ${pass}，失败 ${fail}`);
if (fail) { console.log("失败项："); for (const r of results.filter((x) => !x.pass)) console.log(`  ${r.id} ${r.name} :: ${r.detail}`); }
console.log("console 错误：" + (consoleErrors.length ? consoleErrors.join(" | ") : "无"));
console.log("网络失败：" + (netFails.length ? netFails.slice(0, 6).join(" | ") : "无"));
console.log("JSON_RESULT " + JSON.stringify({ total: results.length, pass, fail, results, consoleErrors, netFails }));

ws.close();
chrome.kill();

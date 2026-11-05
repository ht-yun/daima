// 文件导入链路测试：模拟真实选择文件 -> ingest -> 载入编辑器
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const URL_ = process.argv[2] || "http://127.0.0.1:8080/";
const FILE = process.argv[3] || "./_test/sample_upload.py";
const port = 9500 + Math.floor(Math.random() * 200);
const profile = path.join(os.tmpdir(), "cr-file-" + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=" + profile, "--remote-debugging-port=" + port, "--window-size=1440,900", "about:blank",
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
if (!target) { console.error("no target"); chrome.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params) => new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
async function js(expression, awaitPromise = false) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description };
  return r.result?.value;
}
const rec = (name, pass, detail) => console.log(`[${pass ? "PASS" : "FAIL"}] ${name} :: ${detail}`);

await send("Page.enable");
await send("Runtime.enable");
await send("DOM.enable");
await send("Page.navigate", { url: URL_ });
await sleep(5000);

const login = await js(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({username:'testuser',password:'testpass'})}).then(r=>r.status)`, true);
rec("登录", login === 200, "status=" + login);
await send("Page.reload", { ignoreCache: true });
await sleep(5500);
// 默认落地页是「概览」，先进审阅台
await js(`(function(){const b=[...document.querySelectorAll('.navitem')].find(x=>/审阅台/.test(x.textContent)); if(b) b.click(); return 'ok';})()`, true);
await sleep(1600);

// 打开「打开文件」面板
const opened = await js(`(function(){
  const btns = Array.from(document.querySelectorAll('.editor-foot button'));
  const b = btns.find(x => x.innerText.trim() === '打开文件');
  if (!b) return 'NOT_FOUND';
  b.click(); return 'OK';
})()`);
await sleep(1500);
const modalVisible = await js(`!!document.querySelector('.filemodal')`);
rec("点击「打开文件」弹出选择面板", opened === "OK" && modalVisible === true, `点击=${opened} 面板=${modalVisible}`);

// 用 CDP 直接给 file input 塞文件
await send("DOM.getDocument", { depth: -1 });
const q = await send("DOM.querySelector", { nodeId: 1, selector: ".filemodal input[type=file]" });
if (!q || !q.nodeId) {
  rec("找到文件输入框", false, "未找到 input[type=file]");
} else {
  rec("找到文件输入框", true, "nodeId=" + q.nodeId);
  await send("DOM.setFileInputFiles", { nodeId: q.nodeId, files: [FILE] });
  await sleep(4000);
  const st = await js(`JSON.stringify({
    panelClosed: !document.querySelector('.filemodal'),
    cmLen: document.querySelector('.cm-content')?.innerText.length || 0,
    cmHasSql: (document.querySelector('.cm-content')?.innerText || '').includes('SELECT'),
    cmHasFunc: (document.querySelector('.cm-content')?.innerText || '').includes('get_user'),
    chip: (document.querySelector('.title-chip')||{}).innerText || ''
  })`);
  const o = JSON.parse(st);
  rec("导入后面板自动关闭", o.panelClosed === true, `仍打开=${!o.panelClosed}`);
  rec("文件内容载入编辑器", o.cmHasSql && o.cmHasFunc, `字符=${o.cmLen} 含SELECT=${o.cmHasSql} 含get_user=${o.cmHasFunc}`);
  rec("当前文件名正确", /sample_upload\.py/.test(o.chip), `标题="${(o.chip||'').replace(/\s+/g,' ')}"`);

  // 导入后会自动开始分析；若按钮已是「开始检查」则手动点一次
  const analyze = await js(`(function(){
    const btns = Array.from(document.querySelectorAll('.editor-foot button'));
    const b = btns.find(x=>/开始检查/.test(x.innerText));
    if(b){ b.click(); return 'CLICKED'; }
    if(btns.some(x=>/分析中/.test(x.innerText))) return 'AUTO_RUNNING';
    return 'NO_BTN:' + btns.map(x=>x.innerText.trim()).join('/');
  })()`);
  let issues = 0;
  let banner = "";
  let stillBusy = true;
  for (let i = 0; i < 30; i += 1) {
    await sleep(2000);
    issues = await js(`document.querySelectorAll('.list [class*="issue"]').length || 0`);
    banner = await js(`(document.querySelector('.banner')||{}).innerText || ''`);
    stillBusy = await js(`!!document.querySelector('.steps')`);
    if (issues > 0 && !stillBusy) break;
  }
  const okTrigger = analyze === "CLICKED" || analyze === "AUTO_RUNNING";
  rec("导入文件后自动分析并出结果", okTrigger && issues > 0,
    `触发=${analyze} 问题数=${issues} 仍在分析=${stillBusy} 提示="${(banner||'').replace(/\s+/g,' ').slice(0,40)}"`);
}

ws.close();
chrome.kill();

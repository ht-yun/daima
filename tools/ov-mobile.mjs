// 移动端（390×844）核查：概览页 + 审阅台 + 返回按钮
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.argv[2] || "http://127.0.0.1:8099").replace(/\/+$/, "");
const OUT = process.argv[3] || "./_shots/ov-mobile";
const W = Number(process.argv[4] || 390);
const H = Number(process.argv[5] || 844);
mkdirSync(OUT, { recursive: true });

const port = 9850 + Math.floor(Math.random() * 120);
const profile = path.join(os.tmpdir(), "cr-ovm-" + Date.now());
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const fails = [];
function check(n, ok, extra = "") {
  if (ok) {
    pass += 1;
    console.log(`  [PASS] ${n}${extra ? " — " + extra : ""}`);
  } else {
    fail += 1;
    fails.push(n + (extra ? " — " + extra : ""));
    console.log(`  [FAIL] ${n}${extra ? " — " + extra : ""}`);
  }
}

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--user-data-dir=" + profile, "--remote-debugging-port=" + port, "about:blank",
], { stdio: "ignore" });

let target = null;
for (let i = 0; i < 80; i += 1) {
  await sleep(200);
  try {
    const l = await fetch("http://127.0.0.1:" + port + "/json/list").then((r) => r.json());
    target = l.find((t) => t.type === "page");
    if (target) break;
  } catch { /* retry */ }
}
if (!target) { console.error("no devtools"); chrome.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pend = new Map();
const errs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
};
const send = (me, pa) => {
  const i = ++id;
  return new Promise((r) => { pend.set(i, r); ws.send(JSON.stringify({ id: i, method: me, params: pa || {} })); });
};
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: W, height: H, deviceScaleFactor: 2, mobile: true,
  screenWidth: W, screenHeight: H,
});
const js = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return "ERR";
  return r.result?.value;
};
async function waitFor(expr, t = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { if (await js(expr)) return true; await sleep(250); }
  return false;
}
async function shot(n) {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(path.join(OUT, n + ".png"), Buffer.from(r.data, "base64"));
  console.log("    截图 " + n + ".png");
}

console.log(`目标 ${BASE}  视口 ${W}×${H}\n`);
await send("Page.navigate", { url: BASE + "/" });
await sleep(4000);

const hasGate = await js("!!document.querySelector('.login-gate')");
if (hasGate) {
  await js(`(function(){
    const g=document.querySelector('.login-gate'); const ins=g.querySelectorAll('input');
    const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    s.call(ins[0],'testuser'); ins[0].dispatchEvent(new Event('input',{bubbles:true}));
    s.call(ins[1],'testpass'); ins[1].dispatchEvent(new Event('input',{bubbles:true}));
    g.querySelector('button.primary').click(); return 'ok';
  })()`);
  await waitFor("!!document.querySelector('.ov')", 12000);
}

const m = JSON.parse(await js(`JSON.stringify({
  ov: !!document.querySelector('.ov'),
  scrollW: document.documentElement.scrollWidth,
  clientW: document.documentElement.clientWidth,
  stats: document.querySelectorAll('.ov-stat').length,
  rows: getComputedStyle(document.querySelector('.ov-row2') || document.body).gridTemplateColumns,
  quickCols: getComputedStyle(document.querySelector('.ov-quick') || document.body).gridTemplateColumns
})`));
check("概览页渲染", m.ov);
check("没有横向溢出", m.scrollW <= m.clientW + 1, `内容宽 ${m.scrollW} / 视口 ${m.clientW}`);
check("统计卡在窄屏变两列", m.stats === 4, m.stats + " 张");
check("第二行改单列", !m.rows.includes(" "), m.rows || "");
await shot("01-概览-手机");

await js(`(function(){const b=document.querySelector('.ov-go'); if(b) b.click();})()`);
await waitFor("!!document.querySelector('.editor-card')", 8000);
await sleep(1200);
const d = JSON.parse(await js(`JSON.stringify({
  editor: !!document.querySelector('.editor-card'),
  back: !!document.querySelector('.ovback'),
  backVisible: (function(){const b=document.querySelector('.ovback'); return b ? getComputedStyle(b).display !== 'none' : false;})(),
  scrollW: document.documentElement.scrollWidth,
  clientW: document.documentElement.clientWidth
})`));
check("进入审阅台", d.editor);
check("窄屏出现返回概览按钮", d.back && d.backVisible, "display=" + d.backVisible);
check("审阅台无横向溢出", d.scrollW <= d.clientW + 1, `内容宽 ${d.scrollW} / 视口 ${d.clientW}`);
await shot("02-审阅台-手机");

await js(`(function(){const b=document.querySelector('.ovback'); if(b) b.click();})()`);
await sleep(1000);
check("返回按钮能回概览", await js("!!document.querySelector('.ov')"));
await shot("03-返回概览");

check("无 JS 异常", errs.length === 0, errs.slice(0, 2).join(" | ") || "无");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fails.length) console.log("失败：\n- " + fails.join("\n- "));

ws.close();
chrome.kill();
process.exit(fail ? 1 : 0);

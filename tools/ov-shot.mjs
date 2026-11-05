// 概览页改造后的界面核查：登录 -> 概览 -> 审阅台 -> 侧栏入口
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.argv[2] || "http://127.0.0.1:8099").replace(/\/+$/, "");
const OUT = process.argv[3] || "./_shots/overview";
mkdirSync(OUT, { recursive: true });

const port = 9700 + Math.floor(Math.random() * 150);
const profile = path.join(os.tmpdir(), "cr-ov-" + Date.now());
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const fails = [];
function check(name, ok, extra = "") {
  if (ok) {
    pass += 1;
    console.log(`  [PASS] ${name}${extra ? " — " + extra : ""}`);
  } else {
    fail += 1;
    fails.push(name + (extra ? " — " + extra : ""));
    console.log(`  [FAIL] ${name}${extra ? " — " + extra : ""}`);
  }
}

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--no-default-browser-check", "--disable-extensions", "--window-size=1440,900",
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
if (!target) { console.error("no devtools"); chrome.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pend = new Map();
const errs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") {
    errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    errs.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
  }
};
function send(method, params) {
  const i = ++id;
  return new Promise((r) => { pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
}

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const js = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return "ERR " + (r.exceptionDetails.exception?.description || "");
  return r.result?.value;
};
async function waitFor(expr, t = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { if (await js(expr)) return true; await sleep(250); }
  return false;
}
async function shot(n) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  const p = path.join(OUT, n + ".png");
  writeFileSync(p, Buffer.from(r.data, "base64"));
  console.log("    截图 " + p);
}

console.log("目标 " + BASE + "\n");
await send("Page.navigate", { url: BASE + "/" });
await sleep(4000);

// 登录
const needLogin = await waitFor("!!document.querySelector('.login-gate') || !!document.querySelector('.ov')", 12000) && (await js("!!document.querySelector('.login-gate')"));
if (needLogin) {
  await js(`(function(){
    const g=document.querySelector('.login-gate'); const ins=g.querySelectorAll('input');
    const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    s.call(ins[0],'testuser'); ins[0].dispatchEvent(new Event('input',{bubbles:true}));
    s.call(ins[1],'testpass'); ins[1].dispatchEvent(new Event('input',{bubbles:true}));
    g.querySelector('button.primary').click(); return 'ok';
  })()`);
  await waitFor("!!document.querySelector('.ov')", 12000);
}

console.log("【1】概览页");
const ov = JSON.parse(await js(`JSON.stringify({
  hasOv: !!document.querySelector('.ov'),
  stats: document.querySelectorAll('.ov-stat').length,
  radar: !!document.querySelector('.ov-radar polygon'),
  legend: document.querySelectorAll('.ov-legend span').length,
  quick: document.querySelectorAll('.ov-quick button').length,
  nav: [...document.querySelectorAll('.navitem .navlabel')].map(e=>e.textContent),
  activeNav: (document.querySelector('.navitem.on .navlabel')||{}).textContent,
  h1: (document.querySelector('.ov-hello h1')||{}).textContent,
  theme: document.documentElement.dataset.theme,
  bg: getComputedStyle(document.body).backgroundColor,
  accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
})`));
console.log("    导航：" + ov.nav.join(" / "));
check("概览页渲染", ov.hasOv, ov.h1 || "");
check("4 个统计卡", ov.stats === 4, ov.stats + " 个");
check("雷达图已绘制", ov.radar);
check("雷达 5 个维度图例", ov.legend === 5, ov.legend + " 个");
check("快捷入口 4 个", ov.quick === 4, ov.quick + " 个");
check("侧栏 5 项导航", ov.nav.length === 5, ov.nav.join("、"));
check("默认选中「概览」", (ov.activeNav || "").trim() === "概览", ov.activeNav);
check("默认浅色主题", ov.theme === "light", ov.theme + " bg=" + ov.bg);
check("主色为蓝色", ov.accent.toLowerCase() === "#2f6fba", ov.accent);
await shot("01-概览-浅色");

console.log("\n【2】进入审阅台");
await js(`(function(){const b=[...document.querySelectorAll('.ov-go')][0]; if(b){b.click(); return 'ok';} return 'no';})()`);
const deskOk = await waitFor("!!document.querySelector('.editor-card') && !document.querySelector('.ov')", 8000);
check("切到审阅台", deskOk);
const desk = JSON.parse(await js(`JSON.stringify({
  editor: !!document.querySelector('.editor-card'),
  code: !!document.querySelector('.cm-editor, .code, .editor-host'),
  score: !!document.querySelector('.score'),
  mainGrid: getComputedStyle(document.querySelector('.main')).display,
  activeNav: (document.querySelector('.navitem.on .navlabel')||{}).textContent
})`));
check("编辑器存在", desk.editor && desk.code);
check("风险报告存在", desk.score);
check("审阅台仍是左右分栏", desk.mainGrid === "grid", desk.mainGrid);
check("导航选中「审阅台」", (desk.activeNav || "").trim() === "审阅台", desk.activeNav);
await sleep(1500);
await shot("02-审阅台");

console.log("\n【3】侧栏入口");
await js(`(function(){const b=[...document.querySelectorAll('.navitem')].find(x=>/档案库/.test(x.textContent)); b&&b.click();})()`);
await sleep(700);
check("档案库打开导入弹层", await js("!!document.querySelector('.filemodal')"));
await shot("03-档案库");
await js(`(function(){const b=document.querySelector('.filemodal .icon-btn, .filemodal-head .icon-btn'); b&&b.click();})()`);
await sleep(400);

// 风险预警已从侧栏移走，改从概览预警卡片「去处理」进入
await js(`(function(){const b=[...document.querySelectorAll('.navitem')].find(x=>/概览/.test(x.textContent)); b&&b.click();})()`);
await sleep(900);
const goAlert = await js(`(function(){
  const box=document.querySelector('.ov-alert');
  if(!box || !box.classList.contains('on')) return 'NO_ALERT';
  const b=[...box.querySelectorAll('button')].find(x=>/去处理/.test(x.textContent));
  if(!b) return 'NO_BTN';
  b.click(); return 'OK';
})()`);
await sleep(900);
const alertView = JSON.parse(await js(`JSON.stringify({
  desk: !!document.querySelector('.editor-card'),
  tabIssues: !![...document.querySelectorAll('.tab')].find(t=>t.classList.contains('on') && /问题/.test(t.textContent))
})`));
check("概览预警「去处理」跳到审阅台问题页", goAlert === "OK" ? (alertView.desk && alertView.tabIssues) : true,
  goAlert === "NO_ALERT" ? "当前无预警（空态，跳过）" : goAlert + " desk=" + alertView.desk + " tab=" + alertView.tabIssues);
await shot("04-风险预警");

// 评审报告已从侧栏移走，改走顶栏历史图标
await js(`(function(){const b=document.querySelector('.topbar .icon-btn[title="历史记录"]') || [...document.querySelectorAll('.topbar button')].find(x=>/历史/.test(x.title||'')); b&&b.click();})()`);
await sleep(900);
check("顶栏历史图标打开评审记录", await js("!!document.querySelector('.taskmodal')"));
await shot("05-评审报告");
await js(`(function(){const b=document.querySelector('.modal-mask'); b&&b.click();})()`);
await sleep(400);

console.log("\n【4】深浅色切换");
await js(`(function(){const b=[...document.querySelectorAll('.navitem')].find(x=>/概览/.test(x.textContent)); b&&b.click();})()`);
await sleep(700);
const beforeTheme = await js("document.documentElement.dataset.theme");
await js(`(function(){
  const b=[...document.querySelectorAll('.navitem')].find(x=>/设置/.test(x.textContent));
  if(b) b.click();
})()`);
await sleep(600);
const themeBtns = await js(`[...document.querySelectorAll('.theme-card')].length`);
if (themeBtns >= 2) {
  await js(`(function(){const c=[...document.querySelectorAll('.theme-card')]; const d=c.find(x=>/深色/.test(x.textContent)); d&&d.click();})()`);
  await sleep(900);
  const nowDark = await js("document.documentElement.dataset.theme");
  check("可切到深色", nowDark === "dark", beforeTheme + " -> " + nowDark);
  await js(`(function(){const b=document.querySelector('.settings .icon-btn'); b&&b.click();})()`);
  await sleep(500);
  await shot("06-概览-深色");
} else {
  check("设置里能找到主题切换", false, "未找到 .theme-card");
}

console.log("\n【5】收尾");
check("无 JS 异常", errs.length === 0, errs.slice(0, 3).join(" | ") || "无");

console.log("\n=========== 结果 ===========");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
if (fails.length) console.log("失败：\n- " + fails.join("\n- "));
console.log("截图目录 " + OUT);

ws.close();
chrome.kill();
process.exit(fail ? 1 : 0);

// 代码雨提亮版预览：在真实页面里注入，截图即最终效果
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/+$/, "");
const OUT = process.argv[3] || "./_preview/rain-bright";
mkdirSync(OUT, { recursive: true });

const port = 9820 + Math.floor(Math.random() * 80);
const profile = path.join(os.tmpdir(), "cr-bright-" + Date.now());
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1440;
const H = 900;

// 三档提亮：L1 微亮 / L2 明显 / L3 强
const STYLES = [
  {
    id: "L1", name: "提亮1档-微亮", page: "overview",
    bg: "#06170E", card: "rgba(13,24,17,0.70)", card2: "rgba(11,20,15,0.70)",
    tint: [76, 240, 138], head: "#EDFFF5", glow: 14, sky: ["#0B2918", "#071710", "#03100A"],
    colStep: 13, fontSize: 12, trailMin: 18, trailMax: 48, speedMin: 90, speedMax: 260,
    strands: 140, bokeh: 62, charset: "kana", vignette: 0.22,
    fade: 1.30, bodyAlpha: 1.0,
  },
  {
    id: "L2", name: "提亮2档-明显", page: "overview",
    bg: "#071C11", card: "rgba(14,26,19,0.62)", card2: "rgba(12,22,16,0.62)",
    tint: [92, 255, 152], head: "#F2FFF8", glow: 16, sky: ["#0F3520", "#0A2016", "#05120C"],
    colStep: 13, fontSize: 12, trailMin: 22, trailMax: 56, speedMin: 90, speedMax: 260,
    strands: 170, bokeh: 80, charset: "kana", vignette: 0.14,
    fade: 1.05, bodyAlpha: 1.0,
  },
  {
    id: "L3", name: "提亮3档-强", page: "overview",
    bg: "#082315", card: "rgba(15,29,21,0.55)", card2: "rgba(13,25,18,0.55)",
    tint: [116, 255, 170], head: "#F7FFFB", glow: 18, sky: ["#144427", "#0C2A1B", "#07170F"],
    colStep: 13, fontSize: 12, trailMin: 26, trailMax: 64, speedMin: 90, speedMax: 260,
    strands: 200, bokeh: 96, charset: "kana", vignette: 0.08,
    fade: 0.85, bodyAlpha: 1.0,
  },
];

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--no-default-browser-check", "--disable-extensions", "--window-size=" + W + "," + H,
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
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
};
function send(method, params) {
  const i = ++id;
  return new Promise((r) => { pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

const js = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return "ERR " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
async function waitFor(expr, t = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { if (await js(expr)) return true; await sleep(250); }
  return false;
}

function injector(cfg) {
  return `(function(){
  const C = ${JSON.stringify(cfg)};
  document.querySelectorAll('#rain-canvas,#rain-style').forEach(function(e){ e.remove(); });

  const st = document.createElement('style');
  st.id = 'rain-style';
  st.textContent = [
    'body{background:' + C.bg + ' !important}',
    '[data-theme="dark"] .topbar{background:rgba(10,20,14,0.88) !important}',
    '[data-theme="dark"] .sidebar{background:rgba(10,20,14,0.86) !important}',
    '[data-theme="dark"] .main{background:rgba(9,18,13,0.30) !important}',
    '[data-theme="dark"] .card,[data-theme="dark"] .ov-card,',
    '[data-theme="dark"] .tabs-card,[data-theme="dark"] .ov-stats .ov-card{',
    'background:' + C.card + ' !important;backdrop-filter:none !important}',
    '[data-theme="dark"] .ov-quick button,[data-theme="dark"] .cb-body,',
    '[data-theme="dark"] .chart,[data-theme="dark"] .ov-ph{background:' + C.card2 + ' !important}',
    '[data-theme="dark"] .ov-alert.on{background:rgba(58,24,26,0.72) !important}',
    '#root{position:relative;z-index:1}'
  ].join('');
  document.head.appendChild(st);

  const cv = document.createElement('canvas');
  cv.id = 'rain-canvas';
  cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;display:block';
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = window.innerWidth, H = window.innerHeight;
  cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr);
  document.body.appendChild(cv);

  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);

  let _s = 20261105;
  function rnd(){ _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; }
  function rgba(c, a){ return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  const KANA = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0testuser9';

  function sky(){
    const g = ctx.createRadialGradient(W*0.5, -H*0.55, 40, W*0.5, H*0.30, W*1.05);
    g.addColorStop(0, C.sky[0]); g.addColorStop(0.44, C.sky[1]); g.addColorStop(1, C.sky[2]);
    ctx.fillStyle = g; ctx.fillRect(0,0,W,H);
  }

  function strands(){
    for (let i=0;i<C.strands;i+=1){
      const x = Math.round(rnd()*W)+0.5;
      const y0 = rnd()*H*1.3 - H*0.2;
      const len = 40 + rnd()*170;
      const a = 0.10 + rnd()*0.22;
      const g = ctx.createLinearGradient(0,y0,0,y0+len);
      g.addColorStop(0, rgba(C.tint,0));
      g.addColorStop(0.7, rgba(C.tint,a));
      g.addColorStop(1, rgba(C.tint,a*0.1));
      ctx.strokeStyle = g; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x,y0); ctx.lineTo(x,y0+len); ctx.stroke();
    }
  }

  function rain(){
    const chars = KANA;
    const cols = Math.ceil(W / C.colStep);
    ctx.font = C.fontSize + 'px "JetBrains Mono","Cascadia Code",Consolas,monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const stepY = C.fontSize * 1.3;
    for (let ci=0; ci<cols; ci+=1){
      const x = ci*C.colStep + C.colStep/2;
      const trail = Math.floor(C.trailMin + rnd()*(C.trailMax-C.trailMin));
      const speed = C.speedMin + rnd()*(C.speedMax-C.speedMin);
      const headY = rnd()*(H + trail*stepY) - speed*3;
      for (let k=0;k<trail;k+=1){
        const y = headY - k*stepY;
        if (y < -stepY || y > H+stepY) continue;
        const t = k/trail;
        const ch = chars[Math.floor(rnd()*chars.length)];
        if (k === 0){
          ctx.shadowColor = rgba(C.tint,0.95); ctx.shadowBlur = C.glow;
          ctx.fillStyle = C.head; ctx.fillText(ch,x,y); ctx.shadowBlur = 0;
        } else {
          ctx.fillStyle = rgba(C.tint, Math.pow(1-t, C.fade) * C.bodyAlpha);
          if (C.glow > 0 && k < 5){
            ctx.shadowColor = rgba(C.tint, 0.75*(1-t)); ctx.shadowBlur = C.glow*0.7;
            ctx.fillText(ch,x,y); ctx.shadowBlur = 0;
          } else ctx.fillText(ch,x,y);
        }
      }
    }
  }

  function bokeh(){
    for (let i=0;i<C.bokeh;i+=1){
      const x=rnd()*W, y=rnd()*H, r=0.6+rnd()*1.6;
      ctx.beginPath(); ctx.fillStyle='rgba(235,255,244,'+(0.35+rnd()*0.55)+')';
      ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
    }
  }

  function vignette(){
    const g = ctx.createRadialGradient(W*0.5,H*0.42,H*0.3,W*0.5,H*0.42,H*0.98);
    g.addColorStop(0,'rgba(0,0,0,0)'); g.addColorStop(1,'rgba(0,0,0,'+C.vignette+')');
    ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
  }

  sky(); rain(); strands(); bokeh(); vignette();
  window.__rainDone = true;
  return 'OK ' + W + 'x' + H;
})()`;
}

console.log("目标 " + BASE);
await send("Page.navigate", { url: BASE + "/" });
await sleep(4500);

const needLogin = (await js("!!document.querySelector('.login-gate')")) === true;
if (needLogin) {
  await js(`(function(){
    const g=document.querySelector('.login-gate'); const ins=g.querySelectorAll('input');
    const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    s.call(ins[0],'testuser'); ins[0].dispatchEvent(new Event('input',{bubbles:true}));
    s.call(ins[1],'testpass'); ins[1].dispatchEvent(new Event('input',{bubbles:true}));
    g.querySelector('button.primary').click(); return 'ok';
  })()`);
  await waitFor("!!document.querySelector('.ov')", 15000);
}

await js(`(function(){const b=document.querySelector('.navitem[title="设置"]'); if(b) b.click();})()`);
await sleep(900);
if (!(await js("!!document.querySelector('.theme-card')"))) {
  await js(`(function(){const b=document.querySelector('.model-chip'); if(b) b.click();})()`);
  await sleep(900);
}
await js(`(function(){const c=[...document.querySelectorAll('.theme-card')]; const d=c.find(x=>/深色/.test(x.textContent)); if(d) d.click();})()`);
await sleep(1000);
await js(`(function(){const b=document.querySelector('.settings-head .icon-btn'); if(b) b.click();})()`);
await sleep(800);

for (const cfg of STYLES) {
  await js(`(function(){const b=[...document.querySelectorAll('.navitem')].find(x=>/概览/.test(x.textContent)); if(b) b.click();})()`);
  await sleep(900);
  const r = await js(injector(cfg));
  await sleep(600);
  const shotRes = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(OUT, cfg.name + ".png"), Buffer.from(shotRes.data, "base64"));
  console.log("  出图 " + cfg.name + ".png  (" + r + ")");
}

// 审阅台：用 2 档再出一张，验证读代码场景
await js(`(function(){document.querySelectorAll('#rain-canvas,#rain-style').forEach(function(e){e.remove();})})()`);
await js(`(function(){const b=[...document.querySelectorAll('.navitem')].find(x=>/审阅台/.test(x.textContent)); if(b) b.click();})()`);
await sleep(2500);
{
  const cfg = Object.assign({}, STYLES[1], { name: "提亮2档-审阅台" });
  await js(injector(cfg));
  await sleep(600);
  const shotRes = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(OUT, "提亮2档-审阅台.png"), Buffer.from(shotRes.data, "base64"));
  console.log("  出图 提亮2档-审阅台.png");
}

ws.close();
chrome.kill();
console.log("完成");
process.exit(0);

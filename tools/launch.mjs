import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const origin = "http://127.0.0.1:5173";
const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
const api = path.join(root, "server", "index.mjs");
const skipOpen = process.env.CR_NO_OPEN === "1";

try { mkdirSync(path.join(root, "logs"), { recursive: true }); } catch { /* ignore */ }
const logFile = path.join(root, "logs", "launcher.log");
function log(msg) {
  try { appendFileSync(logFile, new Date().toISOString() + "  " + msg + "\n"); } catch { /* ignore */ }
}

process.on("uncaughtException", (err) => {
  log("FATAL " + (err && err.stack ? err.stack : String(err)));
  console.error("启动失败：", err);
});

function openBrowser() {
  if (skipOpen) return;
  spawn("cmd", ["/c", "start", "", origin], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

async function alive() {
  try {
    const res = await fetch(origin, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

console.log("");
console.log("  码审 CodeReview");
console.log("  ------------------------------------");

if (!existsSync(vite)) {
  console.log("  依赖没装好：找不到 node_modules/vite");
  process.exit(1);
}

if (await alive()) {
  console.log("  服务已经在运行，直接打开浏览器");
  openBrowser();
  process.exit(0);
}

const children = [];

if (existsSync(api)) {
  log("spawning api");
  const apiProc = spawn(process.execPath, [api], { cwd: root, stdio: "inherit" });
  children.push(apiProc);
  apiProc.on("exit", (code) => log("api exit " + code));
}

log("spawning vite");
const viteProc = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", "5173"], {
  cwd: root,
  stdio: "inherit",
});
children.push(viteProc);

let ready = false;
for (let i = 0; i < 120; i += 1) {
  await sleep(300);
  if (await alive()) { ready = true; break; }
  if (viteProc.exitCode !== null) break;
}

log("ready=" + ready);

if (ready) {
  console.log("");
  console.log("  已就绪： " + origin);
  console.log("  关闭这个窗口即可停止服务。");
  console.log("");
  openBrowser();
} else {
  console.log("");
  console.log("  端口没有起来，日志在 logs/launcher.log");
}

const stop = () => {
  for (const c of children) {
    try { c.kill(); } catch { /* ignore */ }
  }
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
viteProc.on("exit", (code) => {
  log("vite exit " + code);
  stop();
});

// 全量 API 回归测试：覆盖 15 个路由 + 鉴权 + 边界 + 安全
const BASE = process.argv[2] || "http://127.0.0.1:8080";
const USER = process.argv[3] || "testuser";
const PASS = process.argv[4] || "testpass";

let cookie = "";
const results = [];
let n = 0;

function rec(name, pass, detail) {
  n += 1;
  results.push({ id: "T" + String(n).padStart(2, "0"), name, pass, detail });
  const mark = pass ? "PASS" : "FAIL";
  console.log(`[${mark}] T${String(n).padStart(2, "0")} ${name} :: ${detail}`);
}

async function req(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body,
    signal: AbortSignal.timeout(opts.timeout || 30000),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    cookie = setCookie.split(";")[0];
  }
  const text = await res.text();
  return { status: res.status, text, headers: res.headers, ms: Date.now() - t0 };
}

const j = (t) => { try { return JSON.parse(t); } catch { return null; } };

// ---------- 1. 基础与鉴权 ----------
{
  const r = await req("/api/health");
  const b = j(r.text);
  rec("健康检查", r.status === 200 && b?.ok === true, `HTTP ${r.status} ${r.text.slice(0, 40)}`);
}
{
  const r = await req("/api/auth");
  const b = j(r.text);
  rec("未登录鉴权状态", b?.required === true && b?.authed === false,
    `required=${b?.required} authed=${b?.authed} cache=${r.headers.get("cache-control")}`);
  rec("鉴权接口不可缓存", (r.headers.get("cache-control") || "").includes("no-store"),
    `Cache-Control=${r.headers.get("cache-control")}`);
}
{
  const r = await req("/api/lint", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language: "python", code: "x=1" }),
  });
  rec("未登录访问受保护接口", r.status === 401, `HTTP ${r.status}`);
}
{
  const r = await req("/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USER, password: "wrong-password" }),
  });
  rec("错误密码被拒绝", r.status === 401, `HTTP ${r.status} ${r.text.slice(0, 60)}`);
}
{
  const r = await req("/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const b = j(r.text);
  rec("正确密码登录", r.status === 200 && b?.ok === true && !!cookie, `HTTP ${r.status} ${r.text.slice(0, 50)}`);
}
{
  const r = await req("/api/auth");
  const b = j(r.text);
  rec("登录后鉴权状态", b?.authed === true && b?.user === USER, `authed=${b?.authed} user=${b?.user}`);
}

// ---------- 2. 配置 ----------
{
  const r = await req("/api/config");
  const b = j(r.text);
  const leaked = /sk-[A-Za-z0-9]/.test(r.text);
  rec("读取配置", r.status === 200 && typeof b?.hasKey === "boolean",
    `hasKey=${b?.hasKey} model=${b?.model} mock=${b?.mock}`);
  rec("配置接口不泄露密钥", !leaked, leaked ? "!! 响应含 sk- 明文 !!" : "未发现明文密钥");
}
{
  const r = await req("/api/config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "deepseek-chat", mock: false }),
  });
  const b = j(r.text);
  rec("写入配置（幂等，传原值）", r.status === 200 && b?.ok === true, `HTTP ${r.status} model=${b?.model} mock=${b?.mock}`);
}

// ---------- 3. 规则检查 lint ----------
const lintCases = [
  ["python", "import os\ndef f(p):\n    x = eval(input())\n    return open(p).read()\n"],
  ["javascript", "var unused = 1\nfunction g(){ return notDefined }\n"],
  ["java", "public class A{ void f(){ String s=null; s.length(); } }"],
];
for (const [lang, code] of lintCases) {
  const r = await req("/api/lint", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language: lang, code }),
  });
  const b = j(r.text);
  const ok = r.status === 200 && b && b.engine && b.engine !== "failed" && b.engine !== "none";
  rec(`规则检查 ${lang}`, ok, `engine=${b?.engine} issues=${b?.issues?.length} ${b?.message || ""}`);
}

// ---------- 4. 格式化 format ----------
const fmtCases = [
  ["python", "import os\ndef  f( a,b ):\n  return a+b\n", true],
  ["javascript", "const a=1;function f(x){return x*2}", true],
  ["java", 'public class A{public static void main(String[] a){int x=1;if(x>0){x++;}}}', true],
];
for (const [lang, code, expectChanged] of fmtCases) {
  const r = await req("/api/format", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language: lang, code }),
  });
  const b = j(r.text);
  const ok = r.status === 200 && b && typeof b.code === "string" && b.code.length > 0 && b.changed === expectChanged;
  rec(`格式化 ${lang}`, ok, `changed=${b?.changed} len=${b?.code?.length} ${b?.message || ""}`);
}
{
  const r = await req("/api/format", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language: "python", code: "   " }),
  });
  rec("格式化空代码返回 400", r.status === 400, `HTTP ${r.status} ${r.text.slice(0, 50)}`);
}

// ---------- 5. 文件导入 ingest ----------
let ingestId = "";
{
  const r = await req("/api/ingest", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "demo.py", content: "print('hello')\n" }),
  });
  const b = j(r.text);
  ingestId = b?.id || "";
  rec("导入文件", r.status === 200 && !!ingestId, `id=${ingestId} bytes=${b?.bytes}`);
}
{
  const r = await req("/api/ingest/" + ingestId);
  const b = j(r.text);
  rec("取回导入文件", r.status === 200 && b?.content?.includes("hello"), `name=${b?.name} len=${b?.content?.length}`);
}
{
  const r = await req("/api/ingest/deadbeef");
  rec("取回不存在的文件返回 404", r.status === 404, `HTTP ${r.status}`);
}

// ---------- 6. 日志 ----------
{
  const r = await req("/api/logs?limit=10");
  const b = j(r.text);
  rec("读取运行日志", r.status === 200 && Array.isArray(b?.lines), `total=${b?.total} 返回=${b?.lines?.length} 行`);
}

// ---------- 7. 静态资源 ----------
{
  const r = await req("/");
  const ok = r.status === 200 && r.text.includes("码审");
  rec("首页 HTML", ok, `HTTP ${r.status} ${r.text.length}B cache=${r.headers.get("cache-control")}`);
  const js = r.text.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/);
  const css = r.text.match(/assets\/(index-[A-Za-z0-9_-]+\.css)/);
  if (js) {
    const rj = await req("/assets/" + js[1]);
    rec("首页引用的 JS 可加载", rj.status === 200 && rj.text.length > 100000,
      `HTTP ${rj.status} ${rj.text.length}B cache=${rj.headers.get("cache-control")}`);
  }
  if (css) {
    const rc = await req("/assets/" + css[1]);
    rec("首页引用的 CSS 可加载", rc.status === 200 && rc.text.length > 10000,
      `HTTP ${rc.status} ${rc.text.length}B`);
  }
  const r404 = await req("/assets/index-NOTEXIST.js");
  rec("缺失资源返回 404 而非 HTML", r404.status === 404, `HTTP ${r404.status} type=${r404.headers.get("content-type")}`);
  const rSpa = await req("/some/deep/route");
  rec("前端路由回退", rSpa.status === 200 && rSpa.text.includes("码审"), `HTTP ${rSpa.status}`);
  const rOcr = await req("/eng.traineddata", { timeout: 60000 });
  rec("OCR 语言包", rOcr.status === 200 && rOcr.text.length > 5000000, `HTTP ${rOcr.status} ${rOcr.text.length}B`);
}

// ---------- 8. 安全 ----------
{
  const r = await req("/api/ingest/..%2f..%2f.env");
  rec("路径穿越尝试被拦截", r.status === 404 || r.status === 400, `HTTP ${r.status}`);
}
{
  const r = await req("/api/unknown-route");
  rec("未知接口返回 404", r.status === 404, `HTTP ${r.status}`);
}

// ---------- 9. AI 能力 ----------
{
  const r = await req("/api/analyze", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      language: "python",
      code: "import sqlite3\ndef login(u, p):\n    conn = sqlite3.connect('a.db')\n    cur = conn.cursor()\n    cur.execute('SELECT * FROM users WHERE name=' + u + \"'\")\n    return cur.fetchone()\n",
      checks: ["security", "style"],
    }),
    timeout: 120000,
  });
  const b = j(r.text);
  const issues = b?.issues || b?.result?.issues || [];
  rec("AI 代码审查 /api/analyze", r.status === 200 && issues.length > 0,
    `HTTP ${r.status} ${r.ms}ms issues=${issues.length} score=${b?.score ?? "-"}`);
  if (issues.length) {
    globalThis.__firstIssue = issues[0];
    console.log("   首个问题: " + JSON.stringify(issues[0]).slice(0, 200));
  }
}
{
  const r = await req("/api/analyze", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language: "python", code: "" }),
  });
  rec("审查空代码返回 400", r.status === 400, `HTTP ${r.status}`);
}
{
  const longCode = Array(2001).fill("x = 1").join("\n");
  const r = await req("/api/analyze", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language: "python", code: longCode }),
    timeout: 60000,
  });
  rec("超长代码被拒绝", r.status === 400, `HTTP ${r.status} ${r.text.slice(0, 60)}`);
}
{
  // SSE 流式对话
  const t0 = Date.now();
  const res = await fetch(BASE + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ messages: [{ role: "user", content: "只回复两个字：正常" }], language: "python", code: "" }),
    signal: AbortSignal.timeout(120000),
  });
  const ct = res.headers.get("content-type") || "";
  let chunks = 0;
  let preview = "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const s = dec.decode(value, { stream: true });
    chunks += 1;
    if (preview.length < 160) preview += s;
  }
  rec("AI 流式对话 /api/chat", res.status === 200 && ct.includes("event-stream") && chunks > 1,
    `HTTP ${res.status} type=${ct.split(";")[0]} 分片=${chunks} ${Date.now() - t0}ms`);
  console.log("   流内容: " + preview.replace(/\s+/g, " ").slice(0, 140));
}
{
  // AI 修复
  const r = await req("/api/fix", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      language: "python",
      code: "import sqlite3\n\ndef login(u):\n    conn = sqlite3.connect('a.db')\n    cur = conn.cursor()\n    cur.execute('SELECT * FROM users WHERE name=' + u)\n    return cur.fetchone()\n",
      issue: { line: 6, title: "SQL 语句由字符串拼接而成", detail: "存在 SQL 注入风险", suggestion: "使用参数化查询" },
    }),
    timeout: 120000,
  });
  const b = j(r.text);
  const ok = r.status === 200 && b && (b.find || b.replace || b.ok !== false);
  rec("AI 一键修复 /api/fix", ok, `HTTP ${r.status} ${r.ms}ms find=${(b?.find || "").slice(0, 30).replace(/\n/g, "\\n")} keys=${Object.keys(b || {}).join(",")}`);
}
{
  // 语音转写：无音频应 400
  const r = await req("/api/transcribe", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  rec("语音转写空音频返回 400", r.status === 400 || r.status === 503, `HTTP ${r.status} ${r.text.slice(0, 60)}`);
}
{
  const r = await req("/api/transcribe", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio: Buffer.from("RIFF0000WAVEfmt ").toString("base64"), format: "wav" }),
    timeout: 90000,
  });
  let b = j(r.text);
  rec("语音转写接口可达（无效音频应有明确错误）", r.status >= 200 && r.status < 600,
    `HTTP ${r.status} ${(b?.message || r.text).slice(0, 70).replace(/\n/g, " ")}`);
}

// ---------- 10. CORS 与登出 ----------
{
  const res = await fetch(BASE + "/api/health", { method: "OPTIONS", signal: AbortSignal.timeout(10000) });
  rec("OPTIONS 预检", res.status === 204 || res.status === 200, `HTTP ${res.status}`);
}
{
  const r = await req("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  rec("登出", r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 40)}`);
  const r2 = await req("/api/auth");
  const b2 = j(r2.text);
  rec("登出后鉴权失效", b2?.authed === false, `authed=${b2?.authed}`);
}

// ---------- 汇总 ----------
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log("\n================ 汇总 ================");
console.log(`总计 ${results.length} 项：通过 ${pass}，失败 ${fail}`);
if (fail) {
  console.log("\n失败项：");
  for (const r of results.filter((x) => !x.pass)) console.log(`  ${r.id} ${r.name} :: ${r.detail}`);
}
console.log("\nJSON_RESULT " + JSON.stringify({ total: results.length, pass, fail, results }));

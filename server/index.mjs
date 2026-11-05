import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const envPath = path.join(root, ".env");

function readEnv() {
  const out = {};
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  for (const k of Object.keys(process.env)) {
    if (/^(MODEL_|MM_|APP_|PYTHON_BIN)/.test(k)) out[k] = process.env[k];
  }
  return out;
}

function getConfig() {
  const e = readEnv();
  return {
    baseUrl: e.MODEL_BASE_URL || "https://api.deepseek.com/v1",
    apiKey: e.MODEL_API_KEY || "",
    model: e.MODEL_NAME || "deepseek-chat",
    timeout: Number(e.MODEL_TIMEOUT_MS || 45000),
    temperature: Number(e.MODEL_TEMPERATURE || 0.1),
    mock: e.MODEL_MOCK === "1",
    port: Number(e.APP_PORT || 8787),
    mmBaseUrl: e.MM_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
    mmApiKey: e.MM_API_KEY || "",
    visionModel: e.MM_VISION_MODEL || "qwen3-vl-plus",
    audioModel: e.MM_AUDIO_MODEL || "qwen3.8-omni-flash",
    password: e.APP_PASSWORD || "",
  };
}

function saveConfig(patch) {
  const e = readEnv();
  const next = { ...e, ...patch };
  const order = [
    "MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_NAME", "MODEL_TIMEOUT_MS", "MODEL_TEMPERATURE", "MODEL_MOCK",
    "APP_PORT", "APP_PASSWORD",
    "MM_BASE_URL", "MM_API_KEY", "MM_VISION_MODEL", "MM_AUDIO_MODEL",
    "PYTHON_BIN",
  ];
  const seen = new Set();
  const lines = [];
  for (const k of order) {
    if (next[k] !== undefined) {
      lines.push(k + "=" + next[k]);
      seen.add(k);
    }
  }
  for (const k of Object.keys(next)) {
    if (!seen.has(k)) lines.push(k + "=" + next[k]);
  }
  writeFileSync(envPath, lines.join("\n") + "\n", "utf8");
}

const DIMS = ["security", "syntax", "logic", "performance", "style"];
const SEVS = ["high", "mid", "low"];

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    // API 一律不缓存。否则 /api/auth 返回的 authed:false 会被浏览器记住，
    // 表现为"输入密码登录成功后刷新，又回到登录页"。
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const SYSTEM_PROMPT = [
  "你是一名资深代码审查专家。用户会给你一段代码，你要找出真实存在的问题并给出修复后的完整代码。",
  "只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。",
  "JSON 结构：",
  "{",
  '  "summary": "一句话总结",',
  '  "issues": [{"line": 12, "dimension": "security|syntax|logic|performance|style", "severity": "high|mid|low", "title": "一句话问题", "detail": "为什么错", "suggestion": "怎么改"}],',
  '  "scores": {"before": {"security":0-100,"syntax":0-100,"logic":0-100,"performance":0-100,"style":0-100},',
  '             "after":  {"security":0-100,"syntax":0-100,"logic":0-100,"performance":0-100,"style":0-100}},',
  '  "fixedCode": "修复后的完整代码，可直接替换原文件",',
  '  "suggestions": ["进一步优化建议"]',
  "}",
  "要求：line 必须是原代码中真实存在的行号；issues 最多 12 条，按严重度排序；fixedCode 必须保留原有功能、语言与缩进风格。",
].join("\n");

// 大文件（几百行以上）如果还要求模型重写整段代码，输出必然被 max_tokens 截断，
// 拿到半截 JSON，表现为"模型输出不是合法 JSON"。这类文件改成只报问题。
const SYSTEM_PROMPT_NOFIX = SYSTEM_PROMPT
  .replace('"fixedCode": "修复后的完整代码，可直接替换原文件",', '"fixedCode": "",')
  + "\n这次不要重写代码：fixedCode 必须输出空字符串 \"\"，只把问题找准、说清楚。";

function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^\uFEFF/, "");
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function clampScore(n, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function normalize(raw, code, lang, opts) {
  const noFix = !!(opts && opts.noFix);
  const lines = String(code).split("\n").length;
  const issues = Array.isArray(raw.issues) ? raw.issues : [];
  const out = [];
  issues.slice(0, 12).forEach((it, i) => {
    const line = Math.max(1, Math.min(lines, Math.round(Number(it.line) || 1)));
    out.push({
      id: "ai" + i,
      line,
      dimension: DIMS.includes(it.dimension) ? it.dimension : "logic",
      severity: SEVS.includes(it.severity) ? it.severity : "mid",
      title: String(it.title || "发现问题").slice(0, 120),
      detail: String(it.detail || "").slice(0, 800),
      suggestion: String(it.suggestion || "").slice(0, 800),
      source: "ai",
    });
  });
  const b = raw.scores && raw.scores.before ? raw.scores.before : {};
  const a = raw.scores && raw.scores.after ? raw.scores.after : {};
  const before = {};
  const after = {};
  for (const d of DIMS) {
    before[d] = clampScore(b[d], 60);
    after[d] = clampScore(a[d], Math.min(100, before[d] + 20));
  }
  return {
    summary: String(raw.summary || "AI 已完成分析").slice(0, 200),
    issues: out,
    before,
    after,
    fixedCode: typeof raw.fixedCode === "string" && raw.fixedCode.trim()
      ? raw.fixedCode
      : (noFix ? "" : String(code)),
    suggestions: Array.isArray(raw.suggestions) ? raw.suggestions.slice(0, 6).map((x) => String(x).slice(0, 200)) : [],
    language: lang || "python",
  };
}

async function callModel(messages, cfg, attempt = 0) {
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
    body: JSON.stringify({ model: cfg.model, messages, temperature: cfg.temperature, max_tokens: 8000, stream: false }),
    signal: AbortSignal.timeout(cfg.timeout),
  });
  if (res.status === 429 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 2200 * (attempt + 1)));
    return callModel(messages, cfg, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error("模型返回 " + res.status + " " + text.slice(0, 200));
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";
  return {
    content: String(content || ""),
    usage: data.usage || null,
    finishReason: data && data.choices && data.choices[0] ? data.choices[0].finish_reason : null,
  };
}

const DEMO_LOGIN = {
  summary: "发现 8 个问题，其中 3 个高危，集中在 SQL 拼接、口令比对与密钥处理上。",
  issues: [
    { line: 7, dimension: "security", severity: "high", title: "SQL 由字符串拼接而成", detail: "username 直接拼进 SQL，攻击者构造 ' OR '1'='1 即可绕过登录。", suggestion: "改用参数化查询，把 username 作为参数传入。" },
    { line: 10, dimension: "security", severity: "high", title: "口令以明文直接比较", detail: "数据库里存明文口令，一旦库被拖走全部账号直接失守；比较也不是恒定时间。", suggestion: "存 salt+hash，用 hmac.compare_digest 或 bcrypt 校验。" },
    { line: 11, dimension: "security", severity: "high", title: "密钥从配置读取后写入 token", detail: "SECRET_KEY 被直接当会话令牌使用，且下一行还打印到日志。", suggestion: "改用签名后的 JWT，密钥只留在服务端且不进日志。" },
    { line: 4, dimension: "logic", severity: "mid", title: "可变默认参数会跨调用复用", detail: "默认值只在定义时求值一次，多次调用会共享同一对象。", suggestion: "默认写 None，函数体内再初始化。" },
    { line: 19, dimension: "performance", severity: "mid", title: "循环内逐条查询，典型 N+1", detail: "ids 有多少个就查多少次，1000 条就是 1000 次往返。", suggestion: "改成一次 IN 查询，循环外批量取回。" },
    { line: 19, dimension: "syntax", severity: "mid", title: "query_user 未定义", detail: "本文件里找不到这个函数，运行到这里会 NameError。", suggestion: "补上定义或 import，或改成批量查询。" },
    { line: 4, dimension: "syntax", severity: "low", title: "参数 role 声明后未使用", detail: "role 只出现在签名里，函数体没有用到。", suggestion: "删掉它，或补上真正的权限判断。" },
    { line: 12, dimension: "style", severity: "low", title: "调试输出残留并带出令牌", detail: "print 会把 token 写到标准输出，可能进日志系统。", suggestion: "删掉，或改用 logging 并脱敏。" },
  ],
  scores: {
    before: { security: 55, syntax: 77, logic: 92, performance: 92, style: 97 },
    after: { security: 88, syntax: 96, logic: 96, performance: 90, style: 96 },
  },
  fixedCode: [
    "import hashlib",
    "import hmac",
    "import os",
    "import sqlite3",
    "",
    "DB_PATH = os.environ.get(\"DB_PATH\", \"app.db\")",
    "",
    "",
    "def verify_password(password, stored_hash):",
    "    digest = hashlib.sha256(password.encode(\"utf-8\")).hexdigest()",
    "    return hmac.compare_digest(digest, stored_hash)",
    "",
    "",
    "def login(username, password):",
    "    conn = sqlite3.connect(DB_PATH)",
    "    try:",
    "        cur = conn.cursor()",
    "        cur.execute(\"SELECT password_hash FROM users WHERE name = ?\", (username,))",
    "        row = cur.fetchone()",
    "        if not row:",
    "            return False",
    "        return verify_password(password, row[0])",
    "    finally:",
    "        conn.close()",
    "",
    "",
    "def load_users(conn, ids):",
    "    if not ids:",
    "        return []",
    "    placeholders = \",\".join(\"?\" for _ in ids)",
    "    cur = conn.execute(",
    "        \"SELECT id, name FROM users WHERE id IN (\" + placeholders + \")\",",
    "        tuple(ids),",
    "    )",
    "    return cur.fetchall()",
    "",
  ].join("\n"),
  suggestions: [
    "把连接管理收敛到统一的会话工厂，避免每处都手写 close。",
    "登录失败增加限流与审计日志，防止撞库。",
  ],
};

function demoAnalysis(sampleId) {
  if (sampleId === "login") return DEMO_LOGIN;
  return null;
}

// 解析可用的 Python 解释器：环境变量指定的绝对路径 -> PATH 中的 python / python3 / py
// 目的：避免 .env 里写死某台机器的绝对路径，换机后直接 ENOENT
let pythonCache;
function resolvePython() {
  if (pythonCache !== undefined) return pythonCache;
  const candidates = [];
  const configured = readEnv().PYTHON_BIN;
  if (configured) candidates.push(configured.trim());
  candidates.push("python", "python3", "py");
  for (const bin of candidates) {
    if (!bin) continue;
    // 绝对路径先判断文件是否存在，避免 spawn 抛 ENOENT 到调用方
    if (path.isAbsolute(bin) && !existsSync(bin)) continue;
    try {
      const r = spawnSync(bin, ["-c", "import sys;print(sys.version_info[0])"], { timeout: 8000, encoding: "utf8" });
      if (r.status === 0 && String(r.stdout).trim() === "3") {
        pythonCache = bin;
        return bin;
      }
    } catch {
      /* try next */
    }
  }
  pythonCache = null;
  return null;
}

function requirePython() {
  const py = resolvePython();
  if (!py) {
    throw new Error("服务器没有可用的 Python 3 运行时，已跳过 Python 相关处理（可在 .env 用 PYTHON_BIN 指定解释器路径）");
  }
  return py;
}

function runProc(bin, args, input, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error("lint timeout"));
    }, timeout);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out) reject(new Error(err || "exit " + code));
      else resolve(out);
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function lintPython(code) {
  const py = requirePython();
  const script = path.join(here, "lint_py.py");
  const raw = await runProc(py, [script], code, 15000);
  const data = JSON.parse(raw);
  return { engine: data.engine || "python-ast", issues: data.issues || [] };
}

let eslintLinter = null;
async function lintJs(code) {
  if (!eslintLinter) {
    let mod;
    try {
      mod = await import("eslint");
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (err && (err.code === "ERR_MODULE_NOT_FOUND" || /Cannot find package/i.test(msg))) {
        throw new Error("服务器缺少 eslint 依赖，JavaScript 规则检查不可用（npm install eslint）");
      }
      throw err;
    }
    const Linter = mod.Linter || (mod.default && mod.default.Linter);
    eslintLinter = new Linter();
  }
  const messages = eslintLinter.verify(code, {
    parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    env: { browser: true, es2022: true, node: true },
    rules: {
      "no-unused-vars": ["warn", { args: "none" }],
      "no-undef": "error",
      "no-unreachable": "error",
      indent: ["warn", 2],
    },
  });
  const issues = messages.slice(0, 12).map((m) => {
    const rule = m.ruleId || "JS-PARSE";
    let severity = "low";
    if (m.fatal) severity = "high";
    else if (rule === "indent" || rule === "no-undef") severity = "mid";
    const title = m.fatal
      ? "语法错误：" + m.message
      : rule === "indent"
        ? "缩进不一致"
        : rule === "no-unused-vars"
          ? "变量未使用"
          : rule === "no-undef"
            ? "使用了未定义的变量"
            : m.message;
    return { line: m.line || 1, dimension: "syntax", severity, title, detail: m.message, ruleId: rule };
  });
  return { engine: "eslint", issues };
}

function lintJava(code) {
  const lines = code.split("\n");
  const issues = [];
  let depth = 0;
  let badLine = 0;
  lines.forEach((l, i) => {
    const s = l.replace(/"(?:[^"\\]|\\.)*"/g, "").replace(/\/\/.*$/, "");
    for (const ch of s) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      if (depth < 0 && !badLine) badLine = i + 1;
    }
    if (depth < 0) depth = 0;
    const m = l.match(/^ +/);
    if (m && l.trim() && m[0].length % 4 !== 0 && issues.length < 6) {
      issues.push({ line: i + 1, dimension: "syntax", severity: "low", title: "缩进不是 4 的倍数", detail: "Java 惯例是 4 空格缩进", ruleId: "JAVA-INDENT" });
    }
  });
  if (depth !== 0) {
    issues.push({ line: badLine || lines.length, dimension: "syntax", severity: "high", title: "花括号不配对", detail: "还有 " + depth + " 个 { 没有闭合", ruleId: "JAVA-BRACE" });
  }
  return { engine: "heuristic", issues };
}

function parseUsers() {
  const raw = readEnv().APP_USERS || "";
  const map = new Map();
  for (const part of String(raw).split(/[,;\n]+/)) {
    const idx = part.indexOf(":");
    if (idx > 0) {
      const u = part.slice(0, idx).trim();
      const p = part.slice(idx + 1).trim();
      if (u && p) map.set(u, p);
    }
  }
  return map;
}

function tokenFor(user, pass) {
  return createHmac("sha256", "codereview-session").update(user + ":" + pass).digest("hex").slice(0, 40);
}

function currentUser(req) {
  const raw = readCookie(req, "cr");
  if (!raw) return null;
  const [user, token] = raw.split("|");
  if (!user || !token) return null;
  const pass = parseUsers().get(user);
  if (!pass) return null;
  return tokenFor(user, pass) === token ? user : null;
}

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  const hit = raw.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + "="));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : "";
}

const INGEST = new Map();
const LOG_DIR = path.join(root, "logs");
const LOG_FILE = path.join(LOG_DIR, "app.log");

function logEvent(event) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (statSync(LOG_FILE).size > 5 * 1024 * 1024) renameSync(LOG_FILE, LOG_FILE + ".1");
    } catch {
      /* ignore */
    }
    appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), ...event }) + "\n");
  } catch {
    /* ignore */
  }
}

async function formatPython(code) {
  const py = requirePython();
  try {
    const out = await runProc(py, ["-m", "black", "-q", "-"], code, 30000);
    return String(out);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/No module named|ModuleNotFoundError/i.test(msg) && /black/i.test(msg)) {
      throw new Error("服务器没有安装 black，Python 格式化不可用（pip install black）");
    }
    throw err;
  }
}

async function formatJs(code) {
  let mod;
  try {
    mod = await import("prettier");
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (err && (err.code === "ERR_MODULE_NOT_FOUND" || /Cannot find package/i.test(msg))) {
      throw new Error("服务器缺少 prettier 依赖，JavaScript 格式化不可用（npm install prettier）");
    }
    throw err;
  }
  const prettier = mod.default || mod;
  return await prettier.format(code, { parser: "babel", printWidth: 100, semi: true });
}

function formatJava(code) {
  // 轻量 Java 格式化：按 { } ; 重新断行并统一 4 空格缩进。
  // 会跳过字符串/字符字面量/注释，避免把 "a;b" 这类内容误切；
  // for(...) 头部圆括号内的分号不换行；数组初始化 {1,2} 保持内联。
  const src = String(code).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const INDENT = "    ";
  const out = [];
  let line = "";
  let depth = 0;
  let paren = 0;
  let newlineRun = 0;
  const braceStack = [];

  const push = (text) => { out.push(INDENT.repeat(Math.max(0, depth)) + text); };
  const flush = () => { const t = line.trim(); if (t) push(t); line = ""; newlineRun = 0; };
  const add = (s) => { line += s; newlineRun = 0; };

  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];

    if (c === '"' && src.startsWith('"""', i)) {
      let e = src.indexOf('"""', i + 3);
      e = e === -1 ? n : e + 3;
      add(src.slice(i, e));
      i = e;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) { j += 1; break; }
        if (src[j] === "\n") break;
        j += 1;
      }
      add(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      let e = src.indexOf("\n", i);
      if (e === -1) e = n;
      add(src.slice(i, e).replace(/\s+$/, ""));
      flush();
      i = e;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let e = src.indexOf("*/", i + 2);
      e = e === -1 ? n : e + 2;
      const block = src.slice(i, e);
      if (block.includes("\n")) {
        flush();
        for (const b of block.split("\n").map((s) => s.trim()).filter(Boolean)) push(b);
      } else if (line.trim() === "") {
        add(block);
        flush();
      } else {
        add(block);
      }
      i = e;
      continue;
    }
    if (c === "\n") {
      if (line.trim()) {
        flush();
        newlineRun = 0;
      } else {
        newlineRun += 1;
        if (newlineRun === 2 && out.length && out[out.length - 1] !== "") out.push("");
      }
      i += 1;
      continue;
    }
    if (c === " " || c === "\t") {
      if (line && !line.endsWith(" ")) line += " ";
      i += 1;
      continue;
    }
    if (c === "{") {
      const prev = line.replace(/\s+$/, "").slice(-1);
      const isExpr = prev === "=" || prev === "," || prev === "(" || prev === "[" || prev === "]";
      braceStack.push(isExpr);
      if (isExpr) {
        add("{");
      } else {
        line = line.replace(/\s+$/, "");
        add(" {");
        flush();
        depth += 1;
      }
      i += 1;
      continue;
    }
    if (c === "}") {
      const wasExpr = braceStack.length ? braceStack.pop() : false;
      if (wasExpr) { add("}"); i += 1; continue; }
      flush();
      depth = Math.max(0, depth - 1);
      const rest = src.slice(i + 1);
      const m = rest.match(/^[ \t]*(else|catch|finally|while)\b/);
      if (m) {
        line = "} " + m[1];
        newlineRun = 0;
        i = i + 1 + m[0].length;
        continue;
      }
      line = "}";
      flush();
      i += 1;
      continue;
    }
    if (c === ";") {
      add(";");
      if (paren === 0) flush();
      i += 1;
      continue;
    }
    if (c === "(") { paren += 1; add("("); i += 1; continue; }
    if (c === ")") { paren = Math.max(0, paren - 1); add(")"); i += 1; continue; }

    add(c);
    i += 1;
  }
  flush();
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/* ==================== GitHub 仓库导入 ==================== */
// 只做"取代码"这一件事：把 github.com 上的文件拉成纯文本，
// 之后仍然走原有流程（编辑器 → 规则扫描 → 模型分析）。

const GH_API = "https://api.github.com";
const GH_RAW = "https://raw.githubusercontent.com";
const GH_MAX_FILES = 800;
const GH_MAX_BYTES = 400 * 1024;
const GH_TREE_TTL = 5 * 60 * 1000;
const GH_CACHE = new Map();

// 本系统只对 python / javascript / java 三套规则做深度分析
const GH_CODE_EXT = new Set(["py", "js", "jsx", "mjs", "cjs", "ts", "tsx", "java"]);
const GH_TEXT_EXT = new Set([
  "go", "rs", "c", "h", "cc", "cpp", "hpp", "cs", "php", "rb", "kt", "kts", "swift", "scala",
  "sh", "bash", "ps1", "sql", "html", "htm", "css", "scss", "less", "vue", "svelte",
  "json", "yml", "yaml", "xml", "toml", "ini", "cfg", "conf", "md", "txt", "env",
]);
const GH_SKIP_DIRS = new Set([
  "node_modules", ".git", ".github", "dist", "build", "out", "vendor", "third_party",
  ".next", ".nuxt", ".svelte-kit", "target", "bin", "obj", "__pycache__", ".venv", "venv",
  "coverage", ".idea", ".vscode", "bower_components", "pods", ".gradle", "logs", "log",
  "test", "tests", "__tests__", "spec", "docs", "doc", "examples", "example", "demo",
]);

// 国内服务器常常连不上 raw/api，直连失败时自动套一层加速镜像。
// 可以在 .env 里用 GITHUB_PROXY=https://xxx/ 覆盖。
const GH_DEFAULT_PROXY = "https://gh-proxy.com/";
let ghCfgCache = { at: 0, token: "", proxy: "" };

function ghCfg() {
  if (Date.now() - ghCfgCache.at < 30000) return ghCfgCache;
  const e = readEnv();
  ghCfgCache = {
    at: Date.now(),
    token: String(process.env.GITHUB_TOKEN || e.GITHUB_TOKEN || "").trim(),
    proxy: String(process.env.GITHUB_PROXY || e.GITHUB_PROXY || "").trim(),
    forceProxy: String(process.env.GITHUB_FORCE_PROXY || e.GITHUB_FORCE_PROXY || "") === "1",
  };
  return ghCfgCache;
}

function ghToken() {
  return ghCfg().token;
}

function ghHeaders() {
  const h = {
    "User-Agent": "CodeReview/1.0",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const t = ghToken();
  if (t) h.Authorization = "Bearer " + t;
  return h;
}

// 直连不通才走镜像；返回 404/403 这类 HTTP 错误不重试（说明资源真的没有）
async function ghRequest(url, timeout = 12000) {
  const proxy = (ghCfg().proxy || GH_DEFAULT_PROXY).replace(/\/+$/, "") + "/";
  const attempts = [];
  if (!ghCfg().forceProxy) attempts.push({ url, ms: timeout });
  attempts.push({ url: proxy + url, ms: timeout + 10000 });
  let lastMsg = "";
  for (const a of attempts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), a.ms);
    try {
      const r = await fetch(a.url, { headers: ghHeaders(), signal: ctrl.signal, redirect: "follow" });
      clearTimeout(timer);
      return r;
    } catch (e) {
      clearTimeout(timer);
      lastMsg = e && e.name === "AbortError" ? "超时" : String((e && e.message) || e);
    }
  }
  const err = new Error("服务器连不上 GitHub（直连和镜像都失败）：" + lastMsg.slice(0, 80));
  err.status = 504;
  throw err;
}

async function ghFetchJSON(url, timeout = 15000) {
  const r = await ghRequest(url, timeout);
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(ghErrorText(r.status, text));
    err.status = r.status;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error("GitHub 返回了非 JSON 内容，可能是镜像异常");
    err.status = 502;
    throw err;
  }
}

function ghErrorText(status, body) {
  if (status === 404) return "仓库、分支或文件不存在（私有仓库需要在服务器 .env 配置 GITHUB_TOKEN）";
  if (status === 401) return "GITHUB_TOKEN 无效或已过期";
  if (status === 403) {
    const limited = /rate limit/i.test(String(body || ""));
    return limited ? "GitHub 接口限流了（匿名每小时 60 次），请稍后再试，或在 .env 配置 GITHUB_TOKEN" : "GitHub 拒绝访问（403）";
  }
  if (status === 451) return "该仓库因地区限制无法访问";
  return "GitHub 返回 " + status;
}

function parseGitHubUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) throw new Error("请先粘贴 GitHub 地址");
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) s = "https://github.com/" + s; // 支持 owner/repo 简写
  if (!/^[a-z]+:\/\//i.test(s)) s = "https://" + s;

  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error("地址格式不对，示例：https://github.com/owner/repo");
  }
  const host = u.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    throw new Error("只支持 github.com 的仓库地址");
  }
  const seg = u.pathname.split("/").filter(Boolean).map((x) => {
    try {
      return decodeURIComponent(x);
    } catch {
      return x;
    }
  });
  if (seg.length < 2) throw new Error("地址里缺少仓库名，示例：https://github.com/owner/repo");

  const owner = seg[0];
  const repo = seg[1].replace(/\.git$/i, "");
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new Error("仓库名不合法");

  let kind = "tree";
  let rest = [];
  const marker = (seg[2] || "").toLowerCase();
  if (marker === "tree") {
    kind = "tree";
    rest = seg.slice(3);
  } else if (marker === "blob" || marker === "raw") {
    kind = "file";
    rest = seg.slice(3);
  } else if (seg.length > 2) {
    throw new Error("看不懂这个地址，支持：仓库首页、/tree/分支/目录、/blob/分支/文件");
  }
  return { owner, repo, kind, rest };
}

// tree/blob 后面那段可能是 "分支/目录" 也可能是 "feature/xxx 分支/目录"，
// 从短到长试探，命中 /commits/{ref} 的那一段就是分支名。
async function ghResolveRef(owner, repo, rest) {
  const base = GH_API + "/repos/" + owner + "/" + repo;
  if (!rest.length) return null;

  const maxTry = Math.min(rest.length, 4);
  for (let n = 1; n <= maxTry; n += 1) {
    const cand = rest.slice(0, n).join("/");
    const url = base + "/commits/" + cand.split("/").map(encodeURIComponent).join("/");
    try {
      const commit = await ghFetchJSON(url);
      return { ref: cand, sha: commit.sha, rest: rest.slice(n) };
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  throw new Error("分支 " + rest[0] + " 不存在");
}

// 没指定分支时，用默认分支拿一个 tree sha（拿不到就直接把分支名当 tree-ish 用）
async function ghDefaultSha(owner, repo, branch) {
  try {
    const c = await ghFetchJSON(
      GH_API + "/repos/" + owner + "/" + repo + "/commits/" + String(branch).split("/").map(encodeURIComponent).join("/")
    );
    return c.sha || branch;
  } catch {
    return branch;
  }
}

function ghExt(p) {
  const base = String(p).split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

function ghSkipPath(p) {
  const parts = String(p).split("/");
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (GH_SKIP_DIRS.has(parts[i].toLowerCase())) return true;
  }
  const base = parts[parts.length - 1].toLowerCase();
  if (/^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|cargo\.lock|go\.sum|poetry\.lock)$/.test(base)) return true;
  return false;
}

function ghLanguageOf(p) {
  const e = ghExt(p);
  if (e === "java") return "java";
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(e)) return "javascript";
  return "python";
}

async function ghRepoInfo(owner, repo) {
  const info = await ghFetchJSON(GH_API + "/repos/" + owner + "/" + repo);
  return {
    owner: info.owner ? info.owner.login : owner,
    repo: info.name || repo,
    branch: info.default_branch || "main",
    private: !!info.private,
    stars: info.stargazers_count || 0,
    description: info.description || "",
    language: info.language || "",
    url: info.html_url || "https://github.com/" + owner + "/" + repo,
  };
}

async function ghListTree(owner, repo, ref, sha, subPath) {
  const key = owner + "/" + repo + "@" + sha + "@" + subPath;
  const hit = GH_CACHE.get(key);
  if (hit && Date.now() - hit.at < GH_TREE_TTL) return hit.data;

  const tree = await ghFetchJSON(
    GH_API + "/repos/" + owner + "/" + repo + "/git/trees/" + encodeURIComponent(sha) + "?recursive=1",
    20000
  );

  const prefix = subPath ? subPath.replace(/\/+$/, "") + "/" : "";
  const files = [];
  let skipped = 0;
  for (const node of tree.tree || []) {
    if (!node || node.type !== "blob") continue;
    const p = node.path;
    if (prefix && !p.startsWith(prefix)) continue;
    if (ghSkipPath(p)) { skipped += 1; continue; }
    const ext = ghExt(p);
    const kind = GH_CODE_EXT.has(ext) ? "code" : GH_TEXT_EXT.has(ext) ? "text" : "";
    if (!kind) { skipped += 1; continue; }
    if (typeof node.size === "number" && node.size > GH_MAX_BYTES) { skipped += 1; continue; }
    files.push({
      path: p,
      name: p.split("/").pop() || p,
      ext,
      kind,
      language: ghLanguageOf(p),
      size: node.size || 0,
      sha: node.sha,
    });
  }

  files.sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "code" ? -1 : 1));
  const data = {
    files: files.slice(0, GH_MAX_FILES),
    total: files.length,
    truncated: files.length > GH_MAX_FILES || !!tree.truncated,
    skipped,
    prefix,
  };
  GH_CACHE.set(key, { at: Date.now(), data });
  if (GH_CACHE.size > 60) {
    const oldest = [...GH_CACHE.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) GH_CACHE.delete(oldest[0]);
  }
  return data;
}

function ghDecodeBase64(b64) {
  return Buffer.from(String(b64 || "").replace(/\s/g, ""), "base64").toString("utf8");
}

async function ghReadFile(owner, repo, ref, filePath, blobSha) {
  const ext = ghExt(filePath);
  if (!GH_CODE_EXT.has(ext) && !GH_TEXT_EXT.has(ext)) throw new Error("这个文件不是文本代码，跳过");

  // 有 token 时走 API，私有仓库也能读；没有 token 先走 raw（不消耗匿名配额）
  if (!ghToken()) {
    try {
      const rawUrl =
        GH_RAW + "/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + "/" +
        String(ref || "HEAD").split("/").map(encodeURIComponent).join("/") + "/" +
        filePath.split("/").map(encodeURIComponent).join("/");
      const r = await ghRequest(rawUrl, 15000);
      if (r.ok) {
        const text = await r.text();
        if (Buffer.byteLength(text) <= GH_MAX_BYTES) {
          return { content: text, size: Buffer.byteLength(text) };
        }
      }
    } catch {
      /* 回退到 API */
    }
  }

  let data;
  try {
    const url = blobSha
      ? GH_API + "/repos/" + owner + "/" + repo + "/git/blobs/" + blobSha
      : GH_API + "/repos/" + owner + "/" + repo + "/contents/" +
        filePath.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(ref || "HEAD");
    data = await ghFetchJSON(url, 20000);
  } catch (e) {
    if (e && e.status === 404) {
      const err = new Error("文件不存在：" + filePath + "（分支 " + (ref || "默认") + "）");
      err.status = 404;
      throw err;
    }
    throw e;
  }
  if (data && data.encoding === "base64" && typeof data.content === "string") {
    const text = ghDecodeBase64(data.content);
    if (Buffer.byteLength(text) > GH_MAX_BYTES) throw new Error("文件超过 400KB，跳过");
    return { content: text, size: Buffer.byteLength(text) };
  }
  if (data && typeof data.content === "string") {
    return { content: ghDecodeBase64(data.content), size: data.size || 0 };
  }
  throw new Error("没能取到文件内容");
}

const server = createServer(async (req, res) => {
  const startedAt = Date.now();
  const url = new URL(req.url || "/", "http://localhost");
  const method = req.method || "GET";
  res.on("finish", () => {
    if (url.pathname.startsWith("/api/")) {
      logEvent({ path: url.pathname, method, status: res.statusCode, ms: Date.now() - startedAt });
    }
  });

  const users = parseUsers();
  const authRequired = users.size > 0;
  const sessionUser = currentUser(req);

  if (authRequired && url.pathname.startsWith("/api/") &&
      url.pathname !== "/api/health" && url.pathname !== "/api/login" && url.pathname !== "/api/auth") {
    if (!sessionUser) {
      json(res, 401, { code: "UNAUTHORIZED", message: "请先登录" });
      return;
    }
  }

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    res.end();
    return;
  }

  try {
    if (url.pathname === "/api/health") {
      json(res, 200, { ok: true, time: Date.now() });
      return;
    }

    if (url.pathname === "/api/config" && method === "GET") {
      const c = getConfig();
      json(res, 200, { hasKey: Boolean(c.apiKey), model: c.model, baseUrl: c.baseUrl, mock: c.mock || !c.apiKey });
      return;
    }

    if (url.pathname === "/api/config" && method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      const patch = {};
      if (typeof body.baseUrl === "string") patch.MODEL_BASE_URL = body.baseUrl.trim();
      if (typeof body.model === "string") patch.MODEL_NAME = body.model.trim();
      if (typeof body.apiKey === "string" && body.apiKey.trim()) patch.MODEL_API_KEY = body.apiKey.trim();
      if (typeof body.mock === "boolean") patch.MODEL_MOCK = body.mock ? "1" : "0";
      saveConfig(patch);
      const c = getConfig();
      json(res, 200, { ok: true, hasKey: Boolean(c.apiKey), model: c.model, mock: c.mock || !c.apiKey });
      return;
    }

    if (url.pathname === "/api/chat" && method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const cfg = getConfig();
      if (!cfg.apiKey || cfg.mock) {
        json(res, 503, { code: "NO_MODEL", message: "还没有配置模型" });
        return;
      }
      const history = Array.isArray(body.messages) ? body.messages.slice(-10) : [];
      const code = String(body.code || "").slice(0, 60000);
      const language = String(body.language || "python");
      const images = Array.isArray(body.images) ? body.images.filter((x) => typeof x === "string").slice(0, 3) : [];
      const lastUser = [...history].reverse().find((m) => m && m.role === "user");
      const lastText = String((lastUser && lastUser.content) || "");
      const sys =
        "你是资深代码审查助手。回答要简短、具体，能引用行号就引用；涉及修改时代码用 ```语言 包裹。不要客套。";
      const ctx = code
        ? "\n\n当前正在审查的代码（" + language + "）：\n```" + language + "\n" + code + "\n```"
        : "";
      const messages = [
        { role: "system", content: sys + ctx },
        ...history.map((m) => ({
          role: m && m.role === "assistant" ? "assistant" : "user",
          content: String((m && m.content) || "").slice(0, 4000),
        })),
      ];

      // 带图片：走千问视觉模型，一次性返回
      if (images.length && cfg.mmApiKey) {
        try {
          const parts = images.map((url) => ({ type: "image_url", image_url: { url } }));
          parts.push({ type: "text", text: (lastText || "看看这张图") + (code ? "\n\n（当前编辑器里的代码见上文）" : "") });
          const vr = await fetch(cfg.mmBaseUrl.replace(/\/+$/, "") + "/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.mmApiKey },
            body: JSON.stringify({ model: cfg.visionModel, messages: [{ role: "system", content: sys + ctx }, { role: "user", content: parts }], max_tokens: 1200 }),
            signal: AbortSignal.timeout(cfg.timeout),
          });
          const vj = await vr.json();
          const answer = vj && vj.choices && vj.choices[0] ? String(vj.choices[0].message.content || "") : "图片没有看明白：" + JSON.stringify(vj).slice(0, 160);
          res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
          res.write("data: " + JSON.stringify({ text: answer }) + "\n\n");
          res.write("data: " + JSON.stringify({ done: true }) + "\n\n");
          res.end();
          return;
        } catch (err) {
          res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
          res.write("data: " + JSON.stringify({ text: "看图失败：" + String(err && err.message ? err.message : err).slice(0, 120) }) + "\n\n");
          res.write("data: " + JSON.stringify({ done: true }) + "\n\n");
          res.end();
          return;
        }
      }

      let upstream;
      try {
        upstream = await fetch(cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
          body: JSON.stringify({ model: cfg.model, messages, temperature: cfg.temperature, stream: true }),
          signal: AbortSignal.timeout(cfg.timeout),
        });
      } catch (err) {
        json(res, 502, { code: "MODEL_FAILED", message: String(err && err.message ? err.message : err).slice(0, 200) });
        return;
      }
      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => "");
        json(res, 502, { code: "MODEL_FAILED", message: ("模型返回 " + upstream.status + " " + text).slice(0, 200) });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no",
      });

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buf += decoder.decode(chunk.value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() || "";
          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta ? parsed.choices[0].delta.content : "";
              if (delta) res.write("data: " + JSON.stringify({ text: delta }) + "\n\n");
            } catch {
              /* ignore keep-alive */
            }
          }
        }
      } catch (err) {
        res.write("data: " + JSON.stringify({ error: String(err && err.message ? err.message : err).slice(0, 200) }) + "\n\n");
      }
      res.write("data: " + JSON.stringify({ done: true }) + "\n\n");
      res.end();
      return;
    }

    if (url.pathname === "/api/auth" && method === "GET") {
      const us = parseUsers();
      const who = currentUser(req);
      json(res, 200, { required: us.size > 0, authed: us.size === 0 || Boolean(who), user: who || null });
      return;
    }

    if (url.pathname === "/api/login" && method === "POST") {
      const us = parseUsers();
      const body = JSON.parse((await readBody(req)) || "{}");
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      if (us.size === 0) {
        json(res, 200, { ok: true, user: "anonymous" });
        return;
      }
      const pass = us.get(username);
      if (!pass || pass !== password) {
        json(res, 401, { code: "BAD_CREDENTIALS", message: "账号或密码不对" });
        return;
      }
      const cookie = username + "|" + tokenFor(username, pass);
      res.setHeader("Set-Cookie", "cr=" + encodeURIComponent(cookie) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800");
      logEvent({ event: "login", user: username });
      json(res, 200, { ok: true, user: username });
      return;
    }

    if (url.pathname === "/api/logout" && method === "POST") {
      res.setHeader("Set-Cookie", "cr=; Path=/; HttpOnly; Max-Age=0");
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/logs" && method === "GET") {
      const limit = Math.min(500, Number(url.searchParams.get("limit") || 200));
      let lines = [];
      try {
        if (existsSync(LOG_FILE)) {
          const all = readFileSync(LOG_FILE, "utf8").trim().split("\n");
          lines = all.slice(-limit);
        }
      } catch {
        /* ignore */
      }
      json(res, 200, { file: "logs/app.log", lines, total: lines.length });
      return;
    }

    if (url.pathname === "/api/format" && method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const code = String(body.code || "");
      const language = String(body.language || "python");
      if (!code.trim()) {
        json(res, 400, { code: "EMPTY", message: "代码是空的" });
        return;
      }
      try {
        const t0 = Date.now();
        let formatted = code;
        if (language === "python") formatted = await formatPython(code);
        else if (language === "javascript") formatted = await formatJs(code);
        else formatted = formatJava(code);
        logEvent({ event: "format", language, ms: Date.now() - t0, changed: formatted !== code });
        json(res, 200, { code: formatted, changed: formatted !== code });
      } catch (err) {
        json(res, 502, { code: "FORMAT_FAILED", message: "格式化失败：" + String(err && err.message ? err.message : err).slice(0, 160) });
      }
      return;
    }

    if (url.pathname === "/api/fix" && method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const code = String(body.code || "");
      const language = String(body.language || "python");
      const issue = body.issue || {};
      const cfg = getConfig();
      if (!cfg.apiKey || cfg.mock) {
        json(res, 503, { code: "NO_MODEL", message: "还没有配置模型" });
        return;
      }
      const sys = "你是代码修复助手。只修用户指定的那一个问题，其余代码原样保留。只输出 JSON：{\"find\":\"原文片段\",\"replace\":\"替换后片段\"}。find 必须逐字符摘自原文（包含缩进）且在文件中唯一；replace 是替换后的片段，可以多行。不要输出解释。";
      const user = "语言：" + language + "\n问题：第 " + (issue.line || 0) + " 行 · " + String(issue.title || "") + "\n说明：" + String(issue.detail || "") + "\n建议：" + String(issue.suggestion || "") + "\n代码：\n" + code;
      let parsed = null;
      let lastError = "";
      for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
        try {
          const r = await callModel([
            { role: "system", content: sys },
            { role: "user", content: attempt === 0 ? user : user + "\n\n注意：只输出 JSON 对象。" },
          ], cfg);
          parsed = extractJson(r.content);
          if (!parsed) lastError = "模型没有返回合法 JSON";
        } catch (err) {
          lastError = String(err && err.message ? err.message : err);
        }
      }
      if (!parsed || typeof parsed.find !== "string" || typeof parsed.replace !== "string") {
        json(res, 502, { code: "FIX_FAILED", message: lastError || "模型没有给出可用的补丁" });
        return;
      }
      json(res, 200, { find: parsed.find, replace: parsed.replace });
      return;
    }

    if (url.pathname === "/api/github/tree" && method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        const p = parseGitHubUrl(body.url);
        const info = await ghRepoInfo(p.owner, p.repo);

        let ref = info.branch;
        let sha = "";
        let subPath = "";
        if (p.rest.length) {
          const r = await ghResolveRef(p.owner, p.repo, p.rest);
          ref = r.ref;
          sha = r.sha;
          subPath = r.rest.join("/");
        } else {
          sha = await ghDefaultSha(p.owner, p.repo, info.branch);
          if (p.kind === "file") {
            json(res, 400, { code: "NO_FILE", message: "这个地址没指向具体文件，请换一个文件链接" });
            return;
          }
        }

        const listed = await ghListTree(p.owner, p.repo, ref, sha, subPath);

        // 直接给了 /blob/ 文件链接：一步到位把内容也带回去
        if (p.kind === "file" && subPath) {
          const ext = ghExt(subPath);
          if (!GH_CODE_EXT.has(ext) && !GH_TEXT_EXT.has(ext)) {
            json(res, 400, { code: "NOT_TEXT", message: "这个文件不是文本代码" });
            return;
          }
          const node = listed.files.find((f) => f.path === subPath);
          const got = await ghReadFile(p.owner, p.repo, ref, subPath, node ? node.sha : "");
          logEvent({ event: "github", mode: "file", repo: p.owner + "/" + p.repo, path: subPath, bytes: got.size });
          json(res, 200, {
            mode: "file",
            repo: { ...info, ref, sha },
            file: {
              path: subPath,
              name: subPath.split("/").pop() || subPath,
              content: got.content,
              size: got.size,
              language: ghLanguageOf(subPath),
            },
          });
          return;
        }

        logEvent({ event: "github", mode: "tree", repo: p.owner + "/" + p.repo, branch: ref, files: listed.total });
        json(res, 200, {
          mode: "tree",
          repo: { ...info, ref, sha },
          path: subPath,
          files: listed.files,
          total: listed.total,
          truncated: listed.truncated,
          skipped: listed.skipped,
          token: !!ghToken(),
        });
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 220);
        const st = e && e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
        json(res, st === 504 ? 504 : st, { code: "GITHUB_FAILED", message: msg });
      }
      return;
    }

    if (url.pathname === "/api/github/file" && method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const owner = String(body.owner || "");
      const repo = String(body.repo || "");
      const ref = String(body.ref || "");
      const filePath = String(body.path || "");
      const blobSha = String(body.sha || "");
      if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo) || !filePath) {
        json(res, 400, { code: "BAD_ARGS", message: "参数不完整" });
        return;
      }
      if (filePath.startsWith("/") || filePath.includes("..")) {
        json(res, 400, { code: "BAD_PATH", message: "文件路径不合法" });
        return;
      }
      try {
        const got = await ghReadFile(owner, repo, ref, filePath, blobSha);
        if (!got.content.trim()) {
          json(res, 400, { code: "EMPTY", message: "这个文件是空的" });
          return;
        }
        logEvent({ event: "github", mode: "file", repo: owner + "/" + repo, path: filePath, bytes: got.size });
        json(res, 200, {
          path: filePath,
          name: filePath.split("/").pop() || filePath,
          content: got.content,
          size: got.size,
          language: ghLanguageOf(filePath),
        });
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 220);
        const st = e && e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
        json(res, st, { code: "GITHUB_FAILED", message: msg });
      }
      return;
    }

    if (url.pathname === "/api/ingest" && method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const content = String(body.content || "");
      if (!content.trim()) {
        json(res, 400, { code: "EMPTY", message: "文件是空的" });
        return;
      }
      const id = randomUUID().slice(0, 8);
      INGEST.set(id, { name: String(body.name || "导入文件"), content: content.slice(0, 400000), at: Date.now() });
      json(res, 200, { id, name: body.name || "导入文件", bytes: content.length });
      return;
    }

    if (url.pathname.startsWith("/api/ingest/") && method === "GET") {
      const id = url.pathname.split("/").pop();
      const item = INGEST.get(id);
      if (!item) {
        json(res, 404, { code: "NOT_FOUND", message: "文件已经过期，请重新拖一次" });
        return;
      }
      json(res, 200, item);
      return;
    }

    if (url.pathname === "/api/transcribe" && method === "POST") {
      const cfg = getConfig();
      if (!cfg.mmApiKey) {
        json(res, 503, { code: "NO_MM", message: "还没有配置语音模型" });
        return;
      }
      const body = JSON.parse((await readBody(req)) || "{}");
      const audio = String(body.audio || "");
      const format = String(body.format || "wav");
      if (!audio) {
        json(res, 400, { code: "EMPTY_AUDIO", message: "没有收到音频" });
        return;
      }
      const dataUrl = audio.startsWith("data:") ? audio : "data:audio/" + format + ";base64," + audio;
      try {
        const r = await fetch(cfg.mmBaseUrl.replace(/\/+$/, "") + "/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.mmApiKey },
          body: JSON.stringify({
            model: cfg.audioModel,
            messages: [{ role: "user", content: [
              { type: "input_audio", input_audio: { data: dataUrl, format } },
              { type: "text", text: "把这段音频逐字转写成文字，只输出转写结果，不要解释。" },
            ] }],
            max_tokens: 800,
          }),
          signal: AbortSignal.timeout(cfg.timeout),
        });
        const j = await r.json();
        const text = j && j.choices && j.choices[0] ? String(j.choices[0].message.content || "").trim() : "";
        if (!text) {
          json(res, 502, { code: "ASR_FAILED", message: "没有识别出内容：" + JSON.stringify(j).slice(0, 160) });
          return;
        }
        json(res, 200, { text });
      } catch (err) {
        json(res, 502, { code: "ASR_FAILED", message: String(err && err.message ? err.message : err).slice(0, 160) });
      }
      return;
    }

    if (url.pathname === "/api/lint" && method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const code = String(body.code || "");
      const language = String(body.language || "python");
      const started = Date.now();
      let result = { engine: "none", issues: [] };
      try {
        if (code.trim()) {
          if (language === "python") result = await lintPython(code);
          else if (language === "javascript") result = await lintJs(code);
          else result = lintJava(code);
        }
      } catch (err) {
        json(res, 200, { engine: "failed", issues: [], message: String(err && err.message ? err.message : err).slice(0, 200) });
        return;
      }
      json(res, 200, { ...result, elapsedMs: Date.now() - started });
      return;
    }

    if (url.pathname === "/api/analyze" && method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      const code = String(body.code || "");
      const language = String(body.language || "python");
      const checks = Array.isArray(body.checks) ? body.checks : ["style", "performance", "security"];
      if (!code.trim()) {
        json(res, 400, { code: "EMPTY_CODE", message: "代码为空" });
        return;
      }
      if (code.split("\n").length > 2000) {
        json(res, 400, { code: "TOO_LONG", message: "超过 2000 行，请分段检查" });
        return;
      }

      const cfg = getConfig();
      const useMock = cfg.mock || !cfg.apiKey;
      const started = Date.now();
      const requestId = randomUUID();

      if (useMock) {
        const demo = demoAnalysis(String(body.sampleId || ""));
        if (!demo) {
          json(res, 503, {
            code: "NO_MODEL",
            message: "还没有配置模型，当前只能看到规则扫描结果。",
            requestId,
          });
          return;
        }
        const normalized = normalize(demo, code, language);
        json(res, 200, { requestId, ...normalized, meta: { model: "demo", elapsedMs: Date.now() - started, degraded: true, reason: "demo" } });
        return;
      }

      const hints = Array.isArray(body.lintIssues) ? body.lintIssues.slice(0, 20) : [];
      const hintText = hints.length
        ? "静态检查（Python AST / ESLint）已经发现以下问题，可作为线索，不要原样重复报告：" +
          hints.map((h) => "第" + h.line + "行 " + h.title).join("；")
        : "";
      const userPrompt = [
        "语言：" + language,
        "需要重点检查：" + checks.join(", "),
        hintText,
        "代码：",
        "```",
        code,
        "```",
      ].join("\n");

      let parsed = null;
      let lastError = "";
      let lastFinish = null;
      // 几百行以上的文件如果还要求模型重写整份代码，输出必然被 max_tokens 截断
      const lineCount = code.split("\n").length;
      const bigFile = lineCount > 400 || code.length > 16000;
      for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
        try {
          const messages = [
            { role: "system", content: bigFile ? SYSTEM_PROMPT_NOFIX : SYSTEM_PROMPT },
            { role: "user", content: attempt === 0 ? userPrompt : userPrompt + "\n\n注意：上一次输出不是合法 JSON，这次只输出 JSON 对象本身。" },
          ];
          const result = await callModel(messages, cfg);
          parsed = extractJson(result.content);
          lastFinish = result.finishReason;
          if (!parsed) lastError = "模型输出不是合法 JSON";
        } catch (err) {
          lastError = String(err && err.message ? err.message : err);
        }
      }

      if (!parsed) {
        const rateLimited = /429|rate_limit/i.test(lastError);
        const msg = rateLimited
          ? "模型限流了（每分钟 3 次），等十几秒再试"
          : /不是合法 JSON/.test(lastError)
            ? "模型没能给出完整结果" + (bigFile ? "（文件较长，输出被截断）" : "") + "，可以先看规则和静态检查结果，或减少检查项再试"
            : lastError || "模型调用失败";
        json(res, rateLimited ? 429 : 502, {
          code: rateLimited ? "RATE_LIMIT" : "MODEL_FAILED",
          message: msg,
          requestId,
        });
        return;
      }

      const normalized = normalize(parsed, code, language, { noFix: bigFile });
      const srcLines = code.split("\n").length;
      const fixLines = normalized.fixedCode ? normalized.fixedCode.split("\n").length : 0;
      const tooShort = srcLines > 120 && fixLines > 0 && fixLines < srcLines * 0.6;
      if (lastFinish === "length" || tooShort) {
        normalized.fixedCode = "";
        normalized.fixable = false;
        normalized.note = "这份文件太长，模型没能输出完整重写版；建议拆成更小的文件再分析。";
      } else {
        normalized.fixable = Boolean(normalized.fixedCode);
      }
      if (bigFile && !normalized.note) {
        normalized.note = "这份文件有 " + lineCount + " 行，本次只做问题定位，不生成整体重写版；单条问题可以在右侧点「修复」逐个改。";
      }
      logEvent({
        event: "analyze",
        model: cfg.model,
        ms: Date.now() - started,
        lines: srcLines,
        issues: normalized.issues.length,
        fixable: normalized.fixable,
        finish: lastFinish,
      });
      json(res, 200, {
        requestId,
        ...normalized,
        meta: { model: cfg.model, elapsedMs: Date.now() - started, degraded: false },
      });
      return;
    }

    if (!url.pathname.startsWith("/api/")) {
      const dist = path.join(root, "dist");
      const MIME = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".json": "application/json",
      };
      let filePath = path.join(dist, url.pathname === "/" ? "index.html" : url.pathname);
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        // 带扩展名的资源找不到时必须返回 404，不能回退成 index.html。
        // 否则浏览器把 HTML 当 JS/CSS 解析，页面直接白屏或丢样式。
        if (/\.[a-z0-9]{2,8}$/i.test(url.pathname)) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
          res.end("asset not found");
          return;
        }
        filePath = path.join(dist, "index.html");
      }
      if (existsSync(filePath)) {
        const ext = path.extname(filePath);
        const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
        if (ext === ".html") {
          // 入口页必须每次校验，否则更新后浏览器还拿着旧的资源引用
          headers["Cache-Control"] = "no-cache, must-revalidate";
        } else if (url.pathname.startsWith("/assets/")) {
          // 带内容哈希，可以永久缓存
          headers["Cache-Control"] = "public, max-age=31536000, immutable";
        } else {
          headers["Cache-Control"] = "public, max-age=604800";
        }
        res.writeHead(200, headers);
        res.end(readFileSync(filePath));
        return;
      }
    }

    json(res, 404, { code: "NOT_FOUND", message: "no route" });
  } catch (err) {
    json(res, 500, { code: "INTERNAL", message: String(err && err.message ? err.message : err) });
  }
});

const cfg = getConfig();
const host = process.env.APP_HOST || "127.0.0.1";
server.listen(cfg.port, host, () => {
  console.log("[api] listening on http://" + host + ":" + cfg.port + (cfg.apiKey ? " (model: " + cfg.model + ")" : " (mock mode)"));
});

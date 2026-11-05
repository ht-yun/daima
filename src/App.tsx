import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent } from "react";
import CodeEditor from "./components/CodeEditor";
import DiffView from "./components/DiffView";
import SettingsPanel from "./components/SettingsPanel";
import type { Prefs } from "./components/SettingsPanel";
import ChatPanel from "./components/ChatPanel";
import FilePicker from "./components/FilePicker";
import Sidebar from "./components/Sidebar";
import MatrixRain from "./components/MatrixRain";
import Overview from "./components/Overview";
import RulesPanel from "./components/RulesPanel";
import type { PickedFile } from "./components/FilePicker";
import { runRules, RULE_COUNT, RULE_META } from "./engine/rules";
import { computeScores, average } from "./engine/score";
import { SAMPLES } from "./data/samples";
import { DIMENSIONS, DIM_LABEL, DIM_COLOR, SEV_LABEL, SEV_RANK } from "./types";
import type { Issue, Language, Scores, Dimension } from "./types";

type Checks = { style: boolean; performance: boolean; security: boolean };
type Filter = "all" | "high" | Dimension;
type Phase = "idle" | "rules" | "lint" | "ai" | "done";

interface HistoryItem {
  id: string;
  at: number;
  name: string;
  language: Language;
  code: string;
  issues: Issue[];
  analysis: Analysis | null;
  ms?: number;
}

interface Analysis {
  summary: string;
  before: Scores;
  after: Scores;
  fixedCode: string;
  suggestions: string[];
  degraded: boolean;
  note?: string;
}

function filterIssues(items: Issue[], c: Checks): Issue[] {
  return items.filter((i) => {
    if (i.dimension === "style") return c.style;
    if (i.dimension === "performance") return c.performance;
    if (i.dimension === "security") return c.security;
    return true;
  });
}

function mergeIssues(base: Issue[], extra: Issue[]): Issue[] {
  const list: Issue[] = base.slice();
  for (const it of extra) {
    const idx = list.findIndex((x) => x.dimension === it.dimension && Math.abs(x.line - it.line) <= 2);
    if (idx >= 0) {
      const prev = list[idx];
      const severity = SEV_RANK[it.severity] >= SEV_RANK[prev.severity] ? it.severity : prev.severity;
      list[idx] = { ...it, severity };
    } else {
      list.push(it);
    }
  }
  return list.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.line - b.line);
}

interface LogEntry {
  raw: string;
  time: string;
  kind: "req" | "analyze" | "format" | "misc";
  label: string;
  text: string;
  bad: boolean;
}

function parseLog(line: string): LogEntry {
  try {
    const o = JSON.parse(line);
    const time = String(o.t || "").slice(11, 19);
    if (o.path) {
      return {
        raw: line,
        time,
        kind: "req",
        label: "请求",
        text: String(o.method || "") + " " + String(o.path) + " · " + String(o.status) + " · " + String(o.ms) + "ms",
        bad: Number(o.status) >= 400,
      };
    }
    if (o.event === "analyze") {
      return {
        raw: line,
        time,
        kind: "analyze",
        label: "分析",
        text: String(o.model) + " · " + String(o.lines) + " 行 · " + String(o.issues) + " 问题 · " +
          (Number(o.ms) / 1000).toFixed(1) + "s" + (o.fixable ? " · 已给修复代码" : " · 未给修复代码"),
        bad: false,
      };
    }
    if (o.event === "format") {
      return {
        raw: line,
        time,
        kind: "format",
        label: "格式化",
        text: String(o.language) + " · " + String(o.ms) + "ms" + (o.changed ? " · 有改动" : " · 无改动"),
        bad: false,
      };
    }
    return { raw: line, time, kind: "misc", label: "其他", text: line, bad: false };
  } catch {
    return { raw: line, time: "", kind: "misc", label: "原始", text: line, bad: false };
  }
}

function guessLang(name: string): Language {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "js" || ext === "jsx" || ext === "ts" || ext === "tsx") return "javascript";
  if (ext === "java") return "java";
  return "python";
}

function dimTag(d: Dimension): string {
  if (d === "security" || d === "syntax") return "sec";
  if (d === "style") return "style";
  return "perf";
}

function sevClass(s: string): string {
  return s === "high" ? "high" : s === "mid" ? "mid" : "low";
}

function Plot({ scores, runId }: { scores: Scores; runId: number }) {
  return (
    <div className="plot" key={runId}>
      {DIMENSIONS.map((d, i) => (
        <div className="bar-col" key={d} style={{ "--h": scores[d] + "%" } as CSSProperties}>
          <div className={"bar b" + (i + 1)} />
          <span className="val">{scores[d]}</span>
        </div>
      ))}
    </div>
  );
}

function XLabels() {
  return (
    <div className="xlabels">
      {DIMENSIONS.map((d) => (
        <span key={d}>
          <i style={{ background: DIM_COLOR[d] }} />
          {DIM_LABEL[d]}
        </span>
      ))}
    </div>
  );
}

function Switch({ on, label, onToggle }: { on: boolean; label: string; onToggle: () => void }) {
  return (
    <div className={"sw" + (on ? "" : " off")} onClick={onToggle} role="button" tabIndex={0}>
      <i />
      {label}
    </div>
  );
}

export default function App() {
  const first = SAMPLES[0];
  const [lang, setLang] = useState<Language>(first.lang);
  const [code, setCode] = useState<string>(first.code);
  const [fileName, setFileName] = useState<string | null>(first.fileName);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [ruleScores, setRuleScores] = useState<Scores>(computeScores([]));
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [ruleCount, setRuleCount] = useState(0);
  const [lintCount, setLintCount] = useState(0);
  const [aiCount, setAiCount] = useState(0);
  const [runId, setRunId] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [banner, setBanner] = useState("");
  const [bannerOk, setBannerOk] = useState(false);
  const [checks, setChecks] = useState<Checks>({ style: true, performance: true, security: true });
  const [theme, setTheme] = useState<"dark" | "light">("light");
  const [tab, setTab] = useState<"issues" | "diff" | "chat">("issues");
  const [filter, setFilter] = useState<Filter>("all");
  const [jump, setJump] = useState<{ line: number; n: number } | null>(null);
  const [toast, setToast] = useState("");
  const [sampleIdx, setSampleIdx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [settings, setSettings] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(() => {
    try {
      const raw = localStorage.getItem("cr-prefs");
      const parsed = raw ? JSON.parse(raw) : {};
      const lv = Number(parsed.rainLevel);
      return {
        nickname: parsed.nickname || "",
        avatar: parsed.avatar || "",
        retry: Number(parsed.retry) || 1,
        verbose: Boolean(parsed.verbose),
        rain: parsed.rain === undefined ? true : Boolean(parsed.rain),
        rainLevel: lv === 1 || lv === 2 || lv === 3 ? (lv as 1 | 2 | 3) : 2,
      };
    } catch {
      return { nickname: "", avatar: "", retry: 1, verbose: false, rain: true, rainLevel: 2 };
    }
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [taskQ, setTaskQ] = useState("");
  const [fileOpen, setFileOpen] = useState(false);
  const [nav, setNav] = useState("overview");
  const [view, setView] = useState<"overview" | "desk">("overview");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [ruleFavs, setRuleFavs] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("cr-rule-favs");
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });
  const [onlyFavs, setOnlyFavs] = useState<boolean>(() => localStorage.getItem("cr-only-favs") === "1");
  const [favOnly, setFavOnly] = useState(false);
  const [ruleOff, setRuleOff] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("cr-rules-off");
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });
  const [logsOpen, setLogsOpen] = useState(false);
  const [auth, setAuth] = useState<{ required: boolean; authed: boolean; user?: string | null } | null>(null);
  const [pw, setPw] = useState("");
  const [userName, setUserName] = useState("");
  const [loginErr, setLoginErr] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [logFilter, setLogFilter] = useState<"all" | "req" | "analyze" | "format" | "err">("all");
  const [fileLib, setFileLib] = useState<PickedFile[]>([]);
  const [fixingId, setFixingId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try {
      const raw = localStorage.getItem("cr-history");
      return raw ? (JSON.parse(raw) as HistoryItem[]) : [];
    } catch {
      return [];
    }
  });
  const [cfg, setCfg] = useState<{ hasKey: boolean; model: string; baseUrl?: string; mock?: boolean } | null>(null);
  const [original, setOriginal] = useState("");
  const fileInput = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const autoFixRef = useRef(false);

  const sampleIdFor = (text: string) => {
    const hit = SAMPLES.find((s) => s.code === text);
    return hit ? hit.id : "";
  };

  async function fetchWithRetry(url: string, init: RequestInit, retries: number) {
    let lastError: unknown = null;
    for (let i = 0; i <= retries; i += 1) {
      try {
        return await fetch(url, init);
      } catch (e) {
        lastError = e;
        if (i < retries) await new Promise((r) => setTimeout(r, 700));
      }
    }
    throw lastError;
  }

  function runLocal(text: string, language: Language) {
    const disabled = new Set(ruleOff);
    if (onlyFavs && ruleFavs.length > 0) {
      for (const r of RULE_META) {
        if (!ruleFavs.includes(r.id)) disabled.add(r.id);
      }
    }
    return runRules({ code: text, lines: text.split("\n"), lang: language }, disabled);
  }

  async function analyze(text: string, language: Language, chk: Checks) {
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setBanner("");
    setBannerOk(false);
    setAnalysis(null);
    setPhase("rules");
    const taskStart = Date.now();
    const hits = filterIssues(runLocal(text, language), chk);
    setIssues(hits);
    setRuleCount(hits.length);
    setAiCount(0);
    setRuleScores(computeScores(hits));
    setRunId((n) => n + 1);

    setPhase("lint");
    let lintHits: Issue[] = [];
    try {
      const lr = await fetch("/api/lint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({ code: text, language }),
      });
      const ld = await lr.json();
      lintHits = (ld.issues || []).map((it: any, i: number) => ({
        id: "lint" + i,
        ruleId: it.ruleId || "LINT",
        line: Number(it.line) || 1,
        dimension: "syntax" as Dimension,
        severity: it.severity || "low",
        title: it.title,
        detail: it.detail || "",
        suggestion: "",
      }));
      setLintCount(lintHits.length);
      if (lintHits.length) setIssues(mergeIssues(hits, lintHits));
    } catch {
      /* linter 不可用不影响主流程 */
    }
    setPhase("ai");
    try {
      const res = await fetchWithRetry("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          code: text,
          language,
          sampleId: sampleIdFor(text),
          checks: (Object.keys(chk) as (keyof Checks)[]).filter((k) => chk[k]),
          lintIssues: hits.concat(lintHits).slice(0, 20).map((i) => ({ line: i.line, title: i.title })),
        }),
      }, prefs.retry);
      const data = await res.json();
      if (!res.ok) {
        setBanner(data.message || "分析没有成功，先看规则结果");
        setPhase("done");
        return;
      }
      const aiIssues: Issue[] = (data.issues || []).map((it: any, i: number) => ({
        id: "ai" + i,
        ruleId: "AI",
        line: Number(it.line) || 1,
        dimension: it.dimension as Dimension,
        severity: it.severity,
        title: it.title,
        detail: it.detail,
        suggestion: it.suggestion,
      }));
      const merged = mergeIssues(mergeIssues(hits, lintHits), aiIssues);
      setIssues(merged);
      setAiCount(aiIssues.length);
      const anaObj: Analysis = {
        summary: data.summary || "",
        before: data.before || computeScores(merged),
        after: data.after,
        fixedCode: data.fixedCode,
        suggestions: data.suggestions || [],
        degraded: Boolean(data.meta && data.meta.degraded),
        note: data.note || undefined,
      };
      setAnalysis(anaObj);
      pushHistory(fileName || "未命名", language, text, merged, anaObj, Date.now() - taskStart);
      if (data.note) setBanner(data.note);
      if (data.meta && data.meta.degraded) setBanner("当前是内置演示结果；在右上角配置模型后会走真实分析");
      if (!autoFixRef.current && new URLSearchParams(location.search).get("autofix") === "1" && data.fixedCode) {
        autoFixRef.current = true;
        const fixed = data.fixedCode as string;
        const count = merged.length;
        const bScores = (data.before || computeScores(merged)) as Scores;
        const aScores = data.after as Scores;
        setTimeout(() => applyFixData(fixed, count, bScores, aScores), 900);
      }
      setPhase("done");
      setRunId((n) => n + 1);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setBanner(
          prefs.verbose
            ? "接口没连上：" + String((err as Error).message || err).slice(0, 120)
            : "接口没连上，先显示规则结果。确认 api 服务是否在运行。"
        );
      }
      setPhase("done");
    }
  }

  function pushHistory(name: string, language: Language, text: string, items: Issue[], ana: Analysis | null, ms?: number) {
    const entry: HistoryItem = {
      id: String(Date.now()),
      at: Date.now(),
      name: name || "未命名",
      language,
      code: text.slice(0, 60000),
      issues: items.slice(0, 60),
      analysis: ana,
      ms,
    };
    setHistory((prev) => {
      const next = [entry, ...prev.filter((h) => !(h.code === entry.code && h.name === entry.name))].slice(0, 20);
      try {
        localStorage.setItem("cr-history", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  function restoreHistory(h: HistoryItem) {
    setCode(h.code);
    setLang(h.language);
    setFileName(h.name);
    setIssues(h.issues);
    setAnalysis(h.analysis);
    setRuleScores(computeScores(h.issues));
    setOriginal("");
    setTab("issues");
    setHistoryOpen(false);
    setToast("已恢复：" + new Date(h.at).toLocaleString());
  }

  async function fixOne(issue: Issue) {
    if (fixingId) return;
    setFixingId(issue.id);
    try {
      const res = await fetch("/api/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, language: lang, issue }),
      });
      const j = await res.json();
      if (!res.ok) {
        setToast(j.message || "修复失败");
        return;
      }
      const find = String(j.find || "");
      const repl = String(j.replace || "");
      if (!find || code.indexOf(find) < 0) {
        setToast("补丁没能对上原文，换个说法再试");
        return;
      }
      setOriginal(code);
      setCode(code.replace(find, repl));
      setIssues((prev) => prev.filter((i) => i.id !== issue.id));
      setTab("diff");
      setToast("已修复：" + issue.title);
    } catch {
      setToast("接口不通，修复没做");
    } finally {
      setFixingId(null);
    }
  }

  function toggleCheck(key: keyof Checks) {
    const next = { ...checks, [key]: !checks[key] };
    setChecks(next);
    analyze(code, lang, next);
  }

  function loadSample(idx: number) {
    const s = SAMPLES[idx % SAMPLES.length];
    setSampleIdx(idx % SAMPLES.length);
    setCode(s.code);
    setLang(s.lang);
    setFileName(s.fileName);
    setOriginal("");
    analyze(s.code, s.lang, checks);
  }

  function loadItem(item: PickedFile) {
    setCode(item.content);
    setLang(item.language);
    setFileName(item.name);
    setOriginal("");
    setFileOpen(false);
    analyze(item.content, item.language, checks);
    setToast("已载入 " + item.name);
  }

  function addFiles(list: FileList | File[]) {
    const arr = Array.from(list).slice(0, 10);
    arr.forEach((f) => {
      if (f.size > 400 * 1024) {
        setToast(f.name + " 太大，已跳过");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || "");
        if (!text.trim() || text.indexOf(String.fromCharCode(0)) >= 0) {
          setToast(f.name + " 看起来不是文本文件");
          return;
        }
        const item: PickedFile = {
          id: String(Date.now()) + Math.random().toString(16).slice(2, 6),
          name: f.name,
          content: text,
          size: f.size,
          language: guessLang(f.name),
        };
        setFileLib((prev) => [item, ...prev.filter((x) => x.name !== item.name)].slice(0, 20));
        loadItem(item);
      };
      reader.readAsText(f);
    });
  }

  function clearAll() {
    setCode("");
    setFileName(null);
    setIssues([]);
    setAnalysis(null);
    setOriginal("");
    setRuleScores(computeScores([]));
  }

  async function openLogs() {
    setLogsOpen(true);
    try {
      const res = await fetch("/api/logs?limit=120");
      const j = await res.json();
      setLogs((j.lines || []).slice().reverse());
    } catch {
      setLogs([]);
    }
  }

  async function formatCode() {
    setToast("正在格式化…");
    try {
      const res = await fetch("/api/format", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, language: lang }),
      });
      const j = await res.json();
      if (!res.ok) {
        setToast(j.message || "格式化失败");
        return;
      }
      if (j.code) {
        setOriginal(code);
        setCode(j.code);
        setToast(j.changed ? "已格式化" : "已经是规范格式了");
      }
    } catch {
      setToast("格式化接口不通");
    }
  }

  function applyFixData(fixed: string, count: number, bScores: Scores, aScores: Scores) {
    if (!fixed) return;
    setOriginal(code);
    setCode(fixed);
    setTab("diff");
    const remain = filterIssues(runLocal(fixed, lang), checks);
    setIssues(remain);
    setRuleScores(computeScores(remain));
    setBanner("已修复 " + count + " 处，风险评分 " + average(bScores) + " → " + average(aScores));
    setBannerOk(true);
    setRunId((n) => n + 1);
  }

  function applyFix() {
    if (!analysis || !analysis.fixedCode) return;
    applyFixData(analysis.fixedCode, issues.length, analysis.before, analysis.after);
  }

  async function saveConfig(patch: { baseUrl: string; model: string; apiKey: string }) {
    try {
      await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...patch, mock: false }),
      });
      const c = await fetch("/api/config").then((r) => r.json());
      setCfg(c);
      setSettings(false);
      setToast(c.hasKey ? "已启用 " + c.model : "已保存，但 Key 是空的");
      analyze(code, lang, checks);
    } catch {
      setToast("保存失败，检查 api 服务是否在运行");
    }
  }

  useEffect(() => {
    fetch("/api/auth")
      .then((r) => r.json())
      .then(setAuth)
      .catch(() => setAuth({ required: false, authed: true }));
  }, []);

  async function doLogin() {
    setLoginErr("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: userName, password: pw }),
      });
      if (res.ok) window.location.reload();
      else {
        const j = await res.json().catch(() => ({}));
        setLoginErr(j.message || "账号或密码不对");
      }
    } catch {
      setLoginErr("接口不通");
    }
  }

  useEffect(() => {
    if (new URLSearchParams(location.search).get("ask") || new URLSearchParams(location.search).get("tab") === "chat") setTab("chat");
    fetch("/api/config")
      .then((r) => r.json())
      .then(setCfg)
      .catch(() => setCfg({ hasKey: false, model: "未连接", mock: true }));
    const ing = new URLSearchParams(location.search).get("ingest");
    if (ing) {
      fetch("/api/ingest/" + ing)
        .then((r) => r.json())
        .then((d) => {
          if (!d || !d.content) {
            analyze(SAMPLES[0].code, SAMPLES[0].lang, { style: true, performance: true, security: true });
            return;
          }
          const l = guessLang(d.name || "");
          setCode(d.content);
          setLang(l);
          setFileName(d.name || "导入文件");
          setToast("已载入 " + (d.name || "文件"));
          analyze(d.content, l, { style: true, performance: true, security: true });
        })
        .catch(() => analyze(SAMPLES[0].code, SAMPLES[0].lang, { style: true, performance: true, security: true }));
    } else {
      analyze(SAMPLES[0].code, SAMPLES[0].lang, { style: true, performance: true, security: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      const q = new URLSearchParams(location.search).get("theme");
      if (q === "light" || q === "dark") {
        setTheme(q);
        return;
      }
      const saved = localStorage.getItem("cr-theme");
      if (saved === "light" || saved === "dark") setTheme(saved);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("cr-rule-favs", JSON.stringify(ruleFavs));
      localStorage.setItem("cr-only-favs", onlyFavs ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [ruleFavs, onlyFavs]);

  useEffect(() => {
    try {
      localStorage.setItem("cr-rules-off", JSON.stringify(ruleOff));
    } catch {
      /* ignore */
    }
  }, [ruleOff]);

  useEffect(() => {
    try {
      localStorage.setItem("cr-prefs", JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
  }, [prefs]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("cr-theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const visible = useMemo(() => {
    return issues.filter((i) => {
      if (filter === "all") return true;
      if (filter === "high") return i.severity === "high";
      return i.dimension === filter;
    });
  }, [issues, filter]);

  const beforeScores = analysis ? analysis.before : ruleScores;
  const afterScores = analysis ? analysis.after : null;
  const highCount = issues.filter((i) => i.severity === "high").length;
  const lineCount = code.length ? code.split("\n").length : 0;
    const busy = phase === "rules" || phase === "lint" || phase === "ai";

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  }

  // auth 结果回来之前不要先渲染主界面，否则会闪一下「未登录」再跳登录门
  if (!auth) {
    return <div className="boot" />;
  }

  if (auth.required && !auth.authed) {
    return (
      <div className="login-gate">
        <div className="login-card">
          <div className="logo">审</div>
          <b>码审 CodeReview</b>
          <span className="login-sub">登录后使用</span>
          <input
            type="text"
            value={userName}
            autoFocus
            placeholder="账号"
            onChange={(e) => setUserName(e.target.value)}
          />
          <input
            type="password"
            value={pw}
            placeholder="密码"
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") doLogin();
            }}
          />
          {loginErr ? <div className="login-err">{loginErr}</div> : null}
          <button className="primary" style={{ marginLeft: 0, width: "100%", justifyContent: "center" }} onClick={doLogin}>
            进入
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={"app" + (dragging ? " drag-over" : "")}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {theme === "dark" && prefs.rain ? <MatrixRain level={prefs.rainLevel} /> : null}
      <header className="topbar">
        <span className="view-title">{view === "overview" ? "概览" : "审阅台"}</span>
        {view === "desk" ? (
          <button
            className="ovback"
            onClick={() => {
              setNav("overview");
              setView("overview");
            }}
          >
            概览
          </button>
        ) : null}
        <div className="title-chip" style={view === "overview" ? { display: "none" } : undefined}>
          {fileName || "未命名"} ▾
        </div>
        <div className="spacer" />
        <button className={"model-chip" + (cfg && cfg.hasKey ? "" : " off")} onClick={() => setSettings(true)} title="模型设置">
          <span className="dot2" />
          {cfg ? (cfg.hasKey ? cfg.model : "演示模式") : "连接中"}
        </button>
        <button className="icon-btn" title="运行日志" onClick={openLogs}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="m7 9 3 3-3 3M13 15h4" />
          </svg>
        </button>
        <button className="icon-btn" title="历史记录" onClick={() => setHistoryOpen(true)}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <circle cx="12" cy="12" r="8.4" />
            <path d="M12 7.6V12l3.1 1.9" />
          </svg>
        </button>
        <div className="divider" />
        <div className="avatar" title={auth && auth.user ? "当前账号：" + auth.user : "未登录"}>
          {prefs.avatar ? (
            <img src={prefs.avatar} alt="" />
          ) : (
            (prefs.nickname || (auth && auth.user) || "L").slice(0, 1).toUpperCase()
          )}
        </div>
      </header>

      <div className="body">
      <Sidebar
        active={nav}
        onNav={(key) => {
          if (key === "overview") {
            setNav(key);
            setView("overview");
          } else if (key === "desk") {
            setNav(key);
            setView("desk");
          } else if (key === "archive") {
            setFileOpen(true);
          } else if (key === "search") {
            setHistoryOpen(true);
            setTimeout(() => {
              const el = document.querySelector(".taskmodal .rules-search") as HTMLInputElement | null;
              if (el) el.focus();
            }, 320);
          } else if (key === "settings") {
            setSettings(true);
          }
        }}
      />
      <main className={"main" + (view === "overview" ? " main-ov" : "")}>
        {view === "overview" ? (
          <Overview
            user={prefs.nickname || (auth && auth.user) || ""}
            scores={ruleScores}
            issues={issues}
            history={history}
            fileName={fileName}
            onDesk={() => {
              setNav("desk");
              setView("desk");
            }}
            onAlert={() => {
              setNav("desk");
              setView("desk");
              setTab("issues");
              setFilter("all");
            }}
            onImport={() => setFileOpen(true)}
            onGithub={() => setFileOpen(true)}
            onRules={() => {
              setFavOnly(false);
              setRulesOpen(true);
            }}
            onLogs={openLogs}
            onHistory={() => setHistoryOpen(true)}
          />
        ) : (
          <>
        <section className="card editor-card">
          <div className="toolbar">
            <select
              className="select"
              value={lang}
              onChange={(e) => {
                const l = e.target.value as Language;
                setLang(l);
                analyze(code, l, checks);
              }}
            >
              <option value="python">Python</option>
              <option value="javascript">JavaScript</option>
              <option value="java">Java</option>
            </select>
            {fileName ? (
              <div className="filechip" title={fileName}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                  <path d="M14 3v5h5" />
                </svg>
                <b>{fileName}</b>
                <span className="fx" onClick={clearAll}>×</span>
              </div>
            ) : null}
            <span className="meta">{lineCount} 行</span>
            <div className="switches">
              <Switch on={checks.style} label="规范" onToggle={() => toggleCheck("style")} />
              <Switch on={checks.performance} label="性能" onToggle={() => toggleCheck("performance")} />
              <Switch on={checks.security} label="安全" onToggle={() => toggleCheck("security")} />
            </div>
          </div>

          <CodeEditor value={code} language={lang} issues={issues} onChange={setCode} onRun={() => analyze(code, lang, checks)} jump={jump} />

          <div className="editor-foot">
            <button className="ghost" onClick={() => setFileOpen(true)}>打开文件</button>
            <button className="ghost" onClick={formatCode}>格式化</button>
            <button className="ghost" onClick={() => loadSample(sampleIdx + 1)}>示例</button>
            <button
              className="ghost"
              onClick={() => {
                setFavOnly(false);
                setRulesOpen(true);
              }}
            >
              规则
            </button>
            <button className="ghost" onClick={clearAll}>清空</button>
            <button className="primary" onClick={() => analyze(code, lang, checks)} disabled={busy}>
              {busy ? "分析中…" : "开始检查"}
            </button>
          </div>
        </section>

        <section className="right">
          <div className="card score">
            <div className="score-head">
              <b>风险报告</b>
              {busy ? (
                <span className="steps"><i className="spin" />{phase === "rules" ? "规则扫描…" : phase === "lint" ? "静态检查…" : "分析中…"}</span>
              ) : (
                <span className="tag-neutral">规则 {ruleCount} · 静态 {lintCount} · 模型 {aiCount}</span>
              )}
              <button className="ghost" onClick={() => analyze(code, lang, checks)} disabled={busy}>↻ 重新检查</button>
            </div>

            <div className="charts">
              <div className="chart">
                <div className="chart-title">
                  {analysis ? "修复前" : "当前"} <em>平均 {average(beforeScores)}</em>
                </div>
                <Plot scores={beforeScores} runId={runId} />
                <XLabels />
              </div>
              <div className="chart after">
                <div className="chart-title">
                  修复后 <em>{afterScores ? "平均 " + average(afterScores) : "待分析"}</em>
                </div>
                {afterScores ? (
                  <>
                    <Plot scores={afterScores} runId={runId + 1000} />
                    <XLabels />
                  </>
                ) : (
                  <>
                    <div className="chart-empty">
                      <span>修复后评分</span>
                      <em>跑一次检查后显示</em>
                    </div>
                    <XLabels />
                  </>
                )}
              </div>
            </div>

            {afterScores ? (
              <div className="deltas">
                {DIMENSIONS.map((d) => (
                  <span className="delta" key={d}>
                    <s>{DIM_LABEL[d]} {beforeScores[d]}</s> → <b>{afterScores[d]}</b>{" "}
                    <em className={afterScores[d] - beforeScores[d] < 0 ? "down" : ""}>
                      {afterScores[d] - beforeScores[d] >= 0 ? "+" : ""}
                      {afterScores[d] - beforeScores[d]}
                    </em>
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <div className="card tabs-card">
            {banner ? (
              <div className={"banner" + (bannerOk ? " ok" : "")}>
                <span>{banner}</span>
              </div>
            ) : null}
            <div className="tabs">
              <div className={"tab" + (tab === "issues" ? " on" : "")} onClick={() => setTab("issues")}>
                问题 <span className="count">{issues.length}</span>
              </div>
              <div className={"tab" + (tab === "diff" ? " on" : "")} onClick={() => setTab("diff")}>
                对比
              </div>
              <div className={"tab" + (tab === "chat" ? " on" : "")} onClick={() => setTab("chat")}>对话</div>
            </div>

            {tab === "issues" ? (
              <div className="list">
                <div className="filters">
                  <span className={"fchip" + (filter === "all" ? " on" : "")} onClick={() => setFilter("all")}>全部 {issues.length}</span>
                  <span className={"fchip" + (filter === "high" ? " on" : "")} onClick={() => setFilter("high")}>高危 {highCount}</span>
                  <span className={"fchip" + (filter === "security" ? " on" : "")} onClick={() => setFilter("security")}>安全</span>
                  <span className={"fchip" + (filter === "performance" ? " on" : "")} onClick={() => setFilter("performance")}>性能</span>
                  <span className={"fchip" + (filter === "style" ? " on" : "")} onClick={() => setFilter("style")}>规范</span>
                </div>
                {analysis && analysis.summary ? <div className="summary">{analysis.summary}</div> : null}
                {visible.length === 0 ? (
                  <div className="pane-empty">
                    {phase === "idle" ? "点「开始检查」跑一次分析。" : "没有命中问题，这段代码挺干净。"}
                  </div>
                ) : (
                  visible.map((i) => (
                    <div className="issue" key={i.id} onClick={() => setJump({ line: i.line, n: (jump ? jump.n : 0) + 1 })} title={i.detail}>
                      <div className="issue-top">
                        <span className={"sev " + sevClass(i.severity)} />
                        <span className="line-no">第 {i.line} 行</span>
                        <span className="issue-title">{i.title}</span>
                      </div>
                      <div className="issue-foot">
                        <span className={"tag " + dimTag(i.dimension)}>{DIM_LABEL[i.dimension]}</span>
                        <span className={"tag " + sevClass(i.severity)}>{SEV_LABEL[i.severity]}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : tab === "diff" ? (
              <div className="diffpane">
                {analysis && analysis.suggestions.length ? (
                  <details className="sugg">
                    <summary>建议（{analysis.suggestions.length}）</summary>
                    {analysis.suggestions.map((s, i) => (
                      <span key={i}>· {s}</span>
                    ))}
                  </details>
                ) : null}
                <DiffView before={original} after={code} language={lang} />
              </div>
            ) : (
              <ChatPanel
                code={code}
                language={lang}
                onApply={(c) => {
                  setCode(c);
                  setToast("已写回编辑器");
                }}
              />
            )}
          </div>

          <div className="fixbar">
            <button className="fixbtn" disabled={!analysis || busy || !analysis.fixedCode} onClick={applyFix}>
              {!analysis ? "修复" : analysis.fixedCode ? "修复" : "文件过长，暂无整份修复"}
            </button>
          </div>
        </section>
          </>
        )}
      </main>
      </div>

      <RulesPanel
        open={rulesOpen}
        off={ruleOff}
        favs={ruleFavs}
        onlyFavs={onlyFavs}
        favOnly={favOnly}
        onChange={setRuleOff}
        onFavs={setRuleFavs}
        onOnlyFavs={setOnlyFavs}
        onFavOnly={setFavOnly}
        onClose={() => setRulesOpen(false)}
      />

      <FilePicker
        open={fileOpen}
        files={fileLib}
        current={fileName}
        onFiles={addFiles}
        onPick={(id) => {
          const it = fileLib.find((x) => x.id === id);
          if (it) loadItem(it);
        }}
        onRemove={(id) => setFileLib((prev) => prev.filter((x) => x.id !== id))}
        onGithubLoad={(f) => {
          const item: PickedFile = {
            id: "gh-" + Date.now() + Math.random().toString(16).slice(2, 6),
            name: f.path,
            content: f.content,
            size: f.size,
            language: f.language,
          };
          setFileLib((prev) => [item, ...prev.filter((x) => x.name !== item.name)].slice(0, 20));
          loadItem(item);
        }}
        onClose={() => setFileOpen(false)}
      />

      <div className={"drawer-mask" + (logsOpen ? " open" : "")} onClick={() => setLogsOpen(false)} />
      <aside className={"drawer" + (logsOpen ? " open" : "")}>
        <div className="drawer-head">
          <b>运行日志</b>
          <span className="meta">logs/app.log</span>
          <button className="ghost" onClick={openLogs}>刷新</button>
          <button className="icon-btn" onClick={() => setLogsOpen(false)}>×</button>
        </div>
        <div className="logfilters">
          {(["all", "req", "analyze", "format", "err"] as const).map((k) => (
            <span className={"fchip" + (logFilter === k ? " on" : "")} key={k} onClick={() => setLogFilter(k)}>
              {k === "all" ? "全部" : k === "req" ? "请求" : k === "analyze" ? "分析" : k === "format" ? "格式化" : "错误"}
            </span>
          ))}
        </div>
        <div className="logbox">
          {logs.length === 0 ? (
            <div className="pane-empty">还没有日志，跑一次检查就有了</div>
          ) : (
            logs
              .map(parseLog)
              .filter((e) => (logFilter === "all" ? true : logFilter === "err" ? e.bad : e.kind === logFilter))
              .map((e, i) => (
                <div className={"logrow " + e.kind + (e.bad ? " bad" : "")} key={i} title={e.raw}>
                  <span className="logtime">{e.time}</span>
                  <span className={"logtag " + e.kind}>{e.label}</span>
                  <span className="logtext">{e.text}</span>
                </div>
              ))
          )}
        </div>
      </aside>

      {historyOpen ? (
        <div className="modal-mask" onClick={() => setHistoryOpen(false)}>
          <div className="taskmodal" onClick={(e) => e.stopPropagation()}>
            <div className="task-head">
              <b>评审任务</b>
              <span className="task-sub">{history.length} 条 · 最多保留 20 条</span>
              <input
                className="rules-search"
                value={taskQ}
                placeholder="搜索文件名"
                onChange={(e) => setTaskQ(e.target.value)}
              />
              <button
                className="ghost"
                onClick={() => {
                  setHistory([]);
                  try {
                    localStorage.removeItem("cr-history");
                  } catch {
                    /* ignore */
                  }
                  setToast("已清空任务");
                }}
              >
                清空
              </button>
              <button className="icon-btn" onClick={() => setHistoryOpen(false)}>×</button>
            </div>

            <div className="task-table">
              <div className="task-row th">
                <span>文件</span>
                <span>语言</span>
                <span>状态</span>
                <span>问题</span>
                <span>风险评分</span>
                <span>耗时</span>
                <span>时间</span>
                <span>操作</span>
              </div>
              {history.filter((h) => !taskQ.trim() || h.name.includes(taskQ.trim())).length === 0 ? (
                <div className="pane-empty">
                  <span>还没有任务</span>
                  <span>点「开始检查」跑一次，就会出现在这里</span>
                </div>
              ) : (
                history
                  .filter((h) => !taskQ.trim() || h.name.includes(taskQ.trim()))
                  .map((h) => (
                    <div className="task-row" key={h.id}>
                      <span className="task-name" title={h.name}>{h.name}</span>
                      <span>{h.language}</span>
                      <span className="task-state"><i />完成</span>
                      <span>{h.issues.length}</span>
                      <span>{h.analysis ? average(h.analysis.after) : "-"}</span>
                      <span>{h.ms ? (h.ms / 1000).toFixed(1) + "s" : "-"}</span>
                      <span className="task-time">{new Date(h.at).toLocaleString()}</span>
                      <span className="task-actions">
                        <button className="ghost" onClick={() => restoreHistory(h)}>打开</button>
                        <button
                          className="ghost danger"
                          onClick={() => {
                            setHistory((prev) => {
                              const next = prev.filter((x) => x.id !== h.id);
                              try {
                                localStorage.setItem("cr-history", JSON.stringify(next));
                              } catch {
                                /* ignore */
                              }
                              return next;
                            });
                          }}
                        >
                          删除
                        </button>
                      </span>
                    </div>
                  ))
              )}
            </div>
          </div>
        </div>
      ) : null}

      <SettingsPanel
        open={settings}
        cfg={cfg}
        auth={auth}
        prefs={prefs}
        theme={theme}
        onClose={() => setSettings(false)}
        onSaveModel={saveConfig}
        onPrefs={(patch) => setPrefs((prev) => ({ ...prev, ...patch }))}
        onTheme={setTheme}
        onLogout={async () => {
          try {
            await fetch("/api/logout", { method: "POST" });
          } catch {
            /* ignore */
          }
          window.location.reload();
        }}
      />
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

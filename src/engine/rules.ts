import type { Issue, Language, Dimension, Severity } from "../types";
import { SEV_RANK } from "../types";

export interface RuleCtx {
  code: string;
  lines: string[];
  lang: Language;
}

type Hit = { line: number; detail?: string; suggestion?: string };

interface RuleDef {
  id: string;
  title: string;
  dimension: Dimension;
  severity: Severity;
  run: (ctx: RuleCtx) => Hit[];
}

const isPy = (c: RuleCtx) => c.lang === "python";
const isJs = (c: RuleCtx) => c.lang === "javascript";
const ind = (s: string) => s.length - s.replace(/^\s+/, "").length;

function lineAt(code: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < code.length; i++) if (code[i] === "\n") n++;
  return n;
}

function stripStrings(code: string): string {
  return code
    .replace(/"(?:[^"\\\\\n]|\\\\.)*"/g, '""')
    .replace(/'(?:[^'\\\\\n]|\\\\.)*'/g, "''")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/#[^\n]*/g, "");
}

const RULES: RuleDef[] = [
  {
    id: "SEC-001",
    title: "疑似硬编码密钥或口令",
    dimension: "security",
    severity: "high",
    run: (c) => {
      const hits: Hit[] = [];
      const re = /(api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*["']([^"']{4,})["']/i;
      c.lines.forEach((l, i) => {
        if (re.test(l) && !/def\s|function\s|=>/.test(l)) {
          hits.push({ line: i + 1, detail: "代码里直接写了密钥或口令字面量。", suggestion: "改为从环境变量或密钥管理服务读取。" });
        }
      });
      return hits.slice(0, 2);
    },
  },
  {
    id: "SEC-002",
    title: "SQL 语句由字符串拼接而成",
    dimension: "security",
    severity: "high",
    run: (c) => {
      const hits: Hit[] = [];
      const sql = /\b(select|insert|update|delete)\b/i;
      c.lines.forEach((l, i) => {
        if (sql.test(l) && /(\+\s*\w|%\s*\(|\.format\(|f["'])/.test(l)) {
          hits.push({ line: i + 1, detail: "外部输入被直接拼进 SQL，可被注入。", suggestion: "改用参数化查询，把变量作为参数传入。" });
        }
      });
      return hits;
    },
  },
  {
    id: "SEC-003",
    title: "使用了危险函数",
    dimension: "security",
    severity: "high",
    run: (c) => {
      const hits: Hit[] = [];
      const re = /\b(eval|exec)\s*\(|os\.system\(|shell\s*=\s*True|pickle\.loads\(/;
      c.lines.forEach((l, i) => {
        if (re.test(l)) hits.push({ line: i + 1, detail: "这类调用会执行任意代码或命令。", suggestion: "改用显式解析或白名单调用。" });
      });
      return hits.slice(0, 2);
    },
  },
  {
    id: "SEC-004",
    title: "口令以明文直接比较",
    dimension: "security",
    severity: "high",
    run: (c) => {
      const hits: Hit[] = [];
      const re = /(password|passwd|pwd)\w*\s*==\s*[^=]|==\s*["']?\w*(password|passwd|pwd)\b/i;
      c.lines.forEach((l, i) => {
        if (re.test(l)) hits.push({ line: i + 1, detail: "数据库中的口令若为明文，泄露后可直接复用。", suggestion: "存储与比较都用 bcrypt / argon2 等慢哈希。" });
      });
      return hits.slice(0, 2);
    },
  },
  {
    id: "SYN-001",
    title: "括号或引号不配对",
    dimension: "syntax",
    severity: "high",
    run: (c) => {
      const s = stripStrings(c.code);
      const stack: { ch: string; idx: number }[] = [];
      const close: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === "(" || ch === "[" || ch === "{") stack.push({ ch, idx: i });
        else if (ch === ")" || ch === "]" || ch === "}") {
          const top = stack.pop();
          if (!top || top.ch !== close[ch]) return [{ line: lineAt(c.code, i), detail: "多余的 " + ch + " 或前面缺少配对的左括号。", suggestion: "补齐或删除多余的括号。" }];
        }
      }
      if (stack.length) {
        const first = stack[0];
        return [{ line: lineAt(c.code, first.idx), detail: "这里的 " + first.ch + " 直到文件结束都没有闭合。", suggestion: "补上对应的右括号。" }];
      }
      return [];
    },
  },
  {
    id: "SYN-002",
    title: "缩进不一致（Tab 与空格混用）",
    dimension: "syntax",
    severity: "mid",
    run: (c) => {
      let tab = -1;
      let space = -1;
      c.lines.forEach((l, i) => {
        if (!l.trim()) return;
        if (/^\t+/.test(l) && tab < 0) tab = i + 1;
        if (/^ +\S/.test(l) && space < 0) space = i + 1;
      });
      if (tab > 0 && space > 0) {
        return [{ line: Math.min(tab, space), detail: "同一个文件里既用了 Tab 又用了空格缩进。", suggestion: "统一改为 4 个空格。" }];
      }
      return [];
    },
  },
  {
    id: "SYN-003",
    title: "变量或导入声明后未使用",
    dimension: "syntax",
    severity: "low",
    run: (c) => {
      const decls: { name: string; line: number }[] = [];
      c.lines.forEach((l, i) => {
        let m: RegExpMatchArray | null = null;
        if (isPy(c) && (m = l.match(/^\s*import\s+([\w.]+)\s*$/))) decls.push({ name: m[1].split(".")[0], line: i + 1 });
        if (isPy(c) && (m = l.match(/^\s*from\s+[\w.]+\s+import\s+([\w,\s]+)$/))) {
          m[1].split(",").map((x) => x.trim()).filter(Boolean).forEach((n) => decls.push({ name: n, line: i + 1 }));
        }
        if (isJs(c) && (m = l.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/))) decls.push({ name: m[1], line: i + 1 });
        if (isPy(c) && (m = l.match(/^\s*([a-z_][\w]*)\s*=(?!=)/))) decls.push({ name: m[1], line: i + 1 });
        if (isPy(c) && (m = l.match(/def\s+\w+\(([^)]*)\)/))) {
          m[1].split(",").map((x) => x.trim().split("=")[0].trim().split(":")[0].trim()).filter((x) => /^[a-z_]\w*$/i.test(x))
            .forEach((n) => decls.push({ name: n, line: i + 1 }));
        }
      });
      const hits: Hit[] = [];
      const seen = new Set<string>();
      for (const d of decls) {
        if (d.name.length < 2 || d.name === "self" || seen.has(d.name)) continue;
        seen.add(d.name);
        const count = (c.code.match(new RegExp("\\b" + d.name + "\\b", "g")) || []).length;
        if (count < 2) hits.push({ line: d.line, detail: d.name + " 声明后没有再被用到。", suggestion: "删掉它，或者补上真正需要的使用。" });
        if (hits.length >= 3) break;
      }
      return hits;
    },
  },
  {
    id: "SYN-004",
    title: "调用了未定义的函数",
    dimension: "syntax",
    severity: "mid",
    run: (c) => {
      if (!isPy(c)) return [];
      const builtins = new Set(("print len range str int float list dict set tuple bool open input enumerate zip map filter sorted sum min max abs round isinstance type super exception valueerror typeerror keyerror self object".split(" ")));
      const defined = new Set<string>();
      c.lines.forEach((l) => {
        let m: RegExpMatchArray | null = null;
        if ((m = l.match(/^\s*def\s+([A-Za-z_]\w*)/))) defined.add(m[1]);
        if ((m = l.match(/^\s*class\s+([A-Za-z_]\w*)/))) defined.add(m[1]);
        if ((m = l.match(/^\s*([A-Za-z_]\w*)\s*=(?!=)/))) defined.add(m[1]);
        if ((m = l.match(/\bfor\s+([A-Za-z_]\w*)\s+in\b/))) defined.add(m[1]);
        if ((m = l.match(/\bas\s+([A-Za-z_]\w*)/))) defined.add(m[1]);
        if ((m = l.match(/^\s*import\s+([\w.]+)/))) defined.add(m[1].split(".")[0]);
        if ((m = l.match(/^\s*from\s+[\w.]+\s+import\s+(.+)$/))) m[1].split(",").forEach((x) => defined.add(x.trim()));
        if ((m = l.match(/def\s+\w+\(([^)]*)\)/))) {
          m[1].split(",").map((x) => x.trim().split("=")[0].split(":")[0].trim()).forEach((x) => { if (x) defined.add(x); });
        }
      });
      const hits: Hit[] = [];
      const reported = new Set<string>();
      const re = /(^|[^\w.])([A-Za-z_]\w*)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(c.code))) {
        const name = m[2];
        if (defined.has(name) || builtins.has(name.toLowerCase()) || reported.has(name)) continue;
        if (["if", "for", "while", "return", "print", "elif", "except", "with", "lambda"].includes(name)) continue;
        reported.add(name);
        hits.push({ line: lineAt(c.code, m.index), detail: name + " 在本文件里找不到定义。", suggestion: "确认是否漏了 import，或者函数名拼写有误。" });
        if (hits.length >= 2) break;
      }
      return hits;
    },
  },
  {
    id: "LOG-001",
    title: "异常被静默吞掉",
    dimension: "logic",
    severity: "mid",
    run: (c) => {
      const hits: Hit[] = [];
      const re1 = /except[^:\n]*:\s*\n\s*pass\b/g;
      const re2 = /catch\s*\([^)]*\)\s*\{\s*\}/g;
      let m: RegExpExecArray | null;
      while ((m = re1.exec(c.code))) hits.push({ line: lineAt(c.code, m.index), detail: "异常被 pass 掉了，出错时完全无感知。", suggestion: "至少记录日志，或向调用方抛出明确错误。" });
      while ((m = re2.exec(c.code))) hits.push({ line: lineAt(c.code, m.index), detail: "空 catch 块吞掉了所有异常。", suggestion: "补日志或重新抛出。" });
      return hits.slice(0, 2);
    },
  },
  {
    id: "LOG-002",
    title: "可变对象作为默认参数",
    dimension: "logic",
    severity: "high",
    run: (c) => {
      const hits: Hit[] = [];
      c.lines.forEach((l, i) => {
        if (/def\s+\w+\s*\([^)]*=\s*(\[\]|\{\}|set\(\))/.test(l)) {
          hits.push({ line: i + 1, detail: "默认值只在定义时创建一次，会被多次调用共享。", suggestion: "默认写 None，函数体内再初始化。" });
        }
      });
      return hits.slice(0, 2);
    },
  },
  {
    id: "LOG-003",
    title: "宽松相等比较（== 而非 ===）",
    dimension: "logic",
    severity: "mid",
    run: (c) => {
      if (!isJs(c)) return [];
      const hits: Hit[] = [];
      c.lines.forEach((l, i) => {
        if (/[^=!<>]==[^=]/.test(l)) hits.push({ line: i + 1, detail: "== 会做隐式类型转换，容易得到意外结果。", suggestion: "改用 ===。" });
      });
      return hits.slice(0, 2);
    },
  },
  {
    id: "LOG-004",
    title: "打开的资源没有关闭",
    dimension: "logic",
    severity: "mid",
    run: (c) => {
      if (/\.close\(\)|try\s*\(/.test(c.code)) return [];
      const hits: Hit[] = [];
      c.lines.forEach((l, i) => {
        if (/\bopen\s*\(|new\s+FileInputStream\s*\(/.test(l) && !/\bwith\b/.test(l)) {
          hits.push({ line: i + 1, detail: "文件句柄没有关闭，异常时会泄漏。", suggestion: "用 with / try-with-resources 自动关闭。" });
        }
      });
      return hits.slice(0, 2);
    },
  },
  {
    id: "PER-001",
    title: "循环内逐条发起查询或请求",
    dimension: "performance",
    severity: "mid",
    run: (c) => {
      const hits: Hit[] = [];
      for (let i = 0; i < c.lines.length; i++) {
        const head = c.lines[i].match(/^\s*(for|while)\b/);
        if (!head) continue;
        const base = ind(c.lines[i]);
        for (let j = i + 1; j < c.lines.length; j++) {
          const line = c.lines[j];
          if (!line.trim()) continue;
          if (ind(line) <= base) break;
          if (/(query|select|fetch|execute|requests\.|httpx\.|open\(|\.get\()/i.test(line)) {
            hits.push({ line: j + 1, detail: "每条数据都单独查一次，数据量一大就成 N+1。", suggestion: "改成批量查询，循环外一次取回。" });
            break;
          }
        }
        if (hits.length >= 2) break;
      }
      return hits;
    },
  },
  {
    id: "PER-002",
    title: "循环内用字符串拼接",
    dimension: "performance",
    severity: "low",
    run: (c) => {
      const hits: Hit[] = [];
      const stringVars = new Set<string>();
      c.lines.forEach((l) => {
        const m = l.match(/^\s*([A-Za-z_]\w*)\s*=\s*["']/);
        if (m) stringVars.add(m[1]);
      });
      for (let i = 0; i < c.lines.length; i++) {
        if (!/^\s*(for|while)\b/.test(c.lines[i])) continue;
        const base = ind(c.lines[i]);
        for (let j = i + 1; j < c.lines.length; j++) {
          const line = c.lines[j];
          if (!line.trim()) continue;
          if (ind(line) <= base) break;
          const m = line.match(/([A-Za-z_]\w*)\s*\+=/);
          if (m && stringVars.has(m[1])) {
            hits.push({ line: j + 1, detail: "循环里反复拼接字符串，会不断分配新内存。", suggestion: "先 append 到列表，最后 join 一次。" });
          }
        }
        if (hits.length >= 2) break;
      }
      return hits;
    },
  },
  {
    id: "PER-003",
    title: "同一调用被重复执行",
    dimension: "performance",
    severity: "low",
    run: (c) => {
      const seen = new Map<string, number>();
      const hits: Hit[] = [];
      c.lines.forEach((l, i) => {
        const m = l.match(/\b([A-Za-z_][\w.]{2,}\([^()\n]*\))/g);
        if (!m) return;
        for (const call of m) {
          if (/^(print|len|range|append|push|log|String)\b/.test(call)) continue;
          const key = call.replace(/\s+/g, "");
          if (seen.has(key) && seen.get(key) !== i) {
            hits.push({ line: i + 1, detail: key + " 在别处已经算过一次，结果可以复用。", suggestion: "把结果存到变量里，只算一次。" });
            return;
          }
          seen.set(key, i);
        }
      });
      return hits.slice(0, 1);
    },
  },
  {
    id: "STY-001",
    title: "函数过长",
    dimension: "style",
    severity: "low",
    run: (c) => {
      if (!isPy(c)) return [];
      const starts: number[] = [];
      c.lines.forEach((l, i) => { if (/^\s*def\s+\w+/.test(l)) starts.push(i); });
      for (let k = 0; k < starts.length; k++) {
        const end = k + 1 < starts.length ? starts[k + 1] : c.lines.length;
        if (end - starts[k] > 80) return [{ line: starts[k] + 1, detail: "这个函数超过 80 行，职责可能过多。", suggestion: "按职责拆成几个小函数。" }];
      }
      return [];
    },
  },
  {
    id: "STY-002",
    title: "出现魔法数字",
    dimension: "style",
    severity: "low",
    run: (c) => {
      const hits: Hit[] = [];
      for (let i = 0; i < c.lines.length; i++) {
        const raw = c.lines[i];
        if (/^\s*(#|\/\/)/.test(raw)) continue;
        const line = raw.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
        const m = line.match(/(^|[^\w.)])([1-9]\d{1,})(?![\w.])/);
        if (m) {
          hits.push({ line: i + 1, detail: "数字 " + m[2] + " 直接写在代码里，含义不明。", suggestion: "抽成有名字的常量。" });
          if (hits.length >= 2) break;
        }
      }
      return hits;
    },
  },
  {
    id: "STY-003",
    title: "命名不符合语言习惯",
    dimension: "style",
    severity: "low",
    run: (c) => {
      const hits: Hit[] = [];
      c.lines.forEach((l, i) => {
        if (isPy(c) && /def\s+[a-z][a-z0-9]*[A-Z]\w*\s*\(/.test(l)) {
          hits.push({ line: i + 1, detail: "Python 函数习惯用 snake_case。", suggestion: "改成下划线命名。" });
        }
        if (isJs(c) && /\b(?:const|let|var)\s+[a-z][a-z0-9]*_[a-z]/.test(l)) {
          hits.push({ line: i + 1, detail: "JavaScript 变量习惯用 camelCase。", suggestion: "改成小驼峰命名。" });
        }
      });
      return hits.slice(0, 2);
    },
  },
  {
    id: "STY-004",
    title: "调试输出残留",
    dimension: "style",
    severity: "low",
    run: (c) => {
      const hits: Hit[] = [];
      c.lines.forEach((l, i) => {
        if (/(^|[^\w.])print\s*\(|console\.(log|debug)\s*\(/.test(l) && !/^\s*(#|\/\/)/.test(l)) {
          hits.push({ line: i + 1, detail: "上线前忘了删调试输出，可能带出敏感信息。", suggestion: "改用正式日志组件，并控制级别。" });
        }
      });
      return hits.slice(0, 2);
    },
  },
];

export interface RuleMeta {
  id: string;
  title: string;
  dimension: Dimension;
  severity: Severity;
}

export const RULE_META: RuleMeta[] = RULES.map((r) => ({
  id: r.id,
  title: r.title,
  dimension: r.dimension,
  severity: r.severity,
}));

export function runRules(ctx: RuleCtx, disabled?: Set<string>): Issue[] {
  const collected: Issue[] = [];
  let n = 0;
  for (const rule of RULES) {
    if (disabled && disabled.has(rule.id)) continue;
    let hits: Hit[] = [];
    try {
      hits = rule.run(ctx) || [];
    } catch {
      hits = [];
    }
    for (const h of hits.slice(0, 4)) {
      n += 1;
      collected.push({
        id: "i" + n,
        ruleId: rule.id,
        line: Math.max(1, Math.min(h.line, ctx.lines.length)),
        dimension: rule.dimension,
        severity: rule.severity,
        title: rule.title,
        detail: h.detail || rule.title,
        suggestion: h.suggestion || "",
      });
    }
  }

  const best = new Map<string, Issue>();
  for (const it of collected) {
    const key = it.line + "|" + it.dimension;
    const prev = best.get(key);
    if (!prev || SEV_RANK[it.severity] > SEV_RANK[prev.severity]) best.set(key, it);
  }
  return [...best.values()].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.line - b.line);
}

export const RULE_COUNT = RULES.length;

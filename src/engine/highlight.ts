import hljs from "highlight.js/lib/core";
import python from "highlight.js/lib/languages/python";
import javascript from "highlight.js/lib/languages/javascript";
import java from "highlight.js/lib/languages/java";
import type { Language } from "../types";

hljs.registerLanguage("python", python);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("java", java);

const NAME: Record<Language, string> = { python: "python", javascript: "javascript", java: "java" };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * hljs 的高亮结果可能跨行（多行字符串、注释），直接按 \n 切会把 span 截断。
 * 这里逐字符扫描，遇到换行时先闭合所有未闭合的 span，下一行再重新打开。
 */
function splitKeepTags(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let cur = "";
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === "<") {
      const end = html.indexOf(">", i);
      if (end < 0) {
        cur += html.slice(i);
        break;
      }
      const tag = html.slice(i, end + 1);
      if (tag.startsWith("</")) open.pop();
      else if (tag.startsWith("<span")) open.push(tag);
      cur += tag;
      i = end + 1;
      continue;
    }
    if (ch === "\n") {
      for (let k = open.length - 1; k >= 0; k -= 1) cur += "</span>";
      lines.push(cur);
      cur = open.join("");
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  for (let k = open.length - 1; k >= 0; k -= 1) cur += "</span>";
  lines.push(cur);
  return lines;
}

export function highlightLines(code: string, language: Language): string[] {
  try {
    const html = hljs.highlight(code, { language: NAME[language] || "python", ignoreIllegals: true }).value;
    return splitKeepTags(html);
  } catch {
    return code.split("\n").map(escapeHtml);
  }
}

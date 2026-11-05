export type Dimension = "security" | "syntax" | "logic" | "performance" | "style";
export type Severity = "high" | "mid" | "low";
export type Language = "python" | "javascript" | "java";

export interface Issue {
  id: string;
  ruleId: string;
  line: number;
  dimension: Dimension;
  severity: Severity;
  title: string;
  detail: string;
  suggestion: string;
}

export type Scores = Record<Dimension, number>;

export const DIMENSIONS: Dimension[] = ["security", "syntax", "logic", "performance", "style"];

export const DIM_LABEL: Record<Dimension, string> = {
  security: "安全",
  syntax: "语法",
  logic: "逻辑",
  performance: "性能",
  style: "规范",
};

export const DIM_COLOR: Record<Dimension, string> = {
  security: "#1E5A9A",
  syntax: "#2F6FBA",
  logic: "#4A8FD0",
  performance: "#6FA9DD",
  style: "#93C2E8",
};

export const SEV_LABEL: Record<Severity, string> = { high: "高危", mid: "中危", low: "提示" };
export const SEV_RANK: Record<Severity, number> = { high: 3, mid: 2, low: 1 };

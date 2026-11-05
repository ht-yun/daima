import type { Issue, Scores, Dimension } from "../types";
import { DIMENSIONS } from "../types";

const WEIGHT: Record<string, number> = { high: 15, mid: 8, low: 3 };

export function computeScores(issues: Issue[]): Scores {
  const out = {} as Scores;
  for (const d of DIMENSIONS) {
    const penalty = issues
      .filter((i) => i.dimension === d)
      .reduce((sum, i) => sum + (WEIGHT[i.severity] ?? 0), 0);
    out[d] = Math.max(0, Math.min(100, 100 - penalty));
  }
  return out;
}

export function average(scores: Scores): number {
  const total = DIMENSIONS.reduce((s, d) => s + scores[d], 0);
  return Math.round(total / DIMENSIONS.length);
}

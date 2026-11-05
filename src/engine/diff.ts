export type DiffRow = { type: "same" | "add" | "del"; oldNo: number | null; newNo: number | null; text: string };

export function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: "same", oldNo: i + 1, newNo: j + 1, text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", oldNo: i + 1, newNo: null, text: a[i] });
      i += 1;
    } else {
      rows.push({ type: "add", oldNo: null, newNo: j + 1, text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    rows.push({ type: "del", oldNo: i + 1, newNo: null, text: a[i] });
    i += 1;
  }
  while (j < m) {
    rows.push({ type: "add", oldNo: null, newNo: j + 1, text: b[j] });
    j += 1;
  }
  return rows;
}

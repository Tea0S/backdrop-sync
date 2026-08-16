/** Line-oriented diff helpers for conflict review (no external deps). */

export type DiffOp = "same" | "add" | "del";

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line number in the “before” (local) text, when applicable. */
  leftNo?: number;
  /** 1-based line number in the “after” (remote) text, when applicable. */
  rightNo?: number;
}

/** Split on newlines, keep empty trailing lines consistent. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/**
 * LCS-based line diff. Fine for article bodies (typically thousands of lines, not tens of thousands).
 */
export function diffLines(local: string, remote: string): DiffLine[] {
  const a = splitLines(local);
  const b = splitLines(remote);
  const n = a.length;
  const m = b.length;

  // dp[i][j] = LCS length of a[i..] and b[j..] — use rolling arrays for space when huge,
  // but for readability keep a full table with a size guard.
  if (n * m > 2_000_000) {
    // Fallback: treat whole bodies as replace when too large to LCS.
    const out: DiffLine[] = [];
    for (let i = 0; i < n; i++) out.push({ op: "del", text: a[i], leftNo: i + 1 });
    for (let j = 0; j < m; j++) out.push({ op: "add", text: b[j], rightNo: j + 1 });
    return out;
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i], leftNo: i + 1, rightNo: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: "del", text: a[i], leftNo: i + 1 });
      i++;
    } else {
      out.push({ op: "add", text: b[j], rightNo: j + 1 });
      j++;
    }
  }
  while (i < n) {
    out.push({ op: "del", text: a[i], leftNo: i + 1 });
    i++;
  }
  while (j < m) {
    out.push({ op: "add", text: b[j], rightNo: j + 1 });
    j++;
  }
  return out;
}

export function summarizeDiff(lines: DiffLine[]): { added: number; removed: number; unchanged: number } {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const line of lines) {
    if (line.op === "add") added++;
    else if (line.op === "del") removed++;
    else unchanged++;
  }
  return { added, removed, unchanged };
}

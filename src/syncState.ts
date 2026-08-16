import {
  hashContent,
  hashContentRaw,
  normalizeNewlines,
  splitFrontmatter,
} from "./frontmatter";

/** Bookkeeping / separately merged fields — not user article edits. */
const VOLATILE_FM = new Set([
  "backdrop_synced_at",
  "backdrop_updated_at",
  "discord_sync_enabled",
]);

/**
 * True when remote is meaningfully newer than our last sync stamp.
 * Uses a small skew so equal write times don't look like a dual-edit.
 */
export function remoteIsNewer(localSynced: string, remoteUpdated: string): boolean {
  if (!remoteUpdated) return false;
  if (!localSynced) return true;
  const a = Date.parse(localSynced);
  const b = Date.parse(remoteUpdated);
  if (Number.isNaN(a) || Number.isNaN(b)) return remoteUpdated > localSynced;
  return b > a + 1500;
}

function normalizeFmValue(value: unknown): unknown {
  if (value === undefined || value === "") return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return value.map(normalizeFmValue);
  }
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let any = false;
    for (const k of Object.keys(o).sort()) {
      const n = normalizeFmValue(o[k]);
      if (n === null) continue;
      out[k] = n;
      any = true;
    }
    return any ? out : null;
  }
  return value;
}

/** Stable snapshot of user-facing note content (body + non-volatile frontmatter). */
export function noteFingerprint(content: string): string {
  const { data, body } = splitFrontmatter(content);
  const norm: Record<string, unknown> = {};
  for (const k of Object.keys(data).sort()) {
    if (VOLATILE_FM.has(k)) continue;
    const n = normalizeFmValue(data[k]);
    if (n === null) continue;
    norm[k] = n;
  }
  const bodyNorm = normalizeNewlines(body)
    .replace(/[ \t]+$/gm, "")
    .replace(/\s+$/, "");
  return `${JSON.stringify(norm)}\n${bodyNorm}`;
}

export function hashNoteForSync(content: string): string {
  return hashContent(noteFingerprint(content));
}

export function notesSemanticallyEqual(localContent: string, remoteContent: string): boolean {
  return noteFingerprint(localContent) === noteFingerprint(remoteContent);
}

/**
 * True when `stored` is the current note hash or a legacy full-file hash.
 * CRLF vs LF and volatile timestamp fields do not count as local edits.
 */
export function contentMatchesStoredHash(content: string, stored?: string): boolean {
  if (!stored) return false;
  if (stored === hashNoteForSync(content)) return true;
  if (stored === hashContent(content)) return true;
  if (stored === hashContentRaw(content)) return true;
  return false;
}

export type PullDecision =
  | { action: "overwrite" }
  | { action: "skip-unchanged"; rehash: boolean }
  | { action: "skip-dirty" }
  | { action: "conflict" }
  | { action: "stamp" };

/**
 * 3-way pull: last-synced hash is the base.
 * - Local == base, remote differs → overwrite (fast-forward)
 * - Local != base, remote unchanged → keep local (not a conflict)
 * - Local != base, remote changed, content != remote → conflict
 * - Local content == remote content → not a conflict (rehash / stamp timestamps)
 */
export function decidePullAction(opts: {
  localContent: string;
  storedHash?: string;
  localSyncedAt: string;
  remoteUpdatedAt: string;
  remoteContent: string;
}): PullDecision {
  const hashClean = contentMatchesStoredHash(opts.localContent, opts.storedHash);
  const same = notesSemanticallyEqual(opts.localContent, opts.remoteContent);
  const remoteChanged = remoteIsNewer(opts.localSyncedAt, opts.remoteUpdatedAt);

  if (same) {
    if (remoteChanged) return { action: "stamp" };
    const current = hashNoteForSync(opts.localContent);
    return { action: "skip-unchanged", rehash: opts.storedHash !== current };
  }
  if (hashClean) {
    return { action: "overwrite" };
  }
  if (remoteChanged) return { action: "conflict" };
  return { action: "skip-dirty" };
}

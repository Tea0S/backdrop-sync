import type { CachedMetadata } from "obsidian";
import type { PullPack, WikiFrontmatter, TimelineFrontmatter } from "./types";

/**
 * Obsidian types frontmatter values as `any`. Narrow to a record so callers
 * can read fields as `unknown` without unsafe-assignment lint.
 */
export function frontmatterRecord(
  cache: CachedMetadata | null | undefined
): Record<string, unknown> | undefined {
  const fm: unknown = cache?.frontmatter;
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) return undefined;
  return fm as Record<string, unknown>;
}

export function parseWorldSlugs(raw: string): string[] {
  return String(raw || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function safePathSegment(input: string): string {
  return String(input || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80) || "untitled";
}

export function shortId(uuid: string): string {
  return String(uuid || "").replace(/-/g, "").slice(0, 8) || "new";
}

/** Wiki path uses human-readable category folder + title filename (not URL slug). */
export function wikiNotePath(
  vaultRoot: string,
  worldSlug: string,
  categoryFolder: string,
  articleTitle: string
): string {
  return [
    vaultRoot.replace(/\/+$/, ""),
    worldSlug,
    "wiki",
    safePathSegment(categoryFolder),
    `${safePathSegment(articleTitle)}.md`,
  ].join("/");
}

export function timelineNotePath(vaultRoot: string, worldSlug: string, title: string, id: string): string {
  return [
    vaultRoot.replace(/\/+$/, ""),
    worldSlug,
    "timeline",
    `${safePathSegment(title)}--${shortId(id)}.md`,
  ].join("/");
}

export function worldWikiRoot(vaultRoot: string, worldSlug: string): string {
  return [vaultRoot.replace(/\/+$/, ""), worldSlug, "wiki"].join("/");
}

export function worldTimelineRoot(vaultRoot: string, worldSlug: string): string {
  return [vaultRoot.replace(/\/+$/, ""), worldSlug, "timeline"].join("/");
}

export function stringifyFrontmatter(data: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    // Drop empty tags so we never write `tags: []` (pull omits the key entirely).
    if (key === "tags" && Array.isArray(value) && value.length === 0) continue;
    lines.push(`${key}: ${yamlValue(value)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function yamlValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (/[:#[\]{},&*!|>'"%@`]/.test(value) || value.includes("\n") || value.trim() !== value) {
      return JSON.stringify(value);
    }
    return value;
  }
  return JSON.stringify(value);
}

export function splitFrontmatter(content: string): { fm: string; body: string; data: Record<string, unknown> } {
  if (!content.startsWith("---")) {
    return { fm: "", body: content, data: {} };
  }
  const end = content.indexOf("\n---", 3);
  if (end < 0) return { fm: "", body: content, data: {} };
  const fmBlock = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\r?\n/, "");
  const data = parseSimpleYaml(fmBlock);
  return { fm: fmBlock, body, data };
}

function parseYamlScalar(raw: string): unknown {
  const s = String(raw || "").trim();
  if (s === "null") return null;
  if (s === "true" || s === "false") return s === "true";
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      return JSON.parse(s.replace(/^'/, '"').replace(/'$/, '"'));
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("[") || s.startsWith("{")) {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  return s;
}

/**
 * Minimal YAML subset for our frontmatter keys.
 * Supports inline JSON objects and one-level indented maps (Obsidian Properties
 * often rewrites `calendar_date: {...}` into a nested block).
 */
export function parseSimpleYaml(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = src.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    i += 1;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const raw = m[2].trim();
    if (raw === "" || raw === "|" || raw === ">") {
      const nested: Record<string, unknown> = {};
      while (i < lines.length) {
        const nl = lines[i];
        if (!nl.trim() || nl.trim().startsWith("#")) {
          i += 1;
          continue;
        }
        const nm = nl.match(/^([ \t]+)([A-Za-z0-9_]+):\s*(.*)$/);
        if (!nm) break;
        nested[nm[2]] = parseYamlScalar(nm[3]);
        i += 1;
      }
      out[key] = Object.keys(nested).length ? nested : raw === "" ? "" : raw;
      continue;
    }
    out[key] = parseYamlScalar(raw);
  }
  return out;
}

/** Structured calendar date suitable to send to the API, or undefined to leave remote unchanged. */
export function calendarDateForPublish(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const era = o.era != null && String(o.era).trim() && String(o.era).trim() !== "null" ? String(o.era).trim() : "";
  const year = Number.parseInt(String(o.year ?? ""), 10);
  const month = Number.parseInt(String(o.month ?? ""), 10);
  const day = Number.parseInt(String(o.day ?? ""), 10);
  const y = Number.isFinite(year) ? year : 0;
  const m = Number.isFinite(month) ? Math.max(0, month) : 0;
  const d = Number.isFinite(day) ? Math.max(0, day) : 0;
  if (!y && !m && !d && !era) return undefined;
  return { era, year: y, month: m, day: d };
}

export function normalizeNewlines(text: string): string {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function fnv1aHex(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/** FNV-1a of newline-normalized text. */
export function hashContent(content: string): string {
  return fnv1aHex(normalizeNewlines(content));
}

/** Pre-0.1.31 hashes were FNV of the raw string (CRLF on disk never matched). */
export function hashContentRaw(content: string): string {
  return fnv1aHex(String(content || ""));
}

export function wikiFrontmatterFromArticle(
  worldSlug: string,
  article: PullPack["articles"][0],
  syncedAt: string,
  opts?: { parentTitle?: string }
): WikiFrontmatter {
  const characters: string[] = [];
  const museIds: Array<string | null> = [];
  for (const c of article.characters || []) {
    const name = String(c.character_name || c.characterName || "").trim();
    if (!name) continue;
    characters.push(name);
    const mid = c.muse_id ?? c.museId ?? null;
    museIds.push(mid != null && String(mid).trim() ? String(mid).trim() : null);
  }
  const fm: WikiFrontmatter = {
    backdrop_type: "wiki",
    backdrop_id: article.id,
    backdrop_world: worldSlug,
    backdrop_slug: article.slug,
    title: article.title,
    category: article.category_slug || "general",
    status: article.status || "draft",
    summary: article.summary || "",
    thumbnail_url: article.thumbnail_url || "",
    characters,
    location_pin_ids: Array.isArray(article.location_pin_ids)
      ? article.location_pin_ids.map(String)
      : [],
    map_region_ids: Array.isArray(article.map_region_ids)
      ? article.map_region_ids.map(String)
      : [],
    parent_article_id: article.parent_article_id || null,
    backdrop_source: article.source || "manual",
    discord_sync_enabled:
      article.source === "pin" ? false : Boolean(article.discord_sync_enabled),
    backdrop_updated_at: article.updated_at || syncedAt,
    backdrop_synced_at: syncedAt,
  };
  if (museIds.some((m) => m)) fm.character_muse_ids = museIds;
  if (opts?.parentTitle) fm.parent = opts.parentTitle;
  return fm;
}

export function timelineFrontmatterFromEvent(
  worldSlug: string,
  event: PullPack["events"][0],
  laneName: string,
  eraName: string,
  syncedAt: string
): TimelineFrontmatter {
  return {
    backdrop_type: "timeline",
    backdrop_id: event.id,
    backdrop_world: worldSlug,
    title: event.title,
    status: event.status || "draft",
    event_kind: event.event_kind || "scene",
    calendar_date: event.calendar_date ?? null,
    end_calendar_date: event.end_calendar_date ?? null,
    date_precision: event.date_precision || "exact",
    date_granularity: event.date_granularity || undefined,
    lane: laneName || event.lane_id || "",
    era: eraName || event.era_id || "",
    header_image_url: event.header_image_url || "",
    backdrop_updated_at: event.updated_at || syncedAt,
    backdrop_synced_at: syncedAt,
  };
}

export function buildNoteFile(fm: Record<string, unknown>, body: string): string {
  return stringifyFrontmatter(fm) + (body || "").replace(/^\n+/, "");
}

/** Match BackDrop web/API `slugifyArticleTitle` (kebab-case, max 62). */
export function slugify(title: string): string {
  const base = String(title || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 62);
  return base || "article";
}

/**
 * Soft normalize while typing a slug (keeps a trailing hyphen so spaces feel responsive).
 * Match BackDrop web `normalizeSlugInput`.
 */
export function normalizeSlugInput(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63);
}

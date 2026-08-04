import type { PullPack, WikiFrontmatter, TimelineFrontmatter } from "./types";

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
    lines.push(`${key}: ${yamlValue(value)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function yamlValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (/[:#\[\]{},&*!|>'"%@`]/.test(value) || value.includes("\n") || value.trim() !== value) {
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

/** Minimal YAML subset for our frontmatter keys. */
export function parseSimpleYaml(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = src.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let raw = m[2].trim();
    if (raw === "null") {
      out[key] = null;
      continue;
    }
    if (raw === "true" || raw === "false") {
      out[key] = raw === "true";
      continue;
    }
    if (/^-?\d+(\.\d+)?$/.test(raw)) {
      out[key] = Number(raw);
      continue;
    }
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      try {
        out[key] = JSON.parse(raw.replace(/^'/, '"').replace(/'$/, '"'));
      } catch {
        out[key] = raw.slice(1, -1);
      }
      continue;
    }
    if (raw.startsWith("[") || raw.startsWith("{")) {
      try {
        out[key] = JSON.parse(raw);
      } catch {
        out[key] = raw;
      }
      continue;
    }
    out[key] = raw;
  }
  return out;
}

export function hashContent(content: string): string {
  let h = 2166136261;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function wikiFrontmatterFromArticle(
  worldSlug: string,
  article: PullPack["articles"][0],
  tagNames: string[],
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
    tags: tagNames,
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

export function slugify(title: string): string {
  const base = String(title || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 62);
  return base || "article";
}

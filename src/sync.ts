import { App, Notice, TFile, normalizePath } from "obsidian";
import type { BackdropClient } from "./api";
import { BackdropApiError, noticeError, sleepMs } from "./api";
import {
  buildNoteFile,
  frontmatterRecord,
  hashContent,
  parseWorldSlugs,
  splitFrontmatter,
  timelineFrontmatterFromEvent,
  timelineNotePath,
  wikiFrontmatterFromArticle,
  wikiNotePath,
  worldTimelineRoot,
  worldWikiRoot,
  slugify,
  safePathSegment,
} from "./frontmatter";
import type { BackdropSettings, PullPack, SyncBadgeState, WorldCatalogMeta } from "./types";
import { normalizeWikiBodyForVault } from "./markdown";
import { resolvePullTargets } from "./syncSelection";
import {
  WikiSlugIndex,
  rebuildWikiSlugIndex,
  rewriteObsidianToSlugs,
  rewriteSlugsToObsidian,
  scanWikiSlugIndex,
} from "./wikiLinks";

/** Max concurrent world pulls (API rate limits + avoid stampeding). */
const PULL_CONCURRENCY = 2;
/** Spacing between world pull starts / finishes. */
const PULL_GAP_MS = 300;
/** Spacing between bulk publish note requests. */
const PUBLISH_GAP_MS = 400;

/**
 * Run async work over items with bounded concurrency (order of results matches input).
 */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  gapMs = 0
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
      if (gapMs > 0 && i + 1 < items.length) await sleepMs(gapMs);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
export type { SyncBadgeState };

export function cacheWorldCatalog(settings: BackdropSettings, worldSlug: string, pack: PullPack): void {
  if (!settings.worldCatalogs) settings.worldCatalogs = {};
  const meta: WorldCatalogMeta = {
    categories: (pack.categories || []).map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      is_system: c.is_system,
    })),
    tags: (pack.tags || []).map((t) => ({ id: t.id, slug: t.slug, name: t.name })),
    eras: (pack.eras || []).map((e) => ({ id: e.id, name: e.name })),
    lanes: (pack.lanes || []).map((l) => ({
      id: l.id,
      name: l.name,
      is_default: l.is_default,
    })),
    pins: (pack.pins || []).map((p) => ({ id: p.id, name: p.name })),
    regions: (pack.regions || []).map((r) => ({ id: r.id, name: r.name })),
    pulledAt: pack.pulled_at,
    name: pack.world?.name || undefined,
  };
  settings.worldCatalogs[worldSlug] = meta;
  if (worldSlug) settings.lastWorldSlug = worldSlug;
}

/** Resolve pin/region ids from frontmatter (ids or catalog names). */
export function resolveLocationIds(
  settings: BackdropSettings,
  worldSlug: string,
  raw: unknown,
  kind: "pins" | "regions"
): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  if (raw.length === 0) return [];
  const catalog = settings.worldCatalogs?.[worldSlug];
  const list = kind === "pins" ? catalog?.pins || [] : catalog?.regions || [];
  const byId = new Map(list.map((x) => [x.id.toLowerCase(), x.id]));
  const byName = new Map(list.map((x) => [x.name.toLowerCase(), x.id]));
  const ids: string[] = [];
  for (const item of raw) {
    const key = String(item || "").trim();
    if (!key) continue;
    const lower = key.toLowerCase();
    const id =
      (/^[0-9a-f-]{36}$/i.test(key) ? key : null) ||
      byId.get(lower) ||
      byName.get(lower);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function charactersPayloadFromFrontmatter(data: Record<string, unknown>): Array<{
  characterName: string;
  museId?: string | null;
}> | undefined {
  if (!Array.isArray(data.characters)) return undefined;
  const museIds: unknown[] = Array.isArray(data.character_muse_ids) ? data.character_muse_ids : [];
  const out: Array<{ characterName: string; museId?: string | null }> = [];
  for (let i = 0; i < data.characters.length; i++) {
    const name = String(data.characters[i] ?? "").trim();
    if (!name) continue;
    const museRaw: unknown = museIds[i];
    const museId =
      museRaw != null && String(museRaw).trim() ? String(museRaw).trim() : null;
    out.push(museId ? { characterName: name, museId } : { characterName: name });
  }
  return out;
}

/**
 * Categories for a world: last-pull catalog (`worldCatalogs`) plus any
 * `category` values on local wiki notes under that world's vault folder.
 * Prefer catalog entries (name + slug); vault-only values use the raw slug/name.
 */
export function listWorldCategoryOptions(
  app: App,
  settings: BackdropSettings,
  worldSlug: string
): Array<{ slug: string; name: string }> {
  const slug = String(worldSlug || "").trim();
  if (!slug) return [];

  const bySlug = new Map<string, { slug: string; name: string }>();
  const catalog = settings.worldCatalogs?.[slug];
  for (const c of catalog?.categories || []) {
    const catSlug = String(c.slug || "").trim();
    if (!catSlug) continue;
    bySlug.set(catSlug, { slug: catSlug, name: String(c.name || catSlug).trim() || catSlug });
  }

  const root = settings.vaultRoot.replace(/\/+$/, "");
  const prefix = `${root}/${slug}/wiki/`;
  for (const file of app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(prefix) && !file.path.startsWith(normalizePath(prefix))) continue;
    const fm = frontmatterRecord(app.metadataCache.getFileCache(file));
    if (!fm) continue;
    if (String(fm.backdrop_type || "") !== "wiki") continue;
    const noteWorld = String(fm.backdrop_world || "").trim();
    if (noteWorld && noteWorld !== slug) continue;
    const cat = String(fm.category || "").trim();
    if (!cat || bySlug.has(cat)) continue;
    bySlug.set(cat, { slug: cat, name: cat });
  }

  return Array.from(bySlug.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

/** Prefer "general", else first known category, else empty (custom typing). */
export function defaultCategorySlug(
  options: Array<{ slug: string; name: string }>
): string {
  if (options.some((o) => o.slug === "general")) return "general";
  return options[0]?.slug || "";
}

/** Merge a newly created category/tag into the local world catalog cache. */
export function upsertCatalogCategory(
  settings: BackdropSettings,
  worldSlug: string,
  category: { id: string; slug: string; name: string; is_system?: boolean }
): void {
  if (!settings.worldCatalogs) settings.worldCatalogs = {};
  const cat = settings.worldCatalogs[worldSlug] || {
    categories: [],
    tags: [],
    eras: [],
    lanes: [],
    pins: [],
    regions: [],
  };
  const next = [...(cat.categories || [])];
  const idx = next.findIndex((c) => c.id === category.id || c.slug === category.slug);
  if (idx >= 0) next[idx] = { ...next[idx], ...category };
  else next.push(category);
  settings.worldCatalogs[worldSlug] = { ...cat, categories: next };
}

export function upsertCatalogTag(
  settings: BackdropSettings,
  worldSlug: string,
  tag: { id: string; slug: string; name: string }
): void {
  if (!settings.worldCatalogs) settings.worldCatalogs = {};
  const cat = settings.worldCatalogs[worldSlug] || {
    categories: [],
    tags: [],
    eras: [],
    lanes: [],
    pins: [],
    regions: [],
  };
  const next = [...(cat.tags || [])];
  const idx = next.findIndex((t) => t.id === tag.id || t.slug === tag.slug);
  if (idx >= 0) next[idx] = { ...next[idx], ...tag };
  else next.push(tag);
  settings.worldCatalogs[worldSlug] = { ...cat, tags: next };
}

export function addConflictPath(settings: BackdropSettings, path: string): void {
  const norm = normalizePath(path);
  if (!settings.conflictPaths) settings.conflictPaths = [];
  if (!settings.conflictPaths.includes(norm)) {
    settings.conflictPaths.push(norm);
  }
}

export function clearConflictPath(settings: BackdropSettings, path: string): void {
  const norm = normalizePath(path);
  if (!settings.conflictPaths?.length) return;
  settings.conflictPaths = settings.conflictPaths.filter((p) => p !== norm);
}

/** Map frontmatter tag names/slugs to API tag_ids using the cached pull catalog. */
export function resolveTagIdsForPublish(
  settings: BackdropSettings,
  worldSlug: string,
  tags: unknown
): string[] | undefined {
  if (!Array.isArray(tags)) return undefined;
  if (tags.length === 0) return [];
  const catalog = settings.worldCatalogs?.[worldSlug];
  if (!catalog?.tags?.length) return undefined;
  const byName = new Map(catalog.tags.map((t) => [t.name.toLowerCase(), t.id]));
  const bySlug = new Map(catalog.tags.map((t) => [t.slug.toLowerCase(), t.id]));
  const ids: string[] = [];
  for (const raw of tags) {
    const key = String(raw || "").trim().toLowerCase();
    if (!key) continue;
    const id = byName.get(key) || bySlug.get(key);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export async function getSyncBadgeState(
  app: App,
  file: TFile,
  settings: BackdropSettings
): Promise<SyncBadgeState> {
  const content = await app.vault.read(file);
  const { data } = splitFrontmatter(content);
  const id = String(data.backdrop_id || "").trim();
  if (!id) return "unpublished";

  const path = normalizePath(file.path);
  const dirty = await fileIsDirty(app, file, settings);
  const inConflict = (settings.conflictPaths || []).includes(path);
  const remoteUpdated = String(data.backdrop_updated_at || "");
  const localSynced = String(data.backdrop_synced_at || "");
  if (inConflict || (dirty && remoteUpdated && localSynced && remoteUpdated > localSynced)) {
    return "conflict";
  }
  if (dirty) return "dirty";
  return "clean";
}

export function syncBadgeLabel(state: SyncBadgeState): string {
  switch (state) {
    case "conflict":
      return "BackDrop · Conflict";
    case "dirty":
      return "BackDrop · Dirty";
    case "unpublished":
      return "BackDrop · Unpublished";
    default:
      return "BackDrop · Clean";
  }
}

export type PullMode = "startup" | "full" | "force-current";

export interface PullOptions {
  mode: PullMode;
  /** Absolute vault path of the note to force-overwrite (force-current). */
  currentPath?: string;
  /** Pull wiki articles for this world (default true). */
  syncWiki?: boolean;
  /** Pull timeline events for this world (default true). */
  syncTimeline?: boolean;
  /** Invoked from the pull Notice “Review conflicts” button. */
  onReviewConflicts?: (paths: string[]) => void;
}

export interface SyncStats {
  created: number;
  updated: number;
  skippedDirty: number;
  skippedUnchanged: number;
  skippedExisting: number;
  conflicts: string[];
  articleStatusCounts: Record<string, number>;
  eventStatusCounts: Record<string, number>;
}

function ensureFolderPath(app: App, folderPath: string): Promise<void> {
  const parts = folderPath.split("/").filter(Boolean);
  let cur = "";
  return (async () => {
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      const exists = app.vault.getAbstractFileByPath(cur);
      if (!exists) {
        await app.vault.createFolder(cur);
      }
    }
  })();
}

async function writeNote(
  app: App,
  path: string,
  content: string,
  settings: BackdropSettings,
  saveSettings: () => Promise<void>
): Promise<"created" | "updated"> {
  const norm = normalizePath(path);
  const folder = norm.includes("/") ? norm.slice(0, norm.lastIndexOf("/")) : "";
  if (folder) await ensureFolderPath(app, folder);
  const existing = app.vault.getAbstractFileByPath(norm);
  settings.contentHashes[norm] = hashContent(content);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
    await saveSettings();
    return "updated";
  }
  await app.vault.create(norm, content);
  await saveSettings();
  return "created";
}

export async function fileIsDirty(app: App, file: TFile, settings: BackdropSettings): Promise<boolean> {
  const content = await app.vault.read(file);
  const prev = settings.contentHashes[normalizePath(file.path)];
  if (!prev) return false;
  return hashContent(content) !== prev;
}

/** Frontmatter visibility for API push — Sync means push, not “set published”. */
export function normalizePublishStatus(raw: unknown): string {
  const s = String(raw ?? "draft").trim().toLowerCase();
  if (s === "published" || s === "unlisted" || s === "draft") return s;
  return "draft";
}

/** Clamp status to options allowed for the note type (timeline has no unlisted). */
export function normalizePublishStatusForType(type: string, raw: unknown): string {
  const s = normalizePublishStatus(raw);
  if (type === "timeline" && s === "unlisted") return "draft";
  return s;
}

/**
 * True when full/startup pull must not overwrite this note.
 * Protects hash-dirty notes and unhashed notes whose body differs from remote.
 */
async function isProtectedFromOverwrite(
  app: App,
  file: TFile,
  settings: BackdropSettings,
  remoteBody: string
): Promise<{ protected: boolean; dirty: boolean }> {
  const dirty = await fileIsDirty(app, file, settings);
  if (dirty) return { protected: true, dirty: true };
  const prev = settings.contentHashes[normalizePath(file.path)];
  if (prev) return { protected: false, dirty: false };
  const current = await app.vault.read(file);
  const { body: localBody } = splitFrontmatter(current);
  if ((localBody || "").trim() !== (remoteBody || "").trim()) {
    return { protected: true, dirty: false };
  }
  return { protected: false, dirty: false };
}

/** Remote is newer (or timestamps unknown) so a pull would have written. */
function remoteWouldOverwrite(localSynced: string, remoteUpdated: string): boolean {
  if (!localSynced || !remoteUpdated) return true;
  return remoteUpdated > localSynced;
}

interface NoteIndex {
  byId: Map<string, TFile>;
  bySlug: Map<string, TFile>;
}

async function indexWorldNotes(
  app: App,
  rootPrefix: string,
  idKey: "backdrop_id",
  slugKey?: "backdrop_slug"
): Promise<NoteIndex> {
  const byId = new Map<string, TFile>();
  const bySlug = new Map<string, TFile>();
  const prefix = rootPrefix.endsWith("/") ? rootPrefix : `${rootPrefix}/`;
  for (const file of app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(prefix) && file.path !== rootPrefix) continue;
    const content = await app.vault.read(file);
    const { data } = splitFrontmatter(content);
    const id = String(data[idKey] || "").trim();
    if (id) byId.set(id, file);
    if (slugKey) {
      const slug = String(data[slugKey] || "").trim();
      if (slug) bySlug.set(slug, file);
    }
  }
  return { byId, bySlug };
}

/**
 * Resolve existing note: backdrop_id → backdrop_slug → expected path.
 * If found elsewhere and expected path is free, rename/move to title-based path.
 */
async function resolveNoteFile(
  app: App,
  settings: BackdropSettings,
  saveSettings: () => Promise<void>,
  expectedPath: string,
  index: NoteIndex,
  match: { id?: string; slug?: string }
): Promise<{ file: TFile | null; path: string }> {
  const expectedNorm = normalizePath(expectedPath);

  let found: TFile | null = null;
  if (match.id && index.byId.has(match.id)) {
    found = index.byId.get(match.id)!;
  } else if (match.slug && index.bySlug.has(match.slug)) {
    found = index.bySlug.get(match.slug)!;
  } else {
    const atExpected = app.vault.getAbstractFileByPath(expectedNorm);
    if (atExpected instanceof TFile) {
      return { file: atExpected, path: expectedNorm };
    }
    return { file: null, path: expectedNorm };
  }

  const oldNorm = normalizePath(found.path);
  if (oldNorm === expectedNorm) {
    return { file: found, path: expectedNorm };
  }

  const destTaken = app.vault.getAbstractFileByPath(expectedNorm);
  if (destTaken) {
    // Keep existing location if title path is occupied by something else.
    return { file: found, path: oldNorm };
  }

  const folder = expectedNorm.includes("/") ? expectedNorm.slice(0, expectedNorm.lastIndexOf("/")) : "";
  if (folder) await ensureFolderPath(app, folder);
  await app.fileManager.renameFile(found, expectedNorm);
  const hash = settings.contentHashes[oldNorm];
  if (hash) {
    delete settings.contentHashes[oldNorm];
    settings.contentHashes[expectedNorm] = hash;
    await saveSettings();
  }
  if (match.id) index.byId.set(match.id, found);
  if (match.slug) index.bySlug.set(match.slug, found);
  return { file: found, path: expectedNorm };
}

function categoryFolderName(pack: PullPack, article: PullPack["articles"][0]): string {
  const slug = article.category_slug || "general";
  const cat = pack.categories.find((c) => c.slug === slug);
  const name = cat?.name ? String(cat.name).trim() : "";
  if (!name) return safePathSegment(slug);
  // Multiple categories can share a display name (e.g. two "General" rows). On
  // case-insensitive filesystems those would collide and drop notes on pull.
  const sameName = pack.categories.filter((c) => String(c.name || "").trim() === name);
  if (sameName.length > 1) {
    return safePathSegment(`${name} (${slug})`);
  }
  return safePathSegment(name);
}

function countByStatus(items: Array<{ status?: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const key = String(item.status || "unknown");
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function formatStatusCounts(counts: Record<string, number>): string {
  const order = ["draft", "unlisted", "published"];
  const parts: string[] = [];
  for (const key of order) {
    if (counts[key]) parts.push(`${counts[key]} ${key}`);
  }
  for (const [key, n] of Object.entries(counts)) {
    if (!order.includes(key) && n) parts.push(`${n} ${key}`);
  }
  return parts.join(", ");
}

/** Rewrite BackDrop slug wikilinks in a body for Obsidian (title targets). */
function bodyForVault(body: string, worldSlug: string, slugIndex: WikiSlugIndex): string {
  // Heal image URLs first (TipTap nested-link mangling, media proxy, spaces),
  // then rewrite slug wikilinks (images are protected during rewrite).
  return rewriteSlugsToObsidian(normalizeWikiBodyForVault(body || ""), worldSlug, slugIndex);
}

/**
 * If a skipped/unchanged note still has slug-form `[[links]]`, rewrite in place
 * so core Backlinks work without forcing a full body pull.
 */
async function normalizeLinksInPlace(
  app: App,
  file: TFile,
  worldSlug: string,
  slugIndex: WikiSlugIndex,
  settings: BackdropSettings,
  saveSettings: () => Promise<void>
): Promise<boolean> {
  const content = await app.vault.read(file);
  const { data, body } = splitFrontmatter(content);
  const nextBody = bodyForVault(body, worldSlug, slugIndex);
  if (nextBody === body) return false;
  const next = buildNoteFile(data, nextBody);
  await app.vault.modify(file, next);
  settings.contentHashes[normalizePath(file.path)] = hashContent(next);
  await saveSettings();
  return true;
}

export async function pullWorld(
  app: App,
  client: BackdropClient,
  worldSlug: string,
  settings: BackdropSettings,
  saveSettings: () => Promise<void>,
  options: PullOptions = { mode: "full" },
  slugIndex?: WikiSlugIndex
): Promise<SyncStats> {
  const pack = await client.pull(worldSlug);
  cacheWorldCatalog(settings, worldSlug, pack);
  await saveSettings();
  const syncedAt = pack.pulled_at || new Date().toISOString();
  const laneById = new Map(pack.lanes.map((l) => [l.id, l.name]));
  const eraById = new Map(pack.eras.map((e) => [e.id, e.name]));
  const articleTitleById = new Map(
    (pack.articles || []).map((a) => [a.id, a.title] as const)
  );
  const mode = options.mode;
  const forcePath = options.currentPath ? normalizePath(options.currentPath) : "";
  // force-current always pulls the matching note type; otherwise honor facet toggles.
  const syncWiki = mode === "force-current" ? true : options.syncWiki !== false;
  const syncTimeline = mode === "force-current" ? true : options.syncTimeline !== false;

  const stats: SyncStats = {
    created: 0,
    updated: 0,
    skippedDirty: 0,
    skippedUnchanged: 0,
    skippedExisting: 0,
    conflicts: [],
    articleStatusCounts: syncWiki ? countByStatus(pack.articles || []) : {},
    eventStatusCounts: syncTimeline ? countByStatus(pack.events || []) : {},
  };

  let forceMeta: { type: string; id: string } | null = null;
  if (mode === "force-current" && forcePath) {
    const forceFile = app.vault.getAbstractFileByPath(forcePath);
    if (!(forceFile instanceof TFile)) {
      return stats;
    }
    const content = await app.vault.read(forceFile);
    const { data } = splitFrontmatter(content);
    const type = String(data.backdrop_type || "");
    const id = String(data.backdrop_id || "").trim();
    const world = String(data.backdrop_world || "").trim();
    if (!id || (type !== "wiki" && type !== "timeline") || world !== worldSlug) {
      return stats;
    }
    forceMeta = { type, id };
  }

  const wikiIndex = await indexWorldNotes(app, worldWikiRoot(settings.vaultRoot, worldSlug), "backdrop_id", "backdrop_slug");
  const timelineIndex = await indexWorldNotes(app, worldTimelineRoot(settings.vaultRoot, worldSlug), "backdrop_id");

  // Slug → title index for wikilink rewrite (vault scan + pack titles).
  const linkIndex = slugIndex || (await scanWikiSlugIndex(app, settings.vaultRoot));
  linkIndex.mergePullPack(settings.vaultRoot, worldSlug, pack, (article) => categoryFolderName(pack, article));

  // Pull every non-trashed article the API returns (draft / unlisted / published).
  for (const article of syncWiki ? pack.articles || [] : []) {
    if (mode === "force-current") {
      if (!forceMeta || forceMeta.type !== "wiki" || forceMeta.id !== article.id) continue;
    }

    const catFolder = categoryFolderName(pack, article);
    const expectedPath = wikiNotePath(settings.vaultRoot, worldSlug, catFolder, article.title);
    const expectedNorm = normalizePath(expectedPath);
    const vaultBody = bodyForVault(article.body_markdown || "", worldSlug, linkIndex);

    // Startup: create missing only — no rename, no body overwrite.
    if (mode === "startup") {
      const atExpected = app.vault.getAbstractFileByPath(expectedNorm);
      if (
        atExpected instanceof TFile ||
        wikiIndex.byId.has(article.id) ||
        wikiIndex.bySlug.has(article.slug)
      ) {
        stats.skippedExisting += 1;
        continue;
      }
      const parentTitle = article.parent_article_id
        ? articleTitleById.get(article.parent_article_id) || ""
        : "";
      const fm = wikiFrontmatterFromArticle(worldSlug, article, syncedAt, {
        parentTitle,
      });
      const content = buildNoteFile(fm as unknown as Record<string, unknown>, vaultBody);
      const result = await writeNote(app, expectedNorm, content, settings, saveSettings);
      if (result === "created") stats.created += 1;
      else stats.updated += 1;
      continue;
    }

    const { file: existing, path } =
      mode === "force-current" && forcePath
        ? (() => {
            const abs = app.vault.getAbstractFileByPath(forcePath);
            return {
              file: abs instanceof TFile ? abs : null,
              path: forcePath,
            };
          })()
        : await resolveNoteFile(app, settings, saveSettings, expectedPath, wikiIndex, {
            id: article.id,
            slug: article.slug,
          });

    if (existing instanceof TFile) {
      if (mode === "full") {
        const current = await app.vault.read(existing);
        const { data } = splitFrontmatter(current);
        const localSynced = String(data.backdrop_synced_at || "");
        const remoteUpdated = String(article.updated_at || "");
        const { protected: protect } = await isProtectedFromOverwrite(
          app,
          existing,
          settings,
          vaultBody
        );
        if (protect) {
          stats.skippedDirty += 1;
          // Only flag conflict when remote would have overwritten local work.
          if (remoteWouldOverwrite(localSynced, remoteUpdated)) {
            stats.conflicts.push(path);
            addConflictPath(settings, path);
          }
          continue;
        }
        if (localSynced && remoteUpdated && remoteUpdated <= localSynced) {
          await normalizeLinksInPlace(app, existing, worldSlug, linkIndex, settings, saveSettings);
          stats.skippedUnchanged += 1;
          continue;
        }
      }
      // force-current: always overwrite
    } else if (mode === "force-current") {
      continue;
    }

    const parentTitle = article.parent_article_id
      ? articleTitleById.get(article.parent_article_id) || ""
      : "";
    const fm = wikiFrontmatterFromArticle(worldSlug, article, syncedAt, {
      parentTitle,
    });
    const content = buildNoteFile(fm as unknown as Record<string, unknown>, vaultBody);
    const result = await writeNote(app, path, content, settings, saveSettings);
    clearConflictPath(settings, path);
    if (result === "created") stats.created += 1;
    else stats.updated += 1;

    if (mode === "force-current" && forcePath && forcePath !== expectedNorm) {
      const destTaken = app.vault.getAbstractFileByPath(expectedNorm);
      const cur = app.vault.getAbstractFileByPath(forcePath);
      if (!destTaken && cur instanceof TFile) {
        const folder = expectedPath.includes("/") ? expectedPath.slice(0, expectedPath.lastIndexOf("/")) : "";
        if (folder) await ensureFolderPath(app, folder);
        await app.fileManager.renameFile(cur, expectedNorm);
        const hash = settings.contentHashes[forcePath];
        if (hash) {
          delete settings.contentHashes[forcePath];
          settings.contentHashes[expectedNorm] = hash;
          clearConflictPath(settings, forcePath);
          clearConflictPath(settings, expectedNorm);
          await saveSettings();
        }
      }
    }
  }

  // Pull every timeline event the API returns (draft + published).
  for (const event of syncTimeline ? pack.events || [] : []) {
    if (mode === "force-current") {
      if (!forceMeta || forceMeta.type !== "timeline" || forceMeta.id !== event.id) continue;
    }

    const expectedPath = timelineNotePath(settings.vaultRoot, worldSlug, event.title, event.id);
    const expectedNorm = normalizePath(expectedPath);
    const vaultBody = bodyForVault(event.body_markdown || "", worldSlug, linkIndex);

    // Startup: create missing only — no rename, no body overwrite.
    if (mode === "startup") {
      const atExpected = app.vault.getAbstractFileByPath(expectedNorm);
      if (atExpected instanceof TFile || timelineIndex.byId.has(event.id)) {
        stats.skippedExisting += 1;
        continue;
      }
      const fm = timelineFrontmatterFromEvent(
        worldSlug,
        event,
        laneById.get(String(event.lane_id || "")) || "",
        eraById.get(String(event.era_id || "")) || "",
        syncedAt
      );
      const content = buildNoteFile(fm as unknown as Record<string, unknown>, vaultBody);
      const result = await writeNote(app, expectedNorm, content, settings, saveSettings);
      if (result === "created") stats.created += 1;
      else stats.updated += 1;
      continue;
    }

    const { file: existing, path } =
      mode === "force-current" && forcePath
        ? (() => {
            const abs = app.vault.getAbstractFileByPath(forcePath);
            return {
              file: abs instanceof TFile ? abs : null,
              path: forcePath,
            };
          })()
        : await resolveNoteFile(app, settings, saveSettings, expectedPath, timelineIndex, {
            id: event.id,
          });

    if (existing instanceof TFile) {
      if (mode === "full") {
        const current = await app.vault.read(existing);
        const { data } = splitFrontmatter(current);
        const localSynced = String(data.backdrop_synced_at || "");
        const remoteUpdated = String(event.updated_at || "");
        const { protected: protect } = await isProtectedFromOverwrite(
          app,
          existing,
          settings,
          vaultBody
        );
        if (protect) {
          stats.skippedDirty += 1;
          if (remoteWouldOverwrite(localSynced, remoteUpdated)) {
            stats.conflicts.push(path);
            addConflictPath(settings, path);
          }
          continue;
        }
        if (localSynced && remoteUpdated && remoteUpdated <= localSynced) {
          await normalizeLinksInPlace(app, existing, worldSlug, linkIndex, settings, saveSettings);
          stats.skippedUnchanged += 1;
          continue;
        }
      }
      // force-current: always overwrite
    } else if (mode === "force-current") {
      continue;
    }

    const fm = timelineFrontmatterFromEvent(
      worldSlug,
      event,
      laneById.get(String(event.lane_id || "")) || "",
      eraById.get(String(event.era_id || "")) || "",
      syncedAt
    );
    const content = buildNoteFile(fm as unknown as Record<string, unknown>, vaultBody);
    const result = await writeNote(app, path, content, settings, saveSettings);
    clearConflictPath(settings, path);
    if (result === "created") stats.created += 1;
    else stats.updated += 1;

    if (mode === "force-current" && forcePath && forcePath !== expectedNorm) {
      const destTaken = app.vault.getAbstractFileByPath(expectedNorm);
      const cur = app.vault.getAbstractFileByPath(forcePath);
      if (!destTaken && cur instanceof TFile) {
        const folder = expectedPath.includes("/") ? expectedPath.slice(0, expectedPath.lastIndexOf("/")) : "";
        if (folder) await ensureFolderPath(app, folder);
        await app.fileManager.renameFile(cur, expectedNorm);
        const hash = settings.contentHashes[forcePath];
        if (hash) {
          delete settings.contentHashes[forcePath];
          settings.contentHashes[expectedNorm] = hash;
          clearConflictPath(settings, forcePath);
          clearConflictPath(settings, expectedNorm);
          await saveSettings();
        }
      }
    }
  }

  if (stats.conflicts.length) {
    await saveSettings();
  }

  if (slugIndex) {
    await rebuildWikiSlugIndex(app, slugIndex, settings.vaultRoot);
  }

  return stats;
}

export async function pullAll(
  app: App,
  client: BackdropClient,
  settings: BackdropSettings,
  saveSettings: () => Promise<void>,
  options: PullOptions = { mode: "full" },
  slugIndex?: WikiSlugIndex
): Promise<{ conflicts: string[] }> {
  if (options.mode === "force-current") {
    await pullCurrentNote(app, client, settings, saveSettings, options.currentPath, slugIndex);
    return { conflicts: [] };
  }

  let apiWorlds: Awaited<ReturnType<BackdropClient["worlds"]>>["worlds"] = [];
  const needsWorldList =
    !settings.syncWorldsConfigured && !parseWorldSlugs(settings.worldSlugs).length;
  if (needsWorldList) {
    try {
      apiWorlds = (await client.worlds()).worlds || [];
    } catch (e) {
      noticeError(e, "List worlds");
      return { conflicts: [] };
    }
  }

  const resolved = resolvePullTargets(settings, apiWorlds);
  if (!resolved.ok) {
    if (resolved.reason === "none-selected") {
      new Notice("BackDrop: pick worlds to sync in Settings → BackDrop.");
    } else {
      new Notice("BackDrop: no worlds available for this API key.");
    }
    return { conflicts: [] };
  }

  let created = 0;
  let updated = 0;
  let dirty = 0;
  let skippedExisting = 0;
  const conflicts: string[] = [];
  const articleStatusCounts: Record<string, number> = {};
  const eventStatusCounts: Record<string, number> = {};
  // Bounded concurrency (not Promise.all over every world) to respect API rate limits.
  await mapPool(
    resolved.targets,
    PULL_CONCURRENCY,
    async (target) => {
      try {
        const stats = await pullWorld(
          app,
          client,
          target.slug,
          settings,
          saveSettings,
          {
            ...options,
            syncWiki: target.syncWiki,
            syncTimeline: target.syncTimeline,
          },
          slugIndex
        );
        created += stats.created;
        updated += stats.updated;
        dirty += stats.skippedDirty;
        skippedExisting += stats.skippedExisting;
        conflicts.push(...stats.conflicts);
        for (const [k, n] of Object.entries(stats.articleStatusCounts || {})) {
          articleStatusCounts[k] = (articleStatusCounts[k] || 0) + n;
        }
        for (const [k, n] of Object.entries(stats.eventStatusCounts || {})) {
          eventStatusCounts[k] = (eventStatusCounts[k] || 0) + n;
        }
      } catch (e) {
        noticeError(e, `Pull ${target.slug}`);
      }
    },
    PULL_GAP_MS
  );
  if (slugIndex) {
    await rebuildWikiSlugIndex(app, slugIndex, settings.vaultRoot);
  }
  const wikiStatus = formatStatusCounts(articleStatusCounts);
  const timelineStatus = formatStatusCounts(eventStatusCounts);
  const uniqueConflicts = [...new Set(conflicts.map((p) => normalizePath(p)))];
  if (options.mode === "startup") {
    new Notice(
      `BackDrop startup pull: ${created} created` +
        (skippedExisting ? `, ${skippedExisting} existing skipped` : "") +
        (wikiStatus ? ` · wiki ${wikiStatus}` : "")
    );
  } else {
    const conflictN = uniqueConflicts.length;
    const notice = new Notice(
      `BackDrop pull: ${created} created, ${updated} updated` +
        (dirty ? `, ${dirty} skipped (local edits kept)` : "") +
        (conflictN
          ? ` · ${conflictN} conflict${conflictN === 1 ? "" : "s"} — open Review sync conflicts`
          : "") +
        (wikiStatus ? ` · wiki ${wikiStatus}` : "") +
        (timelineStatus ? ` · timeline ${timelineStatus}` : ""),
      conflictN ? 12000 : 5000
    );
    if (conflictN) {
      const actions = notice.messageEl.createDiv({ cls: "bd-notice-actions" });
      const btn = actions.createEl("button", {
        text: "Review conflicts",
        cls: "mod-cta",
      });
      btn.addEventListener("click", (evt) => {
        evt.preventDefault();
        notice.hide();
        options.onReviewConflicts?.(uniqueConflicts);
      });
    }
  }
  if (uniqueConflicts.length) {
    console.warn("[backdrop-sync] dirty conflicts", uniqueConflicts);
  }
  return { conflicts: uniqueConflicts };
}

export async function pullCurrentNote(
  app: App,
  client: BackdropClient,
  settings: BackdropSettings,
  saveSettings: () => Promise<void>,
  currentPath?: string,
  slugIndex?: WikiSlugIndex
): Promise<void> {
  const path = currentPath || app.workspace.getActiveFile()?.path;
  if (!path) {
    new Notice("BackDrop: open a wiki or timeline note to pull.");
    return;
  }
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (!(file instanceof TFile)) {
    new Notice("BackDrop: open a wiki or timeline note to pull.");
    return;
  }
  const content = await app.vault.read(file);
  const { data } = splitFrontmatter(content);
  const type = String(data.backdrop_type || "");
  const worldSlug = String(data.backdrop_world || "").trim();
  const id = String(data.backdrop_id || "").trim();
  if (!worldSlug || !id || (type !== "wiki" && type !== "timeline")) {
    new Notice("BackDrop: note needs backdrop_type, backdrop_world, and backdrop_id.");
    return;
  }

  const dirty = await fileIsDirty(app, file, settings);
  if (dirty) {
    new Notice("BackDrop: overwriting local edits on this note from server…");
  }

  const stats = await pullWorld(
    app,
    client,
    worldSlug,
    settings,
    saveSettings,
    {
      mode: "force-current",
      currentPath: normalizePath(file.path),
    },
    slugIndex
  );
  if (stats.updated + stats.created === 0) {
    new Notice("BackDrop: matching remote article/event not found.");
    return;
  }
  clearConflictPath(settings, file.path);
  await saveSettings();
  new Notice(
    dirty
      ? "BackDrop: pulled current note (local edits overwritten)."
      : "BackDrop: pulled current note."
  );
}

async function rewriteLocalMedia(
  app: App,
  client: BackdropClient,
  worldSlug: string,
  body: string,
  sourcePath: string
): Promise<string> {
  const folder = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
  let out = body;

  const imageRe = /!\[([^\]]*)\]\(([^)]+)\)(\{align=(left|center|right)\})?/g;
  const matches = [...body.matchAll(imageRe)];
  for (const m of matches) {
    const url = m[2];
    if (/^https?:\/\//i.test(url)) continue;
    const rel = normalizePath(url.startsWith("/") ? url.slice(1) : folder ? `${folder}/${url}` : url);
    const file = app.vault.getAbstractFileByPath(rel);
    if (!(file instanceof TFile)) continue;
    const data = await app.vault.readBinary(file);
    const ext = file.extension.toLowerCase();
    const mime =
      ext === "png"
        ? "image/png"
        : ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "gif"
            ? "image/gif"
            : ext === "webp"
              ? "image/webp"
              : "application/octet-stream";
    const publicUrl = await client.uploadAsset(worldSlug, file.name, mime, data);
    out = out.split(m[0]).join(`![${m[1]}](${publicUrl})${m[3] || ""}`);
  }

  const audioRe = /\[([^\]]*)\]\(([^)]+\.(?:mp3|ogg|wav|m4a|aac|flac|webm))\)/gi;
  const audioMatches = [...out.matchAll(audioRe)];
  for (const m of audioMatches) {
    const url = m[2];
    if (/^https?:\/\//i.test(url)) continue;
    const rel = normalizePath(url.startsWith("/") ? url.slice(1) : folder ? `${folder}/${url}` : url);
    const file = app.vault.getAbstractFileByPath(rel);
    if (!(file instanceof TFile)) continue;
    const data = await app.vault.readBinary(file);
    const publicUrl = await client.uploadAsset(worldSlug, file.name, "audio/mpeg", data);
    out = out.split(m[0]).join(`[${m[1]}](${publicUrl})`);
  }

  return out;
}

export async function publishFile(
  app: App,
  client: BackdropClient,
  file: TFile,
  settings: BackdropSettings,
  saveSettings: () => Promise<void>,
  opts: { force?: boolean; slugIndex?: WikiSlugIndex } = {}
): Promise<void> {
  const content = await app.vault.read(file);
  const { data, body } = splitFrontmatter(content);
  const type = String(data.backdrop_type || "");
  const worldSlug = String(data.backdrop_world || "").trim();
  if (!worldSlug || (type !== "wiki" && type !== "timeline")) {
    throw new Error("Note is missing backdrop_type / backdrop_world frontmatter.");
  }

  const bodyWithMedia = await rewriteLocalMedia(
    app,
    client,
    worldSlug,
    normalizeWikiBodyForVault(body),
    file.path
  );
  const linkIndex = opts.slugIndex || (await scanWikiSlugIndex(app, settings.vaultRoot));
  // API expects BackDrop slug wikilinks; vault keeps Obsidian title links.
  const bodyForApi = normalizeWikiBodyForVault(
    rewriteObsidianToSlugs(bodyWithMedia, worldSlug, linkIndex)
  );
  const ifUpdated = String(data.backdrop_updated_at || "") || undefined;

  if (type === "wiki") {
    const payload: Record<string, unknown> = {
      title: String(data.title || file.basename),
      slug: String(data.backdrop_slug || slugify(String(data.title || file.basename))),
      category_slug: String(data.category || "general"),
      body_markdown: bodyForApi,
      summary: data.summary != null ? String(data.summary) : "",
      status: normalizePublishStatusForType("wiki", data.status),
      if_updated_at: ifUpdated,
      force: opts.force === true,
    };
    if ("thumbnail_url" in data) {
      payload.thumbnail_url = data.thumbnail_url ? String(data.thumbnail_url) : null;
    }
    if ("parent_article_id" in data) {
      const pid = data.parent_article_id;
      payload.parent_article_id =
        pid != null && String(pid).trim() ? String(pid).trim() : null;
    }
    const pinIds = resolveLocationIds(settings, worldSlug, data.location_pin_ids, "pins");
    if (pinIds) payload.location_pin_ids = pinIds;
    const regionIds = resolveLocationIds(settings, worldSlug, data.map_region_ids, "regions");
    if (regionIds) payload.map_region_ids = regionIds;
    const characters = charactersPayloadFromFrontmatter(data);
    if (characters) payload.characters = characters;
    const tagIds = resolveTagIdsForPublish(settings, worldSlug, data.tags);
    if (tagIds) {
      payload.tag_ids = tagIds;
    } else if (Array.isArray(data.tags) && data.tags.length) {
      new Notice(
        "BackDrop: tags not sent (pull once to cache tag IDs). Other fields still sync."
      );
    }

    const source = String(data.backdrop_source || "").trim();
    if (source !== "pin") {
      if (typeof data.discord_sync_enabled === "boolean") {
        payload.discord_sync_enabled = data.discord_sync_enabled;
      } else if (data.discord_sync_enabled === "true" || data.discord_sync_enabled === "false") {
        payload.discord_sync_enabled = data.discord_sync_enabled === "true";
      }
    }
    const id = String(data.backdrop_id || "").trim();
    let article: Record<string, unknown>;
    try {
      if (id) {
        ({ article } = await client.updateWikiArticle(worldSlug, id, payload));
      } else {
        ({ article } = await client.createWikiArticle(worldSlug, payload));
      }
    } catch (e) {
      if (e instanceof BackdropApiError && e.status === 409) {
        throw new Error("Remote changed since last pull. Pull again or force sync.");
      }
      throw e;
    }
    const syncedAt = new Date().toISOString();
    const publishedChars = Array.isArray(article.characters)
      ? (article.characters as Array<{ character_name?: string; muse_id?: string | null }>)
      : null;
    const charNames = publishedChars
      ? publishedChars.map((c) => String(c.character_name || "").trim()).filter(Boolean)
      : Array.isArray(data.characters)
        ? data.characters
        : [];
    const museIds = publishedChars
      ? publishedChars.map((c) => (c.muse_id != null ? String(c.muse_id) : null))
      : Array.isArray(data.character_muse_ids)
        ? data.character_muse_ids
        : undefined;
    const parentId =
      article.parent_article_id != null ? String(article.parent_article_id) : data.parent_article_id;
    let parentTitle = typeof data.parent === "string" ? data.parent : "";
    if (parentId && opts.slugIndex && !parentTitle) {
      opts.slugIndex.forEach((e) => {
        if (e.world !== worldSlug || parentTitle) return;
        const f = app.vault.getAbstractFileByPath(e.path);
        if (!(f instanceof TFile)) return;
        const id = frontmatterRecord(app.metadataCache.getFileCache(f))?.backdrop_id;
        if (id != null && String(id) === String(parentId)) parentTitle = e.title;
      });
    }
    const fm: Record<string, unknown> = {
      ...data,
      backdrop_type: "wiki",
      backdrop_id: article.id,
      backdrop_world: worldSlug,
      backdrop_slug: article.slug,
      title: article.title,
      category: article.category_slug || data.category,
      status: normalizePublishStatusForType("wiki", article.status ?? data.status),
      backdrop_source: article.source || String(data.backdrop_source || "manual"),
      discord_sync_enabled:
        article.source === "pin"
          ? false
          : Boolean(
              article.discord_sync_enabled ??
                (typeof data.discord_sync_enabled === "boolean"
                  ? data.discord_sync_enabled
                  : false)
            ),
      summary: article.summary || "",
      thumbnail_url: article.thumbnail_url || "",
      characters: charNames,
      location_pin_ids: Array.isArray(article.location_pin_ids)
        ? article.location_pin_ids
        : data.location_pin_ids || [],
      map_region_ids: Array.isArray(article.map_region_ids)
        ? article.map_region_ids
        : data.map_region_ids || [],
      parent_article_id: parentId || null,
      backdrop_updated_at: article.updated_at || syncedAt,
      backdrop_synced_at: syncedAt,
    };
    // Preserve non-empty user tags if present; never inject empty `tags: []`.
    if (!Array.isArray(fm.tags) || fm.tags.length === 0) delete fm.tags;
    if (museIds && museIds.some((m) => m)) fm.character_muse_ids = museIds;
    if (parentTitle) fm.parent = parentTitle;
    // Keep Obsidian title-form links in the vault (do not write API slug body back).
    const next = buildNoteFile(fm, bodyWithMedia);
    await app.vault.modify(file, next);
    settings.contentHashes[normalizePath(file.path)] = hashContent(next);
    clearConflictPath(settings, file.path);
    await saveSettings();
    if (opts.slugIndex) {
      opts.slugIndex.setEntry({
        slug: String(article.slug || ""),
        world: worldSlug,
        path: file.path,
        linkText: file.basename,
        title: String(article.title || file.basename),
      });
    }
    new Notice(
      `Synced wiki (${normalizePublishStatusForType("wiki", article.status ?? data.status)}): ${String(article.title)}`
    );
    return;
  }

  const payload: Record<string, unknown> = {
    title: String(data.title || file.basename),
    body_markdown: bodyForApi,
    status: normalizePublishStatusForType("timeline", data.status),
    event_kind: String(data.event_kind || "scene"),
    calendar_date: data.calendar_date ?? null,
    end_calendar_date: data.end_calendar_date ?? null,
    header_image_url: data.header_image_url || null,
    if_updated_at: ifUpdated,
    force: opts.force === true,
  };
  if (typeof data.lane === "string" && /^[0-9a-f-]{36}$/i.test(data.lane)) {
    payload.lane_id = data.lane;
  }
  if (typeof data.era === "string" && /^[0-9a-f-]{36}$/i.test(data.era)) {
    payload.era_id = data.era;
  }
  const id = String(data.backdrop_id || "").trim();
  let event: Record<string, unknown>;
  try {
    if (id) {
      ({ event } = await client.updateTimelineEvent(worldSlug, id, payload));
    } else {
      ({ event } = await client.createTimelineEvent(worldSlug, payload));
    }
  } catch (e) {
    if (e instanceof BackdropApiError && e.status === 409) {
      throw new Error("Remote changed since last pull. Pull again or force sync.");
    }
    throw e;
  }
  const syncedAt = new Date().toISOString();
  const fm = {
    ...data,
    backdrop_type: "timeline",
    backdrop_id: event.id,
    backdrop_world: worldSlug,
    title: event.title,
    status: normalizePublishStatusForType("timeline", event.status ?? data.status),
    event_kind: event.event_kind,
    calendar_date: event.calendar_date,
    end_calendar_date: event.end_calendar_date,
    header_image_url: event.header_image_url || "",
    backdrop_updated_at: event.updated_at || syncedAt,
    backdrop_synced_at: syncedAt,
  };
  const next = buildNoteFile(fm, bodyWithMedia);
  await app.vault.modify(file, next);
  settings.contentHashes[normalizePath(file.path)] = hashContent(next);
  clearConflictPath(settings, file.path);
  await saveSettings();
  new Notice(
    `Synced timeline (${normalizePublishStatusForType("timeline", event.status ?? data.status)}): ${String(event.title)}`
  );
}

/** Hint shown in the Sync panel for why a note is a push candidate. */
export type PublishCandidateHint = "Dirty" | "New" | "Conflict" | "Clean";

export interface PublishCandidate {
  file: TFile;
  path: string;
  title: string;
  world: string;
  type: "wiki" | "timeline";
  status: string;
  discordSyncEnabled: boolean;
  showDiscord: boolean;
  /** True when local content hash differs from last pull/publish. */
  dirty: boolean;
  unpublished: boolean;
  conflict: boolean;
  /** Local differs from last-synced snapshot (hash) or has never been published. */
  localDiffers: boolean;
  hint: PublishCandidateHint;
  /** Default checkbox when opening the panel. */
  defaultChecked: boolean;
}

/**
 * Notes under vault root that are candidates to push:
 * dirty vs last sync, unpublished (no backdrop_id), and/or conflict-flagged.
 * Optionally force-include a focus note even when clean.
 */
export async function listPublishCandidates(
  app: App,
  settings: BackdropSettings,
  opts: { includePath?: string } = {}
): Promise<PublishCandidate[]> {
  const root = settings.vaultRoot.replace(/\/+$/, "");
  const includeNorm = opts.includePath ? normalizePath(opts.includePath) : "";
  const conflictSet = new Set((settings.conflictPaths || []).map((p) => normalizePath(p)));
  const out: PublishCandidate[] = [];

  for (const file of app.vault.getMarkdownFiles()) {
    const path = normalizePath(file.path);
    const underRoot = file.path.startsWith(`${root}/`) || file.path === root;
    const isFocus = includeNorm !== "" && path === includeNorm;
    if (!underRoot && !isFocus) continue;
    const content = await app.vault.read(file);
    const { data } = splitFrontmatter(content);
    const typeRaw = String(data.backdrop_type || "");
    if (typeRaw !== "wiki" && typeRaw !== "timeline") continue;
    const type: "wiki" | "timeline" = typeRaw === "wiki" ? "wiki" : "timeline";

    const dirty = await fileIsDirty(app, file, settings);
    const id = String(data.backdrop_id || "").trim();
    const unpublished = !id;
    const conflict = conflictSet.has(path);
    if (!dirty && !unpublished && !conflict && !isFocus) continue;

    const articleSource = String(data.backdrop_source || "").trim();
    const showDiscord = type === "wiki" && articleSource !== "pin";
    const discordSyncEnabled = showDiscord
      ? data.discord_sync_enabled === true || data.discord_sync_enabled === "true"
      : false;

    const hint: PublishCandidateHint = conflict
      ? "Conflict"
      : unpublished
        ? "New"
        : dirty
          ? "Dirty"
          : "Clean";
    const localDiffers = dirty || unpublished;

    out.push({
      file,
      path,
      title: String(data.title || file.basename).trim() || file.basename,
      world: String(data.backdrop_world || "").trim() || "—",
      type,
      status: normalizePublishStatusForType(type, data.status),
      discordSyncEnabled,
      showDiscord,
      dirty,
      unpublished,
      conflict,
      localDiffers,
      hint,
      // Dirty / New default on; conflict default on; clean focus-only also checked.
      defaultChecked: isFocus || dirty || unpublished || conflict,
    });
  }

  const rank = (c: PublishCandidate) => {
    if (includeNorm && c.path === includeNorm) return 0;
    if (c.hint === "Conflict") return 1;
    if (c.hint === "New") return 2;
    if (c.hint === "Dirty") return 3;
    return 4;
  };
  out.sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return a.title.localeCompare(b.title);
  });

  return out;
}

/** Notes that bulk sync would push (dirty or never synced). */
export async function countPendingPublish(
  app: App,
  settings: BackdropSettings
): Promise<number> {
  const candidates = await listPublishCandidates(app, settings);
  return candidates.filter((c) => c.dirty || c.unpublished || c.conflict).length;
}

export interface PublishSelectionItem {
  file: TFile;
  status: string;
  discordSyncEnabled?: boolean;
  force?: boolean;
}

/** Persist status / discord overrides into frontmatter before publishFile reads them. */
export async function applyPublishChoices(
  app: App,
  file: TFile,
  choices: { status: string; discordSyncEnabled?: boolean; showDiscord?: boolean }
): Promise<void> {
  const latest = await app.vault.read(file);
  const parsed = splitFrontmatter(latest);
  const type = String(parsed.data.backdrop_type || "");
  const nextStatus = normalizePublishStatusForType(type, choices.status);
  const currentStatus = normalizePublishStatusForType(type, parsed.data.status);
  const showDiscord = choices.showDiscord === true;
  const currentDiscord =
    showDiscord &&
    (parsed.data.discord_sync_enabled === true || parsed.data.discord_sync_enabled === "true");
  const statusChanged = currentStatus !== nextStatus;
  const discordChanged =
    showDiscord && choices.discordSyncEnabled !== undefined && currentDiscord !== choices.discordSyncEnabled;
  if (!statusChanged && !discordChanged) return;

  const fm: Record<string, unknown> = { ...parsed.data, status: nextStatus };
  if (showDiscord && choices.discordSyncEnabled !== undefined) {
    fm.discord_sync_enabled = choices.discordSyncEnabled;
  }
  const next = buildNoteFile(fm, parsed.body);
  await app.vault.modify(file, next);
  // Leave hash dirty so pull still skips overwrite until sync completes.
}

/**
 * Push selected notes sequentially (respects PUBLISH_GAP_MS / rate limits).
 */
export async function publishSelected(
  app: App,
  client: BackdropClient,
  settings: BackdropSettings,
  saveSettings: () => Promise<void>,
  items: PublishSelectionItem[],
  slugIndex?: WikiSlugIndex
): Promise<{ published: number; failed: number; rateLimited: boolean }> {
  let published = 0;
  let failed = 0;
  let rateLimited = false;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const content = await app.vault.read(item.file);
    const { data } = splitFrontmatter(content);
    const type = String(data.backdrop_type || "");
    const articleSource = String(data.backdrop_source || "").trim();
    const showDiscord = type === "wiki" && articleSource !== "pin";
    try {
      await applyPublishChoices(app, item.file, {
        status: item.status,
        discordSyncEnabled: item.discordSyncEnabled,
        showDiscord,
      });
      await publishFile(app, client, item.file, settings, saveSettings, {
        force: item.force === true,
        slugIndex,
      });
      published += 1;
    } catch (e) {
      failed += 1;
      if (e instanceof BackdropApiError && e.status === 429) {
        rateLimited = true;
        noticeError(e, `Sync ${item.file.path}`);
        break;
      }
      noticeError(e, `Sync ${item.file.path}`);
    }
    if (i + 1 < items.length) await sleepMs(PUBLISH_GAP_MS);
  }

  new Notice(
    `BackDrop sync: ${published} pushed` +
      (failed ? `, ${failed} failed` : "") +
      (rateLimited ? " (stopped early — rate limited)" : "")
  );
  return { published, failed, rateLimited };
}

/** @deprecated Prefer Sync panel + publishSelected. Kept for scripts. */
export async function publishPending(
  app: App,
  client: BackdropClient,
  settings: BackdropSettings,
  saveSettings: () => Promise<void>,
  slugIndex?: WikiSlugIndex
): Promise<void> {
  const candidates = await listPublishCandidates(app, settings);
  const items: PublishSelectionItem[] = candidates
    .filter((c) => c.defaultChecked)
    .map((c) => ({
      file: c.file,
      status: c.status,
      discordSyncEnabled: c.showDiscord ? c.discordSyncEnabled : undefined,
    }));
  await publishSelected(app, client, settings, saveSettings, items, slugIndex);
}

export async function createWikiStub(
  app: App,
  settings: BackdropSettings,
  worldSlug: string,
  title: string,
  category: string,
  articleSlug?: string
): Promise<TFile> {
  const rawSlug = String(articleSlug || "").trim();
  const slug = rawSlug ? slugify(rawSlug) : slugify(title);
  const rawCategory = String(category || "").trim();
  const catalog = settings.worldCatalogs?.[worldSlug];
  const known = (catalog?.categories || []).find(
    (c) => c.slug === rawCategory || String(c.name || "").trim() === rawCategory
  );
  // Frontmatter stores category slug (matches pull / Article properties).
  const categorySlug = known?.slug || (rawCategory ? slugify(rawCategory) : "") || "general";
  // Folder uses display name when known (same as pull), else the typed value.
  const catFolder = safePathSegment(
    known?.name ? String(known.name).trim() : rawCategory || categorySlug || "general"
  );
  const path = wikiNotePath(settings.vaultRoot, worldSlug, catFolder, title);
  const syncedAt = new Date().toISOString();
  const content = buildNoteFile(
    {
      backdrop_type: "wiki",
      backdrop_world: worldSlug,
      backdrop_slug: slug,
      title,
      category: categorySlug,
      status: "draft",
      tags: [],
      summary: "",
      backdrop_synced_at: syncedAt,
    },
    `# ${title}\n\n`
  );
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (folder) await ensureFolderPath(app, folder);
  const file = await app.vault.create(normalizePath(path), content);
  settings.contentHashes[normalizePath(path)] = hashContent(content);
  return file;
}

export async function createTimelineStub(
  app: App,
  settings: BackdropSettings,
  worldSlug: string,
  title: string
): Promise<TFile> {
  const tempId = `local-${Date.now().toString(16)}`;
  const path = timelineNotePath(settings.vaultRoot, worldSlug, title, tempId);
  const syncedAt = new Date().toISOString();
  const content = buildNoteFile(
    {
      backdrop_type: "timeline",
      backdrop_world: worldSlug,
      title,
      status: "draft",
      event_kind: "major",
      calendar_date: { era: null, year: null, month: null, day: null },
      end_calendar_date: null,
      lane: "",
      era: "",
      header_image_url: "",
      backdrop_synced_at: syncedAt,
    },
    `# ${title}\n\n`
  );
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (folder) await ensureFolderPath(app, folder);
  const file = await app.vault.create(normalizePath(path), content);
  settings.contentHashes[normalizePath(path)] = hashContent(content);
  return file;
}

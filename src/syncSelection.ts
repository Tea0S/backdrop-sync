import { parseWorldSlugs } from "./frontmatter";
import type {
  BackdropSettings,
  ObsidianWorldSummary,
  SyncWorldSelection,
} from "./types";

/** Derive compatibility worldSlugs string from structured selection. */
export function deriveWorldSlugs(syncWorlds: SyncWorldSelection[]): string {
  return syncWorlds
    .filter((w) => w.syncWiki || w.syncTimeline)
    .map((w) => w.slug)
    .join(", ");
}

/**
 * Migrate legacy worldSlugs → syncWorlds when structured list is empty.
 * Returns true if settings were mutated.
 */
export function migrateSyncWorldsFromSlugs(settings: BackdropSettings): boolean {
  if (!Array.isArray(settings.syncWorlds)) {
    settings.syncWorlds = [];
  }
  if (typeof settings.syncWorldsConfigured !== "boolean") {
    settings.syncWorldsConfigured = false;
  }
  if (settings.syncWorlds.length > 0) return false;
  const slugs = parseWorldSlugs(settings.worldSlugs);
  if (!slugs.length) return false;
  settings.syncWorlds = slugs.map((slug) => ({
    slug,
    syncWiki: true,
    syncTimeline: true,
  }));
  settings.syncWorldsConfigured = true;
  return true;
}

/** UI defaults for a world row given current settings. */
export function selectionForWorld(
  settings: BackdropSettings,
  world: ObsidianWorldSummary
): { syncWiki: boolean; syncTimeline: boolean } {
  const entry = settings.syncWorlds.find((s) => s.slug === world.slug);
  // Prefer stored syncWorlds whenever present (refresh merges discoveries here).
  if (entry || settings.syncWorldsConfigured) {
    return {
      syncWiki: Boolean(entry?.syncWiki) && world.can_edit_wiki,
      syncTimeline: Boolean(entry?.syncTimeline) && world.can_edit_timeline,
    };
  }
  const legacy = parseWorldSlugs(settings.worldSlugs);
  if (legacy.length) {
    const included = legacy.includes(world.slug);
    return {
      syncWiki: included && world.can_edit_wiki,
      syncTimeline: included && world.can_edit_timeline,
    };
  }
  return {
    syncWiki: world.can_edit_wiki,
    syncTimeline: world.can_edit_timeline,
  };
}

export type ResolvePullTargetsResult =
  | { ok: true; targets: SyncWorldSelection[] }
  | { ok: false; reason: "none-selected" | "no-worlds" };

/**
 * Resolve which worlds/facets to pull.
 * - Explicit selection (configured): only listed worlds with a facet on
 * - Else legacy worldSlugs: those slugs, both facets
 * - Else: all API worlds with editable facets
 */
export function resolvePullTargets(
  settings: BackdropSettings,
  apiWorlds: ObsidianWorldSummary[]
): ResolvePullTargetsResult {
  if (settings.syncWorldsConfigured) {
    const targets = (settings.syncWorlds || []).filter((w) => w.syncWiki || w.syncTimeline);
    if (!targets.length) return { ok: false, reason: "none-selected" };
    return { ok: true, targets };
  }

  const legacy = parseWorldSlugs(settings.worldSlugs);
  if (legacy.length) {
    return {
      ok: true,
      targets: legacy.map((slug) => ({
        slug,
        syncWiki: true,
        syncTimeline: true,
      })),
    };
  }

  if (!apiWorlds.length) return { ok: false, reason: "no-worlds" };

  const targets = apiWorlds
    .map((w) => ({
      slug: w.slug,
      syncWiki: Boolean(w.can_edit_wiki),
      syncTimeline: Boolean(w.can_edit_timeline),
    }))
    .filter((t) => t.syncWiki || t.syncTimeline);

  if (!targets.length) return { ok: false, reason: "no-worlds" };
  return { ok: true, targets };
}

/** Persist checklist state as explicit syncWorlds + derived worldSlugs. */
export function applyWorldChecklist(
  settings: BackdropSettings,
  worlds: ObsidianWorldSummary[],
  state: Record<string, { syncWiki: boolean; syncTimeline: boolean }>
): void {
  settings.syncWorldsConfigured = true;
  // Keep disabled worlds so a later refresh does not treat them as "new" and re-enable them.
  settings.syncWorlds = worlds.map((w) => {
    const row = state[w.slug] || { syncWiki: false, syncTimeline: false };
    return {
      slug: w.slug,
      name: w.name,
      syncWiki: Boolean(row.syncWiki) && w.can_edit_wiki,
      syncTimeline: Boolean(row.syncTimeline) && w.can_edit_timeline,
    };
  });
  settings.worldSlugs = deriveWorldSlugs(settings.syncWorlds);
}

/**
 * Merge API worlds into syncWorlds (shared source for settings checklist + create modals).
 * Newly discovered worlds get editable facets enabled; existing toggles are preserved.
 * Returns true if settings were mutated.
 */
export function mergeDiscoveredWorlds(
  settings: BackdropSettings,
  worlds: ObsidianWorldSummary[]
): boolean {
  if (!Array.isArray(settings.syncWorlds)) {
    settings.syncWorlds = [];
  }

  const bySlug = new Map((settings.syncWorlds || []).map((w) => [w.slug, { ...w }]));
  let changed = false;

  for (const w of worlds) {
    const existing = bySlug.get(w.slug);
    if (!existing) {
      bySlug.set(w.slug, {
        slug: w.slug,
        name: w.name,
        syncWiki: Boolean(w.can_edit_wiki),
        syncTimeline: Boolean(w.can_edit_timeline),
      });
      changed = true;
      continue;
    }
    if (w.name && existing.name !== w.name) {
      existing.name = w.name;
      bySlug.set(w.slug, existing);
      changed = true;
    }
  }

  const next = worlds.map((w) => bySlug.get(w.slug)!);
  const prev = settings.syncWorlds || [];
  if (
    changed ||
    prev.length !== next.length ||
    next.some((w, i) => {
      const p = prev[i];
      return (
        !p ||
        p.slug !== w.slug ||
        p.name !== w.name ||
        p.syncWiki !== w.syncWiki ||
        p.syncTimeline !== w.syncTimeline
      );
    })
  ) {
    settings.syncWorlds = next;
    changed = true;
  }

  const derived = deriveWorldSlugs(settings.syncWorlds);
  if (settings.worldSlugs !== derived) {
    settings.worldSlugs = derived;
    changed = true;
  }
  return changed;
}

export type SyncedWorldOption = {
  slug: string;
  name: string;
  syncWiki: boolean;
  syncTimeline: boolean;
};

function worldNameLookup(settings: BackdropSettings): Map<string, string> {
  const map = new Map<string, string>();
  for (const [slug, cat] of Object.entries(settings.worldCatalogs || {})) {
    const name = String(cat?.name || "").trim();
    if (name) map.set(slug, name);
  }
  for (const w of settings.syncWorlds || []) {
    const name = String(w.name || "").trim();
    if (name) map.set(w.slug, name);
  }
  return map;
}

/**
 * Worlds enabled for sync in settings (same source as the settings checklist /
 * mergeDiscoveredWorlds). When nothing is stored yet, fall back to pulled catalog keys.
 */
export function listSyncedWorlds(
  settings: BackdropSettings,
  facet?: "wiki" | "timeline"
): SyncedWorldOption[] {
  const names = worldNameLookup(settings);
  let rows: Array<{ slug: string; name?: string; syncWiki: boolean; syncTimeline: boolean }>;

  const fromSyncWorlds = (settings.syncWorlds || []).filter((w) => w.syncWiki || w.syncTimeline);
  if (settings.syncWorldsConfigured || fromSyncWorlds.length) {
    // Prefer structured syncWorlds whenever refresh/checklist has populated it —
    // including before the user locks an explicit pull list (configured flag).
    rows = fromSyncWorlds;
  } else {
    const legacy = parseWorldSlugs(settings.worldSlugs);
    if (legacy.length) {
      rows = legacy.map((slug) => ({ slug, syncWiki: true, syncTimeline: true }));
    } else {
      rows = Object.keys(settings.worldCatalogs || {}).map((slug) => ({
        slug,
        syncWiki: true,
        syncTimeline: true,
      }));
    }
  }

  const options: SyncedWorldOption[] = rows.map((w) => ({
    slug: w.slug,
    name: String(w.name || names.get(w.slug) || "").trim(),
    syncWiki: w.syncWiki,
    syncTimeline: w.syncTimeline,
  }));

  if (facet === "wiki") return options.filter((w) => w.syncWiki);
  if (facet === "timeline") return options.filter((w) => w.syncTimeline);
  return options;
}

export function syncedWorldLabel(slug: string, name?: string): string {
  const n = String(name || "").trim();
  if (n && n.toLowerCase() !== slug.toLowerCase()) return `${n} (${slug})`;
  return slug;
}

export function mostRecentlyPulledWorldSlug(settings: BackdropSettings): string {
  let bestSlug = "";
  let bestAt = "";
  for (const [slug, cat] of Object.entries(settings.worldCatalogs || {})) {
    const at = String(cat?.pulledAt || "");
    if (at && (!bestAt || at > bestAt)) {
      bestAt = at;
      bestSlug = slug;
    }
  }
  return bestSlug;
}

export function pickDefaultSyncedWorld(
  options: SyncedWorldOption[],
  settings: BackdropSettings,
  currentSlug = ""
): string {
  if (!options.length) return "";
  if (options.length === 1) return options[0].slug;
  const candidates = [
    currentSlug,
    settings.lastWorldSlug,
    mostRecentlyPulledWorldSlug(settings),
  ]
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  for (const slug of candidates) {
    if (options.some((o) => o.slug === slug)) return slug;
  }
  return options[0].slug;
}

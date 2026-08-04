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
  if (settings.syncWorldsConfigured) {
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
  settings.syncWorlds = worlds
    .map((w) => {
      const row = state[w.slug] || { syncWiki: false, syncTimeline: false };
      return {
        slug: w.slug,
        syncWiki: Boolean(row.syncWiki) && w.can_edit_wiki,
        syncTimeline: Boolean(row.syncTimeline) && w.can_edit_timeline,
      };
    })
    .filter((s) => s.syncWiki || s.syncTimeline);
  settings.worldSlugs = deriveWorldSlugs(settings.syncWorlds);
}

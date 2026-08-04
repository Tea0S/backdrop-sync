export interface SyncWorldSelection {
  slug: string;
  syncWiki: boolean;
  syncTimeline: boolean;
}

/** Categories / tags / lanes / eras / pins / regions cached from the last successful pull for a world. */
export interface WorldCatalogMeta {
  categories: Array<{ id: string; slug: string; name: string; is_system?: boolean }>;
  tags: Array<{ id: string; slug: string; name: string }>;
  eras: Array<{ id: string; name: string }>;
  lanes: Array<{ id: string; name: string; is_default?: boolean }>;
  pins?: Array<{ id: string; name: string }>;
  regions?: Array<{ id: string; name: string }>;
  pulledAt?: string;
}

export interface BackdropSettings {
  apiBaseUrl: string;
  apiKey: string;
  vaultRoot: string;
  /**
   * Comma-separated slugs — kept for compatibility / derived from syncWorlds.
   * Prefer syncWorlds for new logic.
   */
  worldSlugs: string;
  /** Explicit world + facet selection (empty + not configured → pull all editable). */
  syncWorlds: SyncWorldSelection[];
  /**
   * Once the user toggles worlds in settings, selection is explicit.
   * Empty syncWorlds with this true → prompt to pick worlds (do not pull all).
   */
  syncWorldsConfigured: boolean;
  pullOnStartup: boolean;
  /** path -> content hash after last successful pull/publish */
  contentHashes: Record<string, string>;
  /** Pull pack metadata keyed by world slug (categories, tags, lanes, eras). */
  worldCatalogs: Record<string, WorldCatalogMeta>;
  /** Vault paths skipped as dirty on pull (or remote-newer + dirty). */
  conflictPaths: string[];
}

export const DEFAULT_SETTINGS: BackdropSettings = {
  apiBaseUrl: "https://api.backdrop.quest",
  apiKey: "",
  vaultRoot: "BackDrop",
  worldSlugs: "",
  syncWorlds: [],
  syncWorldsConfigured: false,
  pullOnStartup: false,
  contentHashes: {},
  worldCatalogs: {},
  conflictPaths: [],
};

export type SyncBadgeState = "clean" | "dirty" | "conflict" | "unpublished";

export type BackdropNoteType = "wiki" | "timeline";

export interface WikiFrontmatter {
  backdrop_type: "wiki";
  backdrop_id?: string;
  backdrop_world: string;
  backdrop_slug: string;
  title: string;
  category: string;
  status: string;
  tags?: string[];
  summary?: string;
  thumbnail_url?: string;
  /** Character display names (publish maps to characters[].character_name). */
  characters?: string[];
  /** Optional muse ids parallel to characters when known. */
  character_muse_ids?: Array<string | null>;
  location_pin_ids?: string[];
  map_region_ids?: string[];
  parent_article_id?: string | null;
  /** Display-only parent title from last pull (not sent on publish). */
  parent?: string;
  backdrop_updated_at?: string;
  backdrop_synced_at?: string;
}

export interface TimelineFrontmatter {
  backdrop_type: "timeline";
  backdrop_id?: string;
  backdrop_world: string;
  title: string;
  status: string;
  event_kind?: string;
  calendar_date?: Record<string, unknown> | null;
  end_calendar_date?: Record<string, unknown> | null;
  lane?: string;
  era?: string;
  header_image_url?: string;
  backdrop_updated_at?: string;
  backdrop_synced_at?: string;
}

export type BackdropFrontmatter = WikiFrontmatter | TimelineFrontmatter;

export interface ObsidianWorldSummary {
  id: string;
  slug: string;
  name: string;
  can_edit_wiki: boolean;
  can_edit_timeline: boolean;
}

export interface PullPackArticle {
  id: string;
  slug: string;
  title: string;
  body_markdown: string;
  summary?: string;
  status: string;
  category_slug?: string;
  category_id?: string;
  tag_ids?: string[];
  thumbnail_url?: string | null;
  parent_article_id?: string | null;
  location_pin_ids?: string[];
  map_region_ids?: string[];
  characters?: Array<{
    character_name?: string;
    characterName?: string;
    muse_id?: string | null;
    museId?: string | null;
  }>;
  updated_at?: string;
  source?: string;
}

export interface PullPack {
  world: { id: string; slug: string; name: string; content_kind?: string };
  can_edit_wiki: boolean;
  can_edit_timeline: boolean;
  categories: Array<{ id: string; slug: string; name: string; is_system?: boolean }>;
  tags: Array<{ id: string; slug: string; name: string }>;
  pins?: Array<{ id: string; name: string }>;
  regions?: Array<{ id: string; name: string }>;
  articles: PullPackArticle[];
  eras: Array<{ id: string; name: string }>;
  lanes: Array<{ id: string; name: string; is_default?: boolean }>;
  events: Array<{
    id: string;
    title: string;
    body_markdown: string;
    status: string;
    event_kind?: string;
    calendar_date?: Record<string, unknown> | null;
    end_calendar_date?: Record<string, unknown> | null;
    lane_id?: string | null;
    era_id?: string | null;
    header_image_url?: string | null;
    updated_at?: string;
  }>;
  pulled_at: string;
}

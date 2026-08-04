import { App, normalizePath } from "obsidian";
import { frontmatterRecord, safePathSegment, splitFrontmatter, wikiNotePath } from "./frontmatter";
import type { PullPack } from "./types";

/** Matches BackDrop wiki slug links: [[slug]], [[slug|label]], [[slug#heading]], [[slug#heading|label]]. */
const BD_SLUG_WIKILINK_RE =
  /\[\[([a-z0-9][a-z0-9-]{0,62})(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/gi;

/** Obsidian-style wikilinks (title/path targets). Timeline links excluded via protection. */
const OBSIDIAN_WIKILINK_RE =
  /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

const TIMELINE_BLOCK_RE = /:::timeline\s*[\s\S]*?:::/gi;
const TIMELINE_LINK_RE = /\[\[timeline:[^\]]+\]\]/gi;
const FENCED_CODE_RE = /```[\s\S]*?```/g;

export interface WikiLinkEntry {
  slug: string;
  world: string;
  path: string;
  /** Obsidian wikilink target — file basename without `.md`. */
  linkText: string;
  title: string;
}

/**
 * In-memory slug → note index per world.
 * Used to rewrite BackDrop `[[slug]]` ↔ Obsidian `[[Title]]` for native backlinks.
 */
export class WikiSlugIndex {
  /** world → slug → entry */
  private byWorldSlug = new Map<string, Map<string, WikiLinkEntry>>();
  private byPath = new Map<string, WikiLinkEntry>();
  /** lowercase linkText → entries (may collide across folders) */
  private byLinkText = new Map<string, WikiLinkEntry[]>();

  clear(): void {
    this.byWorldSlug.clear();
    this.byPath.clear();
    this.byLinkText.clear();
  }

  get size(): number {
    return this.byPath.size;
  }

  forEach(fn: (entry: WikiLinkEntry) => void): void {
    for (const entry of this.byPath.values()) fn(entry);
  }

  setEntry(entry: WikiLinkEntry): void {
    const world = entry.world.trim();
    const slug = entry.slug.trim().toLowerCase();
    if (!world || !slug) return;

    let worldMap = this.byWorldSlug.get(world);
    if (!worldMap) {
      worldMap = new Map();
      this.byWorldSlug.set(world, worldMap);
    }

    const prev = worldMap.get(slug);
    if (prev) this.removeFromSecondary(prev);

    const next: WikiLinkEntry = {
      slug,
      world,
      path: normalizePath(entry.path),
      linkText: entry.linkText,
      title: entry.title,
    };
    worldMap.set(slug, next);
    this.byPath.set(next.path, next);

    const key = next.linkText.toLowerCase();
    const list = this.byLinkText.get(key) || [];
    list.push(next);
    this.byLinkText.set(key, list);
  }

  private removeFromSecondary(entry: WikiLinkEntry): void {
    this.byPath.delete(entry.path);
    const key = entry.linkText.toLowerCase();
    const list = this.byLinkText.get(key);
    if (!list) return;
    const next = list.filter((e) => e.path !== entry.path);
    if (next.length) this.byLinkText.set(key, next);
    else this.byLinkText.delete(key);
  }

  getBySlug(world: string, slug: string): WikiLinkEntry | undefined {
    return this.byWorldSlug.get(world)?.get(String(slug || "").trim().toLowerCase());
  }

  getByPath(path: string): WikiLinkEntry | undefined {
    return this.byPath.get(normalizePath(path));
  }

  /**
   * Resolve an Obsidian wikilink target within a world.
   * Accepts basename, vault-relative path, or already-slug form.
   */
  resolveObsidianTarget(world: string, target: string): WikiLinkEntry | undefined {
    const raw = String(target || "").trim().replace(/\.md$/i, "");
    if (!raw) return undefined;

    const asPath = normalizePath(raw.endsWith(".md") ? raw : `${raw}.md`);
    const byPath = this.byPath.get(asPath) || this.byPath.get(normalizePath(raw));
    if (byPath && byPath.world === world) return byPath;

    const base = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
    const candidates = this.byLinkText.get(base.toLowerCase()) || [];
    const inWorld = candidates.filter((e) => e.world === world);
    if (inWorld.length === 1) return inWorld[0];
    if (inWorld.length > 1) {
      const pathMatch = inWorld.find(
        (e) => e.path === asPath || e.path.endsWith(`/${base}.md`) || e.linkText === base
      );
      if (pathMatch) return pathMatch;
      return inWorld[0];
    }

    return this.getBySlug(world, raw.toLowerCase());
  }

  /**
   * Seed / merge expected titles from a pull pack (before notes exist on disk).
   * Prefer an existing vault path/linkText when the slug is already indexed.
   */
  mergePullPack(
    vaultRoot: string,
    worldSlug: string,
    pack: PullPack,
    categoryFolderFor: (article: PullPack["articles"][0]) => string
  ): void {
    for (const article of pack.articles || []) {
      const slug = String(article.slug || "").trim().toLowerCase();
      if (!slug) continue;
      const title = String(article.title || slug);
      const linkText = safePathSegment(title);
      const path = wikiNotePath(vaultRoot, worldSlug, categoryFolderFor(article), title);
      const existing = this.getBySlug(worldSlug, slug);
      this.setEntry({
        slug,
        world: worldSlug,
        path: existing?.path || path,
        linkText: existing?.linkText || linkText,
        title: existing?.title || title,
      });
    }
  }
}

/** Scan vault for `backdrop_type: wiki` notes under vaultRoot. */
export async function scanWikiSlugIndex(app: App, vaultRoot: string): Promise<WikiSlugIndex> {
  const index = new WikiSlugIndex();
  const root = vaultRoot.replace(/\/+$/, "");
  const prefix = `${root}/`;

  for (const file of app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(prefix) && file.path !== root) continue;
    const fm = frontmatterRecord(app.metadataCache.getFileCache(file));
    let type: unknown = fm?.backdrop_type;
    let world = fm?.backdrop_world != null ? String(fm.backdrop_world) : "";
    let slug = fm?.backdrop_slug != null ? String(fm.backdrop_slug) : "";
    let title = fm?.title != null ? String(fm.title) : "";

    if (type !== "wiki" || !world || !slug) {
      // Metadata cache may lag right after write — fall back to reading frontmatter.
      const content = await app.vault.read(file);
      const { data } = splitFrontmatter(content);
      if (data.backdrop_type !== "wiki") continue;
      world = String(data.backdrop_world || "").trim();
      slug = String(data.backdrop_slug || "").trim();
      title = String(data.title || "").trim();
      type = "wiki";
    }
    if (!world || !slug) continue;

    index.setEntry({
      slug: slug.toLowerCase(),
      world,
      path: file.path,
      linkText: file.basename,
      title: title || file.basename,
    });
  }

  return index;
}

/** Replace `index` contents with a fresh vault scan. */
export async function rebuildWikiSlugIndex(
  app: App,
  index: WikiSlugIndex,
  vaultRoot: string
): Promise<void> {
  const fresh = await scanWikiSlugIndex(app, vaultRoot);
  index.clear();
  fresh.forEach((entry) => index.setEntry(entry));
}

/** Markdown images (incl. nested `()` from TipTap autolink mangling) + optional align. */
const MD_IMAGE_PROTECT_RE =
  /!\[[^\]]*\]\((?:[^()]|\([^)]*\))*\)(?:\{align=(?:left|center|right)\})?/g;

function protectRegions(body: string, transform: (exposed: string) => string): string {
  const placeholders: string[] = [];
  const stash = (m: string) => {
    const i = placeholders.length;
    placeholders.push(m);
    return `\0BDPROT${i}\0`;
  };

  let s = String(body || "");
  s = s.replace(new RegExp(FENCED_CODE_RE.source, "g"), stash);
  s = s.replace(new RegExp(TIMELINE_BLOCK_RE.source, "gi"), stash);
  s = s.replace(new RegExp(TIMELINE_LINK_RE.source, "gi"), stash);
  // Never rewrite wikilinks inside image destinations / alts.
  s = s.replace(MD_IMAGE_PROTECT_RE, stash);
  s = transform(s);
  return s.replace(/\0BDPROT(\d+)\0/g, (_, n) => placeholders[Number(n)] ?? "");
}

function formatBdLink(slug: string, heading: string | undefined, label: string | undefined): string {
  const hash = heading ? `#${heading}` : "";
  const pipe = label != null && label !== "" ? `|${label}` : "";
  return `[[${slug}${hash}${pipe}]]`;
}

function formatObsidianLink(
  linkText: string,
  heading: string | undefined,
  label: string | undefined
): string {
  const hash = heading ? `#${heading}` : "";
  const pipe = label != null && label !== "" ? `|${label}` : "";
  return `[[${linkText}${hash}${pipe}]]`;
}

/**
 * Pull direction: BackDrop `[[slug]]` → Obsidian `[[Note Title]]`.
 * Unknown slugs and `[[timeline:…]]` / `:::timeline` are left unchanged.
 */
export function rewriteSlugsToObsidian(body: string, world: string, index: WikiSlugIndex): string {
  return protectRegions(body, (exposed) => {
    const re = new RegExp(BD_SLUG_WIKILINK_RE.source, "gi");
    return exposed.replace(re, (full, slug: string, heading?: string, label?: string) => {
      const entry = index.getBySlug(world, slug);
      if (!entry) return full;
      return formatObsidianLink(entry.linkText, heading, label);
    });
  });
}

/**
 * Publish direction: Obsidian `[[Title]]` → BackDrop `[[slug]]` via frontmatter slug index.
 * Unresolved targets stay as-is (including broken slug links).
 */
export function rewriteObsidianToSlugs(body: string, world: string, index: WikiSlugIndex): string {
  return protectRegions(body, (exposed) => {
    const re = new RegExp(OBSIDIAN_WIKILINK_RE.source, "g");
    return exposed.replace(re, (full, target: string, heading?: string, label?: string) => {
      const t = String(target || "").trim();
      if (/^timeline:/i.test(t)) return full;
      const entry = index.resolveObsidianTarget(world, t);
      if (!entry) return full;
      return formatBdLink(entry.slug, heading, label);
    });
  });
}

# BackDrop Sync


Digital-garden style sync for BackDrop wiki and timeline articles.

## Setup

1. On [backdrop.quest](https://backdrop.quest) dashboard → **API keys** (vault sync) → Create key (copy once).
2. In this repo: `npm install && npm run install:vault`
3. Enable **BackDrop** under Community plugins (Roleplay Writing vault).
4. Settings → BackDrop: paste API base (`https://api.backdrop.quest`) and your `bd_…` key. After the key is set, a **Worlds to sync** checklist loads from the API — enable wiki and/or timeline per world (disabled when you lack edit access). Leave the list untouched to pull all editable worlds; any toggle saves an explicit selection.

## Editing bar

Open a note with `backdrop_type: wiki` or `timeline` in frontmatter. The markdown view header shows BackDrop actions: **Insert image**, **Insert audio**, spoiler wrap, **Insert wikilink**, **Article properties**, **Resolve sync…**, and **Pull this note**.

On BackDrop notes, a single **Format…** header action opens a menu for H2 / H3 / Bold / Italic / Link / Table (no wrapping strip in the title bar).

The status bar shows sync state for the active note: **Clean** / **Dirty** / **Conflict** / **Unpublished**. Click the badge to open **Resolve sync…** (keep local, take remote, or open the Sync panel to force-push local). Right-click the badge for insert shortcuts.

## Sync to BackDrop panel

Ribbon **Sync to BackDrop**, **Sync current note**, **Sync all pending**, and Resolve → **Sync local…** open a selective push panel (Obsidian Sync–style checklist):

1. Lists dirty, unpublished (no `backdrop_id`), and conflict notes under the vault root.
2. Each row: title, world, type, local status dropdown, Discord toggle (wiki), and a **Dirty** / **New** / **Conflict** hint (plus whether local differs from the last sync hash).
3. Checkboxes default on for dirty/unpublished/conflict; uncheck anything not ready. Conflict rows also get **Review…** / **Keep local** / **Take remote** so you can resolve without leaving the panel (pushing a conflict overwrites remote).
4. **Push selected** uploads only checked notes sequentially (same rate-limit gap as before). **Cancel** closes with no push.
5. Empty state: **Nothing to sync**.
6. Opening from a single note pre-checks and highlights that note (even if clean). **Force sync current note** / Resolve force uses the same panel with force overwrite.

**File explorer right-click**

- On a BackDrop wiki/timeline note: **BackDrop: Sync to BackDrop…** (same panel, that note focused).
- On a folder under the vault root (world, `wiki`/`timeline`, or a category folder): **BackDrop: Sync …** opens the panel **scoped to that folder only**, so you can push one world or one category without scanning everything else.
- Editor right-click on a BackDrop note also offers **BackDrop: Sync to BackDrop…**.

## Wiki editor helpers

| Action | Behavior |
|--------|----------|
| **Insert image** | Pick a vault file or paste path/HTTPS URL; vault files upload via BackDrop assets, then insert `![alt](url){align=…}` (align prompted). |
| **Insert audio** | Same upload/path flow; inserts `[label](url)`. |
| **Insert wikilink** | Fuzzy-search the wiki slug index by title; inserts `[[Note Title]]` or `[[Note Title\|label]]` when text was selected. |
| **Article properties** | Status, category (with **New…** create), Publish to Discord (wiki, non-pin), characters, parent article, linked pins/regions, thumbnail (wiki) or header image (timeline). Categories/pins/regions come from the last pull cache. |
| **Resolve sync…** | Line-level local vs remote diff (unified or side-by-side), plus title/status/category. **Keep local**, **Take remote**, or **Push local…**. |
| **Review sync conflicts** | Conflict list after pull. Per row: **Review…**, **Keep local**, **Take remote**. Bulk: **Keep all local** / **Take all remote**. |

Pull caches each world’s categories, pins, regions, lanes, and eras in plugin data. On publish, pin/region ids, characters, parent, thumbnail, and `discord_sync_enabled` are sent when present.

## Pull behavior

Pulls respect the worlds checklist (wiki / timeline facets). If you turn every world off after customizing, you’ll get a notice to pick worlds in settings instead of silently pulling everything.

| Action | Behavior |
|--------|----------|
| **Pull on startup** | Creates missing notes only; never overwrites existing files |
| **Pull updates** (command / ribbon) | Creates missing notes; fast-forwards notes that match the last sync (or match remote). **Conflict** only when you edited a note locally *and* BackDrop changed it too. Unmodified notes are never flagged. |
| **Pull current note** / Resolve → Take remote | Overwrites that note from the server (explicit) |

Publish / Sync pushes selected notes to the API and **preserves (or overrides) frontmatter `status`** (`draft` / `unlisted` / `published`). Missing status defaults to `draft`. Sync does **not** mean “set published”.

## Commands

- **Pull updates** / **Pull current note**
- **Sync current note** / **Force sync current note** / **Sync all pending** (all open the Sync panel)
- **New wiki article** / **New timeline event**
- **Insert image** / **Insert audio** / **Wrap selection as spoiler** / **Insert timeline embed stub** / **Insert wikilink**
- **Article properties** / **Resolve sync…** / **Review sync conflicts**

## Aligned images

BackDrop uses a single-line attribute after the image markdown (keep it on the same line for publish parity):

```markdown
![alt](https://example.com/photo.jpg){align=left}
![alt](https://example.com/photo.jpg){align=center}
![alt](https://example.com/photo.jpg){align=right}
```

**Insert aligned image** always writes that one-line form. Reading view and Live Preview wrap the image in a floated `figure.bd-lore-figure--{align}` (metrics match backdrop.quest: left/right `max-width: min(50%, 22rem)`, same margins, `clear: both`, img fills the float box; center is block-centered) and hide the `{align=…}` text. Sync collapses a split `{align=…}` back onto the image line.

**Live Preview limits:** LP floats the CodeMirror line that holds the image (width-capped like the site figure). Wrap-around is usually close to Reading view; blank CM lines or editing the `{align=…}` token can still look slightly different. Prefer Reading view when checking final layout.

## Video embeds and tables

Reading view turns YouTube / Vimeo / Twitch markdown links into iframe embeds (same URL rules as BackDrop). GFM tables get light lore styling. Live Preview relies on Obsidian’s native table rendering — the plugin does **not** set overflow on `.cm-scroller` (keeps the 0.1.5 scroll fix).

## Remote images

Wiki bodies keep **absolute HTTPS** media URLs (usually Cloudflare R2 `*.r2.dev`). Obsidian loads those as remote embeds.

1. In Obsidian → **Settings → Files and links**, allow remote images (turn off “Forbid images from insecure origins” / any “disable remote images” style option if present). HTTPS R2 URLs should then load like in a browser.
2. Pull rewrites relative `/api/public/media/fetch?url=…` proxies back to the absolute target URL (Obsidian cannot resolve site-relative `/api/…` paths). Prefer keeping public R2 HTTPS links.
3. Pull also heals TipTap autolink corruption where a filename underscore split the destination into nested markdown — e.g. `![]([https://…/file](https://…/file)rest.png)` → `![](https://…/filerest.png)` — and encodes spaces in URLs. Re-pull notes that still show broken image markdown.
4. If a healed URL still 404s, the object is missing on R2 (content issue on BackDrop), not an Obsidian path bug.

LP image widgets keep their `src` when wrapped in a figure; broken `src` values are repaired from the markdown destination when possible.

## Vault layout

Filenames and category folders use human-readable titles (not URL slugs). `backdrop_slug` in frontmatter stays the URL slug for publishing.

```text
BackDrop/{world-slug}/wiki/{Category Name}/{Article Title}.md
BackDrop/{world-slug}/timeline/{Event Title}--{short-id}.md
```

## Wikilinks and backlinks

BackDrop articles use slug wikilinks (`[[westhollow-academics]]`, `[[slug|label]]`, `[[slug#heading]]`). Obsidian resolves links by **note title/filename**, so the plugin rewrites on sync:

| Direction | Body links become |
|-----------|-------------------|
| **Pull** (and when writing notes) | `[[slug]]` → `[[Article Title]]` (or `[[Title\|label]]` / `#heading` preserved) |
| **Publish** | `[[Article Title]]` → `[[slug]]` via target note’s `backdrop_slug` |

`backdrop_slug` stays in frontmatter either way. After a pull, vault notes contain real Obsidian internal links, so the core **Backlinks** pane, outgoing links, and graph work without a custom resolver.

- Unknown/broken slugs stay as `[[slug]]` (unresolved in Obsidian).
- `[[timeline:…]]` and `:::timeline` blocks are **not** rewritten (BackDrop-only; timeline stubs still render in reading view).
- Timeline event bodies get the same slug↔title rewrite when they contain wiki links.
- An in-memory slug index (per world, from `backdrop_type: wiki` notes) drives rewrites; it refreshes after pull and on vault create/modify/rename/delete (debounced).

**Tip:** If older notes still show slug links, run **Pull from BackDrop** once — unchanged notes are link-normalized in place when not dirty.

## Dev

```bash
npm run build
npm run install:vault
```

Override install path with `BACKDROP_SYNC_VAULT_PLUGIN`.

## Publishing

Obsidian BRAT / community installs need a GitHub Release whose **tag equals `manifest.json` `version` with no `v` prefix** (e.g. `0.1.8`, not `v0.1.8`), with assets `main.js`, `manifest.json`, `styles.css`, and `versions.json`.

1. Bump version (keeps `manifest.json`, `package.json`, and `versions.json` in sync):

   ```bash
   npm run version:patch   # or version:minor / version:major
   # or one-shot:
   npm run release:patch   # bump + build, then commit/push yourself
   ```

2. Commit the bumped files and push to `master` (or `main`).

3. GitHub Actions (`.github/workflows/release.yml`) runs `npm ci && npm run build`, then creates/updates a release tagged with the manifest version and uploads the plugin assets.

Do **not** create tags like `v0.1.x` by hand. Re-running CI for the same version updates that release in place.

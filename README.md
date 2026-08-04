# BackDrop Sync


Digital-garden style sync for BackDrop wiki and timeline articles.

## Setup

1. On [backdrop.quest](https://backdrop.quest) dashboard → **API keys** (vault sync) → Create key (copy once).
2. In this repo: `npm install && npm run install:vault`
3. Enable **BackDrop** under Community plugins (Roleplay Writing vault).
4. Settings → BackDrop: paste API base (`https://api.backdrop.quest`) and your `bd_…` key. After the key is set, a **Worlds to sync** checklist loads from the API — enable wiki and/or timeline per world (disabled when you lack edit access). Leave the list untouched to pull all editable worlds; any toggle saves an explicit selection.

## Editing bar

Open a note with `backdrop_type: wiki` or `timeline` in frontmatter. The markdown view header shows BackDrop actions: **Insert image**, **Insert audio**, spoiler wrap, **Insert wikilink**, **Article properties**, **Resolve sync…**, and **Pull this note**.

A compact format strip (H2 / H3 / Bold / Italic / Link / Table) sits beside the header actions on BackDrop notes only.

The status bar shows sync state for the active note: **Clean** / **Dirty** / **Conflict** / **Unpublished**. Click the badge to open **Resolve sync…** (keep local, take remote, or force-publish local). Right-click the badge for insert shortcuts.

## Wiki editor helpers

| Action | Behavior |
|--------|----------|
| **Insert image** | Pick a vault file or paste path/HTTPS URL; vault files upload via BackDrop assets, then insert `![alt](url){align=…}` (align prompted). |
| **Insert audio** | Same upload/path flow; inserts `[label](url)`. |
| **Insert wikilink** | Fuzzy-search the wiki slug index by title; inserts `[[Note Title]]` or `[[Note Title\|label]]` when text was selected. |
| **Article properties** | Status, category (with **New…** create), Publish to Discord (wiki, non-pin), characters, parent article, linked pins/regions, thumbnail (wiki) or header image (timeline). Categories/pins/regions come from the last pull cache. |
| **Resolve sync…** | On conflict: side-by-side local vs remote body excerpts. Keep local, take remote (force pull), or publish local (force). |

Pull caches each world’s categories, pins, regions, lanes, and eras in plugin data. On publish, pin/region ids, characters, parent, thumbnail, and `discord_sync_enabled` are sent when present.

## Pull behavior

Pulls respect the worlds checklist (wiki / timeline facets). If you turn every world off after customizing, you’ll get a notice to pick worlds in settings instead of silently pulling everything.

| Action | Behavior |
|--------|----------|
| **Pull on startup** | Creates missing notes only; never overwrites existing files |
| **Pull from BackDrop** (command / ribbon) | Creates missing; updates non-dirty remote-newer notes; skips local edits and marks them **Conflict** |
| **Pull current note from BackDrop** | Overwrites the active note from the server even if dirty (with a notice) |

## Commands

- **Pull from BackDrop** / **Pull current note from BackDrop**
- **Publish current note** / **Force publish current note** / **Publish all pending**
- **New wiki article** / **New timeline event**
- **Insert image** / **Insert audio** / **Wrap selection as spoiler** / **Insert timeline embed stub** / **Insert wikilink**
- **Article properties** / **Resolve sync…**

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

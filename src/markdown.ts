import { Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { editorLivePreviewField, type MarkdownPostProcessorContext } from "obsidian";

const ALIGN_RE = /!\[([^\]]*)\]\(([^)]+)\)\{align=(left|center|right)\}/g;
/** Rejoin image + `{align=…}` across one or more blank lines. */
const SPLIT_ALIGN_RE =
  /(!\[[^\]]*\]\([^)]+\))[ \t]*(?:\r?\n[ \t]*)+(\{align=(?:left|center|right)\})/g;
const ALIGN_TOKEN_RE = /\{align=(left|center|right)\}/;
const ALIGN_ONLY_RE = /^\s*\{align=(left|center|right)\}\s*$/;
/**
 * TipTap autolink corruption: `![]([https://…/file](https://…/file)rest.png)`
 * — nested markdown link inside the image destination.
 */
const NESTED_LINK_IN_IMAGE_RE =
  /!\[([^\]]*)\]\(\[(https?:\/\/[^\]\s]+)\]\(\2\)([^)]*)\)/g;
/** Any markdown image (optionally with `{align=…}`) — destination may contain nested `()`. */
const MD_IMAGE_RE =
  /!\[([^\]]*)\]\(((?:[^()]|\([^)]*\))*)\)((?:\{align=(?:left|center|right)\})?)/g;
/**
 * Same-line image + optional whitespace + `{align=…}` (Live Preview source scan).
 * Marker string kept for install:vault verification.
 */
const LP_ALIGN_MARKER = "bd-lp-align-v4";
const LP_ALIGN_IMAGE_RE =
  /!\[([^\]]*)\]\(([^)]+)\)[ \t]*\{align=(left|center|right)\}/g;
/** Wiki/image embed: `![[target]]` or `![[target|size]]` + align. */
const LP_WIKI_ALIGN_RE =
  /!\[\[([^\]]+)\]\][ \t]*\{align=(left|center|right)\}/g;
const LP_IMAGE_LINE_RE = /!\[([^\]]*)\]\(([^)]+)\)\s*$/;
const LP_WIKI_LINE_RE = /!\[\[([^\]]+)\]\]\s*$/;
const LP_BLANK_LINE_RE = /^[\s\u00a0]*$/;
const AUDIO_EXT = /\.(mp3|ogg|wav|m4a|aac|flac|webm)(\?.*)?$/i;
const TIMELINE_BLOCK_RE = /:::timeline\s*([\s\S]*?):::/gi;
const SPOILER_RE = /\|\|([\s\S]+?)\|\|/g;
const SUBHEAD_RE = /^-#\s+(.+)$/gm;

type Align = "left" | "center" | "right";

export function registerMarkdownProcessors(plugin: {
  registerMarkdownPostProcessor: (
    processor: (el: HTMLElement, ctx: MarkdownPostProcessorContext) => void
  ) => void;
  registerMarkdownCodeBlockProcessor: (
    language: string,
    handler: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => void
  ) => void;
}): void {
  plugin.registerMarkdownPostProcessor((el) => {
    enhanceAlignedImages(el);
    enhanceAudioLinks(el);
    enhanceVideoLinks(el);
    enhanceSpoilers(el);
    enhanceTimelineEmbeds(el);
    enhanceTables(el);
  });
}

/**
 * Live Preview (CM6): hide `{align=…}` and wrap Obsidian's image widget in
 * `figure.bd-lore-figure--{align}`. Source on disk stays `![](url){align=…}`.
 */
export function alignedImageLivePreviewExtension(): Extension {
  return alignedImageLpPlugin;
}

/**
 * Ensure `![](url){align=…}` stays on one line (publish + reading parity).
 * Safe to run on any body; does not touch fenced code if no match pattern inside.
 */
export function normalizeAlignedImageLines(body: string): string {
  return String(body || "").replace(SPLIT_ALIGN_RE, "$1$2");
}

/**
 * Heal image destinations so Obsidian can load them:
 * - TipTap autolink nested `[url](url)suffix` inside `![]()`
 * - `/api/public/media/fetch?url=` → absolute HTTPS target (prefer public R2)
 * - encode literal spaces in URLs
 */
export function normalizeRemoteImageMarkdown(body: string): string {
  let s = String(body || "");
  s = s.replace(NESTED_LINK_IN_IMAGE_RE, (_m, alt: string, base: string, rest: string) => {
    // TipTap/linkify usually cuts the URL at `_`, leaving the underscore out of both sides.
    let joined = `${base}${rest}`;
    if (rest && !/^[_/?#.-]/.test(rest) && !/[/_-]$/.test(base)) {
      joined = `${base}_${rest}`;
    }
    return `![${alt}](${joined})`;
  });
  s = s.replace(MD_IMAGE_RE, (_m, alt: string, rawUrl: string, alignSuffix: string) => {
    const url = sanitizeImageDestination(String(rawUrl || "").trim());
    return `![${alt}](${url})${alignSuffix || ""}`;
  });
  return s;
}

/** Full body normalize used on pull / link healing. */
export function normalizeWikiBodyForVault(body: string): string {
  return normalizeAlignedImageLines(normalizeRemoteImageMarkdown(body));
}

function sanitizeImageDestination(url: string): string {
  const raw = String(url || "").trim();
  if (!raw) return "";
  let next = unwrapMediaFetchProxy(raw);
  next = encodeSpacesInUrl(next);
  return next;
}

/** Safe URL parse — never throw on empty/relative/malformed values. */
function tryParseUrl(value: string, base?: string): URL | null {
  const s = String(value || "").trim();
  if (!s) return null;
  try {
    return base !== undefined ? new URL(s, base) : new URL(s);
  } catch {
    return null;
  }
}

/** Prefer absolute public CDN URL over BackDrop media proxy (Obsidian can't use relative `/api/…`). */
function unwrapMediaFetchProxy(url: string): string {
  const s = String(url || "").trim();
  if (!s) return s;
  if (!/media\/fetch/i.test(s) || !/[?&]url=/i.test(s)) return s;
  const abs = /^https?:\/\//i.test(s)
    ? s
    : `https://api.backdrop.quest${s.startsWith("/") ? "" : "/"}${s}`;
  const u = tryParseUrl(abs);
  if (u) {
    if (
      /\/(?:api\/)?public\/media\/fetch$/i.test(u.pathname) ||
      u.pathname.includes("/media/fetch")
    ) {
      const target = u.searchParams.get("url");
      if (target && /^https?:\/\//i.test(target)) return target;
    } else {
      return s;
    }
  }
  const m = s.match(/[?&]url=([^&]+)/i);
  if (m) {
    try {
      const decoded = decodeURIComponent(m[1].replace(/\+/g, " "));
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {
      /* keep original */
    }
  }
  return s;
}

function encodeSpacesInUrl(url: string): string {
  const s = String(url || "").trim();
  if (!s || !/\s/.test(s)) return s || url;
  // Only absolute http(s) go through URL(); relative/app:// etc. get space encode only.
  if (!/^https?:\/\//i.test(s)) return s.replace(/ /g, "%20");
  const u = tryParseUrl(s);
  if (!u) return s.replace(/ /g, "%20");
  u.pathname = u.pathname
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      try {
        return encodeURIComponent(decodeURIComponent(seg));
      } catch {
        return encodeURIComponent(seg);
      }
    })
    .join("/");
  return u.toString();
}

function isAlign(value: string | null | undefined): value is Align {
  return value === "left" || value === "center" || value === "right";
}

function getWrapTarget(img: HTMLImageElement): HTMLElement {
  const embed = img.closest(
    "span.internal-embed, span.image-embed, span.media-embed, div.internal-embed"
  );
  if (embed && embed.instanceOf(HTMLElement) && embed.contains(img)) return embed;
  return img;
}

function setFigureAlign(figure: HTMLElement, align: Align): void {
  figure.className = `bd-lore-figure bd-lore-figure--${align}`;
  figure.setAttribute("data-bd-align", align);
}

/** Strip Obsidian/theme sizing that fights BackDrop float max-width caps. */
function normalizeAlignedImageSizing(img: HTMLImageElement, align: Align): void {
  if (align !== "left" && align !== "right") return;
  img.removeAttribute("width");
  img.removeAttribute("height");
  img.style.removeProperty("width");
  img.style.removeProperty("max-width");
  img.style.removeProperty("height");
}

/**
 * Hoist a floated figure out of a wrapping `<p>` so it participates in the
 * preview-section float context (matches BackDrop HTML `<figure>` siblings).
 */
function hoistFigureFromParagraph(figure: HTMLElement): void {
  const parent = figure.parentElement;
  if (!parent || parent.tagName !== "P") return;
  const align = figure.getAttribute("data-bd-align");
  if (align !== "left" && align !== "right" && align !== "center") return;

  const extras = Array.from(parent.childNodes).filter((n) => {
    if (n === figure) return false;
    if (n.nodeType === Node.TEXT_NODE) return !!(n.textContent || "").trim();
    return true;
  });
  if (extras.length > 0) return;
  parent.replaceWith(figure);
}

/** Repair TipTap-mangled / proxy / space-broken src without stripping a good URL. */
function repairImageSrc(img: HTMLImageElement, preferredUrl?: string): void {
  const current = (img.getAttribute("src") || "").trim();
  let candidate = (preferredUrl || "").trim() || current;
  if (!candidate) return;

  // Nested-link residue Obsidian may put in src: `[https://…` or full mangled form.
  if (candidate.startsWith("[http")) {
    const m = candidate.match(/\[(https?:\/\/[^\]\s]+)\]\(\1\)(.*)$/);
    if (m) candidate = `${m[1]}${m[2] || ""}`;
    else {
      const bare = candidate.match(/\[(https?:\/\/[^\]\s]+)/);
      if (bare) candidate = bare[1];
    }
  }
  candidate = sanitizeImageDestination(candidate);
  if (!candidate || candidate === current) return;
  // Keep Obsidian's widget wired — only rewrite when clearly broken or preferred is cleaner.
  const broken =
    !current ||
    current.startsWith("[") ||
    /media\/fetch/i.test(current) ||
    /\s/.test(current);
  if (broken || (preferredUrl && sanitizeImageDestination(preferredUrl) === candidate && current !== candidate)) {
    // Only push absolute http(s) into the DOM src setter — relative/empty throw Invalid URL in Electron.
    if (!/^https?:\/\//i.test(candidate) && !candidate.startsWith("app://") && !candidate.startsWith("data:")) {
      return;
    }
    img.setAttribute("src", candidate);
    try {
      img.src = candidate;
    } catch {
      /* ignore */
    }
  }
}

function wrapImageInFigure(img: HTMLImageElement, align: Align, preferredUrl?: string): HTMLElement {
  repairImageSrc(img, preferredUrl);
  const existing = img.closest(".bd-lore-figure");
  if (existing && existing.instanceOf(HTMLElement)) {
    setFigureAlign(existing, align);
    normalizeAlignedImageSizing(img, align);
    hoistFigureFromParagraph(existing);
    return existing;
  }

  // Capture src before moving nodes — some themes/widgets clear attributes on reparent.
  const srcBefore = img.getAttribute("src") || img.src || "";
  const target = getWrapTarget(img);
  const figure = createEl("figure");
  setFigureAlign(figure, align);
  target.replaceWith(figure);
  figure.appendChild(target);

  if (srcBefore && !(img.getAttribute("src") || "").trim()) {
    img.setAttribute("src", srcBefore);
    try {
      img.src = srcBefore;
    } catch {
      /* ignore */
    }
  }
  repairImageSrc(img, preferredUrl || srcBefore);

  if (img.alt && !figure.querySelector("figcaption")) {
    figure.createEl("figcaption", { text: img.alt });
  }
  normalizeAlignedImageSizing(img, align);
  hoistFigureFromParagraph(figure);
  return figure;
}

/** Apply align to an img (wrapping if needed). */
function ensureFigure(img: HTMLImageElement, align: Align): HTMLElement {
  return wrapImageInFigure(img, align);
}

/**
 * Remove `{align=…}` tokens from text nodes under `root`.
 * Returns the last align found (if any).
 */
function stripAlignTokensFromTree(root: Node): Align | null {
  let found: Align | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const toFix: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    if (node.instanceOf(Text)) toFix.push(node);
    node = walker.nextNode();
  }
  for (const textNode of toFix) {
    const value = textNode.nodeValue || "";
    if (!ALIGN_TOKEN_RE.test(value)) continue;
    const m = value.match(ALIGN_TOKEN_RE);
    if (m && isAlign(m[1])) found = m[1];
    const next = value.replace(/\{align=(left|center|right)\}/g, "").replace(/\u00a0/g, " ");
    if (!next.trim()) {
      textNode.remove();
    } else {
      textNode.nodeValue = next;
    }
  }
  return found;
}

function findPreviousImage(from: Element): HTMLImageElement | null {
  let el: Element | null = from.previousElementSibling;
  while (el) {
    if (el.instanceOf(HTMLImageElement)) return el;
    const img = el.querySelector("img");
    if (img && img.instanceOf(HTMLImageElement)) return img;
    el = el.previousElementSibling;
  }
  // Cross section: parent section's previous sibling
  const section = from.parentElement;
  if (section) {
    let prevSec: Element | null = section.previousElementSibling;
    while (prevSec) {
      const imgs = prevSec.querySelectorAll("img");
      if (imgs.length) {
        const last = imgs[imgs.length - 1];
        if (last.instanceOf(HTMLImageElement)) return last;
      }
      prevSec = prevSec.previousElementSibling;
    }
  }
  return null;
}

/** Standalone `<p>{align=right}</p>` (or whole section) → previous image. */
function consumeOrphanAlignNodes(root: HTMLElement): void {
  const candidates: Element[] = [];
  if (ALIGN_ONLY_RE.test((root.textContent || "").trim()) && !root.querySelector("img")) {
    candidates.push(root);
  }
  root.querySelectorAll("p").forEach((p) => candidates.push(p));

  for (const el of candidates) {
    if (!el.isConnected) continue;
    const text = (el.textContent || "").trim();
    const m = text.match(/^\{align=(left|center|right)\}$/);
    if (!m || !isAlign(m[1])) continue;
    if (el.querySelector("img")) continue;
    // Avoid eating paragraphs that have other elements with meaningful content
    const meaningful = el.querySelector("a, code, strong, em, span.internal-embed");
    if (meaningful) continue;

    const img = findPreviousImage(el === root ? root : el);
    if (!img) continue;

    ensureFigure(img, m[1]);
    if (el === root) {
      root.replaceChildren();
    } else {
      el.remove();
    }
  }
}

/**
 * Find `{align=…}` beside an image (same block or following sibling) and remove it.
 */
function extractAlignNearImage(img: HTMLImageElement): Align | null {
  const data = img.getAttribute("data-bd-align");
  if (isAlign(data)) {
    img.removeAttribute("data-bd-align");
    return data;
  }

  const target = getWrapTarget(img);
  const closest = target.closest("p, li, td, th, div.markdown-preview-section");
  const block =
    (closest && closest.instanceOf(HTMLElement) ? closest : null) ||
    (target.parentElement && target.parentElement.instanceOf(HTMLElement)
      ? target.parentElement
      : null);
  if (!block) return null;

  let found = stripAlignTokensFromTree(block);

  // Following siblings after the block (next <p>{align=…}</p>)
  let sib: Element | null = block.nextElementSibling;
  while (sib) {
    const t = (sib.textContent || "").trim();
    const m = t.match(/^\{align=(left|center|right)\}$/);
    if (m && isAlign(m[1]) && !sib.querySelector("img")) {
      found = m[1];
      sib.remove();
      break;
    }
    if (t) break;
    const empty = sib;
    sib = sib.nextElementSibling;
    empty.remove();
  }

  // Parent section next sibling (LP / multi-section reading view)
  const section = block.closest(".markdown-preview-section") || block.parentElement;
  if (!found && section) {
    let nextSec: Element | null = section.nextElementSibling;
    while (nextSec) {
      const t = (nextSec.textContent || "").trim();
      const m = t.match(/^\{align=(left|center|right)\}$/);
      if (m && isAlign(m[1]) && !nextSec.querySelector("img")) {
        found = m[1];
        nextSec.replaceChildren();
        break;
      }
      if (t) break;
      nextSec = nextSec.nextElementSibling;
    }
  }

  return found;
}

function isInLivePreviewDom(el: HTMLElement): boolean {
  return !!el.closest(".markdown-source-view.is-live-preview");
}

function enhanceAlignedImages(root: HTMLElement) {
  // Align-only leftovers first (common when Obsidian splits `{align=…}` onto next block)
  consumeOrphanAlignNodes(root);

  const inLp = isInLivePreviewDom(root);
  const images = Array.from(root.querySelectorAll("img"));
  for (const img of images) {
    if (!img.instanceOf(HTMLImageElement)) continue;
    if (img.closest(".bd-lore-figure")) continue;

    const align = extractAlignNearImage(img);
    // In Live Preview the `{align=…}` token often stays in the CM text layer (not HTML),
    // so defaulting to center fights the ViewPlugin and leaves the token visible.
    if (!align) {
      if (inLp) continue;
      wrapImageInFigure(img, "center");
      continue;
    }
    wrapImageInFigure(img, align);
  }

  // Rare: raw markdown still present in a paragraph (source not yet rendered as <img>)
  root.querySelectorAll("p").forEach((p) => {
    if (!p.instanceOf(HTMLElement)) return;
    if (p.querySelector("img, .internal-embed, .bd-lore-figure")) return;
    const text = p.textContent || "";
    if (!text.includes("{align=") || !text.includes("![")) return;
    ALIGN_RE.lastIndex = 0;
    if (!ALIGN_RE.test(text)) return;
    ALIGN_RE.lastIndex = 0;

    const frag = createFragment();
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = ALIGN_RE.exec(text)) !== null) {
      if (match.index > last) {
        frag.appendText(text.slice(last, match.index));
      }
      const alt = String(match[1] || "");
      const url = sanitizeImageDestination(String(match[2] || "").trim());
      const a = isAlign(match[3]) ? match[3] : "center";
      const figure = frag.createEl("figure", {
        cls: `bd-lore-figure bd-lore-figure--${a}`,
        attr: { "data-bd-align": a },
      });
      figure.createEl("img", {
        attr: { src: url, alt },
      });
      if (alt) figure.createEl("figcaption", { text: alt });
      last = match.index + match[0].length;
    }
    if (last < text.length) frag.appendText(text.slice(last));
    p.replaceWith(frag);
  });

  // Heal broken remote srcs even when no `{align=}` token remains.
  root.querySelectorAll("img").forEach((img) => {
    if (img.instanceOf(HTMLImageElement)) repairImageSrc(img);
  });

  markPreviewHasLoreFigures(root);
}

/** Toggle a class on the reading/preview view so CSS can avoid broad `:has()`. */
function markPreviewHasLoreFigures(root: HTMLElement): void {
  const view = root.closest(".markdown-preview-view, .markdown-reading-view");
  if (!view || !view.instanceOf(HTMLElement)) return;
  view.toggleClass("bd-has-lore-figures", !!view.querySelector(".bd-lore-figure"));
}

/* ── Live Preview (CodeMirror 6) ─────────────────────────────────────── */
void LP_ALIGN_MARKER; // retained in bundle for install:vault greps

type LpAlignHit = {
  /** Start of image markdown / embed */
  imageFrom: number;
  /** End of image markdown (before `{align=}`) */
  imageTo: number;
  /** Start of `{align=…}` */
  tokenFrom: number;
  /** End of `{align=…}` */
  tokenTo: number;
  align: Align;
  alt: string;
  url: string;
  /** True when there is no preceding image (orphan token — hide only). */
  orphan?: boolean;
};

function selectionOverlaps(view: EditorView, from: number, to: number): boolean {
  for (const range of view.state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

function isLivePreviewEditor(view: EditorView): boolean {
  const field = view.state.field(editorLivePreviewField, false);
  if (field === true) return true;
  // Field can lag on first paint / mode flips — trust the DOM class Obsidian sets.
  return !!view.dom.closest(".markdown-source-view.is-live-preview");
}

function pushUniqueHit(hits: LpAlignHit[], seenTokens: Set<number>, hit: LpAlignHit): void {
  if (seenTokens.has(hit.tokenFrom)) return;
  seenTokens.add(hit.tokenFrom);
  hits.push(hit);
}

function findPrecedingImageLine(
  doc: EditorView["state"]["doc"],
  alignLineNumber: number
): { lineNumber: number; md: RegExpMatchArray; kind: "md" | "wiki" } | null {
  // Skip blank / nbsp-only lines between image and `{align=…}` (up to 6 lines back).
  for (let n = alignLineNumber - 1, steps = 0; n >= 1 && steps < 6; n--, steps++) {
    const line = doc.line(n);
    if (LP_BLANK_LINE_RE.test(line.text)) continue;
    const md = line.text.match(LP_IMAGE_LINE_RE);
    if (md) return { lineNumber: n, md, kind: "md" };
    const wiki = line.text.match(LP_WIKI_LINE_RE);
    if (wiki) return { lineNumber: n, md: wiki, kind: "wiki" };
    // Non-empty non-image line — stop (token is not attached to a nearby image).
    break;
  }
  return null;
}

/** Collect same-line, next-line, and next-nonempty-line `{align=}` hits. */
function collectLpAlignHits(view: EditorView): LpAlignHit[] {
  const hits: LpAlignHit[] = [];
  const seenTokens = new Set<number>();
  const doc = view.state.doc;

  const ranges =
    view.visibleRanges.length > 0
      ? view.visibleRanges
      : [{ from: 0, to: Math.min(doc.length, 5000) }];

  for (const { from, to } of ranges) {
    // Widen so a split token just outside the viewport is still found
    const scanFrom = Math.max(0, from - 200);
    const scanTo = Math.min(doc.length, to + 200);
    const slice = doc.sliceString(scanFrom, scanTo);

    LP_ALIGN_IMAGE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LP_ALIGN_IMAGE_RE.exec(slice))) {
      if (!isAlign(m[3])) continue;
      const abs = scanFrom + m.index;
      const full = m[0];
      const token = `{align=${m[3]}}`;
      const tokenFrom = abs + full.length - token.length;
      pushUniqueHit(hits, seenTokens, {
        imageFrom: abs,
        imageTo: tokenFrom,
        tokenFrom,
        tokenTo: abs + full.length,
        align: m[3],
        alt: m[1] || "",
        url: m[2] || "",
      });
    }

    LP_WIKI_ALIGN_RE.lastIndex = 0;
    while ((m = LP_WIKI_ALIGN_RE.exec(slice))) {
      if (!isAlign(m[2])) continue;
      const abs = scanFrom + m.index;
      const full = m[0];
      const token = `{align=${m[2]}}`;
      const tokenFrom = abs + full.length - token.length;
      pushUniqueHit(hits, seenTokens, {
        imageFrom: abs,
        imageTo: tokenFrom,
        tokenFrom,
        tokenTo: abs + full.length,
        align: m[2],
        alt: "",
        url: m[1] || "",
      });
    }
  }

  // Split form: image on one line, optional blank lines, then `{align=…}` alone
  for (const { from, to } of ranges) {
    const startLine = doc.lineAt(Math.max(0, from)).number;
    const endLine = doc.lineAt(Math.min(to, doc.length)).number;
    // Look a few lines past the viewport for trailing align tokens
    const last = Math.min(doc.lines, endLine + 4);
    const first = Math.max(1, startLine - 1);
    for (let n = first; n <= last; n++) {
      const line = doc.line(n);
      const trimmed = line.text.trim().replace(/\u00a0/g, "");
      const only = trimmed.match(/^\{align=(left|center|right)\}$/);
      if (!only || !isAlign(only[1])) continue;

      const tokenIdx = line.text.indexOf(`{align=${only[1]}}`);
      if (tokenIdx < 0) continue;
      const tokenFrom = line.from + tokenIdx;
      const tokenTo = tokenFrom + `{align=${only[1]}}`.length;

      const prevImg = findPrecedingImageLine(doc, n);
      if (!prevImg) {
        // Orphan token (no nearby image) — still hide it in LP.
        pushUniqueHit(hits, seenTokens, {
          imageFrom: tokenFrom,
          imageTo: tokenFrom,
          tokenFrom,
          tokenTo,
          align: only[1],
          alt: "",
          url: "",
          orphan: true,
        });
        continue;
      }

      const imgLine = doc.line(prevImg.lineNumber);
      const imgMatch = prevImg.md;
      const raw = imgMatch[0];
      const imageFrom = imgLine.from + imgLine.text.indexOf(raw);
      pushUniqueHit(hits, seenTokens, {
        imageFrom,
        imageTo: imgLine.from + imgLine.text.indexOf(raw) + raw.length,
        tokenFrom,
        tokenTo,
        align: only[1],
        alt: prevImg.kind === "md" ? imgMatch[1] || "" : "",
        url: prevImg.kind === "md" ? imgMatch[2] || "" : imgMatch[1] || "",
      });
    }
  }

  hits.sort((a, b) => a.tokenFrom - b.tokenFrom || a.imageFrom - b.imageFrom);
  return hits;
}

/** Invisible stand-in so `{align=…}` disappears in LP without touching the file. */
class HiddenAlignWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = createSpan({ cls: "bd-lore-align-hidden" });
    span.setAttribute("aria-hidden", "true");
    span.setAttribute("data-bd-lp", LP_ALIGN_MARKER);
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function buildLpAlignDecorations(view: EditorView): DecorationSet {
  try {
    if (!isLivePreviewEditor(view)) {
      return Decoration.none;
    }

    const hits = collectLpAlignHits(view);
    type Item = { from: number; to: number; deco: Decoration };
    const items: Item[] = [];

    for (const hit of hits) {
      const editingToken = selectionOverlaps(view, hit.tokenFrom, hit.tokenTo);

      // Always float the image line when we know the align — even if the caret is
      // on the image markdown. Only skip hiding the token while it is being edited.
      if (!hit.orphan) {
        const line = view.state.doc.lineAt(hit.imageFrom);
        items.push({
          from: line.from,
          to: line.from,
          deco: Decoration.line({
            class: `bd-lore-lp-line bd-lore-lp-line--${hit.align}`,
          }),
        });
      }

      // Split / orphan `{align=…}` on its own line: collapse that CM row (gap fix).
      if (hit.tokenFrom < hit.tokenTo) {
        const tokenLine = view.state.doc.lineAt(hit.tokenFrom);
        const imageLine =
          hit.orphan || hit.imageFrom >= hit.tokenTo
            ? null
            : view.state.doc.lineAt(hit.imageFrom);
        if (!imageLine || tokenLine.number !== imageLine.number) {
          items.push({
            from: tokenLine.from,
            to: tokenLine.from,
            deco: Decoration.line({
              class: "bd-lore-lp-line bd-lore-lp-line--token-only",
            }),
          });
        }
      }

      if (!editingToken && hit.tokenFrom < hit.tokenTo) {
        // Prefer replace widget; also mark so CSS can hide if another plugin fights replace.
        items.push({
          from: hit.tokenFrom,
          to: hit.tokenTo,
          deco: Decoration.replace({
            widget: new HiddenAlignWidget(),
            inclusive: false,
          }),
        });
      }
    }

    items.sort((a, b) => a.from - b.from || a.to - b.to);
    const builder = new RangeSetBuilder<Decoration>();
    const seenLinePos = new Set<number>();
    let prevTo = -1;
    for (const item of items) {
      // One line decoration per line start.
      if (item.from === item.to) {
        if (seenLinePos.has(item.from)) continue;
        seenLinePos.add(item.from);
        // Point decorations may share a position with a prior point; only skip if
        // they would start inside a previous non-empty range.
        if (item.from < prevTo) continue;
        builder.add(item.from, item.to, item.deco);
        continue;
      }
      if (item.from < prevTo) continue;
      builder.add(item.from, item.to, item.deco);
      prevTo = item.to;
    }
    return builder.finish();
  } catch {
    // Never let LP decorate throws freeze the editor / scroll loop.
    return Decoration.none;
  }
}

function cmLineForPos(view: EditorView, pos: number): HTMLElement | null {
  try {
    const dom = view.domAtPos(pos);
    const node = dom.node.instanceOf(Element) ? dom.node : dom.node.parentElement;
    const line = node?.closest(".cm-line");
    return line && line.instanceOf(HTMLElement) ? line : null;
  } catch {
    return null;
  }
}

/**
 * Wrap Obsidian's LP image widget in `figure.bd-lore-figure--*`.
 * Runs after decorations so `{align=…}` is already hidden.
 */
function applyLpAlignFigures(view: EditorView): void {
  try {
    if (!isLivePreviewEditor(view)) return;
    if (!view.contentDOM.isConnected) return;

    const hits = collectLpAlignHits(view);
    for (const hit of hits) {
      if (hit.orphan) continue;

      const lineEl = cmLineForPos(view, hit.imageFrom);
      if (!lineEl) continue;

      const img =
        lineEl.querySelector("img") ||
        lineEl.querySelector(".internal-embed img, .image-embed img, .media-embed img");
      if (img && img.instanceOf(HTMLImageElement)) {
        // Prefer markdown destination (already scanned) so LP widgets keep a loadable src.
        const preferred = hit.url && /^https?:\/\//i.test(hit.url) ? hit.url : undefined;
        wrapImageInFigure(img, hit.align, preferred ? sanitizeImageDestination(preferred) : undefined);
      }
    }

    // Aggressive fallback: any leftover `{align=…}` text nodes under contentDOM
    // (e.g. another plugin re-materialized source) → hide via CSS class on parent.
    hideResidualAlignText(view.contentDOM);
  } catch {
    /* never break CM update / scroll */
  }
}

function hideResidualAlignText(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    if (node.instanceOf(Text)) nodes.push(node);
    node = walker.nextNode();
  }
  for (const textNode of nodes) {
    const value = textNode.nodeValue || "";
    if (!value.includes("{align=")) continue;
    const parent = textNode.parentElement;
    if (!parent || parent.closest("code, pre, .cm-inline-code, .HyperMD-codeblock")) continue;
    if (parent.classList.contains("bd-lore-align-hidden")) continue;

    const normalized = value.replace(/\u00a0/g, " ");
    if (!ALIGN_TOKEN_RE.test(normalized)) continue;

    // Never hide a whole .cm-line that still holds the image widget.
    const line = parent.closest(".cm-line");
    if (line?.querySelector("img, .internal-embed, .image-embed, .media-embed")) {
      if (parent.classList.contains("cm-line") || parent === line) {
        const span = createSpan({ cls: "bd-lore-align-hidden" });
        span.setAttribute("aria-hidden", "true");
        textNode.parentNode?.insertBefore(span, textNode);
        span.appendChild(textNode);
        continue;
      }
    }

    if (!ALIGN_ONLY_RE.test(normalized)) continue;
    parent.classList.add("bd-lore-align-hidden");
    parent.setAttribute("aria-hidden", "true");
  }
}

const alignedImageLpPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private raf = 0;

    constructor(view: EditorView) {
      this.decorations = buildLpAlignDecorations(view);
      this.scheduleDom(view);
    }

    update(update: ViewUpdate) {
      try {
        // Always rebuild: LP field / DOM class can flip without doc/selection flags.
        this.decorations = buildLpAlignDecorations(update.view);
        this.scheduleDom(update.view);
      } catch {
        this.decorations = Decoration.none;
      }
    }

    destroy() {
      if (this.raf) window.cancelAnimationFrame(this.raf);
    }

    private scheduleDom(view: EditorView) {
      if (this.raf) window.cancelAnimationFrame(this.raf);
      this.raf = window.requestAnimationFrame(() => {
        this.raf = 0;
        applyLpAlignFigures(view);
        // Second pass after Obsidian's image widgets finish mounting.
        window.requestAnimationFrame(() => applyLpAlignFigures(view));
      });
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

function enhanceAudioLinks(root: HTMLElement) {
  root.querySelectorAll("a").forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (!AUDIO_EXT.test(href)) return;
    const figure = createEl("figure", { cls: "bd-lore-audio" });
    const audio = figure.createEl("audio");
    audio.controls = true;
    audio.src = href;
    const label = (a.textContent || "").trim();
    if (label && !/^https?:\/\//i.test(label)) {
      figure.createEl("figcaption", { text: label });
    }
    a.replaceWith(figure);
  });
}

/** Match BackDrop client `videoEmbeds.parseVideoEmbedUrl` rules. */
function parseVideoEmbedUrl(
  url: string
): { provider: "youtube" | "vimeo" | "twitch"; embedUrl: string; videoId: string } | null {
  const raw = String(url || "").trim();
  if (!raw) return null;
  let m =
    /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i.exec(
      raw
    );
  if (m) {
    return {
      provider: "youtube",
      videoId: m[1],
      embedUrl: `https://www.youtube-nocookie.com/embed/${m[1]}`,
    };
  }
  m = /(?:https?:\/\/)?(?:www\.)?vimeo\.com\/(?:video\/)?(\d+)/i.exec(raw);
  if (m) {
    return {
      provider: "vimeo",
      videoId: m[1],
      embedUrl: `https://player.vimeo.com/video/${m[1]}`,
    };
  }
  m = /(?:https?:\/\/)?(?:www\.)?twitch\.tv\/videos\/(\d+)/i.exec(raw);
  if (m) {
    return {
      provider: "twitch",
      videoId: m[1],
      embedUrl: `https://player.twitch.tv/?video=v${m[1]}`,
    };
  }
  m = /(?:https?:\/\/)?clips\.twitch\.tv\/([a-zA-Z0-9_-]+)/i.exec(raw);
  if (m) {
    return {
      provider: "twitch",
      videoId: m[1],
      embedUrl: `https://clips.twitch.tv/embed?clip=${encodeURIComponent(m[1])}`,
    };
  }
  m = /(?:https?:\/\/)?(?:www\.)?twitch\.tv\/[a-zA-Z0-9_]+\/clip\/([a-zA-Z0-9_-]+)/i.exec(raw);
  if (m) {
    return {
      provider: "twitch",
      videoId: m[1],
      embedUrl: `https://clips.twitch.tv/embed?clip=${encodeURIComponent(m[1])}`,
    };
  }
  return null;
}

function twitchParentHost(): string {
  try {
    if (typeof window !== "undefined" && window.location?.hostname) {
      return window.location.hostname;
    }
  } catch {
    /* ignore */
  }
  return "obsidian.md";
}

function enhanceVideoLinks(root: HTMLElement) {
  root.querySelectorAll("a").forEach((a) => {
    if (!a.instanceOf(HTMLAnchorElement)) return;
    if (a.closest(".bd-lore-video, .bd-lore-audio, code, pre")) return;
    const href = a.getAttribute("href") || a.href || "";
    const embed = parseVideoEmbedUrl(href);
    if (!embed) return;

    let src = embed.embedUrl;
    if (embed.provider === "twitch") {
      const sep = src.includes("?") ? "&" : "?";
      src = `${src}${sep}parent=${encodeURIComponent(twitchParentHost())}`;
    }

    const figure = createEl("figure", { cls: "bd-lore-figure bd-lore-video" });
    const frame = figure.createDiv({ cls: "bd-lore-video-frame" });
    frame.createEl("iframe", {
      attr: {
        src,
        title: (a.textContent || "").trim() || "Embedded video",
        allow:
          "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
        allowfullscreen: "true",
        referrerpolicy: "strict-origin-when-cross-origin",
        loading: "lazy",
      },
    });
    const label = (a.textContent || "").trim();
    if (label && !/^https?:\/\//i.test(label)) {
      figure.createEl("figcaption", { text: label });
    }
    a.replaceWith(figure);
  });
}

/** Mark tables for lore styling (Obsidian already renders GFM tables). */
function enhanceTables(root: HTMLElement) {
  root.querySelectorAll("table").forEach((table) => {
    if (!table.instanceOf(HTMLTableElement)) return;
    table.classList.add("bd-lore-table");
    const wrap = table.parentElement;
    if (wrap && !wrap.classList.contains("bd-lore-table-wrap") && wrap.tagName !== "FIGURE") {
      // Don't reparent aggressively — just tag for CSS; avoid scroll container hacks.
    }
  });
}

function enhanceSpoilers(root: HTMLElement) {
  root.querySelectorAll("p, li, td, th, h1, h2, h3, h4").forEach((node) => {
    if (!node.instanceOf(HTMLElement)) return;
    replaceSpoilersInElement(node);
  });
  root.querySelectorAll(".bd-discord-spoiler").forEach((el) => {
    el.addEventListener("click", () => {
      el.classList.toggle("is-revealed");
    });
  });
}

/** Split text nodes containing `||spoiler||` into spans — no innerHTML. */
function replaceSpoilersInElement(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    if (node.instanceOf(Text)) textNodes.push(node);
    node = walker.nextNode();
  }
  for (const textNode of textNodes) {
    const value = textNode.nodeValue || "";
    if (!value.includes("||")) continue;
    if (textNode.parentElement?.closest("code, pre, .bd-discord-spoiler")) continue;
    SPOILER_RE.lastIndex = 0;
    if (!SPOILER_RE.test(value)) continue;
    SPOILER_RE.lastIndex = 0;

    const frag = createFragment();
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = SPOILER_RE.exec(value)) !== null) {
      if (match.index > last) frag.appendText(value.slice(last, match.index));
      frag.createSpan({
        cls: "bd-discord-spoiler",
        text: match[1],
        attr: { title: "Click to reveal" },
      });
      last = match.index + match[0].length;
    }
    if (last < value.length) frag.appendText(value.slice(last));
    textNode.replaceWith(frag);
  }
}

function enhanceTimelineEmbeds(root: HTMLElement) {
  root.querySelectorAll("p, pre").forEach((node) => {
    const text = node.textContent || "";
    if (!text.includes(":::timeline")) return;
    const replaced = text.replace(TIMELINE_BLOCK_RE, (_m, opts) => {
      return `__BD_TIMELINE__${encodeURIComponent(String(opts).trim())}__`;
    });
    if (replaced === text) return;
    const parts = replaced.split(/(__BD_TIMELINE__.*?__)/);
    const wrap = createDiv();
    for (const part of parts) {
      const m = part.match(/^__BD_TIMELINE__(.*)__$/);
      if (m) {
        const box = wrap.createEl("aside", { cls: "bd-timeline-embed-stub callout" });
        box.createEl("strong", { text: "Timeline embed" });
        box.createEl("p", { text: "View this timeline on BackDrop." });
        box.createEl("pre", { text: decodeURIComponent(m[1]) });
      } else if (part.trim()) {
        wrap.createEl("p", { text: part });
      }
    }
    node.replaceWith(wrap);
  });
}

/** Used when inserting templates into the editor. */
export function alignedImageMarkdown(alt: string, url: string, align: "left" | "center" | "right"): string {
  return `![${alt}](${url}){align=${align}}`;
}

export function audioMarkdown(label: string, url: string): string {
  return `[${label}](${url})`;
}

export function spoilerMarkdown(text: string): string {
  return `||${text}||`;
}

export function timelineEmbedStub(options = "lane: all"): string {
  return `:::timeline\n${options}\n:::`;
}

export function wikilinkHelper(title: string): string {
  const t = title.trim() || "Article title";
  return `[[${t}]]`;
}

void SUBHEAD_RE;

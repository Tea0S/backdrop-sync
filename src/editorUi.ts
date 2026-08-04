import {
  App,
  Editor,
  FuzzySuggestModal,
  Modal,
  Notice,
  Setting,
  TFile,
  normalizePath,
} from "obsidian";
import type { BackdropClient } from "./api";
import { noticeError } from "./api";
import { buildNoteFile, hashContent, splitFrontmatter } from "./frontmatter";
import { alignedImageMarkdown, audioMarkdown } from "./markdown";
import {
  clearConflictPath,
  getSyncBadgeState,
  pullCurrentNote,
  publishFile,
  upsertCatalogCategory,
  type SyncBadgeState,
} from "./sync";
import type { BackdropSettings, WorldCatalogMeta } from "./types";
import type { WikiLinkEntry, WikiSlugIndex } from "./wikiLinks";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"]);
const AUDIO_EXTS = new Set(["mp3", "ogg", "wav", "m4a", "aac", "flac", "webm"]);

export function mimeForFile(file: TFile): string {
  const ext = file.extension.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "avif":
      return "image/avif";
    case "mp3":
      return "audio/mpeg";
    case "ogg":
      return "audio/ogg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "webm":
      return "audio/webm";
    default:
      return "application/octet-stream";
  }
}

export function resolveWorldSlug(
  app: App,
  file: TFile | null,
  settings: BackdropSettings,
  fallback: string
): string {
  if (file) {
    const cache = app.metadataCache.getFileCache(file);
    const fromFm = cache?.frontmatter?.backdrop_world;
    if (fromFm != null && String(fromFm).trim()) return String(fromFm).trim();
  }
  return fallback;
}

async function uploadVaultFile(
  client: BackdropClient,
  worldSlug: string,
  file: TFile,
  app: App
): Promise<string> {
  if (!worldSlug) throw new Error("World slug is required to upload (set backdrop_world).");
  const data = await app.vault.readBinary(file);
  return client.uploadAsset(worldSlug, file.name, mimeForFile(file), data);
}

async function resolveSourceToPublicUrl(
  app: App,
  client: BackdropClient,
  worldSlug: string,
  source: string,
  kind: "image" | "audio"
): Promise<string | null> {
  const raw = source.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;

  const path = normalizePath(raw.replace(/^\//, ""));
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    new Notice(`BackDrop: vault file not found: ${path}`);
    return null;
  }
  const ext = file.extension.toLowerCase();
  if (kind === "image" && !IMAGE_EXTS.has(ext)) {
    new Notice("BackDrop: pick an image file (png/jpg/gif/webp…).");
    return null;
  }
  if (kind === "audio" && !AUDIO_EXTS.has(ext)) {
    new Notice("BackDrop: pick an audio file (mp3/ogg/wav…).");
    return null;
  }
  try {
    new Notice("BackDrop: uploading…");
    return await uploadVaultFile(client, worldSlug, file, app);
  } catch (e) {
    noticeError(e, "Upload");
    return null;
  }
}

class VaultMediaSuggestModal extends FuzzySuggestModal<TFile> {
  private files: TFile[];
  private onPick: (file: TFile) => void | Promise<void>;

  constructor(app: App, kind: "image" | "audio", onPick: (file: TFile) => void | Promise<void>) {
    super(app);
    this.onPick = onPick;
    const allow = kind === "image" ? IMAGE_EXTS : AUDIO_EXTS;
    this.files = app.vault.getFiles().filter((f) => allow.has(f.extension.toLowerCase()));
    this.setPlaceholder(kind === "image" ? "Pick an image from the vault…" : "Pick audio from the vault…");
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(item: TFile): string {
    return item.path;
  }

  onChooseItem(item: TFile): void {
    void Promise.resolve(this.onPick(item)).catch((e) => noticeError(e));
  }
}

export class InsertImageModal extends Modal {
  private source = "";
  private alt = "";
  private align: "left" | "center" | "right" = "center";

  constructor(
    app: App,
    private client: BackdropClient,
    private worldSlug: string,
    private editor: Editor
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Insert image" });
    contentEl.createEl("p", {
      text: "Pick a vault file (uploads to BackDrop) or paste an HTTPS URL / vault path.",
      cls: "setting-item-description",
    });

    new Setting(contentEl)
      .setName("Source")
      .setDesc("Vault path or https://…")
      .addText((text) => {
        text.setPlaceholder("Attachments/photo.png or https://…").setValue(this.source).onChange((v) => {
          this.source = v;
        });
        text.inputEl.addClass("bd-setting-input-full");
      })
      .addButton((btn) =>
        btn.setButtonText("Vault…").onClick(() => {
          new VaultMediaSuggestModal(this.app, "image", (file) => {
            this.source = file.path;
            this.onOpen();
          }).open();
        })
      );

    new Setting(contentEl).setName("Alt text").addText((text) => {
      text.setValue(this.alt).onChange((v) => {
        this.alt = v;
      });
    });

    new Setting(contentEl).setName("Align").addDropdown((dd) => {
      dd.addOption("left", "Left")
        .addOption("center", "Center")
        .addOption("right", "Right")
        .setValue(this.align)
        .onChange((v) => {
          if (v === "left" || v === "center" || v === "right") this.align = v;
          else this.align = "center";
        });
    });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Insert")
        .setCta()
        .onClick(async () => {
          const url = await resolveSourceToPublicUrl(
            this.app,
            this.client,
            this.worldSlug,
            this.source,
            "image"
          );
          if (!url) {
            if (!this.source.trim()) new Notice("BackDrop: choose a vault file or paste a URL.");
            return;
          }
          this.editor.replaceSelection(alignedImageMarkdown(this.alt || "", url, this.align) + "\n");
          this.close();
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class InsertAudioModal extends Modal {
  private source = "";
  private label = "Audio";

  constructor(
    app: App,
    private client: BackdropClient,
    private worldSlug: string,
    private editor: Editor
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Insert audio" });
    contentEl.createEl("p", {
      text: "Pick a vault audio file (uploads to BackDrop) or paste an HTTPS URL / vault path.",
      cls: "setting-item-description",
    });

    new Setting(contentEl)
      .setName("Source")
      .setDesc("Vault path or https://…")
      .addText((text) => {
        text.setPlaceholder("Attachments/clip.mp3 or https://…").setValue(this.source).onChange((v) => {
          this.source = v;
        });
      })
      .addButton((btn) =>
        btn.setButtonText("Vault…").onClick(() => {
          new VaultMediaSuggestModal(this.app, "audio", (file) => {
            this.source = file.path;
            this.onOpen();
          }).open();
        })
      );

    new Setting(contentEl).setName("Label").addText((text) => {
      text.setValue(this.label).onChange((v) => {
        this.label = v;
      });
    });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Insert")
        .setCta()
        .onClick(async () => {
          const url = await resolveSourceToPublicUrl(
            this.app,
            this.client,
            this.worldSlug,
            this.source,
            "audio"
          );
          if (!url) {
            if (!this.source.trim()) new Notice("BackDrop: choose a vault file or paste a URL.");
            return;
          }
          this.editor.replaceSelection(audioMarkdown(this.label || "Audio", url) + "\n");
          this.close();
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class WikilinkSuggestModal extends FuzzySuggestModal<WikiLinkEntry> {
  private entries: WikiLinkEntry[];
  private label: string;

  constructor(
    app: App,
    slugIndex: WikiSlugIndex,
    worldSlug: string | null,
    private editor: Editor,
    selectedLabel = ""
  ) {
    super(app);
    this.label = selectedLabel.trim();
    const all: WikiLinkEntry[] = [];
    slugIndex.forEach((e) => all.push(e));
    this.entries = worldSlug
      ? all.filter((e) => e.world === worldSlug).sort((a, b) => a.title.localeCompare(b.title))
      : all.sort((a, b) => a.title.localeCompare(b.title));
    this.setPlaceholder("Search wiki notes by title…");
  }

  getItems(): WikiLinkEntry[] {
    return this.entries;
  }

  getItemText(item: WikiLinkEntry): string {
    return `${item.title} (${item.linkText}) · ${item.world}`;
  }

  onChooseItem(item: WikiLinkEntry): void {
    const target = item.linkText || item.title;
    const md =
      this.label && this.label !== target ? `[[${target}|${this.label}]]` : `[[${target}]]`;
    this.editor.replaceSelection(md);
  }
}

export class ArticlePropertiesModal extends Modal {
  private status: string;
  private category: string;
  private discordSyncEnabled = false;
  private articleSource = "";
  private type: string;
  private catalog: WorldCatalogMeta | undefined;
  private world = "";
  private charactersText = "";
  private selectedPinIds: Set<string> = new Set();
  private selectedRegionIds: Set<string> = new Set();
  private parentArticleId: string | null = null;
  private parentTitle = "";
  private thumbnailUrl = "";
  private headerImageUrl = "";
  private lane = "";
  private era = "";

  constructor(
    app: App,
    private file: TFile,
    private settings: BackdropSettings,
    private saveSettings: () => Promise<void>,
    private client: BackdropClient,
    private slugIndex?: WikiSlugIndex
  ) {
    super(app);
    this.status = "draft";
    this.category = "general";
    this.discordSyncEnabled = false;
    this.articleSource = "";
    this.type = "wiki";
  }

  async onOpen() {
    await this.reloadFromFile();
    this.render();
  }

  private async reloadFromFile() {
    const content = await this.app.vault.read(this.file);
    const { data } = splitFrontmatter(content);
    this.type = String(data.backdrop_type || "wiki");
    this.status = String(data.status || "draft");
    this.category = String(data.category || "general");
    this.articleSource = String(data.backdrop_source || "").trim();
    this.discordSyncEnabled =
      this.articleSource === "pin" ? false : Boolean(data.discord_sync_enabled);
    this.world = String(data.backdrop_world || "").trim();
    this.catalog = this.settings.worldCatalogs?.[this.world];
    this.charactersText = Array.isArray(data.characters)
      ? data.characters.map((c) => String(c)).join(", ")
      : "";
    this.selectedPinIds = new Set(
      Array.isArray(data.location_pin_ids) ? data.location_pin_ids.map(String) : []
    );
    this.selectedRegionIds = new Set(
      Array.isArray(data.map_region_ids) ? data.map_region_ids.map(String) : []
    );
    this.parentArticleId =
      data.parent_article_id != null && String(data.parent_article_id).trim()
        ? String(data.parent_article_id).trim()
        : null;
    this.parentTitle = String(data.parent || "").trim();
    this.thumbnailUrl = String(data.thumbnail_url || "").trim();
    this.headerImageUrl = String(data.header_image_url || "").trim();
    this.lane = String(data.lane || "");
    this.era = String(data.era || "");
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Article properties" });
    if (!this.catalog?.categories?.length && this.type === "wiki") {
      contentEl.createEl("p", {
        text: "No cached categories yet — Pull from BackDrop once to load them.",
        cls: "setting-item-description",
      });
    }

    const statusOptions =
      this.type === "timeline"
        ? [
            ["draft", "Draft"],
            ["published", "Published"],
          ]
        : [
            ["draft", "Draft"],
            ["unlisted", "Unlisted"],
            ["published", "Published"],
          ];

    new Setting(contentEl).setName("Status").addDropdown((dd) => {
      for (const [value, label] of statusOptions) dd.addOption(value, label);
      dd.setValue(this.status).onChange((v) => {
        this.status = v;
      });
    });

    if (this.type === "wiki") {
      this.renderWikiFields(contentEl);
    }

    if (this.type === "timeline") {
      this.renderTimelineFields(contentEl);
    }

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Save")
        .setCta()
        .onClick(async () => {
          await this.save();
        })
    );
  }

  private renderWikiFields(contentEl: HTMLElement) {
    const cats = this.catalog?.categories || [];
    new Setting(contentEl)
      .setName("Category")
      .addDropdown((dd) => {
        if (!cats.length) {
          dd.addOption(this.category || "general", this.category || "general");
        } else {
          for (const c of cats) {
            dd.addOption(c.slug, c.name || c.slug);
          }
          if (this.category && !cats.some((c) => c.slug === this.category)) {
            dd.addOption(this.category, this.category);
          }
        }
        dd.setValue(this.category || cats[0]?.slug || "general").onChange((v) => {
          this.category = v;
        });
      })
      .addButton((btn) =>
        btn.setButtonText("New…").onClick(() => {
          this.promptCreateCategory();
        })
      );



    if (this.articleSource !== "pin") {
      new Setting(contentEl)
        .setName("Publish to Discord")
        .setDesc("When published, sync this article to your Discord forum.")
        .addToggle((toggle) => {
          toggle.setValue(this.discordSyncEnabled).onChange((on) => {
            this.discordSyncEnabled = on;
          });
        });
    }
    new Setting(contentEl)
      .setName("Characters")
      .setDesc("Comma-separated character names")
      .addText((text) => {
        text.setPlaceholder("Alice, Bob").setValue(this.charactersText).onChange((v) => {
          this.charactersText = v;
        });
        text.inputEl.addClass("bd-setting-input-full");
      });

    new Setting(contentEl)
      .setName("Parent article")
      .setDesc(this.parentTitle ? `Current: ${this.parentTitle}` : "None")
      .addButton((btn) =>
        btn.setButtonText("Pick…").onClick(() => {
          this.pickParentArticle();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Clear").onClick(() => {
          this.parentArticleId = null;
          this.parentTitle = "";
          this.render();
        })
      );

    const pins = this.catalog?.pins || [];
    if (pins.length) {
      const pinBox = contentEl.createDiv({ cls: "bd-tag-checklist" });
      pinBox.createEl("div", { text: "Linked pins", cls: "setting-item-name" });
      for (const pin of pins.slice(0, 80)) {
        new Setting(pinBox).setName(pin.name || pin.id).addToggle((toggle) => {
          toggle.setValue(this.selectedPinIds.has(pin.id));
          toggle.onChange((on) => {
            if (on) this.selectedPinIds.add(pin.id);
            else this.selectedPinIds.delete(pin.id);
          });
        });
      }
      if (pins.length > 80) {
        pinBox.createEl("p", {
          text: `Showing 80 of ${pins.length} pins — edit location_pin_ids in frontmatter for more.`,
          cls: "setting-item-description",
        });
      }
    }

    const regions = this.catalog?.regions || [];
    if (regions.length) {
      const regionBox = contentEl.createDiv({ cls: "bd-tag-checklist" });
      regionBox.createEl("div", { text: "Linked regions", cls: "setting-item-name" });
      for (const region of regions.slice(0, 80)) {
        new Setting(regionBox).setName(region.name || region.id).addToggle((toggle) => {
          toggle.setValue(this.selectedRegionIds.has(region.id));
          toggle.onChange((on) => {
            if (on) this.selectedRegionIds.add(region.id);
            else this.selectedRegionIds.delete(region.id);
          });
        });
      }
      if (regions.length > 80) {
        regionBox.createEl("p", {
          text: `Showing 80 of ${regions.length} regions — edit map_region_ids in frontmatter for more.`,
          cls: "setting-item-description",
        });
      }
    }

    this.renderImageUrlField(contentEl, "Thumbnail", "thumbnail", this.thumbnailUrl, (v) => {
      this.thumbnailUrl = v;
    });
  }

  private renderTimelineFields(contentEl: HTMLElement) {
    const lanes = this.catalog?.lanes || [];
    const eras = this.catalog?.eras || [];
    if (lanes.length) {
      new Setting(contentEl).setName("Lane").addDropdown((dd) => {
        dd.addOption("", "(none)");
        for (const l of lanes) dd.addOption(l.name, l.name);
        dd.setValue(this.lane).onChange((v) => {
          this.lane = v;
        });
      });
    }
    if (eras.length) {
      new Setting(contentEl).setName("Era").addDropdown((dd) => {
        dd.addOption("", "(none)");
        for (const e of eras) dd.addOption(e.name, e.name);
        dd.setValue(this.era).onChange((v) => {
          this.era = v;
        });
      });
    }
    this.renderImageUrlField(contentEl, "Header image", "header", this.headerImageUrl, (v) => {
      this.headerImageUrl = v;
    });
  }

  private renderImageUrlField(
    contentEl: HTMLElement,
    name: string,
    kind: "thumbnail" | "header",
    value: string,
    onChange: (v: string) => void
  ) {
    new Setting(contentEl)
      .setName(name)
      .setDesc("HTTPS URL or upload a vault image")
      .addText((text) => {
        text.setPlaceholder("https://…").setValue(value).onChange((v) => onChange(v));
        text.inputEl.addClass("bd-setting-input-full");
      })
      .addButton((btn) =>
        btn.setButtonText("Upload…").onClick(() => {
          new VaultMediaSuggestModal(this.app, "image", async (file) => {
            if (!this.world) {
              new Notice("BackDrop: backdrop_world is required to upload.");
              return;
            }
            try {
              new Notice("BackDrop: uploading…");
              const url = await uploadVaultFile(this.client, this.world, file, this.app);
              onChange(url);
              if (kind === "thumbnail") this.thumbnailUrl = url;
              else this.headerImageUrl = url;
              this.render();
            } catch (e) {
              noticeError(e, "Upload");
            }
          }).open();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Clear").onClick(() => {
          onChange("");
          if (kind === "thumbnail") this.thumbnailUrl = "";
          else this.headerImageUrl = "";
          this.render();
        })
      );
  }

  private promptCreateCategory() {
    if (!this.world) {
      new Notice("BackDrop: backdrop_world is required.");
      return;
    }
    new PromptNameModal(this.app, "New category", "Category name", async (name) => {
      try {
        const { category } = await this.client.createWikiCategory(this.world, { name });
        upsertCatalogCategory(this.settings, this.world, {
          id: String(category.id),
          slug: String(category.slug),
          name: String(category.name),
          is_system: Boolean(category.is_system),
        });
        await this.saveSettings();
        this.catalog = this.settings.worldCatalogs?.[this.world];
        this.category = String(category.slug);
        new Notice(`BackDrop: created category ${category.name}`);
        this.render();
      } catch (e) {
        noticeError(e, "Create category");
      }
    }).open();
  }


  private pickParentArticle() {
    if (!this.slugIndex) {
      new Notice("BackDrop: wiki index not ready — try again in a moment.");
      return;
    }
    const selfId = String(
      this.app.metadataCache.getFileCache(this.file)?.frontmatter?.backdrop_id || ""
    );
    new ParentArticleSuggestModal(
      this.app,
      this.slugIndex,
      this.world,
      selfId,
      (entry) => {
        const abs = this.app.vault.getAbstractFileByPath(entry.path);
        if (!(abs instanceof TFile)) {
          new Notice("BackDrop: parent note not found in vault.");
          return;
        }
        const cache = this.app.metadataCache.getFileCache(abs);
        const id = cache?.frontmatter?.backdrop_id;
        if (!id) {
          new Notice("BackDrop: parent note has no backdrop_id (publish it first).");
          return;
        }
        this.parentArticleId = String(id);
        this.parentTitle = entry.title;
        this.render();
      }
    ).open();
  }

  private async save() {
    const latest = await this.app.vault.read(this.file);
    const parsed = splitFrontmatter(latest);
    const fm = { ...parsed.data };
    fm.status = this.status;
    if (this.type === "wiki") {
      fm.category = this.category;
      if (this.articleSource !== "pin") {
        fm.discord_sync_enabled = this.discordSyncEnabled;
      }
      if (this.articleSource) fm.backdrop_source = this.articleSource;
      fm.characters = this.charactersText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      fm.location_pin_ids = Array.from(this.selectedPinIds);
      fm.map_region_ids = Array.from(this.selectedRegionIds);
      fm.parent_article_id = this.parentArticleId;
      if (this.parentTitle) fm.parent = this.parentTitle;
      else delete fm.parent;
      fm.thumbnail_url = this.thumbnailUrl || "";
    }
    if (this.type === "timeline") {
      fm.lane = this.lane;
      fm.era = this.era;
      fm.header_image_url = this.headerImageUrl || "";
    }
    const next = buildNoteFile(fm, parsed.body);
    const prevHash = this.settings.contentHashes[normalizePath(this.file.path)];
    const wasClean = prevHash && prevHash === hashContent(latest);
    await this.app.vault.modify(this.file, next);
    if (wasClean) {
      this.settings.contentHashes[normalizePath(this.file.path)] = hashContent(next);
      await this.saveSettings();
    }
    new Notice("BackDrop: properties saved.");
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class PromptNameModal extends Modal {
  private value = "";

  constructor(
    app: App,
    private heading: string,
    private placeholder: string,
    private onSubmit: (name: string) => void | Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.heading });
    new Setting(contentEl).setName("Name").addText((text) => {
      text.setPlaceholder(this.placeholder).onChange((v) => {
        this.value = v;
      });
      text.inputEl.focus();
    });
    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Create")
        .setCta()
        .onClick(async () => {
          const name = this.value.trim();
          if (!name) {
            new Notice("BackDrop: name is required.");
            return;
          }
          this.close();
          await this.onSubmit(name);
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ParentArticleSuggestModal extends FuzzySuggestModal<WikiLinkEntry> {
  private entries: WikiLinkEntry[];

  constructor(
    app: App,
    slugIndex: WikiSlugIndex,
    worldSlug: string,
    private selfId: string,
    private onPick: (entry: WikiLinkEntry) => void
  ) {
    super(app);
    const all: WikiLinkEntry[] = [];
    slugIndex.forEach((e) => all.push(e));
    this.entries = all
      .filter((e) => e.world === worldSlug)
      .sort((a, b) => a.title.localeCompare(b.title));
    this.setPlaceholder("Search parent wiki article…");
  }

  getItems(): WikiLinkEntry[] {
    return this.entries;
  }

  getItemText(item: WikiLinkEntry): string {
    return item.title;
  }

  onChooseItem(item: WikiLinkEntry): void {
    const file = this.app.vault.getAbstractFileByPath(item.path);
    if (file instanceof TFile) {
      const id = String(this.app.metadataCache.getFileCache(file)?.frontmatter?.backdrop_id || "");
      if (this.selfId && id && id === this.selfId) {
        new Notice("BackDrop: article cannot be its own parent.");
        return;
      }
    }
    this.onPick(item);
  }
}

export class ResolveSyncModal extends Modal {
  private state: SyncBadgeState = "clean";
  private localBody = "";
  private remoteBody = "";
  private remoteLoading = false;

  constructor(
    app: App,
    private file: TFile,
    private settings: BackdropSettings,
    private saveSettings: () => Promise<void>,
    private client: BackdropClient,
    private slugIndex: WikiSlugIndex,
    private onAfter: () => void
  ) {
    super(app);
  }

  async onOpen() {
    this.state = await getSyncBadgeState(this.app, this.file, this.settings);
    const content = await this.app.vault.read(this.file);
    const { body, data } = splitFrontmatter(content);
    this.localBody = body || "";
    this.render();

    if (this.state === "conflict") {
      this.remoteLoading = true;
      this.render();
      try {
        const world = String(data.backdrop_world || "").trim();
        const id = String(data.backdrop_id || "").trim();
        const type = String(data.backdrop_type || "");
        if (world && id) {
          const pack = await this.client.pull(world);
          if (type === "wiki") {
            const art = (pack.articles || []).find((a) => a.id === id);
            this.remoteBody = art?.body_markdown || "(remote article not found)";
          } else {
            const ev = (pack.events || []).find((e) => e.id === id);
            this.remoteBody = ev?.body_markdown || "(remote event not found)";
          }
        } else {
          this.remoteBody = "(missing backdrop_id / world — cannot fetch remote)";
        }
      } catch (e) {
        this.remoteBody = `Failed to load remote: ${e instanceof Error ? e.message : String(e)}`;
      }
      this.remoteLoading = false;
      this.render();
    }
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Resolve sync" });
    contentEl.createEl("p", {
      text: `Status: ${this.state} · ${this.file.path}`,
      cls: "setting-item-description",
    });

    if (this.state === "conflict") {
      contentEl.createEl("p", {
        text: "Local edits conflict with remote. Compare excerpts, then keep local, take remote, or force-publish local.",
        cls: "setting-item-description",
      });

      const compare = contentEl.createDiv({ cls: "bd-conflict-compare" });
      const localCol = compare.createDiv({ cls: "bd-conflict-pane" });
      localCol.createEl("h3", { text: "Local" });
      const localTa = localCol.createEl("textarea", { cls: "bd-conflict-textarea" });
      localTa.value = this.localBody.slice(0, 12000);
      localTa.readOnly = true;
      localTa.rows = 14;

      const remoteCol = compare.createDiv({ cls: "bd-conflict-pane" });
      remoteCol.createEl("h3", { text: "Remote" });
      const remoteTa = remoteCol.createEl("textarea", { cls: "bd-conflict-textarea" });
      remoteTa.value = this.remoteLoading ? "Loading remote…" : this.remoteBody.slice(0, 12000);
      remoteTa.readOnly = true;
      remoteTa.rows = 14;
    }

    new Setting(contentEl)
      .setName("Keep local")
      .setDesc("Clear the conflict flag. Local content stays; publish when ready.")
      .addButton((btn) =>
        btn.setButtonText("Keep local").onClick(async () => {
          clearConflictPath(this.settings, this.file.path);
          await this.saveSettings();
          new Notice("BackDrop: conflict cleared (kept local).");
          this.close();
          this.onAfter();
        })
      );

    new Setting(contentEl)
      .setName("Take remote")
      .setDesc("Force-pull this note from BackDrop (overwrites local edits).")
      .addButton((btn) =>
        btn.setButtonText("Take remote").setDestructive().onClick(async () => {
          this.close();
          try {
            await pullCurrentNote(
              this.app,
              this.client,
              this.settings,
              this.saveSettings,
              this.file.path,
              this.slugIndex
            );
          } catch (e) {
            noticeError(e);
          }
          this.onAfter();
        })
      );

    new Setting(contentEl)
      .setName("Publish local (force)")
      .setDesc("Overwrite remote with this note, ignoring remote updated_at.")
      .addButton((btn) =>
        btn.setButtonText("Publish local").setCta().onClick(async () => {
          this.close();
          try {
            await publishFile(this.app, this.client, this.file, this.settings, this.saveSettings, {
              force: true,
              slugIndex: this.slugIndex,
            });
          } catch (e) {
            noticeError(e);
          }
          this.onAfter();
        })
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Apply markdown wrappers / inserts via Editor API (compact chrome). */
export function applyEditorFormat(
  editor: Editor,
  kind: "h2" | "h3" | "bold" | "italic" | "link" | "table"
): void {
  const selected = editor.getSelection();
  switch (kind) {
    case "h2": {
      const text = selected || "Heading";
      editor.replaceSelection(`\n## ${text.replace(/^#+\s*/, "")}\n`);
      break;
    }
    case "h3": {
      const text = selected || "Heading";
      editor.replaceSelection(`\n### ${text.replace(/^#+\s*/, "")}\n`);
      break;
    }
    case "bold": {
      const text = selected || "bold";
      editor.replaceSelection(`**${text}**`);
      break;
    }
    case "italic": {
      const text = selected || "italic";
      editor.replaceSelection(`*${text}*`);
      break;
    }
    case "link": {
      const text = selected || "label";
      editor.replaceSelection(`[${text}](https://)`);
      break;
    }
    case "table": {
      editor.replaceSelection(
        `\n| Column | Column |\n| --- | --- |\n| Cell | Cell |\n`
      );
      break;
    }
  }
}

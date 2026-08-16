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
import { diffLines, summarizeDiff, type DiffLine } from "./diff";
import { buildNoteFile, frontmatterRecord, splitFrontmatter } from "./frontmatter";
import { alignedImageMarkdown, audioMarkdown } from "./markdown";
import {
  clearConflictPath,
  getSyncBadgeState,
  healSpuriousConflicts,
  listPublishCandidates,
  normalizePublishStatusForType,
  publishSelected,
  pullCurrentNote,
  refreshWikiDiscordFromRemote,
  upsertCatalogCategory,
  type PublishCandidate,
  type SyncBadgeState,
} from "./sync";
import type { BackdropSettings, WorldCatalogMeta } from "./types";
import { contentMatchesStoredHash, hashNoteForSync, notesSemanticallyEqual } from "./syncState";
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
    const fromFm = frontmatterRecord(app.metadataCache.getFileCache(file))?.backdrop_world;
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
      new Setting(pinBox).setName("Linked pins").setHeading();
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
      new Setting(regionBox).setName("Linked regions").setHeading();
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
        const id = frontmatterRecord(cache)?.backdrop_id;
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
    const wasClean = contentMatchesStoredHash(latest, prevHash);
    await this.app.vault.modify(this.file, next);
    if (wasClean && notesSemanticallyEqual(latest, next)) {
      this.settings.contentHashes[normalizePath(this.file.path)] = hashNoteForSync(next);
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
  private localStatus = "draft";
  private localTitle = "";
  private localCategory = "";
  private localUpdated = "";
  private remoteTitle = "";
  private remoteStatus = "";
  private remoteCategory = "";
  private remoteUpdated = "";
  private diffLines: DiffLine[] = [];
  private showUnchanged = false;
  private viewMode: "unified" | "side" = "unified";

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
    this.modalEl.addClass("bd-resolve-modal");
    this.state = await getSyncBadgeState(this.app, this.file, this.settings);
    const content = await this.app.vault.read(this.file);
    const { body, data } = splitFrontmatter(content);
    this.localBody = body || "";
    this.localTitle = String(data.title || this.file.basename);
    this.localCategory = String(data.category || "");
    this.localUpdated = String(data.backdrop_updated_at || "");
    this.localStatus = normalizePublishStatusForType(
      String(data.backdrop_type || ""),
      data.status
    );
    this.render();

    if (this.state === "conflict" || this.state === "dirty") {
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
            this.remoteBody = art?.body_markdown ?? "(remote article not found)";
            this.remoteTitle = art ? String(art.title || "") : "";
            this.remoteStatus = art ? String(art.status || "") : "";
            this.remoteCategory = art ? String(art.category_slug || "") : "";
            this.remoteUpdated = art ? String(art.updated_at || "") : "";
          } else {
            const ev = (pack.events || []).find((e) => e.id === id);
            this.remoteBody = ev?.body_markdown ?? "(remote event not found)";
            this.remoteTitle = ev ? String(ev.title || "") : "";
            this.remoteStatus = ev ? String(ev.status || "") : "";
            this.remoteCategory = "";
            this.remoteUpdated = ev ? String(ev.updated_at || "") : "";
          }
        } else {
          this.remoteBody = "(missing backdrop_id / world — cannot fetch remote)";
        }
      } catch (e) {
        this.remoteBody = `Failed to load remote: ${e instanceof Error ? e.message : String(e)}`;
      }
      this.diffLines = diffLines(this.localBody, this.remoteBody);
      this.remoteLoading = false;
      this.render();
    }
  }

  private renderDiff(container: HTMLElement) {
    const summary = summarizeDiff(this.diffLines);
    const toolbar = container.createDiv({ cls: "bd-diff-toolbar" });
    toolbar.createSpan({
      text: `${summary.removed} removed · ${summary.added} added · ${summary.unchanged} unchanged`,
      cls: "bd-diff-summary",
    });
    new Setting(toolbar)
      .setClass("bd-diff-toolbar-controls")
      .addDropdown((dd) => {
        dd.addOption("unified", "Unified")
          .addOption("side", "Side by side")
          .setValue(this.viewMode)
          .onChange((v) => {
            this.viewMode = v === "side" ? "side" : "unified";
            this.render();
          });
      })
      .addToggle((t) => {
        t.setValue(this.showUnchanged)
          .setTooltip("Show unchanged lines")
          .onChange((on) => {
            this.showUnchanged = on;
            this.render();
          });
      });
    toolbar.createSpan({
      text: this.showUnchanged ? "Showing all lines" : "Changes only",
      cls: "setting-item-description",
    });

    const visible = this.showUnchanged
      ? this.diffLines
      : this.diffLines.filter((l) => l.op !== "same");

    if (!visible.length) {
      container.createEl("p", {
        text: "Bodies match. Differences may be in frontmatter (title, status, category).",
        cls: "setting-item-description",
      });
      return;
    }

    if (this.viewMode === "side") {
      this.renderSideDiff(container, visible);
    } else {
      this.renderUnifiedDiff(container, visible);
    }
  }

  private renderUnifiedDiff(container: HTMLElement, lines: DiffLine[]) {
    const pre = container.createDiv({ cls: "bd-diff-unified" });
    for (const line of lines) {
      const row = pre.createDiv({
        cls: `bd-diff-line bd-diff-line--${line.op}`,
      });
      const gutter = row.createSpan({ cls: "bd-diff-gutter" });
      if (line.op === "add") gutter.setText(`+${line.rightNo ?? ""}`);
      else if (line.op === "del") gutter.setText(`−${line.leftNo ?? ""}`);
      else gutter.setText(String(line.leftNo ?? ""));
      row.createSpan({
        text: line.op === "add" ? "+" : line.op === "del" ? "−" : " ",
        cls: "bd-diff-marker",
      });
      row.createSpan({ text: line.text || " ", cls: "bd-diff-text" });
    }
  }

  private renderSideDiff(container: HTMLElement, lines: DiffLine[]) {
    const grid = container.createDiv({ cls: "bd-diff-side" });
    const left = grid.createDiv({ cls: "bd-diff-side-col" });
    const right = grid.createDiv({ cls: "bd-diff-side-col" });
    left.createDiv({ text: "Local", cls: "bd-diff-side-label" });
    right.createDiv({ text: "Remote", cls: "bd-diff-side-label" });
    for (const line of lines) {
      if (line.op === "same") {
        left.createDiv({
          text: line.text || " ",
          cls: "bd-diff-line bd-diff-line--same",
        });
        right.createDiv({
          text: line.text || " ",
          cls: "bd-diff-line bd-diff-line--same",
        });
      } else if (line.op === "del") {
        left.createDiv({
          text: line.text || " ",
          cls: "bd-diff-line bd-diff-line--del",
        });
        right.createDiv({ text: " ", cls: "bd-diff-line bd-diff-line--empty" });
      } else {
        left.createDiv({ text: " ", cls: "bd-diff-line bd-diff-line--empty" });
        right.createDiv({
          text: line.text || " ",
          cls: "bd-diff-line bd-diff-line--add",
        });
      }
    }
  }

  private renderMeta(container: HTMLElement) {
    const table = container.createDiv({ cls: "bd-conflict-meta" });
    const rows: Array<[string, string, string]> = [
      ["Title", this.localTitle, this.remoteTitle || "—"],
      ["Status", this.localStatus, this.remoteStatus || "—"],
      ["Category", this.localCategory || "—", this.remoteCategory || "—"],
      ["Updated", this.localUpdated || "—", this.remoteUpdated || "—"],
    ];
    for (const [label, local, remote] of rows) {
      const row = table.createDiv({ cls: "bd-conflict-meta-row" });
      if (local !== remote) row.addClass("bd-conflict-meta-row--diff");
      row.createSpan({ text: label, cls: "bd-conflict-meta-label" });
      row.createSpan({ text: local, cls: "bd-conflict-meta-local" });
      row.createSpan({ text: remote, cls: "bd-conflict-meta-remote" });
    }
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Resolve sync" });
    contentEl.createEl("p", {
      text: `${this.state === "conflict" ? "Conflict" : this.state} · ${this.file.path}`,
      cls: "setting-item-description",
    });

    if (this.state === "conflict" || this.state === "dirty") {
      contentEl.createEl("p", {
        text:
          this.state === "conflict"
            ? "Remote changed while you have local edits. Review the diff, then keep local, take remote, or push local."
            : "Local edits not yet pushed. Review against remote, then keep working, take remote, or push local.",
        cls: "setting-item-description",
      });

      if (!this.remoteLoading) this.renderMeta(contentEl);

      const compare = contentEl.createDiv({ cls: "bd-conflict-compare" });
      if (this.remoteLoading) {
        compare.createEl("p", { text: "Loading remote…", cls: "setting-item-description" });
      } else {
        this.renderDiff(compare);
      }
    } else {
      contentEl.createEl("p", {
        text: "This note is clean — no pending local/remote conflict.",
        cls: "setting-item-description",
      });
    }

    const actions = contentEl.createDiv({ cls: "bd-resolve-actions" });

    new Setting(actions)
      .setName("Keep local")
      .setDesc("Clear the conflict flag. Local content stays; sync when ready.")
      .addButton((btn) =>
        btn.setButtonText("Keep local").onClick(async () => {
          clearConflictPath(this.settings, this.file.path);
          await this.saveSettings();
          new Notice("BackDrop: conflict cleared (kept local).");
          this.close();
          this.onAfter();
        })
      );

    new Setting(actions)
      .setName("Take remote")
      .setDesc("Overwrite this note with the BackDrop version.")
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
            new Notice("BackDrop: took remote version.");
          } catch (e) {
            noticeError(e);
          }
          this.onAfter();
        })
      );

    new Setting(actions)
      .setName("Push local")
      .setDesc("Open Sync panel and overwrite remote with this note.")
      .addButton((btn) =>
        btn.setButtonText("Push local…").setCta().onClick(() => {
          this.close();
          new SyncPanelModal(
            this.app,
            this.settings,
            this.saveSettings,
            this.client,
            this.slugIndex,
            { force: true, focusFile: this.file, onDone: () => this.onAfter() }
          ).open();
        })
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}

interface SyncRowState {
  candidate: PublishCandidate;
  checked: boolean;
  status: string;
  discordSyncEnabled: boolean;
}

/**
 * Obsidian Sync–style panel: checklist of push candidates with per-row status / Discord.
 * Cancel closes without pushing; Push selected syncs checked notes sequentially.
 */
export class SyncPanelModal extends Modal {
  private rows: SyncRowState[] = [];
  private loading = true;
  private busy = false;
  private focusPath = "";
  private scopePath = "";
  private statusEl: HTMLElement | null = null;

  constructor(
    app: App,
    private settings: BackdropSettings,
    private saveSettings: () => Promise<void>,
    private client: BackdropClient,
    private slugIndex: WikiSlugIndex,
    private opts: {
      force?: boolean;
      /** Pre-check and scroll to this note (included even if clean). */
      focusFile?: TFile | null;
      /** Limit candidates to this folder (world / category / wiki / timeline). */
      underPath?: string;
      /** Optional short label for the scope in the empty-state copy. */
      scopeLabel?: string;
      onDone?: () => void;
    } = {}
  ) {
    super(app);
    this.focusPath = opts.focusFile ? normalizePath(opts.focusFile.path) : "";
    this.scopePath = opts.underPath ? normalizePath(opts.underPath).replace(/\/+$/, "") : "";
  }

  async onOpen() {
    this.modalEl.addClass("bd-sync-panel-modal");
    this.render();
    try {
      const healed = await healSpuriousConflicts(this.app, this.settings);
      if (healed) await this.saveSettings();
      // BackDrop owns Discord flags; fill local FM when pull skipped dirty/existing notes.
      await refreshWikiDiscordFromRemote(
        this.app,
        this.client,
        this.settings,
        this.saveSettings,
        {
          underPath: this.scopePath || undefined,
          includePath: this.focusPath || undefined,
        }
      );
      const candidates = await listPublishCandidates(this.app, this.settings, {
        includePath: this.focusPath || undefined,
        underPath: this.scopePath || undefined,
      });
      this.rows = candidates.map((c) => ({
        candidate: c,
        checked: c.defaultChecked,
        status: c.status,
        discordSyncEnabled: c.discordSyncEnabled,
      }));
    } catch (e) {
      noticeError(e);
      this.rows = [];
    }
    this.loading = false;
    this.render();
  }

  private checkedCount(): number {
    return this.rows.filter((r) => r.checked).length;
  }

  private setAllChecked(on: boolean) {
    for (const row of this.rows) row.checked = on;
    this.render();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("bd-sync-panel");

    contentEl.createEl("h2", { text: "Sync to BackDrop" });
    const scopeHint = this.opts.scopeLabel
      ? ` Scoped to ${this.opts.scopeLabel}.`
      : this.scopePath
        ? ` Scoped to ${this.scopePath}.`
        : "";
    contentEl.createEl("p", {
      text: (this.opts.force
        ? "Force-push selected notes (overwrite remote). Status is visibility only."
        : "Local edits are ready to push — check what you want, then Push selected. Status is visibility only.") +
        scopeHint,
      cls: "setting-item-description",
    });

    if (this.loading) {
      contentEl.createEl("p", {
        text: "Refreshing Discord flags from BackDrop…",
        cls: "setting-item-description",
      });
      return;
    }

    if (!this.rows.length) {
      contentEl.createEl("p", {
        text: "Nothing to sync",
        cls: "bd-sync-panel-empty",
      });
      contentEl.createEl("p", {
        text: this.scopePath
          ? `No dirty, unpublished, or conflict notes under ${this.opts.scopeLabel || this.scopePath}.`
          : "No dirty, unpublished, or conflict notes under the vault root.",
        cls: "setting-item-description",
      });
      new Setting(contentEl).addButton((btn) =>
        btn.setButtonText("Close").onClick(() => this.close())
      );
      return;
    }

    const toolbar = contentEl.createDiv({ cls: "bd-sync-panel-toolbar" });
    new Setting(toolbar)
      .setName(`${this.checkedCount()} selected`)
      .setDesc(`${this.rows.length} candidate${this.rows.length === 1 ? "" : "s"}`)
      .addButton((btn) =>
        btn.setButtonText("Select all").onClick(() => this.setAllChecked(true))
      )
      .addButton((btn) =>
        btn.setButtonText("Select none").onClick(() => this.setAllChecked(false))
      );

    const list = contentEl.createDiv({ cls: "bd-sync-panel-list" });
    let focusRowEl: HTMLElement | null = null;

    for (const row of this.rows) {
      const c = row.candidate;
      const el = list.createDiv({ cls: "bd-sync-panel-row" });
      if (this.focusPath && c.path === this.focusPath) {
        el.addClass("bd-sync-panel-row--focus");
        focusRowEl = el;
      }

      const head = el.createDiv({ cls: "bd-sync-panel-row-head" });
      const check = head.createEl("input", {
        type: "checkbox",
        cls: "bd-sync-panel-check",
      });
      check.checked = row.checked;
      check.addEventListener("change", () => {
        row.checked = check.checked;
        this.updateSelectionLabel();
      });

      const meta = head.createDiv({ cls: "bd-sync-panel-row-meta" });
      meta.createDiv({ text: c.title, cls: "bd-sync-panel-title" });
      meta.createDiv({
        text: `${c.world} · ${c.type === "timeline" ? "Timeline" : "Wiki"}`,
        cls: "bd-sync-panel-sub",
      });

      const hints = head.createDiv({ cls: "bd-sync-panel-hints" });
      const hintCls =
        c.hint === "Conflict"
          ? "bd-sync-hint--conflict"
          : c.hint === "New"
            ? "bd-sync-hint--new"
            : c.hint === "Dirty"
              ? "bd-sync-hint--dirty"
              : "bd-sync-hint--clean";
      const hintLabel =
        c.hint === "Dirty"
          ? "Not synced"
          : c.hint === "Clean"
            ? "Synced"
            : c.hint === "New"
              ? "Never pushed"
              : c.hint;
      hints.createSpan({ text: hintLabel, cls: `bd-sync-hint ${hintCls}` });
      if (c.hint === "Dirty" || c.hint === "New") {
        hints.createSpan({ text: "Ready to push", cls: "bd-sync-hint bd-sync-hint--differs" });
      } else if (c.hint === "Conflict") {
        hints.createSpan({ text: "Remote also changed", cls: "bd-sync-hint bd-sync-hint--differs" });
      } else if (c.hint === "Clean") {
        hints.createSpan({ text: "Up to date", cls: "bd-sync-hint bd-sync-hint--same" });
      }

      const controls = el.createDiv({ cls: "bd-sync-panel-row-controls" });
      const statusOptions =
        c.type === "timeline"
          ? [
              ["draft", "Draft"],
              ["published", "Published"],
            ]
          : [
              ["draft", "Draft"],
              ["unlisted", "Unlisted"],
              ["published", "Published"],
            ];

      new Setting(controls)
        .setName("Status")
        .addDropdown((dd) => {
          for (const [value, label] of statusOptions) dd.addOption(value, label);
          dd.setValue(row.status).onChange((v) => {
            row.status = normalizePublishStatusForType(c.type, v);
          });
        });

      if (c.showDiscord) {
        new Setting(controls)
          .setName("Discord")
          .setDesc("Publish to Discord when status is Published")
          .addToggle((toggle) => {
            toggle.setValue(row.discordSyncEnabled).onChange((on) => {
              row.discordSyncEnabled = on;
            });
          });
      }

      if (c.conflict || c.hint === "Conflict") {
        const conflictActions = el.createDiv({ cls: "bd-sync-panel-conflict-actions" });
        conflictActions.createDiv({
          text: "Both sides changed. Review the diff, keep local (then push), or take remote. Or just push to overwrite remote.",
          cls: "setting-item-description",
        });
        new Setting(conflictActions)
          .addButton((btn) =>
            btn.setButtonText("Review…").setCta().setDisabled(this.busy).onClick(() => {
              if (this.busy) return;
              new ResolveSyncModal(
                this.app,
                c.file,
                this.settings,
                this.saveSettings,
                this.client,
                this.slugIndex,
                () => {
                  void this.reloadRows();
                  this.opts.onDone?.();
                }
              ).open();
            })
          )
          .addButton((btn) =>
            btn.setButtonText("Keep local").setDisabled(this.busy).onClick(() => {
              void this.keepLocalConflict(row);
            })
          )
          .addButton((btn) =>
            btn
              .setButtonText("Take remote")
              .setDestructive()
              .setDisabled(this.busy)
              .onClick(() => {
                void this.takeRemoteConflict(row);
              })
          );
      }
    }

    this.statusEl = contentEl.createDiv({ cls: "bd-sync-panel-footer-status" });
    this.updateSelectionLabel();

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Cancel").setDisabled(this.busy).onClick(() => {
          if (!this.busy) this.close();
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText(
            this.opts.force
              ? `Force push selected (${this.checkedCount()})`
              : `Push selected (${this.checkedCount()})`
          )
          .setCta()
          .setDisabled(this.busy || this.checkedCount() === 0)
          .onClick(() => {
            void this.pushSelected();
          })
      );

    if (focusRowEl) {
      window.setTimeout(() => {
        focusRowEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }, 50);
    }
  }

  private updateSelectionLabel() {
    const n = this.checkedCount();
    if (this.statusEl) {
      this.statusEl.setText(
        n === 0
          ? "Select at least one note to push."
          : `${n} note${n === 1 ? "" : "s"} will be pushed (overwrites remote if it changed).`
      );
    }
    const buttons = this.contentEl.querySelectorAll("button.mod-cta");
    const lastCta = buttons[buttons.length - 1] as HTMLButtonElement | undefined;
    if (lastCta) {
      lastCta.disabled = this.busy || n === 0;
      lastCta.setText(
        this.opts.force ? `Force push selected (${n})` : `Push selected (${n})`
      );
    }
  }

  private async reloadRows() {
    try {
      const candidates = await listPublishCandidates(this.app, this.settings, {
        includePath: this.focusPath || undefined,
        underPath: this.scopePath || undefined,
      });
      const prev = new Map(this.rows.map((r) => [r.candidate.path, r]));
      this.rows = candidates.map((c) => {
        const old = prev.get(c.path);
        return {
          candidate: c,
          checked: old ? old.checked : c.defaultChecked,
          status: old?.status ?? c.status,
          discordSyncEnabled: old?.discordSyncEnabled ?? c.discordSyncEnabled,
        };
      });
    } catch (e) {
      noticeError(e);
    }
    this.render();
  }

  private async keepLocalConflict(row: SyncRowState) {
    if (this.busy) return;
    clearConflictPath(this.settings, row.candidate.path);
    await this.saveSettings();
    new Notice(`BackDrop: kept local — ${row.candidate.title}`);
    await this.reloadRows();
    this.opts.onDone?.();
  }

  private async takeRemoteConflict(row: SyncRowState) {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      await pullCurrentNote(
        this.app,
        this.client,
        this.settings,
        this.saveSettings,
        row.candidate.path,
        this.slugIndex
      );
      clearConflictPath(this.settings, row.candidate.path);
      await this.saveSettings();
      new Notice(`BackDrop: took remote — ${row.candidate.title}`);
      this.busy = false;
      await this.reloadRows();
      this.opts.onDone?.();
    } catch (e) {
      noticeError(e);
      this.busy = false;
      this.render();
    }
  }

  private async pushSelected() {
    if (this.busy) return;
    const selected = this.rows.filter((r) => r.checked);
    if (!selected.length) {
      new Notice("BackDrop: select at least one note.");
      return;
    }
    this.busy = true;
    this.render();
    try {
      await publishSelected(
        this.app,
        this.client,
        this.settings,
        this.saveSettings,
        selected.map((r) => ({
          file: r.candidate.file,
          status: r.status,
          discordSyncEnabled: r.candidate.showDiscord ? r.discordSyncEnabled : undefined,
          // Sync panel = explicit push approval. Always overwrite remote when timestamps diverge.
          force: true,
        })),
        this.slugIndex
      );
      this.close();
      this.opts.onDone?.();
    } catch (e) {
      noticeError(e);
      this.busy = false;
      this.render();
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** @deprecated Use SyncPanelModal. Thin wrapper for older call sites. */
export class SyncConfirmModal extends SyncPanelModal {
  constructor(
    app: App,
    file: TFile,
    settings: BackdropSettings,
    saveSettings: () => Promise<void>,
    client: BackdropClient,
    slugIndex: WikiSlugIndex,
    opts: { force?: boolean; onDone?: () => void } = {}
  ) {
    super(app, settings, saveSettings, client, slugIndex, {
      force: opts.force,
      focusFile: file,
      onDone: opts.onDone,
    });
  }
}

/** List notes marked conflict after a safe pull; resolve, keep, or take remote. */
export class ConflictListModal extends Modal {
  private busy = false;
  /** Working list — must not keep pointing at the pull-time snapshot forever. */
  private remaining: string[] = [];
  private countEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private rowEls = new Map<string, HTMLElement>();

  constructor(
    app: App,
    private settings: BackdropSettings,
    private saveSettings: () => Promise<void>,
    private client: BackdropClient,
    private slugIndex: WikiSlugIndex,
    private onResolveNote: (file: TFile) => void,
    private onAfter: () => void,
    paths?: string[]
  ) {
    super(app);
    const seed = (paths?.length ? paths : settings.conflictPaths || []).map((p) =>
      normalizePath(p)
    );
    this.remaining = [...new Set(seed)];
  }

  private async dismissPath(path: string) {
    const norm = normalizePath(path);
    this.remaining = this.remaining.filter((p) => p !== norm);
    clearConflictPath(this.settings, norm);
    await this.saveSettings();
    this.removeRow(norm);
    this.onAfter();
  }

  private removeRow(path: string) {
    const row = this.rowEls.get(path);
    if (row) {
      row.remove();
      this.rowEls.delete(path);
    }
    this.updateChrome();
  }

  private updateChrome() {
    const n = this.remaining.length;
    if (this.countEl) {
      this.countEl.setText(`${n} conflict${n === 1 ? "" : "s"}`);
    }
    if (n === 0) {
      this.listEl?.empty();
      this.rowEls.clear();
      if (this.emptyEl) {
        this.emptyEl.removeClass("bd-hidden");
        this.emptyEl.setText("No conflicts right now.");
      }
    }
  }

  private setBusy(on: boolean) {
    this.busy = on;
    this.contentEl.querySelectorAll("button").forEach((btn) => {
      (btn as HTMLButtonElement).disabled = on;
    });
  }

  private async takeRemote(file: TFile) {
    await pullCurrentNote(
      this.app,
      this.client,
      this.settings,
      this.saveSettings,
      file.path,
      this.slugIndex
    );
  }

  async onOpen() {
    this.modalEl.addClass("bd-conflict-list-modal");
    this.buildShell();
  }

  private buildShell() {
    const { contentEl } = this;
    contentEl.empty();
    this.rowEls.clear();
    contentEl.createEl("h2", { text: "Sync conflicts" });
    contentEl.createEl("p", {
      text: "Pull skipped these notes because you have local edits and remote also changed. Review the diff, keep local, take remote, or push later.",
      cls: "setting-item-description",
    });

    const header = new Setting(contentEl);
    this.countEl = header.nameEl;
    this.countEl.setText(
      `${this.remaining.length} conflict${this.remaining.length === 1 ? "" : "s"}`
    );
    header
      .setDesc("Bulk actions apply without opening each diff.")
      .addButton((btn) =>
        btn.setButtonText("Keep all local").onClick(() => void this.keepAllLocal())
      )
      .addButton((btn) =>
        btn
          .setButtonText("Take all remote")
          .setDestructive()
          .onClick(() => void this.takeAllRemote())
      );

    this.emptyEl = contentEl.createEl("p", {
      text: "No conflicts right now.",
      cls: "bd-hidden",
    });
    this.listEl = contentEl.createDiv({ cls: "bd-conflict-list" });

    if (!this.remaining.length) {
      this.emptyEl.removeClass("bd-hidden");
    } else {
      for (const path of this.remaining) this.mountRow(path);
    }

    new Setting(contentEl).addButton((btn) =>
      btn.setButtonText("Close").onClick(() => {
        if (!this.busy) this.close();
      })
    );
  }

  private mountRow(path: string) {
    if (!this.listEl) return;
    const row = this.listEl.createDiv({ cls: "bd-conflict-list-row" });
    this.rowEls.set(path, row);
    const file = this.app.vault.getAbstractFileByPath(path);
    const meta = row.createDiv({ cls: "bd-conflict-list-meta" });

    if (!(file instanceof TFile)) {
      meta.createDiv({ text: path, cls: "bd-conflict-list-path bd-conflict-list-missing" });
      new Setting(row).addButton((btn) =>
        btn.setButtonText("Dismiss").onClick(() => void this.dismissPath(path))
      );
      return;
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const fm = frontmatterRecord(cache);
    const title = String(fm?.title || file.basename);
    meta.createDiv({ text: title, cls: "bd-conflict-list-title" });
    meta.createDiv({ text: path, cls: "bd-conflict-list-path" });

    const btns = row.createDiv({ cls: "bd-conflict-list-actions" });
    new Setting(btns)
      .addButton((btn) =>
        btn.setButtonText("Review…").setCta().onClick(() => {
          if (this.busy) return;
          this.close();
          this.onResolveNote(file);
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Keep local").onClick(async () => {
          if (this.busy) return;
          await this.dismissPath(path);
          new Notice(`BackDrop: kept local — ${title}`);
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Take remote")
          .setDestructive()
          .onClick(async () => {
            if (this.busy) return;
            this.setBusy(true);
            try {
              await this.takeRemote(file);
              await this.dismissPath(path);
              new Notice(`BackDrop: took remote — ${title}`);
            } catch (e) {
              noticeError(e);
            } finally {
              this.setBusy(false);
            }
          })
      );
  }

  private async keepAllLocal() {
    if (this.busy || !this.remaining.length) return;
    this.setBusy(true);
    const paths = [...this.remaining];
    for (const path of paths) {
      this.remaining = this.remaining.filter((p) => p !== path);
      clearConflictPath(this.settings, path);
      this.removeRow(path);
    }
    await this.saveSettings();
    new Notice("BackDrop: cleared all conflict flags (kept local).");
    this.setBusy(false);
    this.onAfter();
  }

  private async takeAllRemote() {
    if (this.busy || !this.remaining.length) return;
    this.setBusy(true);
    let ok = 0;
    let failed = 0;
    const paths = [...this.remaining];
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        this.remaining = this.remaining.filter((p) => p !== path);
        clearConflictPath(this.settings, path);
        this.removeRow(path);
        continue;
      }
      try {
        await this.takeRemote(file);
        this.remaining = this.remaining.filter((p) => p !== path);
        clearConflictPath(this.settings, path);
        this.removeRow(path);
        ok += 1;
      } catch (e) {
        failed += 1;
        noticeError(e, path);
      }
    }
    await this.saveSettings();
    new Notice(`BackDrop: took remote for ${ok}` + (failed ? `, ${failed} failed` : ""));
    this.setBusy(false);
    this.onAfter();
  }

  onClose() {
    this.contentEl.empty();
    this.rowEls.clear();
    this.countEl = null;
    this.listEl = null;
    this.emptyEl = null;
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

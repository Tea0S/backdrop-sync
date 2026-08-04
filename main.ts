import {
  App,
  Editor,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Plugin,
  Setting,
  TFile,
  normalizePath,
} from "obsidian";
import { BackdropClient, noticeError } from "./src/api";
import { DEFAULT_SETTINGS, type BackdropSettings } from "./src/types";
import { BackdropSettingTab } from "./src/settings";
import {
  createTimelineStub,
  createWikiStub,
  getSyncBadgeState,
  publishFile,
  publishPending,
  pullAll,
  pullCurrentNote,
  syncBadgeLabel,
} from "./src/sync";
import {
  alignedImageLivePreviewExtension,
  registerMarkdownProcessors,
  spoilerMarkdown,
  timelineEmbedStub,
} from "./src/markdown";
import {
  ArticlePropertiesModal,
  InsertAudioModal,
  InsertImageModal,
  ResolveSyncModal,
  WikilinkSuggestModal,
  applyEditorFormat,
  resolveWorldSlug,
} from "./src/editorUi";
import {
  buildNoteFile,
  hashContent,
  parseWorldSlugs,
  slugify,
  splitFrontmatter,
} from "./src/frontmatter";
import { migrateSyncWorldsFromSlugs } from "./src/syncSelection";
import { WikiSlugIndex, scanWikiSlugIndex } from "./src/wikiLinks";

export default class BackdropPlugin extends Plugin {
  settings: BackdropSettings = DEFAULT_SETTINGS;
  client!: BackdropClient;
  /** In-memory slug → note path/title per world (for BackDrop ↔ Obsidian link rewrite). */
  slugIndex: WikiSlugIndex = new WikiSlugIndex();
  private slugSyncTimers = new Map<string, number>();
  private indexRefreshTimer: number | null = null;
  private badgeRefreshTimer: number | null = null;
  private headerActionEls: HTMLElement[] = [];
  private statusBarEl: HTMLElement | null = null;
  private formatBarEl: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();
    this.client = new BackdropClient(
      () => this.settings.apiBaseUrl,
      () => this.settings.apiKey
    );

    this.addSettingTab(new BackdropSettingTab(this.app, this));
    registerMarkdownProcessors(this);
    // CM6 Live Preview: hide `{align=…}` + float images (see src/markdown.ts bd-lp-align-v4).
    this.registerEditorExtension(alignedImageLivePreviewExtension());

    this.app.workspace.onLayoutReady(() => {
      void this.refreshSlugIndex();
    });

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("bd-statusbar");
    this.statusBarEl.addClass("bd-statusbar--hidden");
    this.statusBarEl.setText("BackDrop");
    this.statusBarEl.addEventListener("click", () => {
      this.openResolveSync();
    });
    this.statusBarEl.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      this.showInsertMenu(evt);
    });

    this.addRibbonIcon("download", "Pull from BackDrop", () => {
      void this.runPull();
    });
    this.addRibbonIcon("upload", "Publish current note to BackDrop", () => {
      void this.runPublishCurrent();
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.refreshBackdropChrome();
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.refreshBackdropChrome();
      })
    );
    this.app.workspace.onLayoutReady(() => this.refreshBackdropChrome());

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        const root = this.settings.vaultRoot.replace(/\/+$/, "");
        if (!file.path.startsWith(`${root}/`)) return;
        const prev = this.slugSyncTimers.get(file.path);
        if (prev) window.clearTimeout(prev);
        const timer = window.setTimeout(() => {
          this.slugSyncTimers.delete(file.path);
          void this.syncSlugFromTitle(file);
        }, 400);
        this.slugSyncTimers.set(file.path, timer);
        this.scheduleSlugIndexRefresh();
        if (file.path === this.app.workspace.getActiveFile()?.path) {
          this.scheduleSyncBadgeRefresh();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        const root = this.settings.vaultRoot.replace(/\/+$/, "");
        if (!file.path.startsWith(`${root}/`)) return;
        this.scheduleSlugIndexRefresh();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        const root = this.settings.vaultRoot.replace(/\/+$/, "");
        if (!file.path.startsWith(`${root}/`)) return;
        this.scheduleSlugIndexRefresh();
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        const root = this.settings.vaultRoot.replace(/\/+$/, "");
        if (!file.path.startsWith(`${root}/`)) return;
        this.scheduleSlugIndexRefresh();
      })
    );

    this.addCommand({
      id: "backdrop-pull",
      name: "Pull from BackDrop",
      callback: async () => {
        await this.runPull();
      },
    });

    this.addCommand({
      id: "backdrop-pull-current",
      name: "Pull current note from BackDrop",
      editorCheckCallback: (checking, _editor, view) => {
        const file = view?.file;
        if (!file || !this.isBackdropNoteSync(file)) return false;
        if (checking) return true;
        void this.runPullCurrent(file);
        return true;
      },
    });

    this.addCommand({
      id: "backdrop-publish-current",
      name: "Publish current note",
      editorCheckCallback: (checking, _editor, view) => {
        const file = view?.file;
        if (!file) return false;
        if (checking) return true;
        void this.runPublishCurrent(file);
        return true;
      },
    });

    this.addCommand({
      id: "backdrop-publish-current-force",
      name: "Force publish current note",
      editorCheckCallback: (checking, _editor, view) => {
        const file = view?.file;
        if (!file) return false;
        if (checking) return true;
        void publishFile(this.app, this.client, file, this.settings, () => this.saveSettings(), {
          force: true,
          slugIndex: this.slugIndex,
        })
          .then(() => this.refreshSyncBadge())
          .catch(noticeError);
        return true;
      },
    });

    this.addCommand({
      id: "backdrop-publish-pending",
      name: "Publish all pending",
      callback: async () => {
        try {
          await publishPending(
            this.app,
            this.client,
            this.settings,
            () => this.saveSettings(),
            this.slugIndex
          );
          void this.refreshSyncBadge();
        } catch (e) {
          noticeError(e);
        }
      },
    });

    this.addCommand({
      id: "backdrop-new-wiki",
      name: "New wiki article",
      callback: () => {
        new PromptModal(this.app, "New wiki article", [
          { key: "world", label: "World slug", value: defaultWorld(this.settings) },
          { key: "title", label: "Title", value: "" },
          { key: "category", label: "Category name", value: "general" },
        ], async (values) => {
          const title = String(values.title || "").trim();
          if (!title) {
            new Notice("BackDrop: title is required.");
            return;
          }
          const file = await createWikiStub(
            this.app,
            this.settings,
            values.world,
            title,
            values.category
          );
          await this.saveSettings();
          this.slugIndex.setEntry({
            slug: slugify(title),
            world: values.world,
            path: file.path,
            linkText: file.basename,
            title,
          });
          await this.app.workspace.getLeaf(true).openFile(file);
          new Notice(`Created ${file.path} (slug: ${slugify(title)})`);
        }).open();
      },
    });

    this.addCommand({
      id: "backdrop-new-timeline",
      name: "New timeline event",
      callback: () => {
        new PromptModal(this.app, "New timeline event", [
          { key: "world", label: "World slug", value: defaultWorld(this.settings) },
          { key: "title", label: "Title", value: "" },
        ], async (values) => {
          const file = await createTimelineStub(this.app, this.settings, values.world, values.title);
          await this.saveSettings();
          await this.app.workspace.getLeaf(true).openFile(file);
          new Notice(`Created ${file.path}`);
        }).open();
      },
    });

    this.addCommand({
      id: "backdrop-insert-aligned-image",
      name: "Insert image",
      editorCheckCallback: (checking, editor, view) => {
        if (!this.isBackdropNoteSync(view?.file ?? null)) return false;
        if (checking) return true;
        this.promptAlignedImage(editor, view?.file ?? null);
        return true;
      },
    });

    this.addCommand({
      id: "backdrop-insert-audio",
      name: "Insert audio",
      editorCheckCallback: (checking, editor, view) => {
        if (!this.isBackdropNoteSync(view?.file ?? null)) return false;
        if (checking) return true;
        this.promptAudio(editor, view?.file ?? null);
        return true;
      },
    });

    this.addCommand({
      id: "backdrop-insert-spoiler",
      name: "Wrap selection as spoiler",
      editorCheckCallback: (checking, editor, view) => {
        if (!this.isBackdropNoteSync(view?.file ?? null)) return false;
        if (checking) return true;
        this.insertSpoiler(editor);
        return true;
      },
    });

    this.addCommand({
      id: "backdrop-insert-timeline-stub",
      name: "Insert timeline embed stub",
      editorCheckCallback: (checking, editor, view) => {
        if (!this.isBackdropNoteSync(view?.file ?? null)) return false;
        if (checking) return true;
        editor.replaceSelection(timelineEmbedStub() + "\n");
        return true;
      },
    });

    this.addCommand({
      id: "backdrop-insert-wikilink",
      name: "Insert wikilink",
      editorCheckCallback: (checking, editor, view) => {
        if (!this.isBackdropNoteSync(view?.file ?? null)) return false;
        if (checking) return true;
        this.promptWikilink(editor, view?.file ?? null);
        return true;
      },
    });

    this.addCommand({
      id: "backdrop-article-properties",
      name: "Article properties",
      editorCheckCallback: (checking, _editor, view) => {
        const file = view?.file;
        if (!file || !this.isBackdropNoteSync(file)) return false;
        const type = this.app.metadataCache.getFileCache(file)?.frontmatter?.backdrop_type;
        if (type !== "wiki" && type !== "timeline") return false;
        if (checking) return true;
        this.openArticleProperties(file);
        return true;
      },
    });

    this.addCommand({
      id: "backdrop-resolve-sync",
      name: "Resolve sync…",
      editorCheckCallback: (checking, _editor, view) => {
        const file = view?.file;
        if (!file || !this.isBackdropNoteSync(file)) return false;
        if (checking) return true;
        this.openResolveSync(file);
        return true;
      },
    });

    if (this.settings.pullOnStartup && this.settings.apiKey) {
      window.setTimeout(() => {
        void pullAll(
          this.app,
          this.client,
          this.settings,
          () => this.saveSettings(),
          { mode: "startup" },
          this.slugIndex
        )
          .then(() => this.refreshSyncBadge())
          .catch(noticeError);
      }, 2500);
    }
  }

  onunload() {
    this.clearHeaderActions();
    this.removeFormatBar();
    if (this.indexRefreshTimer != null) window.clearTimeout(this.indexRefreshTimer);
    if (this.badgeRefreshTimer != null) window.clearTimeout(this.badgeRefreshTimer);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.contentHashes) this.settings.contentHashes = {};
    if (!this.settings.worldCatalogs) this.settings.worldCatalogs = {};
    if (!Array.isArray(this.settings.conflictPaths)) this.settings.conflictPaths = [];
    if (!Array.isArray(this.settings.syncWorlds)) this.settings.syncWorlds = [];
    if (typeof this.settings.syncWorldsConfigured !== "boolean") {
      this.settings.syncWorldsConfigured = false;
    }
    if (migrateSyncWorldsFromSlugs(this.settings)) {
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async refreshSlugIndex(): Promise<void> {
    const fresh = await scanWikiSlugIndex(this.app, this.settings.vaultRoot);
    this.slugIndex.clear();
    fresh.forEach((entry) => this.slugIndex.setEntry(entry));
  }

  scheduleSlugIndexRefresh(): void {
    if (this.indexRefreshTimer != null) window.clearTimeout(this.indexRefreshTimer);
    this.indexRefreshTimer = window.setTimeout(() => {
      this.indexRefreshTimer = null;
      void this.refreshSlugIndex();
    }, 750);
  }

  scheduleSyncBadgeRefresh(): void {
    if (this.badgeRefreshTimer != null) window.clearTimeout(this.badgeRefreshTimer);
    this.badgeRefreshTimer = window.setTimeout(() => {
      this.badgeRefreshTimer = null;
      void this.refreshSyncBadge();
    }, 300);
  }

  /** Prefer frontmatter `backdrop_type`; fall back to vault-root path. */
  isBackdropNoteSync(file: TFile | null | undefined): boolean {
    if (!file || file.extension !== "md") return false;
    const cache = this.app.metadataCache.getFileCache(file);
    const type = cache?.frontmatter?.backdrop_type;
    if (type === "wiki" || type === "timeline") return true;
    const root = this.settings.vaultRoot.replace(/\/+$/, "");
    if (!root) return false;
    return file.path.startsWith(`${root}/`) || file.path === root;
  }

  refreshBackdropChrome() {
    try {
      this.clearHeaderActions();
      this.removeFormatBar();
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const file = view?.file ?? null;
      const isBd = this.isBackdropNoteSync(file);

      if (!isBd || !view) {
        if (this.statusBarEl) {
          this.statusBarEl.addClass("bd-statusbar--hidden");
          this.statusBarEl.setText("");
          this.statusBarEl.removeClass("bd-statusbar--clean");
          this.statusBarEl.removeClass("bd-statusbar--dirty");
          this.statusBarEl.removeClass("bd-statusbar--conflict");
          this.statusBarEl.removeClass("bd-statusbar--unpublished");
        }
        return;
      }

      void this.refreshSyncBadge();
      this.mountFormatBar(view);

      this.headerActionEls.push(
        view.addAction("image", "BackDrop: Insert image", () => {
          this.promptAlignedImage(view.editor, view.file);
        })
      );
      this.headerActionEls.push(
        view.addAction("audio-file", "BackDrop: Insert audio", () => {
          this.promptAudio(view.editor, view.file);
        })
      );
      this.headerActionEls.push(
        view.addAction("eye-off", "BackDrop: Wrap selection as spoiler", () => {
          this.insertSpoiler(view.editor);
        })
      );
      this.headerActionEls.push(
        view.addAction("link", "BackDrop: Insert wikilink", () => {
          this.promptWikilink(view.editor, view.file);
        })
      );
      this.headerActionEls.push(
        view.addAction("list", "BackDrop: Article properties", () => {
          if (view.file) this.openArticleProperties(view.file);
        })
      );
      this.headerActionEls.push(
        view.addAction("git-compare", "BackDrop: Resolve sync…", () => {
          if (view.file) this.openResolveSync(view.file);
        })
      );
      this.headerActionEls.push(
        view.addAction("download", "BackDrop: Pull this note", () => {
          if (view.file) void this.runPullCurrent(view.file);
        })
      );
    } catch {
      /* leaf change must never throw into Obsidian's workspace update */
      this.clearHeaderActions();
      this.removeFormatBar();
      if (this.statusBarEl) this.statusBarEl.addClass("bd-statusbar--hidden");
    }
  }

  private mountFormatBar(view: MarkdownView) {
    this.removeFormatBar();
    const container =
      view.containerEl.querySelector(".view-header") ||
      view.containerEl.querySelector(".view-actions")?.parentElement ||
      view.containerEl;
    if (!container || !container.instanceOf(HTMLElement)) return;

    const bar = container.createDiv({ cls: "bd-format-bar" });
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "BackDrop formatting");

    const buttons: Array<{ label: string; kind: Parameters<typeof applyEditorFormat>[1]; title: string }> = [
      { label: "H2", kind: "h2", title: "Heading 2" },
      { label: "H3", kind: "h3", title: "Heading 3" },
      { label: "B", kind: "bold", title: "Bold" },
      { label: "I", kind: "italic", title: "Italic" },
      { label: "Link", kind: "link", title: "Link" },
      { label: "Table", kind: "table", title: "Insert table" },
    ];
    for (const b of buttons) {
      const btn = bar.createEl("button", {
        text: b.label,
        cls: "bd-format-btn",
        attr: { type: "button", title: b.title },
      });
      btn.addEventListener("click", (evt) => {
        evt.preventDefault();
        applyEditorFormat(view.editor, b.kind);
        view.editor.focus();
      });
    }

    const actions = view.containerEl.querySelector(".view-actions");
    if (actions?.parentElement) {
      actions.parentElement.insertBefore(bar, actions);
    } else {
      container.appendChild(bar);
    }
    this.formatBarEl = bar;
  }

  private removeFormatBar() {
    if (this.formatBarEl) {
      this.formatBarEl.remove();
      this.formatBarEl = null;
    }
  }

  async refreshSyncBadge() {
    if (!this.statusBarEl) return;
    const file = this.app.workspace.getActiveFile();
    if (!file || !this.isBackdropNoteSync(file)) {
      this.statusBarEl.addClass("bd-statusbar--hidden");
      return;
    }
    this.statusBarEl.removeClass("bd-statusbar--hidden");
    this.statusBarEl.removeClass("bd-statusbar--clean");
    this.statusBarEl.removeClass("bd-statusbar--dirty");
    this.statusBarEl.removeClass("bd-statusbar--conflict");
    this.statusBarEl.removeClass("bd-statusbar--unpublished");
    try {
      const state = await getSyncBadgeState(this.app, file, this.settings);
      this.statusBarEl.setText(syncBadgeLabel(state));
      this.statusBarEl.addClass(`bd-statusbar--${state}`);
      this.statusBarEl.setAttr("aria-label", `BackDrop sync: ${state}. Click to resolve.`);
    } catch {
      this.statusBarEl.setText("BackDrop");
    }
  }

  clearHeaderActions() {
    for (const el of this.headerActionEls) {
      el.remove();
    }
    this.headerActionEls = [];
  }

  openArticleProperties(file?: TFile | null) {
    const target = file || this.app.workspace.getActiveFile();
    if (!(target instanceof TFile)) {
      new Notice("BackDrop: open a wiki or timeline note.");
      return;
    }
    new ArticlePropertiesModal(
      this.app,
      target,
      this.settings,
      () => this.saveSettings(),
      this.client,
      this.slugIndex
    ).open();
  }

  openResolveSync(file?: TFile | null) {
    const target = file || this.app.workspace.getActiveFile();
    if (!(target instanceof TFile) || !this.isBackdropNoteSync(target)) {
      new Notice("BackDrop: open a BackDrop note to resolve sync.");
      return;
    }
    new ResolveSyncModal(
      this.app,
      target,
      this.settings,
      () => this.saveSettings(),
      this.client,
      this.slugIndex,
      () => {
        void this.refreshSyncBadge();
      }
    ).open();
  }

  /** Status-bar right-click still offers insert shortcuts. */
  showInsertMenu(evt: MouseEvent) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !this.isBackdropNoteSync(view.file)) return;
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("Insert image").setIcon("image").onClick(() => {
        this.promptAlignedImage(view.editor, view.file);
      })
    );
    menu.addItem((item) =>
      item.setTitle("Insert audio").setIcon("audio-file").onClick(() => {
        this.promptAudio(view.editor, view.file);
      })
    );
    menu.addItem((item) =>
      item.setTitle("Insert wikilink").setIcon("link").onClick(() => {
        this.promptWikilink(view.editor, view.file);
      })
    );
    menu.addItem((item) =>
      item.setTitle("Article properties").setIcon("list").onClick(() => {
        if (view.file) this.openArticleProperties(view.file);
      })
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("Resolve sync…").setIcon("git-compare").onClick(() => {
        if (view.file) this.openResolveSync(view.file);
      })
    );
    menu.addItem((item) =>
      item.setTitle("Publish this note").setIcon("upload").onClick(() => {
        if (view.file) void this.runPublishCurrent(view.file);
      })
    );
    menu.showAtMouseEvent(evt);
  }

  promptAlignedImage(editor: Editor, file: TFile | null) {
    const world = resolveWorldSlug(
      this.app,
      file,
      this.settings,
      worldFromActive(file, this.settings)
    );
    new InsertImageModal(this.app, this.client, world, editor).open();
  }

  promptAudio(editor: Editor, file: TFile | null) {
    const world = resolveWorldSlug(
      this.app,
      file,
      this.settings,
      worldFromActive(file, this.settings)
    );
    new InsertAudioModal(this.app, this.client, world, editor).open();
  }

  insertSpoiler(editor: Editor) {
    const selected = editor.getSelection();
    if (selected) {
      editor.replaceSelection(spoilerMarkdown(selected));
    } else {
      editor.replaceSelection(spoilerMarkdown("spoiler text"));
    }
  }

  promptWikilink(editor: Editor, file: TFile | null) {
    const selected = editor.getSelection();
    const world = resolveWorldSlug(
      this.app,
      file,
      this.settings,
      worldFromActive(file, this.settings)
    );
    new WikilinkSuggestModal(this.app, this.slugIndex, world || null, editor, selected).open();
  }

  async runPull() {
    try {
      await pullAll(
        this.app,
        this.client,
        this.settings,
        () => this.saveSettings(),
        { mode: "full" },
        this.slugIndex
      );
      void this.refreshSyncBadge();
    } catch (e) {
      noticeError(e);
    }
  }

  async runPullCurrent(file?: TFile | null) {
    const target = file || this.app.workspace.getActiveFile();
    if (!(target instanceof TFile)) {
      new Notice("BackDrop: open a markdown note to pull.");
      return;
    }
    try {
      await pullCurrentNote(
        this.app,
        this.client,
        this.settings,
        () => this.saveSettings(),
        target.path,
        this.slugIndex
      );
      this.refreshBackdropChrome();
    } catch (e) {
      noticeError(e);
    }
  }

  async runPublishCurrent(file?: TFile | null) {
    const target = file || this.app.workspace.getActiveFile();
    if (!(target instanceof TFile) || target.extension !== "md") {
      new Notice("BackDrop: open a markdown note to publish.");
      return;
    }
    try {
      await publishFile(this.app, this.client, target, this.settings, () => this.saveSettings(), {
        slugIndex: this.slugIndex,
      });
      void this.refreshSyncBadge();
    } catch (e) {
      noticeError(e);
    }
  }

  /**
   * For unpublished wiki notes, keep backdrop_slug (URL slug) in sync with title.
   */
  async syncSlugFromTitle(file: TFile) {
    const content = await this.app.vault.read(file);
    const { data, body } = splitFrontmatter(content);
    if (data.backdrop_type !== "wiki") return;
    const title = String(data.title || "").trim();
    if (!title) return;
    const nextSlug = slugify(title);
    const currentSlug = String(data.backdrop_slug || "").trim();
    const published = Boolean(String(data.backdrop_id || "").trim());
    // Always fill empty slug; only rewrite existing slug before first publish.
    if (currentSlug === nextSlug) {
      this.slugIndex.setEntry({
        slug: nextSlug,
        world: String(data.backdrop_world || ""),
        path: file.path,
        linkText: file.basename,
        title,
      });
      return;
    }
    if (published && currentSlug) return;
    const fm = { ...data, backdrop_slug: nextSlug, title };
    const next = buildNoteFile(fm, body);
    // Avoid feedback loops: update hash before modify so pull dirty checks stay sane.
    this.settings.contentHashes[normalizePath(file.path)] = hashContent(next);
    await this.app.vault.modify(file, next);
    await this.saveSettings();
    this.slugIndex.setEntry({
      slug: nextSlug,
      world: String(data.backdrop_world || ""),
      path: file.path,
      linkText: file.basename,
      title,
    });
  }
}

function defaultWorld(settings: BackdropSettings): string {
  const fromSync = (settings.syncWorlds || []).find((w) => w.syncWiki || w.syncTimeline);
  if (fromSync) return fromSync.slug;
  return parseWorldSlugs(settings.worldSlugs)[0] || "";
}

function worldFromActive(file: TFile | null, settings: BackdropSettings): string {
  if (!file) return defaultWorld(settings);
  const root = settings.vaultRoot.replace(/\/+$/, "");
  if (file.path.startsWith(`${root}/`)) {
    const rest = file.path.slice(root.length + 1);
    return rest.split("/")[0] || defaultWorld(settings);
  }
  return defaultWorld(settings);
}

class PromptModal extends Modal {
  titleText: string;
  fields: Array<{ key: string; label: string; value: string }>;
  onSubmit: (values: Record<string, string>) => void | Promise<void>;
  values: Record<string, string> = {};

  constructor(
    app: App,
    titleText: string,
    fields: Array<{ key: string; label: string; value: string }>,
    onSubmit: (values: Record<string, string>) => void | Promise<void>
  ) {
    super(app);
    this.titleText = titleText;
    this.fields = fields;
    this.onSubmit = onSubmit;
    for (const f of fields) this.values[f.key] = f.value;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.titleText });
    for (const field of this.fields) {
      new Setting(contentEl).setName(field.label).addText((text) => {
        text.setValue(this.values[field.key] || "").onChange((v) => {
          this.values[field.key] = v;
        });
      });
    }
    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("OK")
        .setCta()
        .onClick(async () => {
          this.close();
          await this.onSubmit({ ...this.values });
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}


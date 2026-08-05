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
  buildNoteFile,
  frontmatterRecord,
  hashContent,
  parseWorldSlugs,
  normalizeSlugInput,
  slugify,
  splitFrontmatter,
} from "./src/frontmatter";
import {
  createTimelineStub,
  createWikiStub,
  defaultCategorySlug,
  getSyncBadgeState,
  listWorldCategoryOptions,
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
  ConflictListModal,
  InsertAudioModal,
  InsertImageModal,
  ResolveSyncModal,
  SyncPanelModal,
  WikilinkSuggestModal,
  applyEditorFormat,
  resolveWorldSlug,
} from "./src/editorUi";
import {
  listSyncedWorlds,
  migrateSyncWorldsFromSlugs,
  pickDefaultSyncedWorld,
  syncedWorldLabel,
} from "./src/syncSelection";
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
      const conflicts = this.settings.conflictPaths || [];
      if (conflicts.length > 1) {
        this.openConflictList(conflicts);
        return;
      }
      if (conflicts.length === 1) {
        const only = this.app.vault.getAbstractFileByPath(conflicts[0]);
        if (only instanceof TFile) {
          this.openResolveSync(only);
          return;
        }
      }
      this.openResolveSync();
    });
    this.statusBarEl.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      this.showInsertMenu(evt);
    });

    this.addRibbonIcon("download", "Pull updates", () => {
      void this.runPull();
    });
    this.addRibbonIcon("upload", "Sync to BackDrop", () => {
      const active = this.app.workspace.getActiveFile();
      this.openSyncPanel({
        focusFile: active && this.isBackdropNoteSync(active) ? active : null,
      });
    });
    this.addRibbonIcon("book-plus", "New wiki article", () => {
      this.openNewWikiArticle();
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
      name: "Pull updates",
      callback: async () => {
        await this.runPull();
      },
    });

    this.addCommand({
      id: "backdrop-pull-current",
      name: "Pull current note",
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
      name: "Sync current note",
      editorCheckCallback: (checking, _editor, view) => {
        const file = view?.file;
        if (!file) return false;
        if (checking) return true;
        this.openSyncPanel({ focusFile: file });
        return true;
      },
    });

    this.addCommand({
      id: "backdrop-publish-current-force",
      name: "Force sync current note",
      editorCheckCallback: (checking, _editor, view) => {
        const file = view?.file;
        if (!file) return false;
        if (checking) return true;
        this.openSyncPanel({ focusFile: file, force: true });
        return true;
      },
    });

    this.addCommand({
      id: "backdrop-publish-pending",
      name: "Sync all pending",
      callback: () => {
        this.openSyncPanel();
      },
    });

    this.addCommand({
      id: "backdrop-new-wiki",
      name: "New wiki article",
      callback: () => {
        this.openNewWikiArticle();
      },
    });

    this.addCommand({
      id: "backdrop-new-timeline",
      name: "New timeline event",
      callback: () => {
        this.openNewTimelineEvent();
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
        const type = frontmatterRecord(this.app.metadataCache.getFileCache(file))?.backdrop_type;
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

    this.addCommand({
      id: "backdrop-review-conflicts",
      name: "Review sync conflicts",
      callback: () => {
        this.openConflictList();
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
    if (this.indexRefreshTimer != null) window.clearTimeout(this.indexRefreshTimer);
    if (this.badgeRefreshTimer != null) window.clearTimeout(this.badgeRefreshTimer);
  }

  async loadSettings() {
    const raw: unknown = await this.loadData();
    const saved =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Partial<BackdropSettings>)
        : {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    if (!this.settings.contentHashes) this.settings.contentHashes = {};
    if (!this.settings.worldCatalogs) this.settings.worldCatalogs = {};
    if (!Array.isArray(this.settings.conflictPaths)) this.settings.conflictPaths = [];
    if (!Array.isArray(this.settings.syncWorlds)) this.settings.syncWorlds = [];
    if (typeof this.settings.syncWorldsConfigured !== "boolean") {
      this.settings.syncWorldsConfigured = false;
    }
    if (typeof this.settings.lastWorldSlug !== "string") this.settings.lastWorldSlug = "";
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
    const type = frontmatterRecord(this.app.metadataCache.getFileCache(file))?.backdrop_type;
    if (type === "wiki" || type === "timeline") return true;
    const root = this.settings.vaultRoot.replace(/\/+$/, "");
    if (!root) return false;
    return file.path.startsWith(`${root}/`) || file.path === root;
  }

  refreshBackdropChrome() {
    try {
      this.clearHeaderActions();
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

      this.headerActionEls.push(
        view.addAction("type", "BackDrop: Format…", (evt) => {
          this.showFormatMenu(view, evt);
        })
      );
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
      if (this.statusBarEl) this.statusBarEl.addClass("bd-statusbar--hidden");
    }
  }

  /** Compact Format menu — replaces the old wrapping H2/H3/B/I text strip. */
  showFormatMenu(view: MarkdownView, evt: MouseEvent) {
    const menu = new Menu();
    const items: Array<{
      title: string;
      icon: string;
      kind: Parameters<typeof applyEditorFormat>[1];
    }> = [
      { title: "Heading 2", icon: "heading-2", kind: "h2" },
      { title: "Heading 3", icon: "heading-3", kind: "h3" },
      { title: "Bold", icon: "bold", kind: "bold" },
      { title: "Italic", icon: "italic", kind: "italic" },
      { title: "Link", icon: "link-2", kind: "link" },
      { title: "Insert table", icon: "table", kind: "table" },
    ];
    for (const item of items) {
      menu.addItem((mi) =>
        mi.setTitle(item.title).setIcon(item.icon).onClick(() => {
          applyEditorFormat(view.editor, item.kind);
          view.editor.focus();
        })
      );
    }
    menu.showAtMouseEvent(evt);
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

  openConflictList(paths?: string[]) {
    const list = paths?.length ? paths : this.settings.conflictPaths || [];
    if (!list.length) {
      new Notice("BackDrop: no sync conflicts.");
      return;
    }
    new ConflictListModal(
      this.app,
      this.settings,
      () => this.saveSettings(),
      (file) => this.openResolveSync(file),
      list
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
      item.setTitle("Review sync conflicts").setIcon("alert-triangle").onClick(() => {
        this.openConflictList();
      })
    );
    menu.addItem((item) =>
      item.setTitle("Sync to BackDrop…").setIcon("upload").onClick(() => {
        this.openSyncPanel({ focusFile: view.file });
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
      const { conflicts } = await pullAll(
        this.app,
        this.client,
        this.settings,
        () => this.saveSettings(),
        {
          mode: "full",
          onReviewConflicts: (paths) => this.openConflictList(paths),
        },
        this.slugIndex
      );
      void this.refreshSyncBadge();
      if (conflicts.length) {
        this.openConflictList(conflicts);
      }
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

  openSyncPanel(opts: { focusFile?: TFile | null; force?: boolean } = {}) {
    new SyncPanelModal(
      this.app,
      this.settings,
      () => this.saveSettings(),
      this.client,
      this.slugIndex,
      {
        force: opts.force === true,
        focusFile: opts.focusFile ?? null,
        onDone: () => {
          void this.refreshSyncBadge();
        },
      }
    ).open();
  }

  /** @deprecated Prefer openSyncPanel. */
  async runPublishCurrent(file?: TFile | null, opts: { force?: boolean } = {}) {
    const target = file || this.app.workspace.getActiveFile();
    if (!(target instanceof TFile) || target.extension !== "md") {
      new Notice("BackDrop: open a markdown note to sync.");
      return;
    }
    this.openSyncPanel({ focusFile: target, force: opts.force });
  }

  /**
   * Open the New wiki article modal (command + ribbon).
   */
  openNewWikiArticle() {
    const worldField = worldPromptField(this.settings, "wiki", this.app.workspace.getActiveFile());
    const initialWorld = String(worldField.value || "").trim();
    const initialCats = listWorldCategoryOptions(this.app, this.settings, initialWorld);
    new PromptModal(
      this.app,
      "New wiki article",
      [
        worldField,
        { key: "title", label: "Title", value: "" },
        {
          key: "slug",
          label: "Article slug",
          value: "",
          autoSlugFrom: "title",
          placeholder: "auto from title",
        },
        {
          key: "category",
          label: "Category",
          value: defaultCategorySlug(initialCats),
          kind: "combobox",
          optionsDependsOn: "world",
          getOptions: (values) => {
            const world = String(values.world || "").trim();
            return listWorldCategoryOptions(this.app, this.settings, world).map((c) => ({
              value: c.slug,
              label: c.name !== c.slug ? `${c.name} (${c.slug})` : c.name,
            }));
          },
          customOptionLabel: "Type new…",
          customPlaceholder: "New category slug or name",
          emptyHint: "No categories yet — type a new one, or Pull to load from BackDrop.",
          required: true,
        },
      ],
      async (values) => {
        const title = String(values.title || "").trim();
        if (!title) {
          new Notice("BackDrop: title is required.");
          return;
        }
        const world = String(values.world || "").trim();
        if (!world) {
          new Notice("BackDrop: enable a world in Settings → BackDrop.");
          return;
        }
        const category = String(values.category || "").trim();
        if (!category) {
          new Notice("BackDrop: category is required.");
          return;
        }
        const articleSlug = String(values.slug || "").trim();
        const file = await createWikiStub(
          this.app,
          this.settings,
          world,
          title,
          category,
          articleSlug
        );
        const slug = articleSlug ? slugify(articleSlug) : slugify(title);
        this.settings.lastWorldSlug = world;
        await this.saveSettings();
        this.slugIndex.setEntry({
          slug,
          world,
          path: file.path,
          linkText: file.basename,
          title,
        });
        await this.app.workspace.getLeaf(true).openFile(file);
        new Notice(`Created ${file.path} (slug: ${slug})`);
      }
    ).open();
  }

  openNewTimelineEvent() {
    new PromptModal(
      this.app,
      "New timeline event",
      [
        worldPromptField(this.settings, "timeline", this.app.workspace.getActiveFile()),
        { key: "title", label: "Title", value: "" },
      ],
      async (values) => {
        const title = String(values.title || "").trim();
        if (!title) {
          new Notice("BackDrop: title is required.");
          return;
        }
        const world = String(values.world || "").trim();
        if (!world) {
          new Notice("BackDrop: enable a world in Settings → BackDrop.");
          return;
        }
        const file = await createTimelineStub(this.app, this.settings, world, title);
        this.settings.lastWorldSlug = world;
        await this.saveSettings();
        await this.app.workspace.getLeaf(true).openFile(file);
        new Notice(`Created ${file.path}`);
      }
    ).open();
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
  return listSyncedWorlds(settings)[0]?.slug || parseWorldSlugs(settings.worldSlugs)[0] || "";
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

function worldPromptField(
  settings: BackdropSettings,
  facet: "wiki" | "timeline",
  activeFile: TFile | null
): PromptField {
  const worlds = listSyncedWorlds(settings, facet);
  const current = worldFromActive(activeFile, settings);
  return {
    key: "world",
    label: "World",
    value: pickDefaultSyncedWorld(worlds, settings, current),
    kind: "dropdown",
    options: worlds.map((w) => ({
      value: w.slug,
      label: syncedWorldLabel(w.slug, w.name),
    })),
    emptyHint: "Enable worlds in Settings → BackDrop.",
    required: true,
  };
}

type PromptField = {
  key: string;
  label: string;
  value: string;
  /** Auto-fill this field from another via slugify until the user edits it. */
  autoSlugFrom?: string;
  placeholder?: string;
  kind?: "text" | "dropdown" | "combobox";
  options?: Array<{ value: string; label: string }>;
  /** Dynamic options (e.g. categories for the selected world). */
  getOptions?: (values: Record<string, string>) => Array<{ value: string; label: string }>;
  /** When this field changes, re-resolve options for fields that depend on it. */
  optionsDependsOn?: string;
  /** Combobox: label for the “type a new value” option. */
  customOptionLabel?: string;
  customPlaceholder?: string;
  emptyHint?: string;
  required?: boolean;
};

const PROMPT_CUSTOM_OPTION = "__bd_custom__";

class PromptModal extends Modal {
  titleText: string;
  fields: PromptField[];
  onSubmit: (values: Record<string, string>) => void | Promise<void>;
  values: Record<string, string> = {};
  /** Slug fields the user has typed into — stop auto-updating those. */
  private slugTouched = new Set<string>();
  /** Combobox fields currently on the “Type new…” option. */
  private customMode = new Set<string>();

  constructor(
    app: App,
    titleText: string,
    fields: PromptField[],
    onSubmit: (values: Record<string, string>) => void | Promise<void>
  ) {
    super(app);
    this.titleText = titleText;
    this.fields = fields;
    this.onSubmit = onSubmit;
    for (const f of fields) this.values[f.key] = f.value;
  }

  onOpen() {
    this.renderForm();
  }

  private fieldOptions(field: PromptField): Array<{ value: string; label: string }> {
    if (field.getOptions) return field.getOptions(this.values);
    return field.options || [];
  }

  private resolveDefaultForField(field: PromptField): string {
    if (field.kind === "combobox") {
      const options = this.fieldOptions(field);
      return defaultCategorySlug(options.map((o) => ({ slug: o.value, name: o.label })));
    }
    const options = this.fieldOptions(field);
    if (options.length) {
      if (options.some((o) => o.value === this.values[field.key])) return this.values[field.key];
      return options[0].value;
    }
    return this.values[field.key] || "";
  }

  private renderForm() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.titleText });

    const textInputs = new Map<string, { setValue: (v: string) => unknown }>();

    for (const field of this.fields) {
      if (field.kind === "dropdown") {
        const options = this.fieldOptions(field);
        const setting = new Setting(contentEl).setName(field.label);
        if (!options.length) {
          setting.setDesc(field.emptyHint || "No options available.");
          setting.addDropdown((dd) => {
            dd.addOption("", "No synced worlds");
            dd.setValue("");
            dd.setDisabled(true);
          });
          this.values[field.key] = "";
          continue;
        }
        setting.addDropdown((dd) => {
          for (const opt of options) dd.addOption(opt.value, opt.label);
          const initial = options.some((o) => o.value === this.values[field.key])
            ? this.values[field.key]
            : options[0].value;
          this.values[field.key] = initial;
          dd.setValue(initial);
          dd.onChange((v) => {
            this.values[field.key] = v;
            this.onDriverFieldChanged(field.key);
          });
        });
        continue;
      }

      if (field.kind === "combobox") {
        this.renderComboboxField(contentEl, field);
        continue;
      }

      new Setting(contentEl).setName(field.label).addText((text) => {
        text.setValue(this.values[field.key] || "");
        if (field.placeholder) text.setPlaceholder(field.placeholder);
        textInputs.set(field.key, text);
        text.onChange((v) => {
          if (field.autoSlugFrom) {
            this.slugTouched.add(field.key);
            const normalized = normalizeSlugInput(v);
            this.values[field.key] = normalized;
            if (normalized !== v) text.setValue(normalized);
            return;
          }

          this.values[field.key] = v;
          for (const other of this.fields) {
            if (other.autoSlugFrom !== field.key) continue;
            if (this.slugTouched.has(other.key)) continue;
            // Empty title → empty slug while still following (avoid stale "article").
            const display = !String(v || "").trim() ? "" : slugify(v);
            this.values[other.key] = display;
            const otherInput = textInputs.get(other.key);
            if (otherInput) otherInput.setValue(display);
          }
        });
      });
    }

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("OK")
        .setCta()
        .setDisabled(this.isSubmitBlocked())
        .onClick(async () => {
          if (this.isSubmitBlocked()) return;
          this.close();
          await this.onSubmit({ ...this.values });
        })
    );
  }

  private renderComboboxField(contentEl: HTMLElement, field: PromptField) {
    const options = this.fieldOptions(field);
    const customLabel = field.customOptionLabel || "Type new…";
    let current = String(this.values[field.key] || "").trim();
    const known = options.some((o) => o.value === current);

    if (!options.length && !current) {
      this.customMode.add(field.key);
    } else if (known) {
      this.customMode.delete(field.key);
    } else if (this.customMode.has(field.key) || (current !== "" && !known)) {
      this.customMode.add(field.key);
    } else {
      current = this.resolveDefaultForField(field);
      this.values[field.key] = current;
      if (!current) this.customMode.add(field.key);
      else this.customMode.delete(field.key);
    }

    const inCustom = this.customMode.has(field.key);
    const setting = new Setting(contentEl).setName(field.label);
    if (!options.length) {
      setting.setDesc(field.emptyHint || "Type a new category.");
    }

    if (options.length) {
      setting.addDropdown((dd) => {
        for (const opt of options) dd.addOption(opt.value, opt.label);
        dd.addOption(PROMPT_CUSTOM_OPTION, customLabel);
        dd.setValue(inCustom ? PROMPT_CUSTOM_OPTION : current || options[0].value);
        dd.onChange((v) => {
          if (v === PROMPT_CUSTOM_OPTION) {
            this.customMode.add(field.key);
            if (options.some((o) => o.value === this.values[field.key])) {
              this.values[field.key] = "";
            }
            this.renderForm();
            return;
          }
          this.customMode.delete(field.key);
          this.values[field.key] = v;
          this.renderForm();
        });
      });
    }

    if (inCustom || !options.length) {
      setting.addText((text) => {
        text
          .setPlaceholder(field.customPlaceholder || field.placeholder || "New value")
          .setValue(inCustom || !options.length ? String(this.values[field.key] || "") : "")
          .onChange((v) => {
            this.customMode.add(field.key);
            this.values[field.key] = v;
            this.refreshSubmitButton();
          });
        text.inputEl.addClass("bd-setting-input-full");
        window.setTimeout(() => text.inputEl.focus(), 0);
      });
    }
  }

  private onDriverFieldChanged(driverKey: string) {
    let changed = false;
    for (const field of this.fields) {
      if (field.optionsDependsOn !== driverKey) continue;
      if (field.kind === "combobox") {
        this.customMode.delete(field.key);
        this.values[field.key] = this.resolveDefaultForField(field);
        changed = true;
      } else if (field.getOptions) {
        this.values[field.key] = this.resolveDefaultForField(field);
        changed = true;
      }
    }
    if (changed) this.renderForm();
    else this.refreshSubmitButton();
  }

  private refreshSubmitButton() {
    const buttons = this.contentEl.querySelectorAll("button.mod-cta");
    const lastCta = buttons[buttons.length - 1] as HTMLButtonElement | undefined;
    if (lastCta) lastCta.disabled = this.isSubmitBlocked();
  }

  private isSubmitBlocked(): boolean {
    return this.fields.some((field) => {
      if (!field.required) return false;
      return !String(this.values[field.key] || "").trim();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

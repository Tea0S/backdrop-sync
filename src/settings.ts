import { App, PluginSettingTab, Setting } from "obsidian";
import type BackdropPlugin from "../main";
import { noticeError } from "./api";
import type { ObsidianWorldSummary } from "./types";
import { applyWorldChecklist, selectionForWorld } from "./syncSelection";

export class BackdropSettingTab extends PluginSettingTab {
  plugin: BackdropPlugin;
  private worlds: ObsidianWorldSummary[] | null = null;
  private worldsLoading = false;
  private worldsError = "";
  private checklistState: Record<string, { syncWiki: boolean; syncTimeline: boolean }> = {};

  constructor(app: App, plugin: BackdropPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * TODO(obsidian 1.13+): adopt `getSettingDefinitions()` for the static
   * fields (API URL / key / vault / pull-on-startup). The worlds checklist is
   * async + custom-rendered, so keep imperative `display()` until that can be
   * expressed as a definition list / render callback without a large rewrite.
   */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("BackDrop").setHeading();

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc("Usually https://api.backdrop.quest")
      .addText((text) =>
        text
          .setPlaceholder("https://api.backdrop.quest")
          .setValue(this.plugin.settings.apiBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.apiBaseUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Create a bd_… key on the BackDrop dashboard (Obsidian API keys).")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("bd_…")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
            this.worlds = null;
            this.worldsError = "";
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("Vault folder")
      .setDesc("Root folder for synced notes")
      .addText((text) =>
        text
          .setPlaceholder("BackDrop")
          .setValue(this.plugin.settings.vaultRoot)
          .onChange(async (value) => {
            this.plugin.settings.vaultRoot = value.trim() || "BackDrop";
            await this.plugin.saveSettings();
          })
      );

    this.renderWorldsSection(containerEl);

    new Setting(containerEl)
      .setName("Pull on startup")
      .setDesc("Automatically pull when the app loads (requires API key).")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.pullOnStartup).onChange(async (value) => {
          this.plugin.settings.pullOnStartup = value;
          await this.plugin.saveSettings();
        })
      );
  }

  private renderWorldsSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Worlds to sync").setHeading();

    const hasKey = Boolean(this.plugin.settings.apiKey.trim());
    if (!hasKey) {
      containerEl.createEl("p", {
        text: "Set an API key above to load editable worlds.",
        cls: "setting-item-description",
      });
      return;
    }

    const header = new Setting(containerEl)
      .setName("Select worlds")
      .setDesc(
        this.plugin.settings.syncWorldsConfigured
          ? "Pull only the worlds and facets enabled below."
          : "Nothing customized yet — pull uses all editable worlds (wiki + timeline). Toggle any option to save an explicit list."
      );

    header.addButton((btn) =>
      btn
        .setButtonText(this.worldsLoading ? "Loading…" : "Refresh")
        .setDisabled(this.worldsLoading)
        .onClick(() => {
          void this.loadWorlds(true);
        })
    );

    if (this.worldsLoading && !this.worlds) {
      containerEl.createEl("p", {
        text: "Loading worlds…",
        cls: "setting-item-description",
      });
      return;
    }

    if (this.worldsError) {
      containerEl.createEl("p", {
        text: this.worldsError,
        cls: "bd-settings-error",
      });
      return;
    }

    if (!this.worlds) {
      void this.loadWorlds(false);
      containerEl.createEl("p", {
        text: "Loading worlds…",
        cls: "setting-item-description",
      });
      return;
    }

    if (!this.worlds.length) {
      containerEl.createEl("p", {
        text: "No editable worlds for this API key.",
        cls: "setting-item-description",
      });
      return;
    }

    const list = containerEl.createDiv({ cls: "bd-world-checklist" });
    for (const world of this.worlds) {
      this.renderWorldRow(list, world);
    }
  }

  private renderWorldRow(parent: HTMLElement, world: ObsidianWorldSummary): void {
    const state = this.checklistState[world.slug] || selectionForWorld(this.plugin.settings, world);
    this.checklistState[world.slug] = state;

    const row = parent.createDiv({ cls: "bd-world-row" });
    row.createEl("div", {
      text: `${world.name}`,
      cls: "bd-world-row__title",
    });
    row.createEl("div", {
      text: world.slug,
      cls: "bd-world-row__slug setting-item-description",
    });

    const toggles = row.createDiv({ cls: "bd-world-row__toggles" });

    new Setting(toggles)
      .setName("Wiki")
      .setDesc(world.can_edit_wiki ? "Pull wiki articles" : "No wiki edit access")
      .addToggle((toggle) => {
        toggle.setValue(state.syncWiki && world.can_edit_wiki);
        toggle.setDisabled(!world.can_edit_wiki);
        toggle.onChange(async (value) => {
          this.checklistState[world.slug] = {
            ...this.checklistState[world.slug],
            syncWiki: value,
          };
          await this.persistChecklist();
        });
      });

    new Setting(toggles)
      .setName("Timeline")
      .setDesc(world.can_edit_timeline ? "Pull timeline events" : "No timeline edit access")
      .addToggle((toggle) => {
        toggle.setValue(state.syncTimeline && world.can_edit_timeline);
        toggle.setDisabled(!world.can_edit_timeline);
        toggle.onChange(async (value) => {
          this.checklistState[world.slug] = {
            ...this.checklistState[world.slug],
            syncTimeline: value,
          };
          await this.persistChecklist();
        });
      });
  }

  private async persistChecklist(): Promise<void> {
    if (!this.worlds) return;
    const wasConfigured = this.plugin.settings.syncWorldsConfigured;
    applyWorldChecklist(this.plugin.settings, this.worlds, this.checklistState);
    await this.plugin.saveSettings();
    // Refresh once when switching from implicit-all to explicit list (updates header desc).
    if (!wasConfigured) this.display();
  }

  private async loadWorlds(force: boolean): Promise<void> {
    if (this.worldsLoading) return;
    if (this.worlds && !force) return;
    this.worldsLoading = true;
    this.worldsError = "";
    this.display();
    try {
      const res = await this.plugin.client.worlds();
      this.worlds = res.worlds || [];
      this.checklistState = {};
      for (const world of this.worlds) {
        this.checklistState[world.slug] = selectionForWorld(this.plugin.settings, world);
      }
    } catch (e) {
      this.worlds = null;
      this.worldsError = e instanceof Error ? e.message : String(e);
      noticeError(e, "Load worlds");
    } finally {
      this.worldsLoading = false;
      this.display();
    }
  }
}

import {
  App,
  PluginSettingTab,
  Setting,
  type SettingDefinitionItem,
} from "obsidian";
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

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "API base URL",
        desc: "Usually https://api.backdrop.quest",
        aliases: ["endpoint", "server"],
        control: {
          type: "text",
          key: "apiBaseUrl",
          placeholder: "https://api.backdrop.quest",
        },
      },
      {
        name: "API key",
        desc: "Create a bd_… key on the BackDrop dashboard (Obsidian API keys).",
        aliases: ["token", "auth", "password"],
        // Password input is not available on the declarative text control.
        render: (setting) => {
          setting.addText((text) => {
            text.inputEl.type = "password";
            text
              .setPlaceholder("bd_…")
              .setValue(this.plugin.settings.apiKey)
              .onChange(async (value) => {
                this.plugin.settings.apiKey = value.trim();
                await this.plugin.saveSettings();
                this.worlds = null;
                this.worldsError = "";
                this.update();
              });
          });
        },
      },
      {
        name: "Vault folder",
        desc: "Root folder for synced notes",
        aliases: ["path", "directory"],
        control: {
          type: "text",
          key: "vaultRoot",
          placeholder: "BackDrop",
        },
      },
      {
        type: "group",
        heading: "Worlds to sync",
        items: [
          {
            name: "Select worlds",
            desc: this.plugin.settings.syncWorldsConfigured
              ? "Pull only the worlds and facets enabled below."
              : "Nothing customized yet — pull uses all editable worlds (wiki + timeline). Toggle any option to save an explicit list.",
            aliases: ["wiki", "timeline", "checklist", "worlds"],
            render: (setting) => {
              this.renderWorldsSection(setting);
            },
          },
        ],
      },
      {
        name: "Pull on startup",
        desc: "Automatically pull when the app loads (requires API key).",
        aliases: ["autoload", "auto pull"],
        control: {
          type: "toggle",
          key: "pullOnStartup",
        },
      },
    ];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    let next: unknown = value;
    if (typeof value === "string") {
      if (key === "apiBaseUrl") next = value.trim();
      else if (key === "vaultRoot") next = value.trim() || "BackDrop";
    }
    await Promise.resolve(super.setControlValue(key, next));
  }

  private renderWorldsSection(setting: Setting): void {
    const host = setting.settingEl.createDiv({ cls: "bd-world-settings-host" });

    const hasKey = Boolean(this.plugin.settings.apiKey.trim());
    if (!hasKey) {
      host.createEl("p", {
        text: "Set an API key above to load editable worlds.",
        cls: "setting-item-description",
      });
      return;
    }

    setting.addButton((btn) =>
      btn
        .setButtonText(this.worldsLoading ? "Loading…" : "Refresh")
        .setDisabled(this.worldsLoading)
        .onClick(() => {
          void this.loadWorlds(true);
        })
    );

    if (this.worldsLoading && !this.worlds) {
      host.createEl("p", {
        text: "Loading worlds…",
        cls: "setting-item-description",
      });
      return;
    }

    if (this.worldsError) {
      host.createEl("p", {
        text: this.worldsError,
        cls: "bd-settings-error",
      });
      return;
    }

    if (!this.worlds) {
      void this.loadWorlds(false);
      host.createEl("p", {
        text: "Loading worlds…",
        cls: "setting-item-description",
      });
      return;
    }

    if (!this.worlds.length) {
      host.createEl("p", {
        text: "No editable worlds for this API key.",
        cls: "setting-item-description",
      });
      return;
    }

    const list = host.createDiv({ cls: "bd-world-checklist" });
    for (const world of this.worlds) {
      this.renderWorldRow(list, world);
    }
  }

  private renderWorldRow(parent: HTMLElement, world: ObsidianWorldSummary): void {
    const state = this.checklistState[world.slug] || selectionForWorld(this.plugin.settings, world);
    this.checklistState[world.slug] = state;

    const row = parent.createDiv({ cls: "bd-world-row" });
    row.createDiv({
      text: world.name,
      cls: "bd-world-row__title",
    });
    row.createDiv({
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
    if (!wasConfigured) this.update();
  }

  private async loadWorlds(force: boolean): Promise<void> {
    if (this.worldsLoading) return;
    if (this.worlds && !force) return;
    this.worldsLoading = true;
    this.worldsError = "";
    this.update();
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
      this.update();
    }
  }
}

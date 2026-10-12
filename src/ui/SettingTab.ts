import { App, ButtonComponent, Notice, PluginSettingTab, Setting, SettingDefinition, SettingDefinitionItem, TextComponent } from "obsidian";
import { NotSignedInError } from "../api/HubClient";
import { t } from "../i18n";
import type SilkPluginsHub from "../main";
import type { CatalogPlugin, Company, HubSettings } from "../settings";
import { PluginRow } from "./PluginRow";

/** Renders "text with **bold**" without innerHTML. */
function appendWithBold(parent: HTMLElement, text: string): void {
  text.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
    if (part.startsWith("**") && part.endsWith("**")) parent.createEl("strong", { text: part.slice(2, -2) });
    else if (part) parent.appendText(part);
  });
}

/** What the tab shows below the account: loaded from the server each time the tab opens. */
type HubData =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; companies: Company[]; catalog: CatalogPlugin[]; installed: Record<string, string> };

const CHECK_INTERVALS = [0, 1, 3, 6, 12, 24];

/**
 * Settings declared with getSettingDefinitions(), so they appear in Obsidian's settings search.
 * Server data (companies, catalog) is loaded when the tab opens; the definitions are rebuilt with
 * update() once it arrives.
 */
export class HubSettingTab extends PluginSettingTab {
  private data: HubData = { state: "loading" };
  private stale = true;
  private loadId = 0;

  constructor(
    app: App,
    private plugin: SilkPluginsHub,
  ) {
    super(app, plugin);
  }

  /** Reloads server data and redraws the tab, for example after signing in elsewhere. */
  refresh(): void {
    this.stale = true;
    this.update();
  }

  hide(): void {
    // Next time the tab opens, its data is loaded again.
    this.stale = true;
    super.hide();
  }

  getControlValue(key: string): unknown {
    if (key === "enableAfterInstall") return this.plugin.enableAfterInstall;
    return this.plugin.settings[key as keyof HubSettings];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const { settings } = this.plugin;
    if (key === "enableAfterInstall") {
      this.plugin.enableAfterInstall = Boolean(value);
      return;
    }
    if (key === "serverUrl") settings.serverUrl = String(value).trim();
    else if (key === "autoUpdate") settings.autoUpdate = Boolean(value);
    else if (key === "checkIntervalHours") settings.checkIntervalHours = Number(value);
    await this.plugin.saveSettings();
    if (key === "checkIntervalHours") this.plugin.scheduleChecks();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const { settings, client } = this.plugin;
    if (this.stale && client.signedIn) void this.load();

    const items: SettingDefinitionItem[] = [
      {
        name: t("guideTitle"),
        aliases: [t("signIn"), t("connect")],
        render: (setting) => this.renderGuide(setting, !client.signedIn || settings.companyIds.length === 0),
      },
      {
        name: t("serverUrl"),
        desc: t("serverUrlDesc"),
        control: { type: "text", key: "serverUrl", placeholder: "https://hub.example.com" },
      },
      { type: "group", heading: t("account"), items: [this.accountItem()] },
    ];
    if (!client.signedIn) return items;

    const { data } = this;
    if (data.state !== "ready") {
      const message = data.state === "loading" ? t("loading") : t("loadFailed", { error: data.message });
      items.push({ name: message, searchable: false });
      return items;
    }
    if (data.companies.length === 0) {
      items.push({ name: t("noCompanies", { email: settings.accountEmail ?? "" }), searchable: false });
      return items;
    }

    items.push({ type: "group", heading: t("companies"), items: this.companyItems(data.companies) });
    if (settings.companyIds.length === 0) return items;

    items.push(this.pluginsGroup(data.catalog, data.companies, data.installed));
    items.push({
      type: "group",
      heading: t("updates"),
      items: [
        { name: t("autoUpdate"), desc: t("autoUpdateDesc"), control: { type: "toggle", key: "autoUpdate" } },
        { name: t("enableAfterInstall"), desc: t("enableAfterInstallDesc"), control: { type: "toggle", key: "enableAfterInstall" } },
        {
          name: t("checkInterval"),
          desc: t("checkIntervalDesc"),
          control: {
            type: "dropdown",
            key: "checkIntervalHours",
            options: Object.fromEntries(CHECK_INTERVALS.map((n) => [String(n), n === 0 ? t("never") : t("hours", { n })])),
          },
        },
        {
          name: t("checkNow"),
          aliases: [t("openChangelog")],
          render: (s) => {
            // Two long buttons: on a phone they wrap instead of widening the page.
            s.settingEl.addClass("silk-hub-actions");
            s.setName("")
              .addButton((b) => b.setButtonText(t("openChangelog")).onClick(() => void this.plugin.openChangelog()))
              .addButton((b) => b.setButtonText(t("checkNow")).onClick(() => void this.plugin.updates.check(true)));
          },
        },
      ],
    });
    return items;
  }

  /** Loads the user's companies, the catalog of the connected ones and installed versions, then redraws. */
  private async load(): Promise<void> {
    const id = ++this.loadId;
    this.stale = false;
    const { settings, client, installer } = this.plugin;
    let next: HubData;
    try {
      const me = await client.me();
      if (settings.accountEmail !== me.user.email) {
        settings.accountEmail = me.user.email;
        await this.plugin.saveSettings();
      }
      // Drop companies the user was removed from.
      const ids = settings.companyIds.filter((cid) => me.companies.some((c) => c.id === cid));
      if (ids.length !== settings.companyIds.length) {
        settings.companyIds = ids;
        await this.plugin.saveSettings();
      }
      const catalog = (await client.catalog(settings.companyIds)).filter((p) => installer.manages(p.id));
      const installed = await installer.installedVersions(catalog.map((p) => p.id));
      next = { state: "ready", companies: me.companies, catalog, installed };
    } catch (err) {
      next = err instanceof NotSignedInError ? { state: "loading" } : { state: "error", message: (err as Error).message };
    }
    if (id !== this.loadId) return;
    this.data = next;
    this.update();
  }

  private renderGuide(setting: Setting, open: boolean): void {
    setting.settingEl.addClass("silk-hub-guide-setting");
    setting.infoEl.empty();
    const details = setting.infoEl.createEl("details", { cls: "silk-hub-guide" });
    details.open = open;
    details.createEl("summary", { text: t("guideTitle") });
    const list = details.createEl("ol");
    for (const step of t("guideSteps").split("|")) appendWithBold(list.createEl("li"), step);
  }

  private accountItem(): SettingDefinition {
    const { plugin } = this;
    const { settings, client } = plugin;
    if (!client.signedIn) {
      return {
        name: t("signIn"),
        desc: t("signInDesc"),
        render: (s) => {
          // The link is ready before the tap, so the browser opens on iOS too (see prepareSignIn).
          // If the server address changed after that, the link is built on the tap (fine on desktop).
          let url: string | null = null;
          s.addButton((b) =>
            b
              .setButtonText(t("signIn"))
              .setCta()
              .onClick(() => {
                if (url && url.startsWith(plugin.client.serverUrl + "/")) plugin.openSignIn(url);
                else void plugin.startSignIn();
              }),
          );
          void plugin.prepareSignIn().then((prepared) => (url = prepared));
        },
      };
    }
    return {
      name: t("signedInAs", { email: settings.accountEmail ?? "" }),
      aliases: [t("signOut")],
      render: (s) => {
        s.addButton((b) =>
          b.setButtonText(t("signOut")).onClick(async () => {
            await plugin.signOut();
            this.data = { state: "loading" };
            this.refresh();
          }),
        );
      },
    };
  }

  /**
   * Connected companies, each with Disconnect, and a field to add one more by its code (or name).
   * Plugin lists of all connected companies are merged.
   */
  private companyItems(companies: Company[]): SettingDefinition[] {
    const { settings } = this.plugin;
    const connected = companies.filter((c) => settings.companyIds.includes(c.id));
    const items: SettingDefinition[] = connected.map((company) => ({
      name: company.name,
      desc: t("companyCode", { code: company.slug }),
      aliases: [company.slug],
      render: (s) => this.addDisconnect(s, company),
    }));
    items.push({
      name: connected.length ? t("addCompany") : t("company"),
      desc: t("companyCodeDesc"),
      aliases: [t("connect"), t("companyCodePlaceholder")],
      render: (s) => this.renderConnect(s, companies, connected.length),
    });
    return items;
  }

  private renderConnect(setting: Setting, companies: Company[], connectedCount: number): void {
    const { plugin } = this;
    const { settings, client } = plugin;
    const showDesc = (text: string, error = false): void => {
      setting.descEl.setText(text);
      setting.descEl.toggleClass("silk-hub-error", error);
    };
    let input!: TextComponent;
    let button!: ButtonComponent;
    const connect = async (): Promise<void> => {
      const code = input.getValue().trim();
      if (!code) return showDesc(t("companyCodeDesc"), true);
      button.setDisabled(true);
      try {
        const company = await client.lookupCompany(code);
        if (!company) return showDesc(t("companyNotFound", { code, email: settings.accountEmail ?? "" }), true);
        if (settings.companyIds.includes(company.id)) return showDesc(t("companyAlreadyConnected", { name: company.name }), true);
        settings.companyIds = [...settings.companyIds, company.id];
        await plugin.saveSettings();
        new Notice(t("companyAdded", { name: company.name }));
        this.refresh();
      } catch (err) {
        showDesc(t("loadFailed", { error: (err as Error).message }), true);
      } finally {
        button.setDisabled(false);
      }
    };
    // With a single company the code is suggested, but the user connects explicitly (and can disconnect).
    const suggested = connectedCount === 0 && companies.length === 1 ? companies[0].slug : "";
    setting
      .addText((text) => {
        input = text;
        text.setPlaceholder(t("companyCodePlaceholder")).setValue(suggested);
        text.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") void connect();
        });
      })
      .addButton((b) => {
        button = b;
        b.setButtonText(t("connect")).onClick(() => void connect());
        if (connectedCount === 0) b.setCta();
      });
  }

  /**
   * Disconnects the vault from a company, confirmed on the button itself like uninstalling a plugin.
   * Installed plugins stay; plugins no other connected company offers stop getting updates.
   */
  private addDisconnect(setting: Setting, company: Company): () => void {
    const { plugin } = this;
    const { settings } = plugin;
    let armed = false;
    let timer: number | null = null;
    setting.addButton((b) =>
      b.setButtonText(t("disconnect")).onClick(async () => {
        if (!armed) {
          armed = true;
          b.setButtonText(t("disconnectConfirm")).setDestructive();
          timer = window.setTimeout(() => {
            armed = false;
            b.buttonEl.removeClass("mod-warning", "mod-destructive");
            b.setButtonText(t("disconnect"));
          }, 4000);
          return;
        }
        if (timer !== null) window.clearTimeout(timer);
        b.setDisabled(true);
        const rest = settings.companyIds.filter((id) => id !== company.id);
        try {
          const offered = new Set((await plugin.client.catalog(rest)).map((p) => p.id));
          settings.selected = settings.selected.filter((id) => offered.has(id));
        } catch {
          if (rest.length === 0) settings.selected = [];
        }
        settings.companyIds = rest;
        if (rest.length === 0) settings.skipped = {};
        await plugin.saveSettings();
        plugin.updates.reset();
        new Notice(t("disconnected", { name: company.name }));
        this.refresh();
      }),
    );
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }

  /**
   * Company plugins with the group's own search. Each row updates itself after an action,
   * so installing or switching a plugin doesn't redraw the page.
   */
  private pluginsGroup(catalog: CatalogPlugin[], companies: Company[], installed: Record<string, string>): SettingDefinitionItem {
    const { plugin } = this;
    const several = plugin.settings.companyIds.length > 1;
    return {
      type: "group",
      heading: t("plugins"),
      cls: "silk-hub-plugins",
      search:
        catalog.length > 1
          ? {
              placeholder: t("searchPlugins"),
              match: (def, query) => {
                const q = query.toLowerCase().trim();
                return [def.name, ...(def.aliases ?? [])].some((text) => text.toLowerCase().includes(q));
              },
            }
          : undefined,
      extraButtons: [(b) => b.setIcon("refresh-cw").setTooltip(t("refresh")).onClick(() => this.refresh())],
      items:
        catalog.length === 0
          ? [{ name: t("noPlugins"), searchable: false }]
          : catalog.map((p) => {
              // With several companies connected, each plugin says which of them offer it.
              const companyNames = several ? companies.filter((c) => p.companies.includes(c.id)).map((c) => c.name) : [];
              return {
                name: p.name,
                aliases: [p.id, p.description],
                render: (s: Setting) => void new PluginRow(plugin, s, p, installed, companyNames),
              };
            }),
    };
  }
}

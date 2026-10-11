import { App, ButtonComponent, Notice, PluginSettingTab, Setting, SettingGroup, TextComponent } from "obsidian";
import { NotSignedInError } from "../api/HubClient";
import { t } from "../i18n";
import type SilkPluginsHub from "../main";
import type { CatalogPlugin, Company } from "../settings";
import { PluginRow } from "./PluginRow";

/** Renders "text with **bold**" without innerHTML. */
function appendWithBold(parent: HTMLElement, text: string): void {
  text.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
    if (part.startsWith("**") && part.endsWith("**")) parent.createEl("strong", { text: part.slice(2, -2) });
    else if (part) parent.appendText(part);
  });
}

export class HubSettingTab extends PluginSettingTab {
  private renderId = 0;

  constructor(
    app: App,
    private plugin: SilkPluginsHub,
  ) {
    super(app, plugin);
  }

  display(): void {
    void this.render();
  }

  /**
   * Company plugins as a group with search, like BRAT. Each row updates itself after an action,
   * so installing or switching a plugin doesn't redraw the page.
   */
  private async renderPlugins(el: HTMLElement, catalog: CatalogPlugin[], companies: Company[]): Promise<void> {
    const { plugin } = this;
    const rows: { row: PluginRow; name: string }[] = [];
    const group = new SettingGroup(el).setHeading(t("plugins"));
    group.addClass("silk-hub-plugins");
    if (catalog.length > 1) {
      group.addSearch((search) =>
        search.setPlaceholder(t("searchPlugins")).onChange((value) => {
          const q = value.toLowerCase().trim();
          for (const { row, name } of rows) row.element.toggle(q === "" || name.includes(q));
        }),
      );
    }
    group.addExtraButton((b) =>
      b
        .setIcon("refresh-cw")
        .setTooltip(t("refresh"))
        .onClick(async () => {
          const fresh = await plugin.client.catalog(plugin.settings.companyIds);
          el.empty();
          await this.renderPlugins(el, fresh, companies);
        }),
    );
    if (catalog.length === 0) {
      group.addSetting((setting) => setting.setDesc(t("noPlugins")));
      return;
    }
    const installed = await plugin.installer.installedVersions(catalog.map((p) => p.id));
    for (const p of catalog) {
      // With several companies connected, each plugin says which of them offer it.
      const companyNames =
        plugin.settings.companyIds.length > 1 ? companies.filter((c) => p.companies.includes(c.id)).map((c) => c.name) : [];
      group.addSetting((setting) =>
        rows.push({ row: new PluginRow(plugin, setting, p, installed[p.id] ?? null, companyNames), name: p.name.toLowerCase() }),
      );
    }
  }

  /**
   * Connected companies, each with Disconnect, and a field to add one more by its code (or name).
   * Plugin lists of all connected companies are merged.
   */
  private renderCompanies(containerEl: HTMLElement, companies: Company[]): void {
    const { plugin } = this;
    const { settings, client } = plugin;
    new Setting(containerEl).setName(t("companies")).setHeading();
    const connected = companies.filter((c) => settings.companyIds.includes(c.id));
    for (const company of connected) {
      const setting = new Setting(containerEl).setName(company.name).setDesc(t("companyCode", { code: company.slug }));
      this.addDisconnect(setting, company);
    }

    const setting = new Setting(containerEl).setName(connected.length ? t("addCompany") : t("company"));
    const showDesc = (text: string, error = false) => {
      setting.descEl.setText(text);
      setting.descEl.toggleClass("silk-hub-error", error);
    };
    showDesc(t("companyCodeDesc"));

    let input!: TextComponent;
    let button!: ButtonComponent;
    const connect = async () => {
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
        void this.render();
      } catch (err) {
        showDesc(t("loadFailed", { error: (err as Error).message }), true);
      } finally {
        button.setDisabled(false);
      }
    };
    // With a single company the code is suggested, but the user connects explicitly (and can disconnect).
    const suggested = connected.length === 0 && companies.length === 1 ? companies[0].slug : "";
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
        if (connected.length === 0) b.setCta();
      });
  }

  /**
   * Disconnects the vault from a company, confirmed on the button itself like uninstalling a plugin.
   * Installed plugins stay; plugins no other connected company offers stop getting updates.
   */
  private addDisconnect(setting: Setting, company: Company): void {
    const { plugin } = this;
    const { settings } = plugin;
    let armed = false;
    let timer: number | null = null;
    setting.addButton((b) =>
      b.setButtonText(t("disconnect")).onClick(async () => {
        if (!armed) {
          armed = true;
          b.setButtonText(t("disconnectConfirm")).setWarning();
          timer = window.setTimeout(() => {
            armed = false;
            b.buttonEl.removeClass("mod-warning");
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
        void this.render();
      }),
    );
  }

  private renderGuide(containerEl: HTMLElement, open: boolean): void {
    const details = containerEl.createEl("details", { cls: "silk-hub-guide" });
    details.open = open;
    details.createEl("summary", { text: t("guideTitle") });
    const list = details.createEl("ol");
    for (const step of t("guideSteps").split("|")) appendWithBold(list.createEl("li"), step);
  }

  /**
   * Builds the page off-screen and swaps it in at once, keeping the scroll position,
   * so a re-render (also when Obsidian refreshes its plugin settings) doesn't flicker or jump.
   */
  async render(): Promise<void> {
    const renderId = ++this.renderId;
    const root = createDiv();
    await this.build(root, renderId);
    if (renderId !== this.renderId) return;
    const scrollTop = this.containerEl.scrollTop;
    this.containerEl.empty();
    this.containerEl.appendChild(root);
    this.containerEl.scrollTop = scrollTop;
  }

  private async build(containerEl: HTMLElement, renderId: number): Promise<void> {
    const { plugin } = this;
    const { settings, client } = plugin;
    this.renderGuide(containerEl, !client.signedIn || settings.companyIds.length === 0);

    new Setting(containerEl)
      .setName(t("serverUrl"))
      .setDesc(t("serverUrlDesc"))
      .addText((text) =>
        text
          .setPlaceholder("https://hub.example.com")
          .setValue(settings.serverUrl)
          .onChange(async (value) => {
            settings.serverUrl = value.trim();
            await plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName(t("account")).setHeading();

    if (!client.signedIn) {
      new Setting(containerEl)
        .setName(t("signIn"))
        .setDesc(t("signInDesc"))
        .addButton((button) =>
          button
            .setButtonText(t("signIn"))
            .setCta()
            .setDisabled(!settings.serverUrl)
            .onClick(() => void plugin.startSignIn()),
        );
      return;
    }

    new Setting(containerEl)
      .setName(t("signedInAs", { email: settings.accountEmail ?? "" }))
      .addButton((button) =>
        button.setButtonText(t("signOut")).onClick(async () => {
          await plugin.signOut();
          void this.render();
        }),
      );

    let companies: Company[];
    let catalog: CatalogPlugin[] = [];
    try {
      const me = await client.me();
      companies = me.companies;
      // Drop companies the user was removed from.
      const ids = settings.companyIds.filter((id) => companies.some((c) => c.id === id));
      if (ids.length !== settings.companyIds.length) {
        settings.companyIds = ids;
        await plugin.saveSettings();
      }
      catalog = await client.catalog(settings.companyIds);
    } catch (err) {
      if (renderId !== this.renderId) return;
      if (err instanceof NotSignedInError) return void this.render();
      containerEl.createEl("p", { cls: "silk-hub-error", text: t("loadFailed", { error: (err as Error).message }) });
      return;
    }
    if (renderId !== this.renderId) return;

    if (companies.length === 0) {
      containerEl.createEl("p", { cls: "silk-hub-muted", text: t("noCompanies", { email: settings.accountEmail ?? "" }) });
      return;
    }

    this.renderCompanies(containerEl, companies);

    if (settings.companyIds.length === 0) return;

    const pluginsEl = containerEl.createDiv();
    await this.renderPlugins(pluginsEl, catalog, companies);
    if (renderId !== this.renderId) return;

    new Setting(containerEl).setName(t("updates")).setHeading();
    new Setting(containerEl)
      .setName(t("autoUpdate"))
      .setDesc(t("autoUpdateDesc"))
      .addToggle((toggle) =>
        toggle.setValue(settings.autoUpdate).onChange(async (value) => {
          settings.autoUpdate = value;
          await plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName(t("checkInterval"))
      .setDesc(t("checkIntervalDesc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("0", t("never"));
        for (const n of [1, 3, 6, 12, 24]) dropdown.addOption(String(n), t("hours", { n }));
        dropdown.setValue(String(settings.checkIntervalHours)).onChange(async (value) => {
          settings.checkIntervalHours = Number(value);
          await plugin.saveSettings();
          plugin.scheduleChecks();
        });
      });
    new Setting(containerEl)
      .addButton((button) => button.setButtonText(t("openChangelog")).onClick(() => void plugin.openChangelog()))
      .addButton((button) =>
        button.setButtonText(t("checkNow")).onClick(async () => {
          if (!settings.serverUrl) return void new Notice(t("noServer"));
          await plugin.updates.check(true);
        }),
      );
  }
}

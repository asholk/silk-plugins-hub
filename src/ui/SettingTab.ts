import { App, Notice, PluginSettingTab, Setting, SettingGroup } from "obsidian";
import { NotSignedInError } from "../api/HubClient";
import { t } from "../i18n";
import type CorporatePluginHub from "../main";
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
    private plugin: CorporatePluginHub,
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
  private async renderPlugins(el: HTMLElement, catalog: CatalogPlugin[]): Promise<void> {
    const { plugin } = this;
    const rows: { row: PluginRow; name: string }[] = [];
    const group = new SettingGroup(el).setHeading(t("plugins"));
    group.addClass("corp-hub-plugins");
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
          if (plugin.settings.companyId === null) return;
          const fresh = await plugin.client.catalog(plugin.settings.companyId);
          el.empty();
          await this.renderPlugins(el, fresh);
        }),
    );
    if (catalog.length === 0) {
      group.addSetting((setting) => setting.setDesc(t("noPlugins")));
      return;
    }
    const installed = await plugin.installer.installedVersions(catalog.map((p) => p.id));
    for (const p of catalog) {
      group.addSetting((setting) => rows.push({ row: new PluginRow(plugin, setting, p, installed[p.id] ?? null), name: p.name.toLowerCase() }));
    }
  }

  private renderGuide(containerEl: HTMLElement, open: boolean): void {
    const details = containerEl.createEl("details", { cls: "corp-hub-guide" });
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
    this.renderGuide(containerEl, !client.signedIn || settings.companyId === null);

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
      if (settings.companyId !== null && !companies.some((c) => c.id === settings.companyId)) settings.companyId = null;
      if (settings.companyId === null && companies.length === 1) {
        settings.companyId = companies[0].id;
        await plugin.saveSettings();
      }
      if (settings.companyId !== null) catalog = await client.catalog(settings.companyId);
    } catch (err) {
      if (renderId !== this.renderId) return;
      if (err instanceof NotSignedInError) return void this.render();
      containerEl.createEl("p", { cls: "corp-hub-error", text: t("loadFailed", { error: (err as Error).message }) });
      return;
    }
    if (renderId !== this.renderId) return;

    if (companies.length === 0) {
      containerEl.createEl("p", { cls: "corp-hub-muted", text: t("noCompanies", { email: settings.accountEmail ?? "" }) });
      return;
    }

    new Setting(containerEl)
      .setName(t("company"))
      .setDesc(t("companyDesc"))
      .addDropdown((dropdown) => {
        if (settings.companyId === null) dropdown.addOption("", t("chooseCompany"));
        companies.forEach((c) => dropdown.addOption(String(c.id), c.name));
        dropdown.setValue(settings.companyId === null ? "" : String(settings.companyId)).onChange(async (value) => {
          settings.companyId = value ? Number(value) : null;
          settings.selected = [];
          await plugin.saveSettings();
          void this.render();
        });
      });

    if (settings.companyId === null) return;

    const pluginsEl = containerEl.createDiv();
    await this.renderPlugins(pluginsEl, catalog);
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

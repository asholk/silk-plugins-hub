import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { NotSignedInError } from "../api/HubClient";
import { t } from "../i18n";
import type CorporatePluginHub from "../main";
import type { CatalogPlugin, Company } from "../settings";
import { isPluginEnabled, setPluginEnabled } from "../install/communityPlugins";
import { compareVersions } from "./changes";
import { confirm } from "./ConfirmModal";
import { DocModal } from "./DocModal";

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
   * One catalog plugin: not installed → Install; installed → Update (when newer), Uninstall and an on/off switch.
   * Details and Instructions open the plugin card and guide.
   */
  private renderPlugin(containerEl: HTMLElement, p: CatalogPlugin, installed: string | null): void {
    const { plugin } = this;
    const latest = p.latest?.version ?? null;
    const hasUpdate = !!installed && !!latest && compareVersions(latest, installed) > 0;
    const meta = [
      installed ? t("installed", { version: installed }) : t("notInstalled"),
      latest ? t("latest", { version: latest }) : t("notReleased"),
      p.required ? t("required") : null,
    ].filter(Boolean);

    const setting = new Setting(containerEl).setName(p.name).setDesc(p.description);
    setting.settingEl.addClass("corp-hub-plugin-row");
    if (p.instructions) setting.descEl.createDiv({ cls: "corp-hub-instructions", text: t("howToStart", { text: p.instructions }) });
    setting.descEl.createDiv({ cls: "corp-hub-muted", text: meta.join(" · ") });

    if (p.hasCard) {
      setting.addExtraButton((b) =>
        b.setIcon("info").setTooltip(t("details")).onClick(() => new DocModal(this.app, plugin.client, p.id, p.name, "card").open()),
      );
    }
    if (p.hasGuide) {
      setting.addExtraButton((b) =>
        b.setIcon("book-open").setTooltip(t("guide")).onClick(() => new DocModal(this.app, plugin.client, p.id, p.name, "guide").open()),
      );
    }

    const run = async (action: () => Promise<unknown>) => {
      setting.settingEl.addClass("is-busy");
      await action();
      void this.render();
    };

    if (!installed) {
      if (latest) {
        setting.addButton((b) => b.setButtonText(t("install")).setCta().onClick(() => run(() => plugin.updates.installOne(p.id))));
      }
      return;
    }
    if (hasUpdate) {
      setting.addButton((b) =>
        b.setButtonText(t("update", { version: latest ?? "" })).setCta().onClick(() => run(() => plugin.updates.installOne(p.id))),
      );
    }
    if (!p.required) {
      setting.addExtraButton((b) =>
        b
          .setIcon("trash-2")
          .setTooltip(t("uninstall"))
          .onClick(async () => {
            if (await confirm(this.app, t("uninstallConfirm", { name: p.name }), t("uninstall"))) {
              await run(() => plugin.updates.uninstall(p.id, p.name));
            }
          }),
      );
    }
    setting.addToggle((toggle) =>
      toggle
        .setTooltip(t("enabled"))
        .setValue(isPluginEnabled(this.app, p.id))
        .onChange((value) => void run(() => setPluginEnabled(this.app, p.id, value))),
    );
  }

  private renderGuide(containerEl: HTMLElement, open: boolean): void {
    const details = containerEl.createEl("details", { cls: "corp-hub-guide" });
    details.open = open;
    details.createEl("summary", { text: t("guideTitle") });
    const list = details.createEl("ol");
    for (const step of t("guideSteps").split("|")) appendWithBold(list.createEl("li"), step);
  }

  async render(): Promise<void> {
    const renderId = ++this.renderId;
    const { containerEl, plugin } = this;
    const { settings, client } = plugin;
    containerEl.empty();
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

    new Setting(containerEl).setName(t("plugins")).setHeading();
    if (catalog.length === 0) {
      containerEl.createEl("p", { cls: "corp-hub-muted", text: t("noPlugins") });
    }
    for (const p of catalog) {
      const installed = await plugin.installer.installedVersion(p.id);
      if (renderId !== this.renderId) return;
      this.renderPlugin(containerEl, p, installed);
    }

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

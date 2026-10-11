import { ButtonComponent, Setting } from "obsidian";
import { t } from "../i18n";
import { isPluginEnabled, setPluginEnabled } from "../install/communityPlugins";
import type SilkPluginsHub from "../main";
import type { CatalogPlugin } from "../settings";
import { compareVersions } from "./changes";
import { GuideModal } from "./GuideModal";
import { PluginInfoModal } from "./PluginInfoModal";

const CONFIRM_TIMEOUT_MS = 4000;

/**
 * One plugin in the settings list. Actions update only this row, so the settings page doesn't jump:
 * not installed → Install; installed → Update (if newer), Uninstall (confirm on the button) and an on/off switch.
 */
export class PluginRow {
  private installed: string | null;
  private busyText: string | null = null;

  constructor(
    private plugin: SilkPluginsHub,
    private setting: Setting,
    private p: CatalogPlugin,
    installed: string | null,
    /** Names of the companies offering the plugin; shown when the vault is connected to several. */
    private companyNames: string[] = [],
  ) {
    this.installed = installed;
    setting.settingEl.addClass("silk-hub-plugin-row");
    setting.setName(p.name);
    this.render();
  }

  get element(): HTMLElement {
    return this.setting.settingEl;
  }

  private get latest(): string | null {
    return this.p.latest?.version ?? null;
  }

  private render(): void {
    this.renderDesc();
    this.renderControls();
  }

  private renderDesc(): void {
    const { descEl } = this.setting;
    descEl.empty();
    if (this.p.description) descEl.createDiv({ text: this.p.description });
    if (this.p.instructions) descEl.createDiv({ cls: "silk-hub-instructions", text: t("howToStart", { text: this.p.instructions }) });
    const meta = descEl.createDiv({ cls: "silk-hub-plugin-meta" });
    meta.createSpan({
      cls: this.installed ? "silk-hub-chip mod-installed" : "silk-hub-chip",
      text: this.installed ? t("installed", { version: this.installed }) : t("notInstalled"),
    });
    if (this.latest && this.installed !== this.latest) meta.createSpan({ cls: "silk-hub-chip", text: t("latest", { version: this.latest }) });
    if (!this.latest) meta.createSpan({ cls: "silk-hub-chip", text: t("notReleased") });
    if (this.p.required) meta.createSpan({ cls: "silk-hub-chip mod-required", text: t("required") });
    if (this.companyNames.length > 0) meta.createSpan({ cls: "silk-hub-chip mod-company", text: this.companyNames.join(", ") });
  }

  private renderControls(): void {
    const { setting, p, plugin } = this;
    setting.controlEl.empty();

    if (p.hasCard || p.description) {
      setting.addExtraButton((b) =>
        b.setIcon("info").setTooltip(t("details")).onClick(() => new PluginInfoModal(plugin, p, this.installed).open()),
      );
    }
    if (p.hasGuide) {
      setting.addExtraButton((b) => b.setIcon("book-open").setTooltip(t("guide")).onClick(() => new GuideModal(plugin, p).open()));
    }

    if (this.busyText) {
      setting.addButton((b) => b.setButtonText(this.busyText ?? "").setDisabled(true));
      return;
    }

    if (!this.installed) {
      if (this.latest) setting.addButton((b) => b.setButtonText(t("install")).setCta().onClick(() => void this.install()));
      return;
    }
    if (this.latest && compareVersions(this.latest, this.installed) > 0) {
      setting.addButton((b) => b.setButtonText(t("update", { version: this.latest ?? "" })).setCta().onClick(() => void this.install()));
    }
    if (!p.required) setting.addButton((b) => this.uninstallButton(b));
    setting.addToggle((toggle) =>
      toggle
        .setTooltip(t("enabled"))
        .setValue(isPluginEnabled(plugin.app, p.id))
        .onChange(async (value) => {
          toggle.setDisabled(true);
          await setPluginEnabled(plugin.app, p.id, value);
          toggle.setDisabled(false);
        }),
    );
  }

  /** Trash icon; the first press turns it into "Uninstall?", the second one uninstalls. */
  private uninstallButton(b: ButtonComponent): void {
    let armed = false;
    let timer: number | null = null;
    b.setIcon("trash-2")
      .setTooltip(t("uninstall"))
      .onClick(async () => {
        if (!armed) {
          armed = true;
          b.setButtonText(t("uninstallConfirmShort")).setDestructive();
          timer = window.setTimeout(() => {
            armed = false;
            b.buttonEl.removeClass("mod-warning");
            b.setIcon("trash-2");
          }, CONFIRM_TIMEOUT_MS);
          return;
        }
        if (timer !== null) window.clearTimeout(timer);
        await this.busy(t("uninstalling"), async () => {
          await this.plugin.updates.uninstall(this.p.id, this.p.name);
          this.installed = null;
        });
      });
  }

  private async install(): Promise<void> {
    await this.busy(this.installed ? t("updating") : t("installingShort"), async () => {
      await this.plugin.updates.installOne(this.p.id);
      this.installed = await this.plugin.installer.installedVersion(this.p.id);
    });
  }

  private async busy(text: string, action: () => Promise<void>): Promise<void> {
    this.busyText = text;
    this.renderControls();
    try {
      await action();
    } finally {
      this.busyText = null;
      this.render();
    }
  }
}

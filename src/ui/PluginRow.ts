import { ButtonComponent, Notice, Platform, Setting } from "obsidian";
import { t } from "../i18n";
import { EnableError, isPluginEnabled, setPluginEnabled } from "../install/communityPlugins";
import type SilkPluginsHub from "../main";
import type { CatalogPlugin } from "../settings";
import { compareVersions } from "./changes";
import { GuideModal } from "./GuideModal";
import { PluginInfoModal } from "./PluginInfoModal";

const CONFIRM_TIMEOUT_MS = 4000;

/** "1.4 MB" or "180 KB". */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return t("sizeMb", { n: (bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "") });
  return t("sizeKb", { n: Math.max(1, Math.round(bytes / 1024)) });
}

/**
 * One plugin in the settings list. Actions update only this row, so the settings page doesn't jump:
 * not installed → Install; installed → Update (if newer), Uninstall (confirm on the button) and an on/off switch.
 * Actions go through the plugin's OperationQueue; while one is queued or running, the row shows its state
 * instead of the controls. A row drawn again mid-operation picks the state up from the queue.
 */
export class PluginRow {
  private unsubscribe: () => void;
  private confirmTimer: number | null = null;

  constructor(
    private plugin: SilkPluginsHub,
    private setting: Setting,
    private p: CatalogPlugin,
    /** Installed versions by plugin id, shared by all rows of the page and kept up to date by them. */
    private installed: Record<string, string>,
    /** Names of the companies offering the plugin; shown when the vault is connected to several. */
    private companyNames: string[] = [],
  ) {
    setting.settingEl.addClass("silk-hub-plugin-row");
    setting.setName(p.name);
    this.unsubscribe = plugin.queue.onChange(() => this.onQueueChange());
    this.render();
  }

  get element(): HTMLElement {
    return this.setting.settingEl;
  }

  private get version(): string | null {
    return this.installed[this.p.id] ?? null;
  }

  private get latest(): string | null {
    return this.p.latest?.version ?? null;
  }

  /** Desktop-only plugin on a phone: shown, but not installable here. */
  private get unavailable(): boolean {
    return !!this.p.latest?.desktopOnly && !Platform.isDesktopApp;
  }

  private shownOperation = "";

  /** Shown from the click until the operation reaches the queue (Install first asks the server what to download). */
  private starting: string | null = null;

  private onQueueChange(): void {
    // The page was redrawn or closed and this row is gone: stop listening.
    if (!this.setting.settingEl.isConnected) {
      this.unsubscribe();
      return;
    }
    const op = this.plugin.queue.get(this.p.id);
    const key = op ? `${op.running}:${op.label}` : "";
    if (key !== this.shownOperation) this.renderControls();
  }

  private render(): void {
    this.renderDesc();
    this.renderControls();
  }

  private renderDesc(): void {
    const { descEl } = this.setting;
    const version = this.version;
    descEl.empty();
    if (this.p.description) descEl.createDiv({ text: this.p.description });
    if (this.p.instructions) descEl.createDiv({ cls: "silk-hub-instructions", text: t("howToStart", { text: this.p.instructions }) });
    const meta = descEl.createDiv({ cls: "silk-hub-plugin-meta" });
    meta.createSpan({
      cls: version ? "silk-hub-chip mod-installed" : "silk-hub-chip",
      text: version ? t("installed", { version }) : t("notInstalled"),
    });
    if (this.latest && version !== this.latest) meta.createSpan({ cls: "silk-hub-chip", text: t("latest", { version: this.latest }) });
    if (!this.latest) meta.createSpan({ cls: "silk-hub-chip", text: t("notReleased") });
    if (this.p.latest?.size) meta.createSpan({ cls: "silk-hub-chip", text: formatSize(this.p.latest.size) });
    if (this.p.latest?.desktopOnly) meta.createSpan({ cls: "silk-hub-chip mod-desktop", text: t("desktopOnly") });
    if (this.p.required) meta.createSpan({ cls: "silk-hub-chip mod-required", text: t("required") });
    if (this.companyNames.length > 0) meta.createSpan({ cls: "silk-hub-chip mod-company", text: this.companyNames.join(", ") });
  }

  private renderControls(): void {
    const { setting, p, plugin } = this;
    const version = this.version;
    setting.controlEl.empty();
    if (this.confirmTimer !== null) window.clearTimeout(this.confirmTimer);
    this.confirmTimer = null;

    if (p.hasCard || p.description) {
      setting.addExtraButton((b) =>
        b.setIcon("info").setTooltip(t("details")).onClick(() => new PluginInfoModal(plugin, p, version).open()),
      );
    }
    if (p.hasGuide) {
      setting.addExtraButton((b) => b.setIcon("book-open").setTooltip(t("guide")).onClick(() => new GuideModal(plugin, p).open()));
    }

    const op = plugin.queue.get(p.id);
    this.shownOperation = op ? `${op.running}:${op.label}` : "";
    const busy = op ? (op.running ? op.label : t("queued")) : this.starting;
    if (busy) {
      setting.addButton((b) => b.setButtonText(busy).setDisabled(true));
      return;
    }

    if (!version) {
      if (this.latest && !this.unavailable) {
        setting.addButton((b) => b.setButtonText(t("install")).setCta().onClick(() => void this.install()));
      }
      return;
    }
    if (this.latest && compareVersions(this.latest, version) > 0 && !this.unavailable) {
      setting.addButton((b) => b.setButtonText(t("update", { version: this.latest ?? "" })).setCta().onClick(() => void this.install()));
    }
    if (!p.required) setting.addButton((b) => this.uninstallButton(b));
    setting.addToggle((toggle) =>
      toggle
        .setTooltip(t("enabled"))
        .setValue(isPluginEnabled(plugin.app, p.id))
        .onChange((value) => void this.setEnabled(value)),
    );
  }

  /** Trash icon; the first press turns it into "Uninstall?", the second one uninstalls. */
  private uninstallButton(b: ButtonComponent): void {
    let armed = false;
    b.setIcon("trash-2")
      .setTooltip(t("uninstall"))
      .onClick(() => {
        if (!armed) {
          armed = true;
          b.setButtonText(t("uninstallConfirmShort")).setDestructive();
          this.confirmTimer = window.setTimeout(() => {
            armed = false;
            this.confirmTimer = null;
            b.buttonEl.removeClass("mod-warning", "mod-destructive");
            b.setIcon("trash-2");
          }, CONFIRM_TIMEOUT_MS);
          return;
        }
        void this.act(async () => {
          await this.plugin.updates.uninstall(this.p.id, this.p.name);
          delete this.installed[this.p.id];
        });
      });
  }

  private async install(): Promise<void> {
    this.starting = this.version ? t("updating") : t("installingShort");
    this.renderControls();
    await this.act(async () => {
      await this.plugin.updates.installOne(this.p.id);
      const version = await this.plugin.installer.installedVersion(this.p.id);
      if (version) this.installed[this.p.id] = version;
      else delete this.installed[this.p.id];
    });
  }

  private async setEnabled(value: boolean): Promise<void> {
    const { plugin, p } = this;
    await this.act(() =>
      plugin.queue.run(p.id, value ? t("enabling") : t("disabling"), () => setPluginEnabled(plugin.app, p.id, value)),
    );
  }

  /** Runs an action; whatever happens, the row is drawn again from the actual state. */
  private async act(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      if (err instanceof EnableError) new Notice(t("enableFailed", { name: this.p.name }), 10000);
      else new Notice(t("actionFailed", { name: this.p.name, error: (err as Error).message }), 10000);
    } finally {
      this.starting = null;
      this.render();
    }
  }
}

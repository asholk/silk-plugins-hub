import { Notice, Platform } from "obsidian";
import { uninstallPlugin } from "../install/communityPlugins";
import { IncompatibleError } from "../install/Installer";
import { NotSignedInError } from "../api/HubClient";
import { t } from "../i18n";
import { devLog } from "../devLog";
import type SilkPluginsHub from "../main";
import type { PluginUpdate } from "../settings";
import { UpdatesModal } from "../ui/UpdatesModal";

/** Checks the server for updates and applies them, automatically or after confirmation. */
export class UpdateService {
  private running = false;
  /** Updates found by the last check that are still waiting for the user. */
  pending: PluginUpdate[] = [];
  /** New plugins from the last apply() that installed but didn't start. */
  private notStarted = new Set<string>();

  constructor(private plugin: SilkPluginsHub) {}

  /**
   * @param interactive true when the user asked for the check: always report the result and show the dialog.
   */
  async check(interactive: boolean): Promise<void> {
    const { settings, client, installer } = this.plugin;
    if (!client.serverUrl) {
      if (interactive) new Notice(t("noServer"));
      return;
    }
    if (!client.signedIn || settings.companyIds.length === 0 || this.running) {
      if (interactive && !this.running) this.plugin.openSettings();
      return;
    }
    this.running = true;
    devLog.log(`update check started, interactive ${interactive}`);
    try {
      const catalog = await client.catalog(settings.companyIds);
      const candidates = new Set([...settings.selected, ...catalog.filter((p) => p.required).map((p) => p.id)]);
      const installed = await installer.installedVersions(candidates);
      const result = await client.checkUpdates(settings.companyIds, settings.selected, installed);

      if (result.removed.length > 0) {
        settings.selected = settings.selected.filter((id) => !result.removed.includes(id));
        await this.plugin.saveSettings();
        new Notice(t("removedFromCompany", { list: result.removed.join(", ") }), 15000);
      }

      const updates = result.updates.filter(
        (u) =>
          installer.manages(u.id) &&
          // Desktop-only plugins aren't offered on a phone, not even as updates.
          !(u.desktopOnly && !Platform.isDesktopApp) &&
          (interactive || u.reason === "revoked" || settings.skipped[u.id] !== u.version),
      );
      this.setPending(updates);
      if (updates.length === 0) {
        if (interactive) new Notice(t("upToDate"));
        return;
      }

      if (settings.autoUpdate && !interactive) {
        // New required plugins the user hasn't chosen still need confirmation.
        const auto = updates.filter((u) => u.reason !== "install" || settings.selected.includes(u.id));
        const applied = await this.apply(auto);
        if (applied.length > 0) this.notifyApplied(applied);
        const rest = updates.filter((u) => !auto.includes(u));
        this.setPending(rest.concat(auto.filter((u) => !applied.includes(u))));
        if (rest.length > 0) this.notifyAvailable();
        return;
      }

      if (interactive) this.openModal();
      else this.notifyAvailable();
    } catch (err) {
      if (err instanceof NotSignedInError) {
        if (interactive) this.plugin.openSettings();
        return;
      }
      console.error("Silk Hub: update check failed", err);
      if (interactive) new Notice(t("loadFailed", { error: (err as Error).message }));
    } finally {
      this.running = false;
    }
  }

  /**
   * Installs updates one by one through the queue. Returns the ones whose files are in place;
   * a new plugin that installed but didn't start is reported and still counts as installed.
   */
  async apply(updates: PluginUpdate[]): Promise<PluginUpdate[]> {
    const { plugin } = this;
    const applied: PluginUpdate[] = [];
    this.notStarted.clear();
    for (const update of updates) {
      const label = update.installedVersion ? t("updating") : t("installingShort");
      try {
        const result = await plugin.queue.run(update.id, label, async () => {
          const progress = new Notice(t("installing", { name: update.name }), 0);
          try {
            return await devLog.step(`install ${update.id} ${update.installedVersion ?? "-"} → ${update.version}`, () =>
              plugin.installer.install(update, { enable: plugin.enableAfterInstall }),
            );
          } finally {
            progress.hide();
          }
        });
        applied.push(update);
        delete plugin.settings.skipped[update.id];
        if (!update.installedVersion && plugin.enableAfterInstall && !result.enabled) {
          this.notStarted.add(update.id);
          new Notice(t("installedNotStarted", { name: update.name }), 10000);
        }
      } catch (err) {
        if (!(err instanceof IncompatibleError)) console.error(`Silk Hub: failed to install ${update.id}`, err);
        new Notice(t("installFailed", { name: update.name, error: (err as Error).message }), 10000);
      }
    }
    await this.plugin.saveSettings();
    this.setPending(this.pending.filter((p) => !applied.includes(p)));
    return applied;
  }

  /** Installs or updates one plugin from the catalog right away. Returns true on success. */
  async installOne(pluginId: string): Promise<boolean> {
    const { settings, client, installer } = this.plugin;
    if (settings.companyIds.length === 0) return false;
    try {
      const installed = await installer.installedVersions([pluginId]);
      const result = await devLog.step(`check updates for ${pluginId}`, () =>
        client.checkUpdates(settings.companyIds, [pluginId], installed),
      );
      const update = result.updates.find((u) => u.id === pluginId);
      if (!update) {
        new Notice(t("upToDate"));
        return false;
      }
      if (!settings.selected.includes(pluginId)) settings.selected.push(pluginId);
      const applied = await this.apply([update]);
      if (applied.length === 0) return false;
      // A plugin that didn't start was already reported by apply().
      if (this.notStarted.has(pluginId)) return true;
      const vars = { name: update.name, version: update.version };
      new Notice(
        update.installedVersion
          ? t("updatedOne", vars)
          : this.plugin.enableAfterInstall
            ? t("installedOne", vars)
            : t("installedOff", vars),
      );
      return true;
    } catch (err) {
      new Notice(t("loadFailed", { error: (err as Error).message }));
      return false;
    }
  }

  /** Removes the plugin from the vault and stops offering it to this vault. */
  async uninstall(pluginId: string, name: string): Promise<void> {
    const { settings } = this.plugin;
    await this.plugin.queue.run(pluginId, t("uninstalling"), () => uninstallPlugin(this.plugin.app, pluginId));
    settings.selected = settings.selected.filter((id) => id !== pluginId);
    delete settings.skipped[pluginId];
    await this.plugin.saveSettings();
    this.setPending(this.pending.filter((u) => u.id !== pluginId));
    new Notice(t("uninstalled", { name }));
  }

  async skip(update: PluginUpdate): Promise<void> {
    this.plugin.settings.skipped[update.id] = update.version;
    await this.plugin.saveSettings();
    this.setPending(this.pending.filter((p) => p !== update));
  }

  openModal(): void {
    if (this.pending.length > 0) new UpdatesModal(this.plugin.app, this, this.pending).open();
  }

  /** Forgets pending updates, e.g. after the vault is disconnected from the company. */
  reset(): void {
    this.setPending([]);
  }

  private setPending(updates: PluginUpdate[]): void {
    this.pending = updates;
    this.plugin.updateStatusBar(updates.length);
  }

  private notifyAvailable(): void {
    const notice = new Notice(t("updatesAvailable", { n: this.pending.length }), 15000);
    notice.messageEl.addClass("silk-hub-clickable");
    notice.messageEl.addEventListener("click", () => this.openModal());
  }

  private notifyApplied(applied: PluginUpdate[]): void {
    const list = applied.map((u) => `${u.name} ${u.version}`).join(", ");
    const notice = new Notice(t("updatedNotice", { list }), 15000);
    notice.messageEl.addClass("silk-hub-clickable");
    notice.messageEl.addEventListener("click", () => void this.plugin.openChangelog());
  }
}

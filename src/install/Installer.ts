import { apiVersion, App, normalizePath, Platform } from "obsidian";
import type { HubClient } from "../api/HubClient";
import { sha256Hex } from "../api/pkce";
import { t } from "../i18n";
import type { PluginUpdate } from "../settings";
import { compareVersions } from "../ui/changes";
import { startPlugin, stopPlugin } from "./communityPlugins";
import { devLog } from "../devLog";

const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"];
const BACKUP_DIR = ".hub-backup";

/** The release can't run here: it's desktop-only on a phone, or needs a newer Obsidian. */
export class IncompatibleError extends Error {}

/** What install() did: the files are in place, and whether the plugin is running. */
export interface InstallResult {
  enabled: boolean;
}

/**
 * Downloads, verifies and installs plugin releases into the vault's plugins folder, keeping one backup for rollback.
 * Silk Hub itself is never installed or rolled back this way: it updates only through Obsidian.
 * Callers run these methods through the OperationQueue, one plugin at a time.
 */
export class Installer {
  constructor(
    private app: App,
    private client: HubClient,
    private selfId: string,
  ) {}

  /** Whether the Hub may install this plugin: not itself. */
  manages(id: string): boolean {
    return id !== this.selfId;
  }

  private pluginDir(id: string): string {
    return normalizePath(`${this.app.vault.configDir}/plugins/${id}`);
  }

  /** Name and version from the installed manifest.json, or null if the plugin isn't installed. */
  async installedManifest(id: string): Promise<{ name: string; version: string } | null> {
    const file = `${this.pluginDir(id)}/manifest.json`;
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(file))) return null;
    try {
      const manifest = JSON.parse(await adapter.read(file)) as { name?: string; version?: string };
      return manifest.version ? { name: manifest.name ?? id, version: manifest.version } : null;
    } catch {
      return null;
    }
  }

  async installedVersion(id: string): Promise<string | null> {
    return (await this.installedManifest(id))?.version ?? null;
  }

  async installedVersions(ids: Iterable<string>): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const id of ids) {
      const version = await this.installedVersion(id);
      if (version) result[id] = version;
    }
    return result;
  }

  /**
   * Installs or updates a plugin. A running plugin is stopped before its files change and restarted after.
   * If the new version can't be written or doesn't start, the previous files and state come back and this throws;
   * a fresh install that doesn't start stays installed and turned off ({ enabled: false }).
   * `enable: false` installs a new plugin without turning it on.
   */
  async install(update: PluginUpdate, { enable = true }: { enable?: boolean } = {}): Promise<InstallResult> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(update.id)) throw new Error(`invalid plugin id ${update.id}`);
    if (!this.manages(update.id)) throw new Error(`${update.id} updates only through Obsidian`);

    // Download and verify everything before touching the plugin folder.
    const files = new Map<string, ArrayBuffer>();
    for (const asset of update.assets) {
      if (!PLUGIN_FILES.includes(asset.name)) continue;
      const data = await devLog.step(`download ${update.id}/${asset.name}`, () => this.client.download(asset.url));
      const hash = await devLog.step(`sha256 ${asset.name} ${data.byteLength} bytes`, () => sha256Hex(data));
      if (hash !== asset.sha256) throw new Error(`checksum mismatch for ${asset.name}`);
      files.set(asset.name, data);
    }
    const manifestData = files.get("manifest.json");
    if (!files.has("main.js") || !manifestData) throw new Error("release is missing main.js or manifest.json");
    const manifest = JSON.parse(new TextDecoder().decode(manifestData)) as {
      id?: string;
      version?: string;
      minAppVersion?: string;
      isDesktopOnly?: boolean;
    };
    if (manifest.id !== update.id || manifest.version !== update.version) {
      throw new Error("manifest does not match the release");
    }
    if (manifest.isDesktopOnly === true && !Platform.isDesktopApp) throw new IncompatibleError(t("desktopOnlyError"));
    if (manifest.minAppVersion && compareVersions(manifest.minAppVersion, apiVersion) > 0) {
      throw new IncompatibleError(t("needsNewerApp", { version: manifest.minAppVersion }));
    }

    const dir = this.pluginDir(update.id);
    const adapter = this.app.vault.adapter;
    const wasInstalled = await adapter.exists(`${dir}/manifest.json`);
    devLog.log(`${update.id}: installed before ${wasInstalled}, enable ${enable}`);
    const wasRunning = await stopPlugin(this.app, update.id);
    if (wasInstalled) await devLog.step(`backup ${update.id}`, () => this.backup(dir));
    else if (!(await adapter.exists(dir))) await adapter.mkdir(dir);

    let started: boolean;
    try {
      for (const name of PLUGIN_FILES) {
        const data = files.get(name);
        const path = `${dir}/${name}`;
        if (data) await devLog.step(`write ${update.id}/${name}`, () => adapter.writeBinary(path, data));
        else if (await adapter.exists(path)) await adapter.remove(path);
      }
      started = await startPlugin(this.app, update.id, wasRunning ? "restart" : wasInstalled || !enable ? "none" : "enable");
    } catch (err) {
      await this.undo(update.id, dir, wasInstalled, wasRunning);
      throw err;
    }
    if (started) return { enabled: wasRunning || (!wasInstalled && enable) };
    if (!wasRunning) return { enabled: false };
    // The update doesn't start: bring back the version that worked.
    devLog.log(`${update.id}: the update didn't start, restoring the previous version`);
    await this.undo(update.id, dir, true, true);
    throw new Error(t("updateDidNotStart"));
  }

  /** Puts back the state from before install(): the previous files and running state, or no folder at all. */
  private async undo(id: string, dir: string, wasInstalled: boolean, wasRunning: boolean): Promise<void> {
    devLog.log(`${id}: undo, installed before ${wasInstalled}, running before ${wasRunning}`);
    try {
      await stopPlugin(this.app, id);
      if (wasInstalled) await this.restore(dir);
      else if (await this.app.vault.adapter.exists(dir)) await this.app.vault.adapter.rmdir(dir, true);
      await startPlugin(this.app, id, wasRunning ? "restart" : "none");
    } catch (err) {
      console.error(`Silk Hub: couldn't restore ${id}`, err);
    }
  }

  /** Restores the version saved before the last update. Returns the restored version, or null without a backup. */
  async rollback(id: string): Promise<string | null> {
    if (!this.manages(id)) return null;
    const dir = this.pluginDir(id);
    if (!(await this.app.vault.adapter.exists(`${dir}/${BACKUP_DIR}/manifest.json`))) return null;
    const wasRunning = await stopPlugin(this.app, id);
    await this.restore(dir);
    if (!(await startPlugin(this.app, id, wasRunning ? "restart" : "none"))) throw new Error(t("rollbackDidNotStart"));
    return this.installedVersion(id);
  }

  /** Ids of plugins that have a backup from a previous update. */
  async pluginsWithBackup(): Promise<string[]> {
    const adapter = this.app.vault.adapter;
    const { folders } = await adapter.list(normalizePath(`${this.app.vault.configDir}/plugins`));
    const ids: string[] = [];
    for (const folder of folders) {
      if (await adapter.exists(`${folder}/${BACKUP_DIR}/manifest.json`)) ids.push(folder.split("/").pop() as string);
    }
    return ids;
  }

  private async backup(dir: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const backupDir = `${dir}/${BACKUP_DIR}`;
    if (await adapter.exists(backupDir)) await adapter.rmdir(backupDir, true);
    await adapter.mkdir(backupDir);
    for (const name of PLUGIN_FILES) {
      if (await adapter.exists(`${dir}/${name}`)) await adapter.copy(`${dir}/${name}`, `${backupDir}/${name}`);
    }
  }

  private async restore(dir: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const backupDir = `${dir}/${BACKUP_DIR}`;
    for (const name of PLUGIN_FILES) {
      const from = `${backupDir}/${name}`;
      const to = `${dir}/${name}`;
      if (await adapter.exists(from)) await adapter.writeBinary(to, await adapter.readBinary(from));
      else if (await adapter.exists(to)) await adapter.remove(to);
    }
    await adapter.rmdir(backupDir, true);
  }
}

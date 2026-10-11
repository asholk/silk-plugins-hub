import { App, normalizePath } from "obsidian";
import type { HubClient } from "../api/HubClient";
import { sha256Hex } from "../api/pkce";
import type { PluginUpdate } from "../settings";
import { reloadPlugin } from "./communityPlugins";

const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"];
const BACKUP_DIR = ".hub-backup";

/** Downloads, verifies and installs plugin releases into the vault's plugins folder, keeping one backup for rollback. */
export class Installer {
  constructor(
    private app: App,
    private client: HubClient,
  ) {}

  private pluginDir(id: string): string {
    return normalizePath(`${this.app.vault.configDir}/plugins/${id}`);
  }

  async installedVersion(id: string): Promise<string | null> {
    const file = `${this.pluginDir(id)}/manifest.json`;
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(file))) return null;
    try {
      return (JSON.parse(await adapter.read(file)) as { version?: string }).version ?? null;
    } catch {
      return null;
    }
  }

  async installedVersions(ids: Iterable<string>): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const id of ids) {
      const version = await this.installedVersion(id);
      if (version) result[id] = version;
    }
    return result;
  }

  async install(update: PluginUpdate): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(update.id)) throw new Error(`invalid plugin id ${update.id}`);

    // Download and verify everything before touching the plugin folder.
    const files = new Map<string, ArrayBuffer>();
    for (const asset of update.assets) {
      if (!PLUGIN_FILES.includes(asset.name)) continue;
      const data = await this.client.download(asset.url);
      const hash = await sha256Hex(data);
      if (hash !== asset.sha256) throw new Error(`checksum mismatch for ${asset.name}`);
      files.set(asset.name, data);
    }
    const manifestData = files.get("manifest.json");
    if (!files.has("main.js") || !manifestData) throw new Error("release is missing main.js or manifest.json");
    const manifest = JSON.parse(new TextDecoder().decode(manifestData)) as { id?: string; version?: string };
    if (manifest.id !== update.id || manifest.version !== update.version) {
      throw new Error("manifest does not match the release");
    }

    const dir = this.pluginDir(update.id);
    const adapter = this.app.vault.adapter;
    const wasInstalled = await adapter.exists(`${dir}/manifest.json`);
    if (wasInstalled) await this.backup(dir);
    else if (!(await adapter.exists(dir))) await adapter.mkdir(dir);

    try {
      for (const name of PLUGIN_FILES) {
        const data = files.get(name);
        const path = `${dir}/${name}`;
        if (data) await adapter.writeBinary(path, data);
        else if (await adapter.exists(path)) await adapter.remove(path);
      }
      await reloadPlugin(this.app, update.id, wasInstalled);
    } catch (err) {
      if (wasInstalled) {
        await this.restore(dir);
        await reloadPlugin(this.app, update.id, true).catch(() => undefined);
      }
      throw err;
    }
  }

  /** Restores the version saved before the last update. Returns the restored version, or null without a backup. */
  async rollback(id: string): Promise<string | null> {
    const dir = this.pluginDir(id);
    if (!(await this.app.vault.adapter.exists(`${dir}/${BACKUP_DIR}/manifest.json`))) return null;
    await this.restore(dir);
    await reloadPlugin(this.app, id, true);
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

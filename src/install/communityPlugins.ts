import type { App, PluginManifest } from "obsidian";
import { devLog } from "../devLog";

/**
 * Obsidian has no public API for installing or reloading other plugins.
 * Every private call is kept here so a future API change has one place to fix.
 */
interface PluginsInternal {
  manifests: Record<string, PluginManifest>;
  enabledPlugins: Set<string>;
  /** Loaded plugin instances by id. */
  plugins: Record<string, unknown>;
  loadManifests(): Promise<void>;
  enablePluginAndSave(id: string): Promise<boolean>;
  disablePluginAndSave(id: string): Promise<void>;
  enablePlugin(id: string): Promise<boolean>;
  disablePlugin(id: string): Promise<void>;
  uninstallPlugin(id: string): Promise<void>;
}

function plugins(app: App): PluginsInternal {
  return (app as unknown as { plugins: PluginsInternal }).plugins;
}

/** Obsidian couldn't start the plugin: its onload() failed, or it doesn't run on this device. */
export class EnableError extends Error {}

export function isPluginEnabled(app: App, id: string): boolean {
  return plugins(app).enabledPlugins.has(id);
}

/** Whether Obsidian actually runs the plugin now. */
function isLoaded(app: App, id: string): boolean {
  return !!plugins(app).plugins?.[id];
}

/**
 * Turns a plugin on or off and remembers the choice, like the switch in Community plugins.
 * Throws EnableError when Obsidian reports that the plugin didn't start.
 */
export async function setPluginEnabled(app: App, id: string, enabled: boolean): Promise<void> {
  const api = plugins(app);
  if (!enabled) return devLog.step(`disablePluginAndSave ${id}`, () => api.disablePluginAndSave(id));
  if (!api.manifests[id]) await devLog.step("loadManifests", () => api.loadManifests());
  const ok = await devLog.step(`enablePluginAndSave ${id}`, () => api.enablePluginAndSave(id));
  devLog.log(`${id}: enable returned ${ok}, loaded ${isLoaded(app, id)}`);
  if (!ok || !isLoaded(app, id)) {
    // Obsidian may remember the choice even when the start failed; keep the switch truthful.
    if (api.enabledPlugins.has(id)) await devLog.step(`disablePluginAndSave ${id}`, () => api.disablePluginAndSave(id));
    throw new EnableError(id);
  }
}

/** Disables the plugin and deletes its folder, like Uninstall in Community plugins. */
export async function uninstallPlugin(app: App, id: string): Promise<void> {
  const api = plugins(app);
  if (!api.manifests[id]) await devLog.step("loadManifests", () => api.loadManifests());
  await devLog.step(`uninstallPlugin ${id}`, () => api.uninstallPlugin(id));
}

/** Stops a running plugin before its files change; returns whether it was running. */
export async function stopPlugin(app: App, id: string): Promise<boolean> {
  const api = plugins(app);
  const running = api.enabledPlugins.has(id) || isLoaded(app, id);
  devLog.log(`${id}: running ${running}`);
  if (running) await devLog.step(`disablePlugin ${id}`, () => api.disablePlugin(id));
  return running;
}

/**
 * Re-reads manifests after the plugin's files changed and starts it:
 * `restart` brings back a plugin that was running, `enable` turns on a fresh install and remembers it.
 * Returns false if Obsidian couldn't start the plugin.
 */
export async function startPlugin(app: App, id: string, how: "restart" | "enable" | "none"): Promise<boolean> {
  const api = plugins(app);
  await devLog.step("loadManifests", () => api.loadManifests());
  if (how === "none") return true;
  const ok =
    how === "restart"
      ? await devLog.step(`enablePlugin ${id}`, () => api.enablePlugin(id))
      : await devLog.step(`enablePluginAndSave ${id}`, () => api.enablePluginAndSave(id));
  devLog.log(`${id}: enable returned ${ok}, loaded ${isLoaded(app, id)}`);
  if (ok && isLoaded(app, id)) return true;
  if (how === "enable" && api.enabledPlugins.has(id)) await devLog.step(`disablePluginAndSave ${id}`, () => api.disablePluginAndSave(id));
  return false;
}

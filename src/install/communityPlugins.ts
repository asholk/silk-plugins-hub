import type { App, PluginManifest } from "obsidian";

/**
 * Obsidian has no public API for installing or reloading other plugins.
 * Every private call is kept here so a future API change has one place to fix.
 */
interface PluginsInternal {
  manifests: Record<string, PluginManifest>;
  enabledPlugins: Set<string>;
  loadManifests(): Promise<void>;
  enablePluginAndSave(id: string): Promise<boolean>;
  enablePlugin(id: string): Promise<boolean>;
  disablePlugin(id: string): Promise<void>;
}

function plugins(app: App): PluginsInternal {
  return (app as unknown as { plugins: PluginsInternal }).plugins;
}

export function isPluginEnabled(app: App, id: string): boolean {
  return plugins(app).enabledPlugins.has(id);
}

/** Re-reads manifests and (re)starts the plugin: enables a fresh install, restarts an enabled one. */
export async function reloadPlugin(app: App, id: string, wasInstalled: boolean): Promise<void> {
  const api = plugins(app);
  const wasEnabled = api.enabledPlugins.has(id);
  if (wasEnabled) await api.disablePlugin(id);
  await api.loadManifests();
  if (wasEnabled) await api.enablePlugin(id);
  else if (!wasInstalled) await api.enablePluginAndSave(id);
}

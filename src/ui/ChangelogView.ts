import { ItemView, WorkspaceLeaf } from "obsidian";
import { t } from "../i18n";
import type CorporatePluginHub from "../main";
import type { ReleaseInfo } from "../settings";
import { formatDate, renderChanges } from "./changes";

export const CHANGELOG_VIEW = "corporate-plugin-hub-changelog";

/** Sidebar feed of releases across all plugins of the selected company, newest first. */
export class ChangelogView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: CorporatePluginHub,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return CHANGELOG_VIEW;
  }

  getDisplayText(): string {
    return t("changelogTitle");
  }

  getIcon(): string {
    return "scroll-text";
  }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("corp-hub-changelog");
    const { client, settings, installer } = this.plugin;
    if (settings.companyId === null || !client.signedIn) {
      root.createEl("p", { cls: "corp-hub-muted", text: t("signInDesc") });
      return;
    }
    try {
      const catalog = await client.catalog(settings.companyId);
      const shown = catalog.filter((p) => p.required || settings.selected.includes(p.id));
      const entries: { name: string; installed: string | null; release: ReleaseInfo }[] = [];
      for (const p of shown) {
        const installed = await installer.installedVersion(p.id);
        for (const release of await client.changelog(p.id)) entries.push({ name: p.name, installed, release });
      }
      entries.sort((a, b) => b.release.publishedAt.localeCompare(a.release.publishedAt));
      if (entries.length === 0) {
        root.createEl("p", { cls: "corp-hub-muted", text: t("changelogEmpty") });
        return;
      }
      for (const { name, installed, release } of entries) {
        const el = root.createDiv({ cls: "corp-hub-release" });
        const head = el.createDiv({ cls: "corp-hub-release-head" });
        head.createSpan({ cls: "corp-hub-plugin-name", text: name });
        head.createSpan({ cls: "corp-hub-version", text: release.version });
        if (installed === release.version) head.createSpan({ cls: "corp-hub-badge", text: t("installed", { version: "" }).trim() });
        el.createDiv({ cls: "corp-hub-muted", text: formatDate(release.publishedAt) });
        renderChanges(el, release.changes);
      }
    } catch (err) {
      root.createEl("p", { cls: "corp-hub-error", text: t("loadFailed", { error: (err as Error).message }) });
    }
  }
}

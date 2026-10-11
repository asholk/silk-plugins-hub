import { ItemView, setIcon, WorkspaceLeaf } from "obsidian";
import { t } from "../i18n";
import type CorporatePluginHub from "../main";
import type { CatalogPlugin, ReleaseInfo } from "../settings";
import { ChangesModal } from "./ChangesModal";
import { compareVersions, formatDate } from "./changes";
import { GuideModal } from "./GuideModal";

export const CHANGELOG_VIEW = "corporate-plugin-hub-changelog";

/**
 * Changelog as a tree: company plugins → their versions. Selecting a version opens a table of its changes;
 * the guide is a separate button on the plugin row.
 */
export class ChangelogView extends ItemView {
  private expanded = new Set<string>();

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

    const toolbar = root.createDiv({ cls: "corp-hub-changelog-toolbar" });
    toolbar.createDiv({ cls: "corp-hub-changelog-title", text: t("changelogTitle") });
    const refreshBtn = toolbar.createDiv({ cls: "clickable-icon", attr: { "aria-label": t("refresh") } });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => void this.refresh());

    if (settings.companyId === null || !client.signedIn) {
      root.createEl("p", { cls: "corp-hub-muted", text: t("signInDesc") });
      return;
    }
    let catalog: CatalogPlugin[];
    try {
      catalog = await client.catalog(settings.companyId);
    } catch (err) {
      root.createEl("p", { cls: "corp-hub-error", text: t("loadFailed", { error: (err as Error).message }) });
      return;
    }
    if (catalog.length === 0) {
      root.createEl("p", { cls: "corp-hub-muted", text: t("noPlugins") });
      return;
    }

    const tree = root.createDiv({ cls: "corp-hub-tree" });
    for (const p of catalog) {
      const installed = await installer.installedVersion(p.id);
      this.renderPlugin(tree, p, installed);
    }
  }

  private renderPlugin(tree: HTMLElement, p: CatalogPlugin, installed: string | null): void {
    const item = tree.createDiv({ cls: "tree-item corp-hub-tree-plugin" });
    const self = item.createDiv({ cls: "tree-item-self is-clickable mod-collapsible" });
    const chevron = self.createDiv({ cls: "tree-item-icon collapse-icon" });
    setIcon(chevron, "right-triangle");
    self.createDiv({ cls: "tree-item-inner corp-hub-plugin-name", text: p.name });
    const flair = self.createDiv({ cls: "tree-item-flair-outer" });
    flair.createSpan({ cls: "tree-item-flair", text: installed ?? t("notInstalled") });
    if (p.hasGuide) {
      const guide = flair.createDiv({ cls: "clickable-icon corp-hub-guide-btn", attr: { "aria-label": t("guide") } });
      setIcon(guide, "book-open");
      guide.addEventListener("click", (e) => {
        e.stopPropagation();
        new GuideModal(this.plugin, p).open();
      });
    }
    const children = item.createDiv({ cls: "tree-item-children" });

    const setOpen = (open: boolean) => {
      item.toggleClass("is-collapsed", !open);
      chevron.toggleClass("is-collapsed", !open);
      children.toggle(open);
      if (open) this.expanded.add(p.id);
      else this.expanded.delete(p.id);
    };
    let loaded = false;
    const open = async () => {
      setOpen(true);
      if (loaded) return;
      loaded = true;
      try {
        const releases = await this.plugin.client.changelog(p.id);
        this.renderVersions(children, p, releases, installed);
      } catch (err) {
        children.createDiv({ cls: "corp-hub-error", text: t("loadFailed", { error: (err as Error).message }) });
      }
    };
    self.addEventListener("click", () => (item.hasClass("is-collapsed") ? void open() : setOpen(false)));
    setOpen(false);
    if (this.expanded.has(p.id)) void open();
  }

  private renderVersions(parent: HTMLElement, p: CatalogPlugin, releases: ReleaseInfo[], installed: string | null): void {
    if (releases.length === 0) {
      parent.createDiv({ cls: "corp-hub-muted corp-hub-tree-empty", text: t("changelogEmpty") });
      return;
    }
    for (const release of releases) {
      const row = parent.createDiv({ cls: "tree-item-self is-clickable corp-hub-tree-version" });
      row.createDiv({ cls: "tree-item-inner" }).createSpan({ cls: "corp-hub-version", text: release.version });
      const flair = row.createDiv({ cls: "tree-item-flair-outer" });
      if (installed === release.version) flair.createSpan({ cls: "corp-hub-badge", text: t("current") });
      else if (installed && compareVersions(release.version, installed) > 0) flair.createSpan({ cls: "corp-hub-badge mod-new", text: t("newer") });
      flair.createSpan({ cls: "tree-item-flair", text: formatDate(release.publishedAt) });
      row.addEventListener("click", () => new ChangesModal(this.app, p.name, release).open());
    }
  }
}

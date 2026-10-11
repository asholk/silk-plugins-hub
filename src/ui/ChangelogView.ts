import { ItemView, setIcon, WorkspaceLeaf } from "obsidian";
import { t } from "../i18n";
import type SilkPluginsHub from "../main";
import type { CatalogPlugin, ReleaseInfo } from "../settings";
import { ChangesModal } from "./ChangesModal";
import { compareVersions, formatDate } from "./changes";
import { GuideModal } from "./GuideModal";

export const CHANGELOG_VIEW = "silk-plugins-hub-changelog";

/**
 * Changelog as a tree: company plugins → their versions. Selecting a version opens a table of its changes;
 * the guide is a separate button on the plugin row.
 */
export class ChangelogView extends ItemView {
  private expanded = new Set<string>();

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: SilkPluginsHub,
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
    root.addClass("silk-hub-changelog");
    const { client, settings, installer } = this.plugin;

    const toolbar = root.createDiv({ cls: "silk-hub-changelog-toolbar" });
    toolbar.createDiv({ cls: "silk-hub-changelog-title", text: t("changelogTitle") });
    const refreshBtn = toolbar.createDiv({ cls: "clickable-icon", attr: { "aria-label": t("refresh") } });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => void this.refresh());

    if (settings.companyIds.length === 0 || !client.signedIn) {
      root.createEl("p", { cls: "silk-hub-muted", text: t("signInDesc") });
      return;
    }
    let catalog: CatalogPlugin[];
    try {
      catalog = await client.catalog(settings.companyIds);
    } catch (err) {
      root.createEl("p", { cls: "silk-hub-error", text: t("loadFailed", { error: (err as Error).message }) });
      return;
    }
    if (catalog.length === 0) {
      root.createEl("p", { cls: "silk-hub-muted", text: t("noPlugins") });
      return;
    }

    const tree = root.createDiv({ cls: "silk-hub-tree" });
    for (const p of catalog) {
      const installed = await installer.installedVersion(p.id);
      this.renderPlugin(tree, p, installed);
    }
  }

  private renderPlugin(tree: HTMLElement, p: CatalogPlugin, installed: string | null): void {
    const item = tree.createDiv({ cls: "tree-item silk-hub-tree-plugin" });
    const self = item.createDiv({ cls: "tree-item-self is-clickable mod-collapsible" });
    const chevron = self.createDiv({ cls: "tree-item-icon collapse-icon" });
    setIcon(chevron, "right-triangle");
    self.createDiv({ cls: "tree-item-inner silk-hub-plugin-name", text: p.name });
    const flair = self.createDiv({ cls: "tree-item-flair-outer" });
    flair.createSpan({ cls: "tree-item-flair", text: installed ?? t("notInstalled") });
    if (p.hasGuide) {
      const guide = flair.createDiv({ cls: "clickable-icon silk-hub-guide-btn", attr: { "aria-label": t("guide") } });
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
        children.createDiv({ cls: "silk-hub-error", text: t("loadFailed", { error: (err as Error).message }) });
      }
    };
    self.addEventListener("click", () => (item.hasClass("is-collapsed") ? void open() : setOpen(false)));
    setOpen(false);
    if (this.expanded.has(p.id)) void open();
  }

  private renderVersions(parent: HTMLElement, p: CatalogPlugin, releases: ReleaseInfo[], installed: string | null): void {
    if (releases.length === 0) {
      parent.createDiv({ cls: "silk-hub-muted silk-hub-tree-empty", text: t("changelogEmpty") });
      return;
    }
    for (const release of releases) {
      const row = parent.createDiv({ cls: "tree-item-self is-clickable silk-hub-tree-version" });
      row.createDiv({ cls: "tree-item-inner" }).createSpan({ cls: "silk-hub-version", text: release.version });
      const flair = row.createDiv({ cls: "tree-item-flair-outer" });
      if (installed === release.version) flair.createSpan({ cls: "silk-hub-badge", text: t("current") });
      else if (installed && compareVersions(release.version, installed) > 0) flair.createSpan({ cls: "silk-hub-badge mod-new", text: t("newer") });
      flair.createSpan({ cls: "tree-item-flair", text: formatDate(release.publishedAt) });
      row.addEventListener("click", () => new ChangesModal(this.app, p.name, release).open());
    }
  }
}

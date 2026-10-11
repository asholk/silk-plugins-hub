import { App, Modal } from "obsidian";
import { t } from "../i18n";
import type { ReleaseInfo } from "../settings";
import { formatDate, renderChangesTable } from "./changes";

/** Changes of one release as a table: type, what changed, why. */
export class ChangesModal extends Modal {
  constructor(
    app: App,
    private pluginName: string,
    private release: ReleaseInfo,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(t("changesTitle", { name: this.pluginName, version: this.release.version }));
    this.modalEl.addClass("silk-hub-changes-modal");
    const { contentEl } = this;
    contentEl.createDiv({ cls: "silk-hub-muted", text: formatDate(this.release.publishedAt) });
    if (this.release.changes.length === 0) {
      contentEl.createEl("p", { cls: "silk-hub-muted", text: t("changelogEmpty") });
      return;
    }
    renderChangesTable(contentEl, this.release.changes);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

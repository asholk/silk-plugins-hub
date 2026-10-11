import { App, Modal, setIcon } from "obsidian";
import { t } from "../i18n";
import type { ReleaseInfo } from "../settings";
import { CHANGE_TYPES, formatDate } from "./changes";

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
    this.modalEl.addClass("corp-hub-changes-modal");
    const { contentEl } = this;
    contentEl.createDiv({ cls: "corp-hub-muted", text: formatDate(this.release.publishedAt) });
    if (this.release.changes.length === 0) {
      contentEl.createEl("p", { cls: "corp-hub-muted", text: t("changelogEmpty") });
      return;
    }
    const table = contentEl.createEl("table", { cls: "corp-hub-changes-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const key of ["colType", "colWhat", "colWhy"] as const) head.createEl("th", { text: t(key) });
    const body = table.createEl("tbody");
    for (const change of this.release.changes) {
      const type = CHANGE_TYPES[change.type] ?? CHANGE_TYPES.other;
      const row = body.createEl("tr", { cls: `corp-hub-change-${change.type}` });
      const typeCell = row.createEl("td", { cls: "corp-hub-change-type" });
      setIcon(typeCell.createSpan({ cls: "corp-hub-change-icon" }), type.icon);
      typeCell.createSpan({ text: t(type.label) });
      row.createEl("td", { text: change.text });
      row.createEl("td", { cls: change.why ? "" : "corp-hub-muted", text: change.why || "—" });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

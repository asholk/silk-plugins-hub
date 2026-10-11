import { Component, MarkdownRenderer, Modal, Setting } from "obsidian";
import { t } from "../i18n";
import type CorporatePluginHub from "../main";
import type { CatalogPlugin } from "../settings";
import { formatDate, renderChangesTable } from "./changes";
import { GuideModal } from "./GuideModal";

/**
 * "Details": the plugin page — what it is, its status and versions, what's new in the latest version
 * and the overview card (hub/card.md). Step-by-step instructions live in GuideModal.
 */
export class PluginInfoModal extends Modal {
  private component = new Component();

  constructor(
    private plugin: CorporatePluginHub,
    private p: CatalogPlugin,
    private installed: string | null,
  ) {
    super(plugin.app);
  }

  async onOpen(): Promise<void> {
    const { contentEl, p } = this;
    this.modalEl.addClass("corp-hub-info-modal");
    this.setTitle(t("cardTitle", { name: p.name }));
    this.component.load();

    const head = contentEl.createDiv({ cls: "corp-hub-info-head" });
    if (p.description) head.createDiv({ cls: "corp-hub-info-desc", text: p.description });
    const chips = head.createDiv({ cls: "corp-hub-plugin-meta" });
    chips.createSpan({
      cls: this.installed ? "corp-hub-chip mod-installed" : "corp-hub-chip",
      text: this.installed ? t("installed", { version: this.installed }) : t("notInstalled"),
    });
    if (p.latest) chips.createSpan({ cls: "corp-hub-chip", text: t("latest", { version: p.latest.version }) });
    if (p.required) chips.createSpan({ cls: "corp-hub-chip mod-required", text: t("required") });
    if (p.instructions) head.createDiv({ cls: "corp-hub-instructions", text: t("howToStart", { text: p.instructions }) });

    if (p.latest && p.latest.changes.length > 0) {
      const news = contentEl.createDiv({ cls: "corp-hub-info-section" });
      news.createEl("h3", { text: t("whatsNew", { version: p.latest.version }) });
      news.createDiv({ cls: "corp-hub-muted", text: formatDate(p.latest.publishedAt) });
      renderChangesTable(news, p.latest.changes);
    }

    if (p.hasCard) {
      const about = contentEl.createDiv({ cls: "corp-hub-info-section corp-hub-card markdown-rendered" });
      try {
        const card = await this.plugin.client.doc(p.id, "card");
        await MarkdownRenderer.render(this.app, card.markdown, about, "", this.component);
      } catch (err) {
        about.createEl("p", { cls: "corp-hub-error", text: t("cardFailed", { error: (err as Error).message }) });
      }
    }

    const footer = new Setting(contentEl);
    if (p.hasGuide) {
      footer.addButton((b) =>
        b
          .setButtonText(t("openGuide"))
          .setCta()
          .onClick(() => {
            this.close();
            new GuideModal(this.plugin, p).open();
          }),
      );
    }
    footer.addButton((b) =>
      b.setButtonText(t("openChangelog")).onClick(() => {
        this.close();
        void this.plugin.openChangelog();
      }),
    );
  }

  onClose(): void {
    this.component.unload();
    this.contentEl.empty();
  }
}

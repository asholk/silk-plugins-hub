import { App, Component, MarkdownRenderer, Modal } from "obsidian";
import type { HubClient } from "../api/HubClient";
import { t } from "../i18n";

/** Shows the plugin card (hub/card.md) or guide (hub/guide.md) rendered as Markdown. */
export class DocModal extends Modal {
  private component = new Component();

  constructor(
    app: App,
    private client: HubClient,
    private pluginId: string,
    private pluginName: string,
    private kind: "card" | "guide",
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.setTitle(t(this.kind === "card" ? "cardTitle" : "guideTitle2", { name: this.pluginName }));
    this.modalEl.addClass("corp-hub-card-modal");
    this.component.load();
    const body = this.contentEl.createDiv({ cls: "corp-hub-card markdown-rendered" });
    try {
      const doc = await this.client.doc(this.pluginId, this.kind);
      await MarkdownRenderer.render(this.app, doc.markdown, body, "", this.component);
    } catch (err) {
      body.createEl("p", { cls: "corp-hub-error", text: t("cardFailed", { error: (err as Error).message }) });
    }
  }

  onClose(): void {
    this.component.unload();
    this.contentEl.empty();
  }
}

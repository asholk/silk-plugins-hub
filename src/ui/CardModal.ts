import { App, Component, MarkdownRenderer, Modal } from "obsidian";
import type { HubClient } from "../api/HubClient";
import { t } from "../i18n";

/** Shows the plugin card (hub/card.md from the plugin repository) rendered as Markdown. */
export class CardModal extends Modal {
  private component = new Component();

  constructor(
    app: App,
    private client: HubClient,
    private pluginId: string,
    private pluginName: string,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.setTitle(t("cardTitle", { name: this.pluginName }));
    this.modalEl.addClass("corp-hub-card-modal");
    this.component.load();
    const body = this.contentEl.createDiv({ cls: "corp-hub-card markdown-rendered" });
    try {
      const card = await this.client.card(this.pluginId);
      await MarkdownRenderer.render(this.app, card.markdown, body, "", this.component);
    } catch (err) {
      body.createEl("p", { cls: "corp-hub-error", text: t("cardFailed", { error: (err as Error).message }) });
    }
  }

  onClose(): void {
    this.component.unload();
    this.contentEl.empty();
  }
}

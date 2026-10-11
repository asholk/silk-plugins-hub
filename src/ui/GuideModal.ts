import { Component, MarkdownRenderer, Modal } from "obsidian";
import { t } from "../i18n";
import type SilkPluginsHub from "../main";
import type { CatalogPlugin } from "../settings";

/** "Instructions": the step-by-step guide (hub/guide.md) with a table of contents built from its sections. */
export class GuideModal extends Modal {
  private component = new Component();

  constructor(
    private plugin: SilkPluginsHub,
    private p: CatalogPlugin,
  ) {
    super(plugin.app);
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass("silk-hub-guide-modal");
    this.setTitle(t("guideTitle2", { name: this.p.name }));
    this.component.load();

    const layout = this.contentEl.createDiv({ cls: "silk-hub-guide-layout" });
    const toc = layout.createDiv({ cls: "silk-hub-guide-toc" });
    const body = layout.createDiv({ cls: "silk-hub-guide-body silk-hub-card markdown-rendered" });
    try {
      const guide = await this.plugin.client.doc(this.p.id, "guide");
      await MarkdownRenderer.render(this.app, guide.markdown, body, "", this.component);
    } catch (err) {
      toc.remove();
      body.createEl("p", { cls: "silk-hub-error", text: t("cardFailed", { error: (err as Error).message }) });
      return;
    }

    const headings = Array.from(body.querySelectorAll("h2"));
    if (headings.length < 2) {
      toc.remove();
      return;
    }
    toc.createDiv({ cls: "silk-hub-guide-toc-title", text: t("contents") });
    const links: HTMLElement[] = [];
    headings.forEach((heading, index) => {
      const link = toc.createDiv({ cls: "silk-hub-guide-toc-item", text: heading.textContent ?? "" });
      links.push(link);
      link.addEventListener("click", () => {
        heading.scrollIntoView({ behavior: "smooth", block: "start" });
        links.forEach((l, i) => l.toggleClass("is-active", i === index));
      });
    });
    links[0].addClass("is-active");
  }

  onClose(): void {
    this.component.unload();
    this.contentEl.empty();
  }
}

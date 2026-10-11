import { App, Modal, Setting } from "obsidian";

/** Asks a yes/no question; resolves true when the user confirms. */
export function confirm(app: App, message: string, confirmText: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const modal = new (class extends Modal {
      onOpen(): void {
        this.contentEl.createEl("p", { text: message });
        new Setting(this.contentEl).addButton((b) =>
          b
            .setButtonText(confirmText)
            .setWarning()
            .onClick(() => {
              answered = true;
              this.close();
            }),
        );
      }
      onClose(): void {
        resolve(answered);
      }
    })(app);
    modal.open();
  });
}

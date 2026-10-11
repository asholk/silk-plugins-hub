import { App, ButtonComponent, Modal, Setting } from "obsidian";
import { t } from "../i18n";
import type { PluginUpdate } from "../settings";
import type { UpdateService } from "../updates/UpdateService";
import { renderRelease } from "./changes";

/** Lists pending updates with their changelog and lets the user choose what to install. */
export class UpdatesModal extends Modal {
  private chosen = new Set<PluginUpdate>();

  constructor(
    app: App,
    private service: UpdateService,
    private updates: PluginUpdate[],
  ) {
    super(app);
    updates.forEach((u) => this.chosen.add(u));
  }

  onOpen(): void {
    this.setTitle(t("modalTitle"));
    this.modalEl.addClass("corp-hub-updates-modal");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    for (const update of this.updates) {
      const card = contentEl.createDiv({ cls: "corp-hub-update" });
      const reason =
        update.reason === "install"
          ? t("reasonInstall")
          : update.reason === "revoked"
            ? t("reasonRevoked", { version: update.installedVersion ?? "" })
            : t("reasonUpdate");
      const versions = update.installedVersion ? `${update.installedVersion} → ${update.version}` : update.version;

      new Setting(card)
        .setName(update.name)
        .setDesc(`${reason} · ${versions}${update.required ? ` · ${t("required")}` : ""}`)
        .addToggle((toggle) =>
          toggle.setValue(this.chosen.has(update)).onChange((value) => {
            if (value) this.chosen.add(update);
            else this.chosen.delete(update);
            this.installButton?.setDisabled(this.chosen.size === 0);
          }),
        )
        .addExtraButton((button) =>
          button
            .setIcon("eye-off")
            .setTooltip(t("skipVersion"))
            .onClick(async () => {
              await this.service.skip(update);
              this.updates = this.updates.filter((u) => u !== update);
              this.chosen.delete(update);
              if (this.updates.length === 0) this.close();
              else this.render();
            }),
        );

      const log = card.createDiv({ cls: "corp-hub-update-log" });
      update.changelog.forEach((release) => renderRelease(log, release));
    }

    new Setting(contentEl)
      .addButton((button) => button.setButtonText(t("modalLater")).onClick(() => this.close()))
      .addButton((button) => {
        this.installButton = button;
        button
          .setButtonText(t("modalInstall"))
          .setCta()
          .setDisabled(this.chosen.size === 0)
          .onClick(async () => {
            button.setDisabled(true);
            const chosen = this.updates.filter((u) => this.chosen.has(u));
            this.close();
            await this.service.apply(chosen);
          });
      });
  }

  private installButton: ButtonComponent | null = null;
}

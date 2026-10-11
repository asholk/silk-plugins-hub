import { Notice, Plugin, SuggestModal } from "obsidian";
import { HubClient } from "./api/HubClient";
import { createPendingSignIn, PendingSignIn } from "./api/pkce";
import { t } from "./i18n";
import { Installer } from "./install/Installer";
import { DEFAULT_SETTINGS, HubSettings } from "./settings";
import { CHANGELOG_VIEW, ChangelogView } from "./ui/ChangelogView";
import { HubSettingTab } from "./ui/SettingTab";
import { UpdateService } from "./updates/UpdateService";

const SIGN_IN_TTL_MS = 10 * 60 * 1000;
const STARTUP_DELAY_MS = 10 * 1000;

export default class SilkPluginsHub extends Plugin {
  settings!: HubSettings;
  client!: HubClient;
  installer!: Installer;
  updates!: UpdateService;
  private settingTab!: HubSettingTab;
  private statusBarEl: HTMLElement | null = null;
  private checkTimer: number | null = null;
  private pendingSignIn: (PendingSignIn & { serverUrl: string }) | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.client = new HubClient(this.app, () => this.settings.serverUrl, () => this.onSignedOut());
    this.installer = new Installer(this.app, this.client, this.manifest.id);
    this.updates = new UpdateService(this);

    this.settingTab = new HubSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerView(CHANGELOG_VIEW, (leaf) => new ChangelogView(leaf, this));
    this.registerObsidianProtocolHandler("silk-hub-auth", (params) => void this.finishSignIn(params.code, params.state));

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("silk-hub-status", "mod-clickable");
    this.statusBarEl.addEventListener("click", () => this.updates.openModal());
    this.updateStatusBar(0);

    this.addCommand({ id: "check-for-updates", name: t("checkNow"), callback: () => void this.updates.check(true) });
    this.addCommand({ id: "open-changelog", name: t("openChangelog"), callback: () => void this.openChangelog() });
    this.addCommand({ id: "rollback-plugin", name: t("rollback"), callback: () => void this.chooseRollback() });

    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => void this.updates.check(false), STARTUP_DELAY_MS);
      this.scheduleChecks();
    });
  }

  async loadSettings(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<HubSettings> & { companyId?: number | null };
    // Earlier versions kept a single company.
    if (!data.companyIds && typeof data.companyId === "number") data.companyIds = [data.companyId];
    delete data.companyId;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.settings.companyIds = [...this.settings.companyIds];
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  scheduleChecks(): void {
    if (this.checkTimer !== null) window.clearInterval(this.checkTimer);
    this.checkTimer = null;
    if (this.settings.checkIntervalHours > 0) {
      this.checkTimer = window.setInterval(() => void this.updates.check(false), this.settings.checkIntervalHours * 3600 * 1000);
      this.registerInterval(this.checkTimer);
    }
  }

  updateStatusBar(count: number): void {
    if (!this.statusBarEl) return;
    this.statusBarEl.toggle(count > 0);
    this.statusBarEl.setText(`⬆ ${count}`);
    this.statusBarEl.setAttribute("aria-label", t("updatesAvailable", { n: count }));
  }

  /**
   * Prepares the sign-in link ahead of the tap: iOS opens the browser only when window.open runs
   * right in the tap handler, with no await before it. The same link is reused until it expires
   * or the server address changes.
   */
  async prepareSignIn(): Promise<string | null> {
    const serverUrl = this.client.serverUrl;
    if (!serverUrl) return null;
    const pending = this.pendingSignIn;
    if (!pending || pending.serverUrl !== serverUrl || Date.now() - pending.startedAt > SIGN_IN_TTL_MS) {
      this.pendingSignIn = { ...(await createPendingSignIn()), serverUrl };
    }
    const { state, challenge } = this.pendingSignIn as PendingSignIn;
    return this.client.authStartUrl(state, challenge);
  }

  /** Opens a link from prepareSignIn() in the browser. Call it synchronously from the tap handler. */
  openSignIn(url: string): void {
    if (this.pendingSignIn) this.pendingSignIn.startedAt = Date.now();
    window.open(url, "_blank");
    new Notice(t("signInOpened"));
  }

  async startSignIn(): Promise<void> {
    const url = await this.prepareSignIn();
    if (!url) return void new Notice(t("noServer"));
    this.openSignIn(url);
  }

  private async finishSignIn(code: string | undefined, state: string | undefined): Promise<void> {
    const pending = this.pendingSignIn;
    this.pendingSignIn = null;
    if (!pending || !code || state !== pending.state || Date.now() - pending.startedAt > SIGN_IN_TTL_MS) {
      return void new Notice(t("signInExpired"));
    }
    try {
      await this.client.exchangeCode(code, pending.verifier);
      const me = await this.client.me();
      this.settings.accountEmail = me.user.email;
      if (me.companies.length === 1 && this.settings.companyIds.length === 0) this.settings.companyIds = [me.companies[0].id];
      await this.saveSettings();
      new Notice(t("signInDone", { email: me.user.email }));
      this.settingTab.refresh();
      this.openSettings();
    } catch (err) {
      new Notice(t("signInFailed", { error: (err as Error).message }));
    }
  }

  async signOut(): Promise<void> {
    await this.client.signOut();
    this.onSignedOut();
  }

  private onSignedOut(): void {
    this.settings.accountEmail = null;
    void this.saveSettings();
    this.updates.pending = [];
    this.updateStatusBar(0);
    this.settingTab.refresh();
  }

  openSettings(): void {
    const setting = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
    setting.open();
    setting.openTabById(this.manifest.id);
  }

  async openChangelog(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(CHANGELOG_VIEW)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      await (existing.view as ChangelogView).refresh();
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: CHANGELOG_VIEW, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private async chooseRollback(): Promise<void> {
    const candidates: RollbackCandidate[] = [];
    for (const id of await this.installer.pluginsWithBackup()) {
      const installed = await this.installer.installedManifest(id);
      candidates.push({ id, name: installed?.name ?? id, version: installed?.version ?? "" });
    }
    if (candidates.length === 0) return void new Notice(t("rollbackNone"));
    new RollbackModal(this, candidates).open();
  }
}

interface RollbackCandidate {
  id: string;
  name: string;
  version: string;
}

class RollbackModal extends SuggestModal<RollbackCandidate> {
  constructor(
    private plugin: SilkPluginsHub,
    private candidates: RollbackCandidate[],
  ) {
    super(plugin.app);
    this.setPlaceholder(t("rollback"));
  }

  getSuggestions(query: string): RollbackCandidate[] {
    const q = query.toLowerCase();
    return this.candidates.filter((c) => c.name.toLowerCase().includes(q) || c.id.includes(q));
  }

  renderSuggestion(c: RollbackCandidate, el: HTMLElement): void {
    el.createDiv({ text: c.name });
    el.createEl("small", { cls: "silk-hub-muted", text: c.version ? `${c.id} · ${c.version}` : c.id });
  }

  onChooseSuggestion(c: RollbackCandidate): void {
    void (async () => {
      try {
        const version = await this.plugin.installer.rollback(c.id);
        new Notice(version ? t("rollbackDone", { name: c.name, version }) : t("rollbackNone"));
      } catch (err) {
        new Notice(t("installFailed", { name: c.name, error: (err as Error).message }));
      }
    })();
  }
}

import { Notice, Platform, Plugin, SuggestModal } from "obsidian";
import { HubClient, ServerCheck } from "./api/HubClient";
import { createPendingSignIn, PendingSignIn } from "./api/pkce";
import { devLog } from "./devLog";
import { t } from "./i18n";
import { Installer } from "./install/Installer";
import { OperationQueue } from "./install/OperationQueue";
import { DEFAULT_SETTINGS, HubSettings } from "./settings";
import { CHANGELOG_VIEW, ChangelogView } from "./ui/ChangelogView";
import { HubSettingTab } from "./ui/SettingTab";
import { UpdateService } from "./updates/UpdateService";

const SIGN_IN_TTL_MS = 10 * 60 * 1000;
/** A server that answered as Silk Hub is not asked again for this long. */
const SERVER_CHECK_TTL_MS = 5 * 60 * 1000;

/** Opens a URL in the default browser of the desktop (Electron shell); false where that is not available. */
function openInSystemBrowser(url: string): boolean {
  if (!Platform.isDesktopApp) return false;
  try {
    const electron = (window as unknown as { require?: (m: string) => unknown }).require?.("electron") as
      | { shell?: { openExternal?: (u: string) => Promise<void> } }
      | undefined;
    if (typeof electron?.shell?.openExternal !== "function") return false;
    void electron.shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
}

/** What to tell the user about a server address that failed the check. */
function serverProblemText(check: Extract<ServerCheck, { ok: false }>): string {
  switch (check.reason) {
    case "empty":
      return t("noServer");
    case "invalid":
      return t("serverInvalid", { url: check.url });
    case "unreachable":
      return t("serverUnreachable", { url: check.url });
    case "down":
      return t("serverDown", { url: check.url, status: String(check.status ?? "") });
    case "not-hub":
      return t("serverNotHub", { url: check.url });
  }
}
const STARTUP_DELAY_MS = 10 * 1000;
/** Per-device choice, kept out of data.json so a synced vault doesn't carry it to other devices. */
const ENABLE_AFTER_INSTALL_KEY = "silk-hub-enable-after-install";

export default class SilkPluginsHub extends Plugin {
  settings!: HubSettings;
  client!: HubClient;
  installer!: Installer;
  updates!: UpdateService;
  /** Installs, updates, switches and removals, one plugin at a time. */
  readonly queue = new OperationQueue();
  private settingTab!: HubSettingTab;
  private statusBarEl: HTMLElement | null = null;
  private checkTimer: number | null = null;
  private pendingSignIn: (PendingSignIn & { serverUrl: string }) | null = null;

  async onload(): Promise<void> {
    devLog.init(this.app, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    devLog.log(`Silk Hub ${this.manifest.version} loading`);
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
    this.addCommand({
      id: "copy-debug-log",
      name: t("copyDebugLog"),
      checkCallback: (checking) => {
        if (!devLog.enabled) return false;
        if (!checking) void navigator.clipboard.writeText(devLog.text()).then(() => new Notice(t("debugLogCopied")));
        return true;
      },
    });

    // Errors from any plugin while developer mode is on: a plugin failing in onload() shows up here.
    this.registerDomEvent(window, "error", (e) => devLog.log(`window error: ${e.message} at ${e.filename}:${e.lineno}`));
    this.registerDomEvent(window, "unhandledrejection", (e) =>
      devLog.log(`unhandled rejection: ${(e.reason as Error)?.message ?? String(e.reason)}`),
    );

    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => void this.updates.check(false), STARTUP_DELAY_MS);
      this.scheduleChecks();
    });
  }

  onunload(): void {
    devLog.unload();
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

  /** Whether a newly installed plugin is turned on right away; set per device. */
  get enableAfterInstall(): boolean {
    return this.app.loadLocalStorage(ENABLE_AFTER_INSTALL_KEY) !== "false";
  }

  set enableAfterInstall(value: boolean) {
    this.app.saveLocalStorage(ENABLE_AFTER_INSTALL_KEY, value ? null : "false");
  }

  updateStatusBar(count: number): void {
    if (!this.statusBarEl) return;
    this.statusBarEl.toggle(count > 0);
    this.statusBarEl.toggleClass("has-updates", count > 0);
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
    // Only a checked Silk Hub address gets a sign-in link.
    if (!(await this.checkServer(false)).ok) return null;
    const pending = this.pendingSignIn;
    if (!pending || pending.serverUrl !== serverUrl || Date.now() - pending.startedAt > SIGN_IN_TTL_MS) {
      this.pendingSignIn = { ...(await createPendingSignIn()), serverUrl };
    }
    const { state, challenge } = this.pendingSignIn as PendingSignIn;
    return this.client.authStartUrl(state, challenge);
  }

  /**
   * Opens a link from prepareSignIn() in the default browser. On the desktop through Electron's
   * shell.openExternal: window.open may land in Obsidian's own Web viewer tab, and the sign-in must
   * happen in the real browser, where the Google session is (Relay does the same). Elsewhere
   * window.open — call it synchronously from the tap handler.
   */
  openSignIn(url: string): void {
    if (this.pendingSignIn) this.pendingSignIn.startedAt = Date.now();
    if (!openInSystemBrowser(url)) window.open(url, "_blank");
    new Notice(t("signInOpened"));
  }

  /** Last successful server check: the address it was for and when. */
  private serverOk: { url: string; at: number } | null = null;

  /** Checks the server address of the settings; `notify` says what is wrong with it. Successes are kept for a while. */
  async checkServer(notify: boolean): Promise<ServerCheck> {
    const url = this.client.serverUrl;
    if (this.serverOk && this.serverOk.url === url && Date.now() - this.serverOk.at < SERVER_CHECK_TTL_MS) return { ok: true, url };
    const result = await this.client.checkServer();
    this.serverOk = result.ok ? { url, at: Date.now() } : null;
    if (!result.ok && notify) new Notice(serverProblemText(result), 8000);
    return result;
  }

  /** "Sign in with Google" when no checked link was ready: checks the server first, then opens the browser. */
  async startSignIn(): Promise<void> {
    if (!(await this.checkServer(true)).ok) return;
    const url = await this.prepareSignIn();
    if (!url) return;
    // iOS opens the browser only from the tap itself: the link is ready now, the next tap opens it.
    if (Platform.isIosApp) return void new Notice(t("signInTapAgain"));
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
        const version = await this.plugin.queue.run(c.id, t("rollingBack"), () => this.plugin.installer.rollback(c.id));
        new Notice(version ? t("rollbackDone", { name: c.name, version }) : t("rollbackNone"));
      } catch (err) {
        new Notice(t("actionFailed", { name: c.name, error: (err as Error).message }));
      }
    })();
  }
}

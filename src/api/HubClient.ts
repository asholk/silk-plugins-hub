import { apiVersion, App, requestUrl, RequestUrlResponse } from "obsidian";
import type { CatalogPlugin, CheckResult, Company, ReleaseInfo } from "../settings";

const REFRESH_SECRET = "silk-plugins-hub-session";

export class HubError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

export class NotSignedInError extends HubError {
  constructor() {
    super("not signed in", 401);
  }
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** Talks to the Silk Hub server. The refresh token lives in Obsidian's SecretStorage, the access token only in memory. */
export class HubClient {
  private accessToken: string | null = null;
  private accessExpiresAt = 0;
  /**
   * The refresh in progress. The server accepts each refresh token once, so parallel requests
   * must share one refresh: a second one would send the already used token and sign the user out.
   */
  private refreshing: Promise<string> | null = null;

  constructor(
    private app: App,
    private getServerUrl: () => string,
    private onSignedOut: () => void,
  ) {}

  get serverUrl(): string {
    return this.getServerUrl().trim().replace(/\/+$/, "");
  }

  get signedIn(): boolean {
    return !!this.app.secretStorage.getSecret(REFRESH_SECRET);
  }

  authStartUrl(state: string, challenge: string): string {
    return `${this.serverUrl}/auth/start?${new URLSearchParams({ state, challenge }).toString()}`;
  }

  async exchangeCode(code: string, verifier: string): Promise<void> {
    const res = await this.raw("/auth/token", { method: "POST", body: { code, verifier } });
    if (res.status !== 200) throw new HubError(safeJson(res)?.error ?? `HTTP ${res.status}`, res.status);
    this.storeTokens(res.json as TokenResponse);
  }

  async signOut(): Promise<void> {
    const refreshToken = this.app.secretStorage.getSecret(REFRESH_SECRET);
    this.clearTokens();
    if (refreshToken && this.serverUrl) {
      await this.raw("/auth/logout", { method: "POST", body: { refreshToken } }).catch(() => undefined);
    }
  }

  me(): Promise<{ user: { email: string; name: string }; companies: Company[] }> {
    return this.call("/api/me");
  }

  /** Company by its code or name among the user's companies; null if there is no such company or no access. */
  async lookupCompany(code: string): Promise<Company | null> {
    try {
      const res = await this.call<{ company: Company }>(`/api/companies/lookup?code=${encodeURIComponent(code)}`);
      return res.company;
    } catch (err) {
      if (err instanceof HubError && err.status === 404) return null;
      throw err;
    }
  }

  async catalog(companyIds: number[]): Promise<CatalogPlugin[]> {
    if (companyIds.length === 0) return [];
    const res = await this.call<{ plugins: CatalogPlugin[] }>(
      `/api/catalog?companies=${companyIds.join(",")}&appVersion=${encodeURIComponent(appVersion())}`,
    );
    return res.plugins;
  }

  checkUpdates(companyIds: number[], selected: string[], installed: Record<string, string>): Promise<CheckResult> {
    return this.call("/api/updates/check", {
      method: "POST",
      body: { companyIds, selected, installed, appVersion: appVersion() },
    });
  }

  /** Plugin card (overview) or guide (detailed instructions) as Markdown. */
  doc(pluginId: string, kind: "card" | "guide"): Promise<{ version: string; markdown: string }> {
    return this.call(`/api/plugins/${encodeURIComponent(pluginId)}/${kind}`);
  }

  async changelog(pluginId: string): Promise<ReleaseInfo[]> {
    const res = await this.call<{ releases: ReleaseInfo[] }>(`/api/plugins/${encodeURIComponent(pluginId)}/changelog`);
    return res.releases;
  }

  /**
   * Downloads a file by the short-lived signed link from the hub (usually straight from its storage).
   * The link itself grants access, so no session token is sent; integrity is checked by SHA-256 afterwards.
   */
  async download(url: string): Promise<ArrayBuffer> {
    const local = url.startsWith(this.serverUrl + "/");
    if (!local && !url.startsWith("https://")) throw new HubError(`unexpected asset link: ${url}`);
    const res = await requestUrl({ url, throw: false });
    if (res.status !== 200) throw new HubError(`HTTP ${res.status}`, res.status);
    return res.arrayBuffer;
  }

  private async call<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
    let token = await this.getAccessToken();
    let res = await this.raw(path, opts, token);
    if (res.status === 401) {
      // Another request may have refreshed the token meanwhile; drop only the one that failed.
      if (this.accessToken === token) this.accessToken = null;
      token = await this.getAccessToken();
      res = await this.raw(path, opts, token);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new HubError(safeJson(res)?.error ?? `HTTP ${res.status}`, res.status);
    }
    return res.json as T;
  }

  private getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessExpiresAt) return Promise.resolve(this.accessToken);
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const refreshToken = this.app.secretStorage.getSecret(REFRESH_SECRET);
    if (!refreshToken) throw new NotSignedInError();
    const res = await this.raw("/auth/refresh", { method: "POST", body: { refreshToken } });
    if (res.status === 401) {
      this.clearTokens();
      this.onSignedOut();
      throw new NotSignedInError();
    }
    if (res.status !== 200) throw new HubError(`HTTP ${res.status}`, res.status);
    const tokens = res.json as TokenResponse;
    this.storeTokens(tokens);
    return tokens.accessToken;
  }

  private storeTokens(tokens: TokenResponse): void {
    this.accessToken = tokens.accessToken;
    this.accessExpiresAt = Date.now() + (tokens.expiresIn - 60) * 1000;
    this.app.secretStorage.setSecret(REFRESH_SECRET, tokens.refreshToken);
  }

  private clearTokens(): void {
    this.accessToken = null;
    this.accessExpiresAt = 0;
    this.app.secretStorage.setSecret(REFRESH_SECRET, "");
  }

  private async raw(path: string, opts: { method?: string; body?: unknown }, token?: string): Promise<RequestUrlResponse> {
    if (!this.serverUrl) throw new HubError("server address is not set");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    return requestUrl({
      url: this.serverUrl + path,
      method: opts.method ?? "GET",
      headers,
      contentType: opts.body === undefined ? undefined : "application/json",
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      throw: false,
    });
  }
}

function safeJson(res: RequestUrlResponse): { error?: string } | null {
  try {
    return res.json as { error?: string } | null;
  } catch {
    return null;
  }
}

/** Obsidian's API version matches the installed app version. */
function appVersion(): string {
  return apiVersion;
}

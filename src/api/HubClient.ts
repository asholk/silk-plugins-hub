import { apiVersion, App, requestUrl, RequestUrlResponse } from "obsidian";
import type { CatalogPlugin, CheckResult, Company, ReleaseInfo } from "../settings";

const REFRESH_SECRET = "corporate-plugin-hub-session";

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

/** Talks to the Plugin Hub server. The refresh token lives in Obsidian's SecretStorage, the access token only in memory. */
export class HubClient {
  private accessToken: string | null = null;
  private accessExpiresAt = 0;

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

  async catalog(companyId: number): Promise<CatalogPlugin[]> {
    const res = await this.call<{ plugins: CatalogPlugin[] }>(`/api/companies/${companyId}/plugins?appVersion=${encodeURIComponent(appVersion())}`);
    return res.plugins;
  }

  checkUpdates(companyId: number, selected: string[], installed: Record<string, string>): Promise<CheckResult> {
    return this.call("/api/updates/check", {
      method: "POST",
      body: { companyId, selected, installed, appVersion: appVersion() },
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

  async download(url: string): Promise<ArrayBuffer> {
    if (!url.startsWith(this.serverUrl + "/")) throw new HubError(`unexpected asset host: ${url}`);
    const token = await this.getAccessToken();
    const res = await requestUrl({ url, headers: { Authorization: `Bearer ${token}` }, throw: false });
    if (res.status !== 200) throw new HubError(`HTTP ${res.status}`, res.status);
    return res.arrayBuffer;
  }

  private async call<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
    let token = await this.getAccessToken();
    let res = await this.raw(path, opts, token);
    if (res.status === 401) {
      this.accessToken = null;
      token = await this.getAccessToken();
      res = await this.raw(path, opts, token);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new HubError(safeJson(res)?.error ?? `HTTP ${res.status}`, res.status);
    }
    return res.json as T;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessExpiresAt) return this.accessToken;
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
    return res.json;
  } catch {
    return null;
  }
}

/** Obsidian's API version matches the installed app version. */
function appVersion(): string {
  return apiVersion;
}

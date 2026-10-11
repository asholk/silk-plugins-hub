export interface HubSettings {
  serverUrl: string;
  companyId: number | null;
  /** Plugin ids the user chose for this vault. Required plugins are always included by the server. */
  selected: string[];
  autoUpdate: boolean;
  /** Hours between background checks; 0 checks only when the vault opens. */
  checkIntervalHours: number;
  /** Versions the user chose to skip, by plugin id. */
  skipped: Record<string, string>;
  accountEmail: string | null;
}

export const DEFAULT_SETTINGS: HubSettings = {
  serverUrl: "",
  companyId: null,
  selected: [],
  autoUpdate: false,
  checkIntervalHours: 6,
  skipped: {},
  accountEmail: null,
};

export interface Company {
  id: number;
  slug: string;
  name: string;
}

export interface ChangeItem {
  type: "new" | "improved" | "fixed" | "other";
  text: string;
  /** Why the change was made, if the author wrote it after a dash. */
  why?: string;
}

export interface ReleaseInfo {
  version: string;
  minAppVersion: string;
  publishedAt: string;
  changes: ChangeItem[];
}

export interface CatalogPlugin {
  id: string;
  name: string;
  description: string;
  instructions: string;
  required: boolean;
  hasCard: boolean;
  hasGuide: boolean;
  latest: ReleaseInfo | null;
}

export interface UpdateAsset {
  name: string;
  sha256: string;
  size: number;
  url: string;
}

export interface PluginUpdate {
  id: string;
  name: string;
  instructions: string;
  required: boolean;
  installedVersion: string | null;
  version: string;
  minAppVersion: string;
  reason: "install" | "update" | "revoked";
  changelog: ReleaseInfo[];
  assets: UpdateAsset[];
}

export interface CheckResult {
  updates: PluginUpdate[];
  removed: string[];
}

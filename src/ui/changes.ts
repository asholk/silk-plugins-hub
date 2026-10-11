import { setIcon } from "obsidian";
import { MessageKey, t } from "../i18n";
import type { ChangeItem, ReleaseInfo } from "../settings";

export const CHANGE_TYPES: Record<ChangeItem["type"], { icon: string; label: MessageKey }> = {
  new: { icon: "sparkles", label: "typeNew" },
  improved: { icon: "trending-up", label: "typeImproved" },
  fixed: { icon: "bug", label: "typeFixed" },
  other: { icon: "dot", label: "typeOther" },
};

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

export function renderChanges(parent: HTMLElement, changes: ChangeItem[]): void {
  const list = parent.createEl("ul", { cls: "silk-hub-changes" });
  for (const change of changes) {
    const type = CHANGE_TYPES[change.type] ?? CHANGE_TYPES.other;
    const li = list.createEl("li", { cls: `silk-hub-change silk-hub-change-${change.type}` });
    const icon = li.createSpan({ cls: "silk-hub-change-icon", attr: { "aria-label": t(type.label) } });
    setIcon(icon, type.icon);
    li.createSpan({ text: change.text });
  }
}

/** Changes as a table: type, what changed, why. */
export function renderChangesTable(parent: HTMLElement, changes: ChangeItem[]): void {
  const table = parent.createEl("table", { cls: "silk-hub-changes-table" });
  const head = table.createEl("thead").createEl("tr");
  for (const key of ["colType", "colWhat", "colWhy"] as const) head.createEl("th", { text: t(key) });
  const body = table.createEl("tbody");
  for (const change of changes) {
    const type = CHANGE_TYPES[change.type] ?? CHANGE_TYPES.other;
    const row = body.createEl("tr", { cls: `silk-hub-change-${change.type}` });
    const typeCell = row.createEl("td", { cls: "silk-hub-change-type" });
    setIcon(typeCell.createSpan({ cls: "silk-hub-change-icon" }), type.icon);
    typeCell.createSpan({ text: t(type.label) });
    row.createEl("td", { text: change.text });
    row.createEl("td", { cls: change.why ? "" : "silk-hub-muted", text: change.why || "—" });
  }
}

export function renderRelease(parent: HTMLElement, release: ReleaseInfo): void {
  const el = parent.createDiv({ cls: "silk-hub-release" });
  const head = el.createDiv({ cls: "silk-hub-release-head" });
  head.createSpan({ cls: "silk-hub-version", text: release.version });
  head.createSpan({ cls: "silk-hub-muted", text: formatDate(release.publishedAt) });
  if (release.changes.length > 0) renderChanges(el, release.changes);
}

/** Compares x.y.z[-pre] versions. Returns -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre = ""] = v.trim().replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

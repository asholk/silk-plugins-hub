import { setIcon } from "obsidian";
import { MessageKey, t } from "../i18n";
import type { ChangeItem, ReleaseInfo } from "../settings";

const TYPES: Record<ChangeItem["type"], { icon: string; label: MessageKey }> = {
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
  const list = parent.createEl("ul", { cls: "corp-hub-changes" });
  for (const change of changes) {
    const type = TYPES[change.type] ?? TYPES.other;
    const li = list.createEl("li", { cls: `corp-hub-change corp-hub-change-${change.type}` });
    const icon = li.createSpan({ cls: "corp-hub-change-icon", attr: { "aria-label": t(type.label) } });
    setIcon(icon, type.icon);
    li.createSpan({ text: change.text });
  }
}

export function renderRelease(parent: HTMLElement, release: ReleaseInfo): void {
  const el = parent.createDiv({ cls: "corp-hub-release" });
  const head = el.createDiv({ cls: "corp-hub-release-head" });
  head.createSpan({ cls: "corp-hub-version", text: release.version });
  head.createSpan({ cls: "corp-hub-muted", text: formatDate(release.publishedAt) });
  if (release.changes.length > 0) renderChanges(el, release.changes);
}

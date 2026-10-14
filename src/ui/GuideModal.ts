import { App, Component, MarkdownRenderer, Modal, Platform, prepareSimpleSearch, SearchComponent, setIcon } from "obsidian";
import { t } from "../i18n";
import type SilkPluginsHub from "../main";
import type { CatalogPlugin } from "../settings";

/** A block of the guide: the intro (no heading) or everything from one h2 to the next. */
interface GuideSection {
  el: HTMLElement;
  /** Number from the heading ("3. How to …" → 3); null for the intro and unnumbered sections. */
  num: number | null;
  title: string;
  text: string;
  tocItem: HTMLElement | null;
}

const NUMBERED_HEADING = /^\s*(\d+)[.)]\s*/;
// "раздел 5", "разделе 5", "разделы 3–4", "разделах 3 и 4", "section 5", "sections 3 and 4".
const SECTION_REF = /(?<![\p{L}\p{N}])(?:раздел(?:ы|е|а|у|ом|ах|ов|ам)?|sections?)\s+\d+(?:\s*(?:[–—-]|,|и|and)\s*\d+)*(?![\p{L}\p{N}])/giu;
const GUIDE_LINK = /(?:^|\/)guide\.md(?:#(\d+))?$/i;
const COMPACT_QUERY = "(max-width: 700px)";

/**
 * Section a link to the guide points at: `guide.md#5` → 5, `guide.md` → 0 (the top);
 * null when the link isn't to the guide. MarkdownRenderer keeps the target in data-href (internal links) or href.
 */
export function guideLinkSection(a: HTMLElement): number | null {
  const target = (a.getAttribute("data-href") ?? a.getAttribute("href") ?? "").trim();
  const m = GUIDE_LINK.exec(target) ?? /^#(\d+)$/.exec(target);
  if (!m) return null;
  return m[1] ? Number(m[1]) : 0;
}

/** "Instructions": the guide (hub/guide.md) split into section cards, with a searchable table of contents. */
export class GuideModal extends Modal {
  private component = new Component();
  private sections: GuideSection[] = [];
  private active: GuideSection | null = null;
  private observer: IntersectionObserver | null = null;
  private media: MediaQueryList | null = null;
  private onMediaChange = () => this.updateCompact();
  /** While a click-scroll is running, the observer must not move the highlight back. */
  private pinnedUntil = 0;
  private body!: HTMLElement;
  private toc: HTMLElement | null = null;
  private tocCurrent: HTMLElement | null = null;
  private search: SearchComponent | null = null;

  constructor(
    private plugin: SilkPluginsHub,
    private p: CatalogPlugin,
    private startSection?: number,
  ) {
    super(plugin.app);
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass("silk-hub-guide-modal");
    this.setTitle(t("guideTitle2", { name: this.p.name }));
    this.component.load();

    const meta = this.contentEl.createDiv({ cls: "silk-hub-guide-meta" });
    const layout = this.contentEl.createDiv({ cls: "silk-hub-guide-layout" });
    const tocEl = layout.createDiv({ cls: "silk-hub-guide-toc" });
    this.body = layout.createDiv({ cls: "silk-hub-guide-body silk-hub-card markdown-rendered" });

    const scratch = createDiv();
    let version: string;
    try {
      const guide = await this.plugin.client.doc(this.p.id, "guide");
      version = guide.version;
      await MarkdownRenderer.render(this.app, guide.markdown, scratch, "", this.component);
    } catch (err) {
      tocEl.remove();
      meta.remove();
      this.body.createEl("p", { cls: "silk-hub-error", text: t("cardFailed", { error: (err as Error).message }) });
      return;
    }

    this.buildSections(scratch);
    this.decorate();
    this.body.addEventListener("click", (e) => this.onBodyClick(e), { capture: true });

    if (this.sections.length >= 2) {
      this.toc = tocEl;
      this.buildToc(tocEl);
    } else {
      tocEl.remove();
    }

    void this.renderVersion(meta, version);
    this.media = this.contentEl.win.matchMedia(COMPACT_QUERY);
    this.media.addEventListener("change", this.onMediaChange);
    this.updateCompact();

    if (this.startSection) {
      const target = this.startSection;
      this.contentEl.win.requestAnimationFrame(() => this.goTo(target, false));
    }
  }

  onClose(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.media?.removeEventListener("change", this.onMediaChange);
    this.media = null;
    this.component.unload();
    this.contentEl.empty();
  }

  /** Moves the rendered nodes into one <section> per h2; whatever comes before the first h2 is the intro. */
  private buildSections(scratch: HTMLElement): void {
    // MarkdownRenderer wraps blocks in divs, so a boundary is an h2 or a top-level wrapper holding one.
    // Headings inside code blocks are <pre> text and never match.
    const isBoundary = (n: Node) => n.instanceOf(HTMLElement) && (n.tagName === "H2" || n.querySelector(":scope > h2") !== null);

    const intro = createEl("section", { cls: "silk-hub-guide-section mod-intro" });
    let current = intro;
    const all: HTMLElement[] = [intro];
    for (const node of Array.from(scratch.childNodes)) {
      if (isBoundary(node)) {
        current = createEl("section", { cls: "silk-hub-guide-section" });
        all.push(current);
      }
      current.appendChild(node);
    }

    // The first h1 repeats the modal title.
    const h1 = intro.querySelector("h1");
    if (h1) {
      const wrapper = h1.parentElement !== intro && h1.parentElement?.childElementCount === 1 ? h1.parentElement : h1;
      wrapper.remove();
    }
    const introEmpty = (intro.textContent ?? "").trim() === "" && !intro.querySelector("img");

    for (const el of all) {
      if (el === intro && introEmpty) continue;
      const heading = el === intro ? null : el.querySelector("h2");
      let num: number | null = null;
      let title = "";
      if (heading) {
        num = stripNumber(heading);
        title = (heading.textContent ?? "").trim();
        heading.addClass("silk-hub-guide-heading");
        if (num !== null) heading.prepend(createSpan({ cls: "silk-hub-guide-num", text: String(num) }));
      }
      // Top-level numbered lists of a section are its steps.
      el.querySelectorAll(":scope > ol, :scope > div > ol").forEach((ol) => ol.addClass("silk-hub-guide-steps"));
      this.body.appendChild(el);
      this.sections.push({ el, num, title, text: (el.textContent ?? "").toLowerCase(), tocItem: null });
    }
    this.body.createDiv({ cls: "silk-hub-guide-empty silk-hub-muted", text: t("nothingFound") }).hide();
  }

  /** Section references become links, images become zoomable figures. */
  private decorate(): void {
    const numbers = new Set(this.sections.map((s) => s.num).filter((n): n is number => n !== null));
    if (numbers.size > 0) {
      const walker = this.body.doc.createTreeWalker(this.body, NodeFilter.SHOW_TEXT);
      const texts: Text[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const parent = n.parentElement;
        if (!parent || parent.closest("code, pre, a, h1, h2, h3, h4, h5, h6")) continue;
        SECTION_REF.lastIndex = 0;
        if (SECTION_REF.test(n.nodeValue ?? "")) texts.push(n as Text);
      }
      texts.forEach((text) => linkSectionRefs(text, numbers));
    }

    for (const img of Array.from(this.body.querySelectorAll("img"))) {
      const alt = img.alt.trim();
      const anchor = img.parentElement?.hasClass("internal-embed") ? img.parentElement : img;
      const figure = createEl("figure", { cls: "silk-hub-guide-figure" });
      const parent = anchor.parentElement;
      // A paragraph that holds only the image becomes the figure itself.
      if (parent && parent.tagName === "P" && parent.childElementCount === 1 && (parent.textContent ?? "").trim() === (anchor.textContent ?? "").trim()) {
        parent.replaceWith(figure);
      } else {
        anchor.replaceWith(figure);
      }
      figure.appendChild(anchor);
      // Embeds of vault files get the file name as alt — not a caption.
      if (alt && !/\.\w{2,4}$/.test(alt)) figure.createEl("figcaption", { text: alt });
      img.addClass("silk-hub-guide-zoomable");
    }
  }

  private onBodyClick(e: MouseEvent): void {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const link = target.closest("a");
    if (link) {
      const ref = link.getAttribute("data-section");
      const num = ref !== null ? Number(ref) : guideLinkSection(link);
      if (num === null) return;
      // Keep Obsidian from opening a "guide.md" note that doesn't exist.
      e.preventDefault();
      e.stopPropagation();
      this.goTo(num, true);
      return;
    }

    if (target.instanceOf(HTMLImageElement) && target.hasClass("silk-hub-guide-zoomable")) {
      e.preventDefault();
      e.stopPropagation();
      new ImageModal(this.app, target.currentSrc || target.src, target.alt).open();
      return;
    }

    // Foldable callouts: handled here so it works whether or not MarkdownRenderer wired them up.
    const title = target.closest(".callout.is-collapsible > .callout-title");
    const callout = title?.parentElement;
    if (callout) {
      e.preventDefault();
      e.stopPropagation();
      const collapse = !callout.hasClass("is-collapsed");
      callout.toggleClass("is-collapsed", collapse);
      callout.querySelector(":scope > .callout-title .callout-fold")?.toggleClass("is-collapsed", collapse);
      const content = callout.querySelector<HTMLElement>(":scope > .callout-content");
      content?.toggle(!collapse);
    }
  }

  private buildToc(tocEl: HTMLElement): void {
    const toggle = tocEl.createDiv({ cls: "silk-hub-guide-toc-toggle", attr: { role: "button", tabindex: "0", "aria-expanded": "false" } });
    setIcon(toggle.createSpan({ cls: "silk-hub-guide-toc-toggle-icon" }), "list");
    toggle.createSpan({ cls: "silk-hub-guide-toc-toggle-label", text: t("contents") });
    this.tocCurrent = toggle.createSpan({ cls: "silk-hub-guide-toc-current" });
    setIcon(toggle.createSpan({ cls: "silk-hub-guide-toc-chevron" }), "chevron-down");
    const setOpen = (open: boolean) => {
      tocEl.toggleClass("is-open", open);
      toggle.setAttr("aria-expanded", String(open));
    };
    onActivate(toggle, () => setOpen(!tocEl.hasClass("is-open")));

    const panel = tocEl.createDiv({ cls: "silk-hub-guide-toc-panel" });
    this.search = new SearchComponent(panel.createDiv({ cls: "silk-hub-guide-search" }))
      .setPlaceholder(t("guideSearch"))
      .onChange((query) => this.filter(query));
    panel.createDiv({ cls: "silk-hub-guide-toc-title", text: t("contents") });
    const list = panel.createDiv({ cls: "silk-hub-guide-toc-list" });

    for (const section of this.sections) {
      const item = list.createDiv({ cls: "silk-hub-guide-toc-item", attr: { role: "button", tabindex: "0" } });
      if (section.num !== null) item.createSpan({ cls: "silk-hub-guide-toc-num", text: String(section.num) });
      item.createSpan({ cls: "silk-hub-guide-toc-text", text: section.title || t("guideIntro") });
      section.tocItem = item;
      onActivate(item, () => {
        this.scrollToSection(section, true);
        if (this.modalEl.hasClass("is-compact")) setOpen(false);
      });
    }
    panel.createDiv({ cls: "silk-hub-guide-empty silk-hub-muted", text: t("nothingFound") }).hide();

    // Highlight the section that occupies the top part of the body.
    const visible = new Set<HTMLElement>();
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target as HTMLElement);
          else visible.delete(entry.target as HTMLElement);
        }
        if (Date.now() < this.pinnedUntil) return;
        const first = this.sections.find((s) => visible.has(s.el) && s.el.isShown());
        if (first) this.setActive(first);
      },
      { root: this.body, rootMargin: "0px 0px -60% 0px" },
    );
    this.sections.forEach((s) => this.observer?.observe(s.el));
    // Short sections at the end never reach the top: at the very bottom the last one is active.
    this.body.addEventListener("scroll", () => {
      if (Date.now() < this.pinnedUntil) return;
      const { scrollTop, clientHeight, scrollHeight } = this.body;
      if (scrollTop > 0 && scrollTop + clientHeight >= scrollHeight - 2) {
        const last = [...this.sections].reverse().find((s) => s.el.isShown());
        if (last) this.setActive(last);
      }
    });
    this.setActive(this.sections[0]);
  }

  private setActive(section: GuideSection): void {
    if (this.active === section) return;
    this.active = section;
    for (const s of this.sections) s.tocItem?.toggleClass("is-active", s === section);
    if (this.tocCurrent) this.tocCurrent.setText(section.title || t("guideIntro"));
    if (!this.modalEl.hasClass("is-compact")) section.tocItem?.scrollIntoView({ block: "nearest" });
  }

  private filter(query: string): void {
    const q = query.trim();
    const match = q ? prepareSimpleSearch(q) : null;
    let shown = 0;
    for (const s of this.sections) {
      const ok = !match || match(`${s.title}\n${s.text}`) !== null;
      s.el.toggle(ok);
      s.tocItem?.toggle(ok);
      if (ok) shown++;
    }
    this.contentEl.querySelectorAll<HTMLElement>(".silk-hub-guide-empty").forEach((el) => el.toggle(shown === 0));
  }

  /** Scrolls to section N (0 — the top). Clears the search if it hides that section. */
  private goTo(num: number, smooth: boolean): void {
    const section = num === 0 ? this.sections[0] : this.sections.find((s) => s.num === num);
    if (!section) return;
    if (!section.el.isShown() && this.search) {
      this.search.setValue("");
      this.filter("");
    }
    this.scrollToSection(section, smooth);
  }

  private scrollToSection(section: GuideSection, smooth: boolean): void {
    this.pinnedUntil = Date.now() + 1000;
    this.setActive(section);
    this.body.scrollTo({ top: section.el.offsetTop, behavior: smooth ? "smooth" : "auto" });
  }

  /** Narrow windows and phones: the table of contents folds into a "Contents" button above the body. */
  private updateCompact(): void {
    const compact = Platform.isPhone || (this.media?.matches ?? false);
    this.modalEl.toggleClass("is-compact", compact);
    if (!compact) this.toc?.removeClass("is-open");
  }

  private async renderVersion(meta: HTMLElement, version: string): Promise<void> {
    if (!version) return;
    meta.createSpan({ cls: "silk-hub-muted", text: t("guideVersion", { version }) });
    let installed: string | null = null;
    try {
      installed = await this.plugin.installer.installedVersion(this.p.id);
    } catch {
      installed = null;
    }
    if (installed && installed !== version) {
      meta.createSpan({ cls: "silk-hub-guide-version-warning", text: t("guideVersionDiffers", { version: installed }) });
    }
  }
}

/** Removes "3. " from the start of a heading and returns 3; null when the heading isn't numbered. */
function stripNumber(heading: HTMLElement): number | null {
  const m = NUMBERED_HEADING.exec(heading.textContent ?? "");
  if (!m) return null;
  const walker = heading.doc.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const value = n.nodeValue ?? "";
    if (value.trim() === "") continue;
    if (!NUMBERED_HEADING.test(value)) return null;
    n.nodeValue = value.replace(NUMBERED_HEADING, "");
    return Number(m[1]);
  }
  return null;
}

/** Replaces "раздел 5" / "разделы 3 и 4" in a text node with links to those sections. */
function linkSectionRefs(text: Text, numbers: Set<number>): void {
  const value = text.nodeValue ?? "";
  const frag = createFragment();
  let last = 0;
  const link = (parent: DocumentFragment, label: string, num: number) =>
    parent.createEl("a", { cls: "silk-hub-guide-ref", text: label, href: `#${num}`, attr: { "data-section": String(num) } });

  for (const m of value.matchAll(SECTION_REF)) {
    const start = m.index ?? 0;
    frag.append(value.slice(last, start));
    const phrase = m[0];
    const nums = Array.from(phrase.matchAll(/\d+/g));
    if (nums.length === 1 && numbers.has(Number(nums[0][0]))) {
      link(frag, phrase, Number(nums[0][0]));
    } else {
      let pos = 0;
      for (const n of nums) {
        const at = n.index ?? 0;
        frag.append(phrase.slice(pos, at));
        if (numbers.has(Number(n[0]))) link(frag, n[0], Number(n[0]));
        else frag.append(n[0]);
        pos = at + n[0].length;
      }
      frag.append(phrase.slice(pos));
    }
    last = start + phrase.length;
  }
  frag.append(value.slice(last));
  text.replaceWith(frag);
}

/** Enter and Space activate keyboard-focusable pseudo-buttons, like a click. */
function onActivate(el: HTMLElement, action: () => void): void {
  el.addEventListener("click", action);
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    action();
  });
}

/** A guide image at full size; closes on click or Esc. */
class ImageModal extends Modal {
  constructor(
    app: App,
    private src: string,
    private alt: string,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("silk-hub-image-modal");
    const img = this.contentEl.createEl("img", { attr: { src: this.src, alt: this.alt } });
    img.addEventListener("click", () => this.close());
    this.contentEl.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

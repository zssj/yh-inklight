/**
 * [INPUT]: 依赖 AnnotationStore 的标签索引与文档缓存、cardModel 的卡片拍平、navigation 的三端跳转
 * [OUTPUT]: 对外提供 TagBoardView（标签 → 文档 → 批注 三栏主从，含窄屏降级）与 TAG_BOARD_VIEW_TYPE
 * [POS]: views 模块的内容关系视图，跨文档按标签聚合批注；不写回任何 Markdown
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { ItemView, TFile, WorkspaceLeaf } from "obsidian";

import type OverlayAnnotationsPlugin from "../../main";
import type { TagDictionaryEntry, TaggedFileEntry } from "../storage/annotationStore";
import { hasTag } from "../storage/tags";
import { buildCards, SidebarCard } from "./cardModel";
import { openAnnotationTarget } from "./navigation";

export const TAG_BOARD_VIEW_TYPE = "inklight-tag-board";

type LayoutMode = "three" | "two" | "one";
type ColumnKey = "tags" | "files" | "notes";

const COLUMN_CLASS: Record<ColumnKey, string> = {
  tags: "yh-tagboard-tags",
  files: "yh-tagboard-files",
  notes: "yh-tagboard-notes",
};

/** 左栏最多渲染多少个标签（超出靠筛选框收敛） */
const MAX_TAG_ROWS = 200;

export class TagBoardView extends ItemView {
  private selectedTagKey = "";
  private selectedFilePath = "";
  private tagSearch = "";
  private layout: LayoutMode = "three";
  private mobileLevel: ColumnKey = "tags";
  private renderToken = 0;
  private resizeObserver: ResizeObserver | null = null;
  private observedWidth = 0;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: OverlayAnnotationsPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return TAG_BOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "标签总览";
  }

  getIcon(): string {
    return "tags";
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("yh-tagboard-view");
    await this.render();
    this.setupResizeObserver();
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  /** 供侧栏 chip / 「在总览中查看」调用：定位到指定标签 */
  focusTag(key: string): void {
    if (!key) {
      return;
    }
    this.selectedTagKey = key;
    this.selectedFilePath = "";
    this.tagSearch = "";
    this.mobileLevel = "files";
    void this.render();
  }

  private getRootEl(): HTMLElement | null {
    return (this.containerEl.children[1] as HTMLElement | undefined) ?? null;
  }

  private setupResizeObserver(): void {
    const root = this.getRootEl();
    if (!root || typeof ResizeObserver === "undefined") {
      return;
    }
    this.observedWidth = root.clientWidth;
    this.layout = this.layoutForWidth(this.observedWidth);
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? root.clientWidth;
      if (Math.abs(width - this.observedWidth) < 24) {
        return;
      }
      this.observedWidth = width;
      const next = this.layoutForWidth(width);
      if (next !== this.layout) {
        this.layout = next;
        this.applyLayout();
      }
    });
    this.resizeObserver.observe(root);
  }

  private layoutForWidth(width: number): LayoutMode {
    if (width >= 700) {
      return "three";
    }
    return width >= 480 ? "two" : "one";
  }

  async render(): Promise<void> {
    const token = ++this.renderToken;
    const root = this.getRootEl();
    if (!root) {
      return;
    }

    root.empty();
    root.addClass("yh-tagboard");
    root.setAttribute("data-layout", this.layout);

    await this.plugin.store.ensureTagIndex();
    if (token !== this.renderToken) {
      return;
    }

    const dictionary = this.plugin.store.getTagDictionary();
    if (dictionary.length === 0) {
      const empty = root.createDiv({ cls: "yh-tagboard-empty" });
      empty.createDiv({ text: "还没有标签" });
      empty.createDiv({
        cls: "yh-tagboard-empty-hint",
        text: "在批注卡片下方点 + 添加第一个标签，它们会在这里按主题聚起来。",
      });
      return;
    }

    if (!dictionary.some((item) => item.key === this.selectedTagKey)) {
      this.selectedTagKey = dictionary[0].key;
      this.selectedFilePath = "";
    }

    const files = this.plugin.store.getFilesForTag(this.selectedTagKey);
    if (!files.some((item) => item.filePath === this.selectedFilePath)) {
      this.selectedFilePath = files[0]?.filePath ?? "";
    }

    const tagCol = root.createDiv({ cls: `yh-tagboard-col ${COLUMN_CLASS.tags}` });
    const fileCol = root.createDiv({ cls: `yh-tagboard-col ${COLUMN_CLASS.files}` });
    const noteCol = root.createDiv({ cls: `yh-tagboard-col ${COLUMN_CLASS.notes}` });

    this.renderTagColumn(tagCol, dictionary);
    this.renderFileColumn(fileCol, files);
    await this.renderNoteColumn(noteCol, token);

    if (token !== this.renderToken) {
      return;
    }
    this.applyLayout();
  }

  /** 三档布局：wide 三栏并排；mid 收起标签栏；narrow 单栏 + 面包屑 */
  private applyLayout(): void {
    const root = this.getRootEl();
    if (!root) {
      return;
    }
    root.setAttribute("data-layout", this.layout);

    for (const key of Object.keys(COLUMN_CLASS) as ColumnKey[]) {
      root.querySelector(`.${COLUMN_CLASS[key]}`)?.toggleClass("is-active", key === this.mobileLevel);
    }

    root.querySelector(".yh-tagboard-crumbs")?.remove();
    if (this.layout !== "one") {
      return;
    }

    const crumbs = root.createDiv({ cls: "yh-tagboard-crumbs" });
    root.prepend(crumbs);

    const tagName = this.plugin.store.getTagDisplayName(this.selectedTagKey) || "标签";
    const fileName = this.selectedFilePath.split("/").pop() ?? "";

    if (this.mobileLevel === "tags") {
      crumbs.createSpan({ cls: "yh-tagboard-crumb is-current", text: "标签" });
      return;
    }

    const back = crumbs.createSpan({ cls: "yh-tagboard-crumb", text: `‹ ${tagName}` });
    back.addEventListener("click", () => {
      this.mobileLevel = "tags";
      this.applyLayout();
    });

    if (this.mobileLevel === "files") {
      crumbs.createSpan({ cls: "yh-tagboard-crumb is-current", text: "　文档" });
      return;
    }

    const backToFiles = crumbs.createSpan({ cls: "yh-tagboard-crumb", text: "　文档" });
    backToFiles.addEventListener("click", () => {
      this.mobileLevel = "files";
      this.applyLayout();
    });
    crumbs.createSpan({ cls: "yh-tagboard-crumb is-current", text: `　${fileName}` });
  }

  private renderTagColumn(col: HTMLElement, dictionary: TagDictionaryEntry[]): void {
    const head = col.createDiv({ cls: "yh-tagboard-head" });
    head.createSpan({ cls: "yh-tagboard-head-title", text: "标签" });
    head.createSpan({ cls: "yh-tagboard-head-count", text: `${dictionary.length} 个` });

    const search = col.createEl("input", {
      cls: "yh-tagboard-search",
      attr: { type: "search", placeholder: "筛选标签…" },
    });
    search.value = this.tagSearch;

    const list = col.createDiv({ cls: "yh-tagboard-list" });
    this.renderTagList(list, dictionary);

    // 只重绘列表，保持输入框焦点
    search.addEventListener("input", () => {
      this.tagSearch = search.value;
      this.renderTagList(list, dictionary);
    });
  }

  private renderTagList(list: HTMLElement, dictionary: TagDictionaryEntry[]): void {
    list.empty();
    const query = this.tagSearch.trim().toLowerCase();
    const filtered = dictionary.filter((item) => !query || item.name.toLowerCase().includes(query));

    if (filtered.length === 0) {
      list.createDiv({ cls: "yh-tagboard-empty-hint", text: "没有匹配的标签" });
      return;
    }

    for (const item of filtered.slice(0, MAX_TAG_ROWS)) {
      const row = list.createDiv({ cls: "yh-tagboard-row" });
      row.toggleClass("is-active", item.key === this.selectedTagKey);
      row.createSpan({ cls: "yh-tagboard-row-name", text: item.name });
      row.createSpan({ cls: "yh-tagboard-row-count", text: String(item.fileCount) });
      row.addEventListener("click", () => {
        this.selectedTagKey = item.key;
        this.selectedFilePath = "";
        this.mobileLevel = "files";
        void this.render();
      });
    }

    if (filtered.length > MAX_TAG_ROWS) {
      list.createDiv({
        cls: "yh-tagboard-empty-hint",
        text: `还有 ${filtered.length - MAX_TAG_ROWS} 个标签，用上方筛选框缩小范围`,
      });
    }
  }

  private renderFileColumn(col: HTMLElement, files: TaggedFileEntry[]): void {
    const head = col.createDiv({ cls: "yh-tagboard-head" });
    head.createSpan({
      cls: "yh-tagboard-head-title",
      text: this.plugin.store.getTagDisplayName(this.selectedTagKey) || "标签",
    });
    head.createSpan({ cls: "yh-tagboard-head-count", text: `${files.length} 篇` });

    const list = col.createDiv({ cls: "yh-tagboard-list" });
    if (files.length === 0) {
      list.createDiv({ cls: "yh-tagboard-empty-hint", text: "没有命中的文档" });
      return;
    }

    for (const item of files) {
      const row = list.createDiv({ cls: "yh-tagboard-row yh-tagboard-file-row" });
      row.toggleClass("is-active", item.filePath === this.selectedFilePath);
      const name = item.filePath.split("/").pop() ?? item.filePath;
      row.createSpan({ cls: "yh-tagboard-row-name", text: name });
      row.createSpan({ cls: "yh-tagboard-row-count", text: String(item.totalAnnotations) });
      row.setAttribute("title", item.filePath);
      row.addEventListener("click", () => {
        this.selectedFilePath = item.filePath;
        this.mobileLevel = "notes";
        void this.render();
      });
    }
  }

  private async renderNoteColumn(col: HTMLElement, token: number): Promise<void> {
    const head = col.createDiv({ cls: "yh-tagboard-head" });
    const list = col.createDiv({ cls: "yh-tagboard-list" });

    const file = this.selectedFilePath
      ? this.app.vault.getAbstractFileByPath(this.selectedFilePath)
      : null;
    if (!(file instanceof TFile)) {
      head.createSpan({ cls: "yh-tagboard-head-title", text: "批注" });
      list.createDiv({ cls: "yh-tagboard-empty-hint", text: "选一篇文档查看它的批注" });
      return;
    }

    const document = await this.plugin.store.getDocument(file);
    if (token !== this.renderToken) {
      return;
    }

    const cards = buildCards(document).filter((card) => hasTag(card.tags, this.selectedTagKey));
    head.createSpan({ cls: "yh-tagboard-head-title", text: file.basename });
    head.createSpan({ cls: "yh-tagboard-head-count", text: `${cards.length} 条` });

    if (cards.length === 0) {
      list.createDiv({ cls: "yh-tagboard-empty-hint", text: "这篇文档没有该标签的批注" });
      return;
    }

    for (const card of cards) {
      this.renderCard(list, file, card);
    }
  }

  private renderCard(list: HTMLElement, file: TFile, card: SidebarCard): void {
    const el = list.createDiv({ cls: "yh-tagboard-card", attr: { "data-color": card.color } });
    el.toggleClass("is-orphaned", !!card.orphaned);

    el.createDiv({ cls: "yh-tagboard-quote", text: card.text });
    if (card.content) {
      el.createDiv({ cls: "yh-tagboard-note", text: card.content });
    }

    const meta = el.createDiv({ cls: "yh-tagboard-card-meta" });
    meta.createSpan({ text: this.positionLabel(card) });
    const jump = meta.createSpan({ cls: "yh-tagboard-jump", text: "跳回原文 →" });
    jump.setAttribute("role", "button");
    jump.addEventListener("click", () => {
      void openAnnotationTarget(
        this.app,
        {
          file,
          offset: card.startOffset,
          pageNumber: card.pageNumber,
          mode: card.mode,
          cfiRange: card.cfiRange,
        },
        (target, cfi) => this.plugin.navigateEpubToCfi(target, cfi),
      );
    });
  }

  private positionLabel(card: SidebarCard): string {
    if (card.mode === "pdf" && card.pageNumber) {
      return `第 ${card.pageNumber} 页`;
    }
    if (card.mode === "epub" && card.chapter) {
      return card.chapter;
    }
    return card.kind === "highlight" ? "高亮" : "笔记";
  }
}

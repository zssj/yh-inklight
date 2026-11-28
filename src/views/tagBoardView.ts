/**
 * [INPUT]: 依赖 AnnotationStore 的标签索引与文档缓存、cardModel 的卡片拍平、navigation 的三端跳转
 * [OUTPUT]: 对外提供 TagBoardView（标签 → 文档 → 批注 三栏主从，含窄屏降级）、
 *           标签重命名/删除入口（影响范围确认 + 逐文件失败汇总）与 TAG_BOARD_VIEW_TYPE
 * [POS]: views 模块的内容关系视图，跨文档按标签聚合批注；不写回任何 Markdown，
 *        标签的结构性修改全部交给 storage/annotationStore，视图只收集意图与展示结果
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { App, ItemView, Menu, Modal, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";

import type OverlayAnnotationsPlugin from "../../main";
import type {
  TagDictionaryEntry,
  TaggedFileEntry,
  TagMutationResult,
  TagUsage,
} from "../storage/annotationStore";
import { hasTag, normalizeTag } from "../storage/tags";
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
  /** 批量改标签期间挡住第二次操作，避免两个写循环交叉覆盖 sidecar */
  private mutating = false;

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

      const menu = row.createSpan({
        cls: "yh-tagboard-row-menu",
        attr: { role: "button", "aria-label": `管理标签 ${item.name}`, tabindex: "0" },
      });
      setIcon(menu, "more-horizontal");
      menu.addEventListener("click", (event) => {
        event.stopPropagation();
        this.openTagMenu(item, event);
      });
      menu.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const rect = menu.getBoundingClientRect();
        this.openTagMenu(item, new MouseEvent("click", {
          clientX: rect.left,
          clientY: rect.bottom,
          bubbles: true,
        }));
      });

      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.openTagMenu(item, event);
      });
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

  private openTagMenu(item: TagDictionaryEntry, event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((menuItem) => {
      menuItem
        .setTitle("重命名标签")
        .setIcon("pencil")
        .onClick(() => this.openRenameTag(item));
    });
    menu.addItem((menuItem) => {
      menuItem
        .setTitle("删除标签")
        .setIcon("trash-2")
        .onClick(() => void this.confirmDeleteTag(item));
    });
    menu.showAtMouseEvent(event);
  }

  private openRenameTag(item: TagDictionaryEntry): void {
    new RenameTagModal(this.app, item.name, (value) => {
      void this.applyRenameTag(item, value);
    }).open();
  }

  private async applyRenameTag(item: TagDictionaryEntry, rawName: string): Promise<void> {
    if (this.mutating) {
      return;
    }
    const display = normalizeTag(rawName);
    if (!display) {
      new Notice("标签名不能为空");
      return;
    }
    if (display === item.name) {
      return;
    }

    this.mutating = true;
    try {
      const result = await this.plugin.store.renameTag(item.key, display);
      this.plugin.invalidateRelations();
      this.selectedTagKey = result.newKey ?? item.key;
      this.selectedFilePath = "";
      await this.plugin.refreshAnnotations();
      await this.render();
      this.notifyMutation("重命名", result);
    } catch (error) {
      console.warn("yh-inklight: 重命名标签失败", error);
      new Notice(`重命名标签失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.mutating = false;
    }
  }

  private async confirmDeleteTag(item: TagDictionaryEntry): Promise<void> {
    if (this.mutating) {
      return;
    }

    let usage: TagUsage;
    try {
      usage = await this.plugin.store.getTagUsage(item.key);
    } catch (error) {
      new Notice(`统计标签影响范围失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (usage.annotationCount === 0) {
      new Notice("这个标签已经没有批注在使用了");
      return;
    }

    new DeleteTagModal(this.app, item.name, usage, () => {
      void this.applyDeleteTag(item);
    }).open();
  }

  private async applyDeleteTag(item: TagDictionaryEntry): Promise<void> {
    if (this.mutating) {
      return;
    }

    this.mutating = true;
    try {
      const result = await this.plugin.store.deleteTag(item.key);
      this.plugin.invalidateRelations();
      if (this.selectedTagKey === item.key) {
        this.selectedTagKey = "";
        this.selectedFilePath = "";
      }
      await this.plugin.refreshAnnotations();
      await this.render();
      this.notifyMutation("删除", result);
    } catch (error) {
      console.warn("yh-inklight: 删除标签失败", error);
      new Notice(`删除标签失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.mutating = false;
    }
  }

  private notifyMutation(action: string, result: TagMutationResult): void {
    if (result.failed.length > 0) {
      console.warn("yh-inklight: 标签批量操作存在失败文件", result.failed);
      new Notice(
        `${action}完成，但有 ${result.failed.length} 个文件失败（成功 ${result.changedFiles} 个 / ${result.changedAnnotations} 条批注），详情见控制台`,
        8000,
      );
      return;
    }
    if (result.changedFiles === 0) {
      new Notice("没有需要修改的批注");
      return;
    }
    new Notice(`${action}成功：${result.changedFiles} 个文件 / ${result.changedAnnotations} 条批注`);
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
      // 程序化「查看批注目标」不改「当前文件」范围视角（同 sidebarView.jumpTo）
      void this.plugin.openKeepingScope(() =>
        openAnnotationTarget(
          this.app,
          {
            file,
            offset: card.startOffset,
            pageNumber: card.pageNumber,
            mode: card.mode,
            cfiRange: card.cfiRange,
          },
          // 必须是「打开书 + 定位」：navigateEpubToCfi 只定位已打开的阅读器，书没开就什么都不做
          (target, cfi) => this.plugin.openEpubAtCfi(target.path, cfi),
        ),
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

/** 重命名输入框。实际写入由 TagBoardView 负责，Modal 只收集名称，避免 UI 持有写入逻辑。 */
class RenameTagModal extends Modal {
  constructor(
    app: App,
    private readonly currentName: string,
    private readonly onSubmit: (value: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("yh-tagboard-modal");
    contentEl.createEl("h3", { text: "重命名标签" });
    contentEl.createEl("p", {
      cls: "yh-tagboard-modal-hint",
      text: `当前标签：${this.currentName}。如果目标标签已存在，会合并到目标标签，批注不会丢失。`,
    });

    const input = contentEl.createEl("input", {
      cls: "yh-tagboard-modal-input",
      attr: { type: "text", placeholder: "新的标签名" },
    });
    input.value = this.currentName;

    const actions = contentEl.createDiv({ cls: "yh-tagboard-modal-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    const submit = actions.createEl("button", { text: "重命名" });
    submit.addClass("mod-cta");

    const apply = (): void => {
      const value = input.value.trim();
      if (!value) {
        input.focus();
        return;
      }
      this.close();
      this.onSubmit(value);
    };

    cancel.addEventListener("click", () => this.close());
    submit.addEventListener("click", apply);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        apply();
      }
    });

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 删除确认框：明确写出影响范围，并强调只摘标签、不删批注。 */
class DeleteTagModal extends Modal {
  constructor(
    app: App,
    private readonly tagName: string,
    private readonly usage: TagUsage,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("yh-tagboard-modal");
    contentEl.createEl("h3", { text: "删除标签" });
    contentEl.createEl("p", {
      cls: "yh-tagboard-modal-hint",
      text: `将从 ${this.usage.fileCount} 个文件的 ${this.usage.annotationCount} 条批注上移除「${this.tagName}」。`,
    });
    contentEl.createEl("p", {
      cls: "yh-tagboard-modal-warning",
      text: "只会删除标签本身，不会删除任何批注或原文。此操作不可撤销。",
    });

    const actions = contentEl.createDiv({ cls: "yh-tagboard-modal-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    const confirm = actions.createEl("button", { text: "删除标签" });
    confirm.addClass("mod-warning");

    cancel.addEventListener("click", () => this.close());
    confirm.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

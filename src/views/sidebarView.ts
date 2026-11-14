/**
 * [INPUT]: 依赖 Obsidian ItemView、AnnotationStore 数据与插件主类回调
 * [OUTPUT]: 对外提供 AnnotationSidebarView，将当前文件或全库 annotation 合并为可筛选、可跳转、可导出的总览卡片，卡片可挂标签；
 *           标签编辑按内容推荐历史标签，卡片底部折叠展示字面相关的其他批注（受 contentRelations 设置控制）；
 *           相关行可「确认关联」：把一个共享标签写入两侧批注（行内选择条挑标签，可见可改可取消），
 *           已确认的关联显示为「已关联 xx」chip，点 chip 从两侧断开——确认结果落在 tags 字段上，是 MOC 的共享标签
 * [POS]: views 模块的右侧 Leaf 总览面板，承载搜索、颜色/类型/标签筛选、排序、行内编辑、标签编辑、跳转、删除、导出模板、字面关联与确认关联；
 *        顶部搜索/范围/筛选/排序/导出统一收进单一折叠菜单（默认收起，展开态记在视图字段上），列表区域常驻不被菜单挤压；
 *        移动端标签编辑态额外处理软键盘遮挡（列表补底部留白 + 输入框滚入可视区），不触碰阅读区；
 *        标签编辑期间 requestRender / refreshList 只登记不重绘，退出编辑后才补，且重绘重建不抢焦点
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { ItemView, MarkdownRenderer, MarkdownView, Notice, Platform, setIcon, TFile, WorkspaceLeaf } from "obsidian";

import type OverlayAnnotationsPlugin from "../../main";
import { formatTime } from "../utils/format";
import { observeKeyboardInset } from "../utils/keyboardInset";
import {
  ANNOTATION_COLORS,
  AnnotationColor,
  AnnotationExportFormat,
  AnnotationSortMode,
  COLOR_LABELS,
  CommentAnnotation,
  EpubCommentAnnotation,
  EpubHighlightAnnotation,
  FileAnnotationDocument,
  HighlightAnnotation,
  PdfCommentAnnotation,
  PdfHighlightAnnotation,
} from "../storage/types";
import { AnnotationKind, AnnotationMode, buildCards, SidebarCard } from "./cardModel";
import { renderTagChips, renderTagInput, TagSuggestion } from "./tagInput";
import { RelationModel } from "./relationModel";
import { openAnnotationTarget } from "./navigation";
import { hasTag, normalizeTag, tagKey, unionTags } from "../storage/tags";
import type { TagRef } from "../storage/annotationStore";

export const ANNOTATION_SIDEBAR_VIEW = "yh-inklight-sidebar";

type AnnotationScope = "current" | "all";
type TypeFilter = "all" | AnnotationKind;

export class AnnotationSidebarView extends ItemView {
  private annotationScope: AnnotationScope = "current";
  private query = "";
  private color: AnnotationColor | "all" = "all";
  private type: TypeFilter = "all";
  private sort: AnnotationSortMode = "document";
  /** 标签筛选的比较键；空字符串表示不筛选 */
  private tagFilter = "";
  private exportFormat: AnnotationExportFormat = "summary";
  /**
   * 顶部折叠菜单的展开态；必须存在视图字段上，重绘后仍保持用户上一次的选择。
   * 展开/收起以 panel.hidden 为唯一硬状态（见 applyMenuVisibility），class 只用于样式。
   */
  private menuOpen = false;
  /** 菜单面板与触发按钮的直连引用：render 时登记，点击时直接操作，不再靠 querySelector 二次查找 */
  private menuPanel: HTMLElement | null = null;
  private menuButton: HTMLElement | null = null;
  private renderToken = 0;
  private renderTimer: number | null = null;
  /**
   * 当前处于标签编辑态的卡片 id。
   * 编辑态必须记在视图上而不是只挂在 DOM class 上，否则任何一次重绘都会把输入框冲掉。
   */
  private editingTagCardId: string | null = null;
  /** 字面关联的按需内存快照：随 store.version 自动失效，不落盘 */
  private readonly relations: RelationModel;
  /** 移动端标签编辑态的键盘监听清理：同一时刻只允许一个编辑态持有 */
  private keyboardCleanup: (() => void) | null = null;
  /** 标签编辑期间被挡下的重绘请求，编辑结束后补一次 */
  private pendingRender = false;
  /** 只有用户主动点「+」进入编辑态时才抢焦点；重绘重建不抢，否则输入法会自动弹起 */
  private tagEditorAutoFocus = false;
  /** 编辑态里尚未提交的输入，重绘回填用，避免一次刷新吞掉正在打的标签 */
  private pendingTagQuery = "";
  /** 相关区 details 的展开态记在视图字段上：确认关联触发的重绘不会把用户刚展开的相关区折回去 */
  private readonly openRelated = new Set<string>();

  constructor(leaf: WorkspaceLeaf, private readonly plugin: OverlayAnnotationsPlugin) {
    super(leaf);
    this.relations = new RelationModel(plugin.store);
  }

  getViewType(): string {
    return ANNOTATION_SIDEBAR_VIEW;
  }

  getDisplayText(): string {
    return "墨光批注";
  }

  getIcon(): string {
    return "yh-inklight-icon";
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("yh-sidebar");
    // 点击委托挂在视图根节点上：header 每次重绘都会重建按钮，
    // 绑在按钮自身上的监听会随节点一起消失，委托则始终有效。
    this.registerDomEvent(this.containerEl, "click", (event) => this.handleViewClick(event));
    await this.render();
  }

  async onClose(): Promise<void> {
    this.menuPanel = null;
    this.menuButton = null;
    this.keyboardCleanup?.();
    this.keyboardCleanup = null;
    this.pendingRender = false;
    this.pendingTagQuery = "";
    this.tagEditorAutoFocus = false;
    this.openRelated.clear();
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
  }

  requestRender(): void {
    // 标签编辑态下整表重建会删掉输入框：既丢未提交内容，又会 rAF 抢焦点把输入法顶出来。
    // 先记下请求，等编辑结束再补一次重绘。
    if (this.editingTagCardId !== null) {
      this.pendingRender = true;
      return;
    }
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
    }
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      void this.render();
    }, 0);
  }

  async render(): Promise<void> {
    const token = ++this.renderToken;
    const container = this.containerEl.children[1] ?? this.containerEl;
    container.empty();
    container.addClass("yh-overview");

    const file = this.app.workspace.getActiveFile();
    this.renderHeader(container);
    this.renderMenu(container, file);

    if (this.annotationScope === "current" && !file) {
      container.createDiv({ cls: "yh-empty", text: "Open a Markdown or PDF file to inspect annotations." });
      return;
    }

    const documents =
      this.annotationScope === "all" ? await this.plugin.store.getIndexedDocuments() : [await this.plugin.store.getDocument(file!)];
    if (token !== this.renderToken) {
      return;
    }
    if (this.plugin.settings.contentRelations) {
      await this.relations.prepare(documents);
      if (token !== this.renderToken) {
        return;
      }
    }
    const rawCards = documents.flatMap((document) => buildCards(document));
    const cards = this.filterCards(rawCards);
    const highlightCount = rawCards.filter((card) => card.kind === "highlight" && !card.orphaned).length;
    const noteCount = rawCards.filter((card) => card.note && !card.orphaned).length;
    const scopeLabel = this.annotationScope === "all" ? `${documents.length} files` : "current file";
    container.createDiv({ cls: "yh-ov-count", text: `${scopeLabel} · ${highlightCount} highlights · ${noteCount} notes` });

    const list = container.createDiv({ cls: "yh-ov-list" });
    if (!cards.length) {
      list.createDiv({ cls: "yh-empty", text: "No matching annotations." });
    } else {
      for (const card of cards) {
        this.renderCard(list, card);
      }
    }
  }

  /**
   * 只刷新卡片列表（不重建搜索框等控件），用于搜索输入时保持焦点。
   */
  private async refreshList(): Promise<void> {
    // 与 requestRender 同因：编辑态下重建列表会丢输入、抢焦点
    if (this.editingTagCardId !== null) {
      this.pendingRender = true;
      return;
    }
    const root = this.containerEl.children[1] ?? this.containerEl;
    const list = root.querySelector<HTMLElement>(".yh-ov-list");
    if (!list) {
      await this.render();
      return;
    }
    const file = this.app.workspace.getActiveFile();
    if (this.annotationScope === "current" && !file) {
      await this.render();
      return;
    }
    const documents =
      this.annotationScope === "all"
        ? await this.plugin.store.getIndexedDocuments()
        : [await this.plugin.store.getDocument(file!)];
    if (this.plugin.settings.contentRelations) {
      await this.relations.prepare(documents);
    }
    const rawCards = documents.flatMap((document) => buildCards(document));
    const cards = this.filterCards(rawCards);

    list.empty();
    if (!cards.length) {
      list.createDiv({ cls: "yh-empty", text: "No matching annotations." });
    } else {
      for (const card of cards) {
        this.renderCard(list, card);
      }
    }

    const countEl = root.querySelector<HTMLElement>(".yh-ov-count");
    if (countEl) {
      const highlightCount = rawCards.filter((card) => card.kind === "highlight" && !card.orphaned).length;
      const noteCount = rawCards.filter((card) => card.note && !card.orphaned).length;
      const scopeLabel = this.annotationScope === "all" ? `${documents.length} files` : "current file";
      countEl.textContent = `${scopeLabel} · ${highlightCount} highlights · ${noteCount} notes`;
    }
  }

  private renderHeader(container: Element): void {
    const header = container.createDiv({ cls: "yh-ov-head" });
    header.createSpan({ cls: "yh-ov-title", text: "Inklight" });
    const actions = header.createDiv({ cls: "yh-ov-head-actions" });

    // 搜索/范围/筛选/排序/导出的唯一入口：默认收起，点击展开；有生效筛选时点亮小圆点
    const menu = actions.createEl("button", {
      cls: "yh-icon-btn yh-ov-menu-btn",
      attr: {
        type: "button",
        title: "筛选与导出",
        "aria-label": "筛选与导出",
        "aria-expanded": String(this.menuOpen),
      },
    });
    setIcon(menu, "sliders-horizontal");
    this.menuButton = menu;
    this.applyMenuVisibility();

    const refresh = actions.createEl("button", {
      cls: "yh-icon-btn yh-ov-refresh",
      attr: { type: "button", title: "Refresh", "aria-label": "Refresh annotations" },
    });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => this.requestRender());

    const close = actions.createEl("button", {
      cls: "yh-icon-btn yh-ov-close",
      attr: { type: "button", title: "Close panel", "aria-label": "Close panel" },
    });
    setIcon(close, "x");
    close.addEventListener("click", () => {
      void this.leaf.detach();
    });
  }

  /** 视图级点击委托：目前只处理顶部菜单按钮，避免按钮被重绘重建后丢失监听 */
  private handleViewClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.closest(".yh-ov-menu-btn")) {
      return;
    }
    // 阻断冒泡：插件在 document 上还有批注点击处理，侧栏点击不应触发它
    event.preventDefault();
    event.stopPropagation();
    this.setMenuOpen(!this.menuOpen);
  }

  /**
   * 唯一的菜单开合入口：字段 + 面板 hidden + 按钮 aria/样式一次写齐。
   * hidden 是硬开关（CSS 用 [hidden] 兜底），不依赖 is-open 类是否被正确移除。
   */
  private setMenuOpen(open: boolean): void {
    this.menuOpen = open;
    this.applyMenuVisibility();
  }

  private applyMenuVisibility(): void {
    const panel = this.menuPanel;
    if (panel) {
      panel.toggleClass("is-open", this.menuOpen);
      panel.hidden = !this.menuOpen;
    }
    const button = this.menuButton;
    if (button) {
      button.toggleClass("is-open", this.menuOpen);
      button.setAttribute("aria-expanded", String(this.menuOpen));
      button.toggleClass("is-active", this.hasActiveFilters());
    }
  }

  /** 有任一筛选/搜索/范围生效时，菜单按钮点亮小圆点，收起态也能看出列表被过滤过 */
  private hasActiveFilters(): boolean {
    return (
      this.query.trim().length > 0 ||
      this.annotationScope !== "current" ||
      this.color !== "all" ||
      this.type !== "all" ||
      this.tagFilter !== ""
    );
  }

  /**
   * 顶部控件统一收进一个折叠菜单：默认收起，避免搜索 + 五个下拉 + 导出常驻把列表挤成窄条。
   * 展开态记在 this.menuOpen 上，任何一次重绘（改筛选、刷新）后保持展开；
   * 展开/收起只切菜单自身的 class，不重绘列表，因此列表内容与滚动位置都不受影响。
   */
  private renderMenu(container: Element, file: TFile | null): void {
    // 默认按收起态创建（带 hidden），再由 applyMenuVisibility 按 menuOpen 校正，避免首帧闪开
    const panel = container.createDiv({ cls: "yh-ov-menu", attr: { hidden: "hidden" } });
    this.menuPanel = panel;
    this.applyMenuVisibility();

    // 搜索批注
    const search = panel.createEl("input", {
      cls: "yh-ov-search",
      attr: { type: "search", placeholder: "搜索批注..." },
    });
    search.value = this.query;
    let searchTimer: number | null = null;
    search.addEventListener("input", () => {
      this.query = search.value;
      // 搜索只走 refreshList（不整表重建），徽标点手动同步，收起后仍能看出列表被过滤
      this.menuButton?.toggleClass("is-active", this.hasActiveFilters());
      if (searchTimer !== null) {
        window.clearTimeout(searchTimer);
      }
      searchTimer = window.setTimeout(() => {
        searchTimer = null;
        void this.refreshList();
      }, 200);
    });

    // 范围：当前文件 / 全库
    const scope = panel.createEl("select", { cls: "yh-filter-select", attr: { title: "批注范围" } });
    scope.createEl("option", { text: "当前文件", value: "current" });
    scope.createEl("option", { text: "全库", value: "all" });
    scope.value = this.annotationScope;
    scope.addEventListener("change", async () => {
      this.annotationScope = scope.value as AnnotationScope;
      await this.render();
    });

    const filterRow = panel.createDiv({ cls: "yh-ov-menu-row" });
    const color = filterRow.createEl("select", { cls: "yh-filter-select" });
    color.createEl("option", { text: "全部颜色", value: "all" });
    for (const item of ANNOTATION_COLORS) {
      color.createEl("option", { text: COLOR_LABELS[item], value: item });
    }
    color.value = this.color;
    color.addEventListener("change", async () => {
      this.color = color.value as AnnotationColor | "all";
      await this.render();
    });

    const type = filterRow.createEl("select", { cls: "yh-filter-select" });
    type.createEl("option", { text: "全部类型", value: "all" });
    type.createEl("option", { text: "高亮", value: "highlight" });
    type.createEl("option", { text: "笔记", value: "note" });
    type.value = this.type;
    type.addEventListener("change", async () => {
      this.type = type.value as TypeFilter;
      await this.render();
    });

    const sortRow = panel.createDiv({ cls: "yh-ov-menu-row" });
    const sort = sortRow.createEl("select", { cls: "yh-filter-select" });
    const sortOptions = { document: "文档顺序", newest: "最新优先", oldest: "最早优先" } as const;
    for (const item of ["document", "newest", "oldest"] as const) {
      sort.createEl("option", { text: sortOptions[item], value: item });
    }
    sort.value = this.sort;
    sort.addEventListener("change", async () => {
      this.sort = sort.value as AnnotationSortMode;
      await this.render();
    });

    // 标签筛选：选项来自内存索引，按文件数降序；选中后自动切全库，否则当前文件里常为空
    const tagRow = panel.createDiv({ cls: "yh-ov-menu-row" });
    const tagSelect = tagRow.createEl("select", {
      cls: "yh-filter-select yh-tag-filter",
      attr: { title: "按标签筛选" },
    });
    tagSelect.createEl("option", { text: "全部标签", value: "" });
    const dictionary = this.plugin.store.getTagDictionary();
    const currentKey = this.tagFilter;
    const visibleTags = dictionary.filter((item, index) => index < 20 || item.key === currentKey);
    for (const item of visibleTags) {
      tagSelect.createEl("option", { text: `${item.name} (${item.fileCount})`, value: item.key });
    }
    if (currentKey && !dictionary.some((item) => item.key === currentKey)) {
      tagSelect.createEl("option", { text: currentKey, value: currentKey });
    }
    tagSelect.value = currentKey;
    tagSelect.addEventListener("change", async () => {
      this.tagFilter = tagSelect.value;
      if (this.tagFilter) {
        this.annotationScope = "all";
      }
      await this.render();
    });

    const boardButton = tagRow.createEl("button", {
      cls: "yh-icon-btn yh-tag-board-btn",
      attr: { type: "button", title: "在标签总览中查看", "aria-label": "在标签总览中查看" },
    });
    setIcon(boardButton, "layout-grid");
    boardButton.addEventListener("click", () => {
      void this.plugin.activateTagBoard(this.tagFilter || undefined);
    });

    // 导出：按钮 + 格式，语义与原先底部导出栏一致，只是收进菜单
    panel.createDiv({ cls: "yh-ov-menu-sep" });
    const exportRow = panel.createDiv({ cls: "yh-ov-menu-row yh-ov-menu-export" });
    const exportButton = exportRow.createEl("button", { cls: "yh-export-btn", text: "↑ 导出批注", attr: { type: "button" } });
    exportButton.disabled = this.annotationScope === "current" && !file;
    exportButton.addEventListener("click", async () => {
      if (this.annotationScope === "current" && !file) {
        return;
      }
      const exported =
        this.annotationScope === "all"
          ? await this.plugin.store.exportAllNotes(this.exportFormat, this.plugin.settings.obTagBridge)
          : await this.plugin.store.exportNotes(file!, this.exportFormat, this.plugin.settings.obTagBridge);
      new Notice(`已导出笔记至 ${exported.path}`);
    });
    const exportFormat = exportRow.createEl("select", { cls: "yh-filter-select yh-export-format", attr: { title: "导出格式" } });
    exportFormat.createEl("option", { text: "默认摘要", value: "summary" });
    exportFormat.createEl("option", { text: "按颜色分组", value: "by-color" });
    exportFormat.createEl("option", { text: "只导出笔记", value: "notes-only" });
    exportFormat.createEl("option", { text: "阅读笔记", value: "reading-notes" });
    exportFormat.value = this.exportFormat;
    exportFormat.addEventListener("change", () => {
      this.exportFormat = exportFormat.value as AnnotationExportFormat;
    });
  }

  private renderCard(list: Element, cardData: SidebarCard): void {
    const file = this.fileForCard(cardData);
    const card = list.createDiv({
      cls: `yh-ov-card yh-ov-card--${cardData.color}`,
      attr: this.cardAttributes(cardData),
    });
    card.toggleClass("is-orphaned", !!cardData.orphaned);

    const head = card.createDiv({ cls: "yh-ov-card-head" });
    head.createSpan({ cls: `yh-ov-label yh-label--${cardData.color}`, text: COLOR_LABELS[cardData.color] });
    head.createSpan({ cls: "yh-ov-meta", text: cardData.mode === "md" ? "Markdown" : cardData.mode === "pdf" ? "PDF" : "EPUB" });
    head.createSpan({ cls: "yh-ov-dot", text: "·" });
    const title = (cardData.note && "title" in cardData.note ? cardData.note.title : "") ?? "";
    const kindLabel = cardData.kind === "highlight" ? "高亮" : "笔记";
    const type = head.createSpan({
      cls: "yh-ov-type",
      text: title ? getTitleLabel(title) : kindLabel,
    });
    if (title) {
      type.dataset.title = title;
    }
    // EPUB 想法分类标签（insight/question/reminder），仅 EpubCommentAnnotation 有 noteType
    const note = cardData.note;
    const epubNoteType = note && "noteType" in note ? note.noteType : undefined;
    if (epubNoteType) {
      const labelMap: Record<string, string> = { insight: "💡洞见", question: "❓疑问", reminder: "🔔提醒" };
      head.createSpan({ cls: "yh-ov-note-type", text: labelMap[epubNoteType] ?? epubNoteType });
    }
    head.createSpan({ cls: "yh-ov-time", text: formatTime(cardData.createdAt) });

    const quote = card.createDiv({ cls: "yh-ov-quote" });
    quote.textContent = cardData.text;
    quote.toggleClass("is-code", cardData.isCode || isCodeLikeText(cardData.text));
    this.addExpandToggle(quote, card);
    if (cardData.content) {
      const content = card.createDiv({ cls: "yh-ov-content" });
      void MarkdownRenderer.render(this.app, cardData.content, content, cardData.sourcePath, this).then(() => {
        this.addExpandToggle(content, card);
      });
    }

    const tagRow = card.createDiv({ cls: "yh-ov-tags" });
    if (this.editingTagCardId === cardData.id) {
      this.mountTagEditor(tagRow, file, cardData, this.plugin.getTagSuggestions());
    } else {
      this.mountTagRow(tagRow, file, cardData);
    }

    const source = card.createDiv({ cls: "yh-ov-source" });
    source.createSpan({ cls: "yh-ov-file", text: file?.name ?? cardData.sourcePath });
    source.createSpan({
      cls: "yh-ov-mode",
      text: cardData.mode === "epub"
        ? (cardData.chapter ?? "EPUB")
        : cardData.pageNumber
          ? `p.${cardData.pageNumber}`
          : "Markdown",
    });

    const actions = card.createDiv({ cls: "yh-ov-actions" });
    if (cardData.note) {
      const edit = actions.createEl("button", {
        cls: "yh-ov-btn yh-ov-btn--icon",
        attr: { type: "button", title: "编辑笔记", "data-action": "edit-note" },
      });
      setIcon(edit, "pencil");
      edit.disabled = !file;
      edit.addEventListener("click", () => {
        if (file) {
          this.openInlineEditor(card, file, cardData, cardData.content);
        }
      });
    } else if (cardData.highlight) {
      const addNote = actions.createEl("button", {
        cls: "yh-ov-btn",
        text: "添加笔记",
        attr: { type: "button", "data-action": "add-note" },
      });
      addNote.disabled = !file;
      addNote.addEventListener("click", () => {
        if (file) {
          addNote.addClass("hidden");
          this.openInlineEditor(card, file, cardData, "");
        }
      });
    }

    const jump = actions.createEl("button", {
      cls: "yh-ov-btn",
      text: "跳转",
      attr: { type: "button", "data-action": "jump" },
    });
    jump.disabled = !file;
    jump.addEventListener("click", () => {
      if (file) {
        this.jumpTo(file, cardData.startOffset, cardData.pageNumber, cardData.mode, cardData.cfiRange);
      }
    });

    const remove = actions.createEl("button", {
      cls: "yh-ov-btn yh-ov-btn--danger",
      text: "删除",
      attr: { type: "button", "data-action": "delete" },
    });
    remove.disabled = !file;
    remove.addEventListener("click", async () => {
      if (file) {
        await this.deleteCard(file, cardData);
        new Notice("批注已删除");
        await this.plugin.refreshAnnotations();
      }
    });

    if (this.plugin.settings.contentRelations) {
      this.renderRelated(card, cardData);
    }

    const edit = card.createDiv({ cls: "yh-ov-edit hidden" });
    const textarea = edit.createEl("textarea", {
      cls: "yh-ov-textarea",
      attr: { placeholder: "写下你的想法..." },
    });
    const editActions = edit.createDiv({ cls: "yh-ov-edit-actions" });
    editActions.createEl("button", { cls: "yh-ov-save", text: "保存", attr: { type: "button" } });
    editActions.createEl("button", { cls: "yh-ov-cancel", text: "取消", attr: { type: "button" } });
  }

  /**
   * 字面相关的其他批注：默认折叠，每条标出命中的短语（说明为什么相关），
   * 点击跳转到原文。行尾「关联」把确认动作物化为两侧共享标签（MOC 雏形），
   * 已确认的关联显示为「已关联 xx」chip，点 chip 从两侧断开。无命中时整个区块不渲染。
   */
  private renderRelated(card: HTMLElement, cardData: SidebarCard): void {
    const hits = this.relations.getRelated(cardData);
    if (hits.length === 0) {
      return;
    }

    const box = card.createEl("details", { cls: "yh-ov-related" });
    // 展开态记在视图字段：确认关联后的 refreshAnnotations 会整表重绘，
    // 不希望用户刚展开的相关区被折回去
    box.open = this.openRelated.has(cardData.id);
    box.addEventListener("toggle", () => {
      if (box.open) {
        this.openRelated.add(cardData.id);
      } else {
        this.openRelated.delete(cardData.id);
      }
    });
    box.createEl("summary", { text: `相关的 ${hits.length} 条` });
    const list = box.createDiv({ cls: "yh-ov-related-list" });

    const selfFile = this.fileForCard(cardData);

    for (const hit of hits) {
      const row = list.createDiv({ cls: "yh-ov-related-row" });
      const excerpt = hit.card.text.length > 60 ? `${hit.card.text.slice(0, 60)}…` : hit.card.text;
      row.createDiv({ cls: "yh-ov-related-text", text: excerpt });

      const meta = row.createDiv({ cls: "yh-ov-related-meta" });
      meta.createSpan({ cls: "yh-ov-related-reason", text: `都提到「${hit.reasons.join("」「")}」` });
      const source = this.fileForCard(hit.card);
      meta.createSpan({ cls: "yh-ov-related-file", text: source?.basename ?? hit.card.sourcePath });

      // 已确认的关联 = 两侧共享的标签（确认动作的持久结果）；点 chip 从两侧移除该标签
      for (const tag of this.sharedTags(cardData, hit.card)) {
        const chip = meta.createSpan({
          cls: "yh-ov-related-chip",
          text: `已关联 ${tag}`,
          attr: { title: "点击断开该关联标签（两侧同时移除）" },
        });
        chip.addEventListener("click", (event) => {
          event.stopPropagation();
          void this.removeRelationTag(cardData, hit.card, tag);
        });
      }

      // 确认关联：两侧源文件都在才可用；打开行内选择条挑标签，绝不静默写入
      const linkDisabled = !selfFile || !source;
      const link = meta.createSpan({
        cls: "yh-ov-related-link",
        text: "关联",
        attr: linkDisabled
          ? { "aria-disabled": "true", title: "源文件缺失，无法建立关联" }
          : { role: "button", tabindex: "0", "aria-label": "确认关联", title: "确认关联：把一个共享标签写入两侧批注" },
      });
      if (linkDisabled) {
        link.addClass("is-disabled");
      }
      link.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!linkDisabled) {
          this.mountRelationPicker(row, cardData, hit.card, hit.reasons);
        }
      });
      link.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (!linkDisabled) {
          this.mountRelationPicker(row, cardData, hit.card, hit.reasons);
        }
      });

      if (source) {
        row.addClass("is-clickable");
        row.setAttribute("role", "button");
        row.addEventListener("click", () => {
          void this.jumpTo(source, hit.card.startOffset, hit.card.pageNumber, hit.card.mode, hit.card.cfiRange);
        });
      }
    }
  }

  /** 两侧已共享的标签（按比较键判同、去重展示写法）：这就是「确认关联」落在数据上的样子 */
  private sharedTags(a: SidebarCard, b: SidebarCard): string[] {
    const keys = new Set(b.tags.map(tagKey));
    const seen = new Set<string>();
    const shared: string[] = [];
    for (const tag of a.tags) {
      const key = tagKey(tag);
      if (!key || !keys.has(key) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      shared.push(tag);
    }
    return shared;
  }

  /**
   * 相关行的确认关联选择条：候选第一位是命中最长的公共短语（算法已保证术语性），
   * 其后是历史标签，最后一个输入框接受自定义。点候选或回车才写入，Esc / 点外收起。
   */
  private mountRelationPicker(row: HTMLElement, self: SidebarCard, other: SidebarCard, reasons: readonly string[]): void {
    const picker = row.createDiv({ cls: "yh-ov-related-picker" });
    // 不让行级点击跳转吃掉选择条上的点击
    picker.addEventListener("click", (event) => event.stopPropagation());

    const listeners = new AbortController();
    const close = (): void => {
      listeners.abort();
      picker.remove();
    };

    const chips = picker.createDiv({ cls: "yh-ov-related-picker-chips" });
    const candidates: string[] = [];
    const phrase = reasons[0]; // selectDistinctPhrases 按长度降序，第一条即最长短语
    if (phrase) {
      candidates.push(phrase);
    }
    for (const suggestion of this.plugin.getTagSuggestions()) {
      if (candidates.length >= 6) {
        break;
      }
      if (suggestion.kind !== "used") {
        continue;
      }
      const key = tagKey(suggestion.name);
      if (!key) {
        continue;
      }
      // 已经共享的标签再点一次是空操作，不作为候选
      if (hasTag(self.tags, key) && hasTag(other.tags, key)) {
        continue;
      }
      if (!candidates.some((item) => tagKey(item) === key)) {
        candidates.push(suggestion.name);
      }
    }
    for (const name of candidates) {
      const chip = chips.createSpan({
        cls: "yh-ov-related-picker-chip",
        text: name,
        attr: { title: name === phrase ? "用这个共同短语作为关联标签" : "用这个历史标签建立关联" },
      });
      chip.addEventListener("click", () => {
        close();
        void this.applyRelationTag(self, other, name);
      });
    }

    const input = chips.createEl("input", {
      cls: "yh-ov-related-picker-input",
      attr: { type: "text", placeholder: "自定义标签", "aria-label": "自定义关联标签" },
    });
    let composing = false;
    input.addEventListener("compositionstart", () => {
      composing = true;
    });
    input.addEventListener("compositionend", () => {
      composing = false;
    });
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      // IME 选词阶段的 Enter 必须还给输入法；keyCode 229 是安卓 WebView 的兜底
      if (composing || event.isComposing || event.keyCode === 229) {
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const value = input.value.trim();
        if (!value) {
          return;
        }
        close();
        void this.applyRelationTag(self, other, value);
      }
    });

    // 点选择条外收起（capture 先于行跳转）；行被重绘销毁时顺手清监听
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!row.isConnected) {
          listeners.abort();
          return;
        }
        if (event.target instanceof Node && picker.contains(event.target)) {
          return;
        }
        close();
      },
      { capture: true, signal: listeners.signal },
    );
    picker.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          close();
        }
      },
      { signal: listeners.signal },
    );
  }

  /** 标签行：默认只读 chip + 加号；点加号原地切编辑态，不弹窗 */
  private mountTagRow(row: HTMLElement, file: TFile | null, cardData: SidebarCard): void {
    row.empty();
    row.removeClass("is-editing");

    const suggestions = this.plugin.getTagSuggestions();
    renderTagChips(row, cardData.tags, {
      onChipClick: (tag) => this.focusTag(tagKey(tag)),
      onOverflowClick: () => {
        this.tagEditorAutoFocus = true;
        this.mountTagEditor(row, file, cardData, suggestions);
      },
    });

    const add = row.createSpan({
      cls: "yh-ov-tag-add",
      text: "+",
      attr: { role: "button", tabindex: "0", "aria-label": "添加标签", title: "添加标签" },
    });
    // 阻止 + 抢焦点：否则 click 回调里 row.empty() 删掉的是「正持有焦点的节点」，
    // 浏览器把焦点退回 body，接着挂载的输入框会立刻失焦。
    add.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    const open = (event: Event): void => {
      event.stopPropagation();
      // 只有用户主动点「+」才抢焦点；重绘重建走另一条路径，不置这个标志
      this.tagEditorAutoFocus = true;
      this.mountTagEditor(row, file, cardData, suggestions);
    };
    add.addEventListener("click", open);
    add.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open(event);
      }
    });
  }

  /**
   * 进入标签编辑态。
   * 编辑态存于 this.editingTagCardId，关闭只由「点卡片外 / Esc」显式触发；
   * 不再用 blur + 定时器拆解，避免焦点抖动导致输入框一闪即逝。
   */
  private mountTagEditor(row: HTMLElement, file: TFile | null, cardData: SidebarCard, suggestions: readonly TagSuggestion[]): void {
    // 本次挂载是否由用户主动触发；重绘重建时为 false，不抢焦点、不弹输入法
    const shouldFocus = this.tagEditorAutoFocus;
    this.tagEditorAutoFocus = false;
    this.editingTagCardId = cardData.id;
    row.empty();
    row.addClass("is-editing");
    // 按当前划线内容推荐用过的标签：只从历史里挑、不发明新词，冷启动或快照未就绪时静默为空
    const recommended: TagSuggestion[] = this.plugin.settings.contentRelations
      ? this.relations.getRecommendedTags(cardData).map((name): TagSuggestion => ({ name, kind: "recommended" }))
      : [];
    const currentTags = this.plugin.settings.obTagBridge ? this.plugin.getFileObsidianTags(file) : [];
    const quickApply = currentTags.length > 0
      ? { label: `沿用本文档标签（${currentTags.length}）`, tags: currentTags }
      : undefined;
    renderTagInput(row, {
      tags: cardData.tags,
      suggestions: [...recommended, ...suggestions],
      quickApply,
      // 侧栏点 + 即刻给出候选：空内容也显示，不必先输入一个字符
      showSuggestionsOnOpen: true,
      // 重绘回填未提交输入，避免一次刷新把正在打的标签吞掉
      initialQuery: this.pendingTagQuery,
      onQueryChange: (value) => {
        this.pendingTagQuery = value;
      },
      onChange: (tags) => {
        cardData.tags = tags;
        void this.persistCardTags(file, cardData, tags);
      },
    });

    const field = row.querySelector<HTMLInputElement>(".yh-tag-input-field");
    const list = row.closest<HTMLElement>(".yh-ov-list");

    /** 把输入框滚进可视区；侧栏列表是唯一滚动容器，不触碰阅读区与编辑器 */
    const revealField = (): void => {
      if (row.isConnected && field?.isConnected) {
        field.scrollIntoView({ block: "center" });
      }
    };

    const listeners = new AbortController();
    const { signal } = listeners;

    // 前一个编辑态可能没走 close 就被覆盖（点 chip 溢出直接重挂），先收掉旧监听
    this.keyboardCleanup?.();
    this.keyboardCleanup = null;
    if (Platform.isMobile && list) {
      const stop = observeKeyboardInset((inset) => {
        // 软键盘 + 中文候选栏会压缩视觉视口；补一段可滚动留白，底部卡片才滚得上来
        list.style.paddingBottom = inset > 0 ? `${inset + 24}px` : "";
        if (inset > 0) {
          window.setTimeout(revealField, 80);
        }
      }, () => row.isConnected);
      this.keyboardCleanup = () => {
        stop();
        list.style.removeProperty("padding-bottom");
        this.keyboardCleanup = null;
      };
    }

    window.requestAnimationFrame(() => {
      if (!row.isConnected) {
        return;
      }
      // 只有用户主动进入编辑态才聚焦并滚动；重绘重建保持安静，避免输入法自动弹起
      if (shouldFocus) {
        field?.focus();
        revealField();
      }
    });

    const close = (): void => {
      listeners.abort();
      this.keyboardCleanup?.();
      this.keyboardCleanup = null;
      this.pendingTagQuery = "";
      if (this.editingTagCardId === cardData.id) {
        this.editingTagCardId = null;
      }
      const shouldRender = this.pendingRender;
      this.pendingRender = false;
      if (row.isConnected) {
        this.mountTagRow(row, file, cardData);
      }
      // 编辑期间攒下的刷新请求，退出编辑后补一次
      if (shouldRender) {
        this.requestRender();
      }
    };

    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!row.isConnected) {
          listeners.abort();
          return;
        }
        if (event.target instanceof Node && row.contains(event.target)) {
          return;
        }
        close();
      },
      { capture: true, signal },
    );

    row.addEventListener(
      "keydown",
      (event) => {
        // 补全下拉展开时 Esc 由 renderTagInput 自己吃掉（已 preventDefault）
        if (event.key !== "Escape" || event.defaultPrevented) {
          return;
        }
        event.preventDefault();
        close();
      },
      { signal },
    );
  }

  /** 写入标签：一张卡片可能是高亮 + 笔记，两者写同一份数组 */
  private async persistCardTags(file: TFile | null, cardData: SidebarCard, tags: string[]): Promise<void> {
    if (!file) {
      return;
    }

    const refs = this.tagRefs(cardData);
    if (refs.length === 0) {
      return;
    }

    try {
      await this.plugin.store.setTags(refs, tags);
      // 标签变了，「标签 → 词频」字典要跟着重建，不等 3 秒缓存 TTL
      this.relations.invalidate();
    } catch (error) {
      console.warn("yh-inklight: 保存标签失败", error);
      new Notice("标签保存失败，请检查写入权限或同步状态");
    }
  }

  /** 卡片的标签 refs：高亮与其笔记共享同一份标签数组，写入时两者都要覆盖 */
  private tagRefs(card: SidebarCard): TagRef[] {
    const refs: TagRef[] = [];
    if (card.highlight) {
      refs.push({ filePath: card.sourcePath, annotationId: card.highlight.id });
    }
    if (card.note) {
      refs.push({ filePath: card.sourcePath, annotationId: card.note.id });
    }
    return refs;
  }

  /**
   * 活读一张卡的最新标签（高亮与其笔记的并集）。
   * 渲染快照可能滞后于其他入口的写入，确认关联必须以落盘数据为准取并集，否则会覆盖掉新标签。
   * 返回 null 表示该侧不可用（源文件或批注缺失，已给 Notice）。
   */
  private async readLiveCardTags(card: SidebarCard, action: string): Promise<{ refs: TagRef[]; live: string[] } | null> {
    const file = this.fileForCard(card);
    if (!file) {
      new Notice(`源文件缺失，无法${action}`);
      return null;
    }
    const refs = this.tagRefs(card);
    const document = await this.plugin.store.getDocument(file);
    const live: string[] = [];
    let found = false;
    for (const ref of refs) {
      const annotation = findAnnotationById(document, ref.annotationId);
      if (annotation) {
        found = true;
        live.push(...(annotation.tags ?? []));
      }
    }
    if (!found) {
      new Notice(`该批注已不存在，无法${action}`);
      return null;
    }
    return { refs, live };
  }

  /** 确认关联：把同一个标签写入两侧；先两侧都活读成功再写，避免一侧成功一侧失败的不对称 */
  private async applyRelationTag(self: SidebarCard, other: SidebarCard, rawTag: string): Promise<void> {
    const tag = normalizeTag(rawTag);
    if (!tag) {
      return;
    }
    const preparedSelf = await this.readLiveCardTags(self, "建立关联");
    if (!preparedSelf) {
      return;
    }
    const preparedOther = await this.readLiveCardTags(other, "建立关联");
    if (!preparedOther) {
      return;
    }
    try {
      // setTags 是覆盖式：每侧单独一次调用，写入「该侧最新 tags ∪ 确认标签」
      await this.plugin.store.setTags(preparedSelf.refs, unionTags(preparedSelf.live, [tag]));
      await this.plugin.store.setTags(preparedOther.refs, unionTags(preparedOther.live, [tag]));
      // 标签字典变了，「标签 → 词频」索引不等 3 秒 TTL
      this.relations.invalidate();
      new Notice(`已用「${tag}」关联两侧批注`);
      await this.plugin.refreshAnnotations();
    } catch (error) {
      console.warn("yh-inklight: 写入关联标签失败", error);
      new Notice("关联标签写入失败，请检查写入权限或同步状态");
    }
  }

  /** 断开关联：把该标签从两侧移除；其他批注上的同名标签不受影响（setTags 只动指定 refs） */
  private async removeRelationTag(self: SidebarCard, other: SidebarCard, rawTag: string): Promise<void> {
    const key = tagKey(rawTag);
    if (!key) {
      return;
    }
    const preparedSelf = await this.readLiveCardTags(self, "断开关联");
    if (!preparedSelf) {
      return;
    }
    const preparedOther = await this.readLiveCardTags(other, "断开关联");
    if (!preparedOther) {
      return;
    }
    try {
      await this.plugin.store.setTags(
        preparedSelf.refs,
        unionTags(preparedSelf.live).filter((item) => tagKey(item) !== key),
      );
      await this.plugin.store.setTags(
        preparedOther.refs,
        unionTags(preparedOther.live).filter((item) => tagKey(item) !== key),
      );
      this.relations.invalidate();
      new Notice(`已断开关联标签「${rawTag}」`);
      await this.plugin.refreshAnnotations();
    } catch (error) {
      console.warn("yh-inklight: 断开关联标签失败", error);
      new Notice("断开关联失败，请检查写入权限或同步状态");
    }
  }

  /** 把侧栏切到「只看该标签」：跨文档，并同步更新筛选下拉 */
  focusTag(key: string): void {
    if (!key) {
      return;
    }
    this.tagFilter = key;
    this.annotationScope = "all";
    void this.render();
  }

  private cardAttributes(card: SidebarCard): Record<string, string> {
    const attrs: Record<string, string> = { "data-id": card.id, "data-source-path": card.sourcePath };
    if (card.highlight) {
      attrs["data-highlight-id"] = card.highlight.id;
    }
    if (card.note) {
      attrs["data-note-id"] = card.note.id;
    }
    return attrs;
  }

  private openInlineEditor(card: HTMLElement, file: TFile, cardData: SidebarCard, initialValue: string): void {
    const edit = card.querySelector<HTMLElement>(".yh-ov-edit");
    const textarea = card.querySelector<HTMLTextAreaElement>(".yh-ov-textarea");
    const save = card.querySelector<HTMLButtonElement>(".yh-ov-save");
    const cancel = card.querySelector<HTMLButtonElement>(".yh-ov-cancel");
    const addNote = card.querySelector<HTMLElement>('[data-action="add-note"]');
    if (!edit || !textarea || !save || !cancel) {
      return;
    }

    textarea.value = initialValue;
    edit.removeClass("hidden");
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    const saveContent = async (): Promise<void> => {
      await this.saveCardContent(file, cardData, textarea.value);
      await this.plugin.refreshAnnotations();
    };

    save.onclick = () => {
      void saveContent();
    };
    cancel.onclick = () => {
      textarea.value = initialValue;
      edit.addClass("hidden");
      addNote?.removeClass("hidden");
    };
    textarea.onkeydown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void saveContent();
      }
      if (event.key === "Escape") {
        textarea.value = initialValue;
        edit.addClass("hidden");
        addNote?.removeClass("hidden");
      }
    };
  }

  private addExpandToggle(contentEl: HTMLElement, wrapperEl: HTMLElement): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const lineHeight = parseFloat(getComputedStyle(contentEl).lineHeight);
        const threshold = lineHeight * 3 + 10;
        if (contentEl.scrollHeight <= threshold + 2) {
          return;
        }

        const button = document.createElement("span");
        button.className = "yh-ov-expand-btn";
        button.textContent = "展开";
        button.tabIndex = 0;
        button.setAttribute("role", "button");
        contentEl.insertAdjacentElement("afterend", button);
        const toggle = (): void => {
          const expanded = contentEl.hasClass("expanded");
          contentEl.toggleClass("expanded", !expanded);
          button.setText(expanded ? "展开" : "收起");
        };
        button.addEventListener("click", toggle);
        button.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        });
      });
    });
  }

  private async saveCardContent(file: TFile, card: SidebarCard, content: string): Promise<void> {
    if (card.note && card.mode === "pdf") {
      await this.plugin.store.updatePdfComment(file, {
        ...(card.note as PdfCommentAnnotation),
        content,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    if (card.note && card.mode === "md") {
      await this.plugin.store.updateComment(file, {
        ...(card.note as CommentAnnotation),
        content,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    if (card.note && card.mode === "epub") {
      await this.plugin.store.updateEpubComment(file, {
        ...(card.note as EpubCommentAnnotation),
        note: content,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    if (card.highlight && card.mode === "pdf") {
      const now = new Date().toISOString();
      const highlight = card.highlight as PdfHighlightAnnotation;
      await this.plugin.store.addPdfComment(file, {
        id: crypto.randomUUID(),
        highlightId: highlight.id,
        anchor: highlight.anchor,
        content,
        color: highlight.color,
        position: { offsetX: 20, offsetY: 0 },
        collapsed: false,
        author: this.plugin.settings.defaultAuthor,
        createdAt: now,
        updatedAt: now,
        replies: [],
        resolved: false,
      });
      return;
    }

    if (card.highlight && card.mode === "md") {
      const now = new Date().toISOString();
      const highlight = card.highlight as HighlightAnnotation;
      await this.plugin.store.addComment(file, {
        id: crypto.randomUUID(),
        highlightId: highlight.id,
        anchor: highlight.anchor,
        content,
        color: highlight.color,
        position: { offsetX: 20, offsetY: 0 },
        collapsed: false,
        author: this.plugin.settings.defaultAuthor,
        createdAt: now,
        updatedAt: now,
        replies: [],
        resolved: false,
      });
      return;
    }

    if (card.highlight && card.mode === "epub") {
      const now = new Date().toISOString();
      const highlight = card.highlight as EpubHighlightAnnotation;
      await this.plugin.store.addEpubComment(file, {
        id: crypto.randomUUID(),
        type: "epub-comment",
        color: highlight.color,
        style: highlight.style,
        anchor: highlight.anchor,
        note: content,
        createdAt: now,
        collapsed: false,
        author: this.plugin.settings.defaultAuthor,
        updatedAt: now,
        replies: [],
        resolved: false,
      });
    }
  }

  private async deleteCard(file: TFile, card: SidebarCard): Promise<void> {
    if (card.highlight) {
      await this.plugin.store.removeAnnotation(file, card.highlight.id);
    }
    if (card.note) {
      await this.plugin.store.removeAnnotation(file, card.note.id);
    }
  }

  private fileForCard(card: SidebarCard): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(card.sourcePath);
    return file instanceof TFile ? file : null;
  }

  private filterCards(cards: SidebarCard[]): SidebarCard[] {
    return cards
      .filter((card) => this.color === "all" || card.color === this.color)
      .filter((card) => {
        if (this.type === "all") {
          return true;
        }
        if (this.type === "highlight") {
          return card.kind === "highlight";
        }
        return Boolean(card.note);
      })
      .filter((card) => !this.tagFilter || hasTag(card.tags, this.tagFilter))
      .filter((card) => {
        const haystack = `${card.sourcePath} ${card.text} ${card.content} ${card.tags.join(" ")}`.toLowerCase();
        return haystack.includes(this.query.toLowerCase());
      })
      .sort((a, b) => {
        if (this.sort === "newest") {
          return this.cardUpdatedAt(b).localeCompare(this.cardUpdatedAt(a));
        }
        if (this.sort === "oldest") {
          return this.cardUpdatedAt(a).localeCompare(this.cardUpdatedAt(b));
        }
        return a.sourcePath.localeCompare(b.sourcePath) || (a.pageNumber ?? 0) - (b.pageNumber ?? 0) || a.startOffset - b.startOffset;
      });
  }

  private cardUpdatedAt(card: SidebarCard): string {
    return card.note?.updatedAt ?? card.createdAt;
  }

  private async jumpTo(
    file: TFile,
    offset: number,
    pageNumber: number | null,
    mode: AnnotationMode = "md",
    cfiRange?: string,
  ): Promise<void> {
    await openAnnotationTarget(this.app, { file, offset, pageNumber, mode, cfiRange }, (target, cfi) =>
      this.plugin.navigateEpubToCfi(target, cfi),
    );
  }
}

/** 在 sidecar 文档的 6 个批注数组里按 id 找标签载体；找不到说明该批注已被删除 */
function findAnnotationById(document: FileAnnotationDocument, annotationId: string): { tags?: string[] } | null {
  const pools = [
    document.highlights,
    document.comments,
    document.pdfHighlights,
    document.pdfComments,
    document.epubHighlights,
    document.epubComments,
  ];
  for (const pool of pools) {
    const found = pool.find((item) => item.id === annotationId);
    if (found) {
      return found;
    }
  }
  return null;
}

function getTitleLabel(title: string): string {
  const labels: Record<string, string> = {
    Insight: "洞察",
    Question: "疑问",
    Reminder: "提醒",
  };
  return labels[title] ?? title;
}


function isCodeLikeText(text: string): boolean {
  return /^[ \t]{2,}/m.test(text) || /\n[ \t]{2,}\S/.test(text);
}

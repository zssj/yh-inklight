/**
 * [INPUT]: 依赖 Obsidian Plugin API、CM6 扩展、sidecar AnnotationStore、锚点算法、视图与设置模块
 * [OUTPUT]: 对外提供 OverlayAnnotationsPlugin 主类，注册 ribbon 图标、命令、浮动工具栏、高亮、标注详情浮层（三端共用 AnnotationCard）、侧栏、设置和 vault 事件
 * [POS]: 插件装配根，协调模块但不修改用户 Markdown 原文
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { addIcon, Editor, MarkdownPostProcessorContext, MarkdownView, Modal, Notice, Platform, Plugin, TFile, WorkspaceLeaf } from "obsidian";

import { createTextAnchor, relocateDocumentAnchors } from "./src/anchor/textAnchor";
import { foldWhitespaceWithMap, stripWithMap, strippedScore } from "./src/anchor/textStrip";
import { createHighlightExtension } from "./src/editor/highlightExtension";
import { installReadingViewHighlights, refreshReadingViewHighlights } from "./src/editor/readingViewHighlight";
import { SelectionToolbar } from "./src/editor/selectionToolbar";
import { PdfAnnotationLayer } from "./src/pdf/pdfAnnotationLayer";
import { PdfViewerAdapter } from "./src/pdf/pdfViewerAdapter";
import { AnnotationSettingsTab } from "./src/settings/settingsTab";
import { AnnotationStore } from "./src/storage/annotationStore";
import {
  AnnotationColor,
  AnnotationPluginSettings,
  AnnotationRelation,
  CommentAnnotation,
  RelationType,
  DEFAULT_SETTINGS,
  FileAnnotationDocument,
  HighlightAnnotation,
  MdOpenStat,
  SelectionSnapshot,
  SUPPORTED_BOOK_EXTENSIONS,
} from "./src/storage/types";
import { AnnotationCard } from "./src/views/annotationCard";
import { buildCards, canExtractAtomCard, findAnnotationById, relationAnchorOf, SidebarCard } from "./src/views/cardModel";
import { toPopoverRect } from "./src/views/popoverPlacement";
import { ANNOTATION_SIDEBAR_VIEW, AnnotationSidebarView } from "./src/views/sidebarView";
import { findOpenEpubLeaf, openAnnotationTarget } from "./src/views/navigation";
import { RelationModel } from "./src/views/relationModel";
import { filterSharedCandidates, RelatedBlockHost, RelatedHitView } from "./src/views/relatedBlock";
import type { TagRef } from "./src/storage/annotationStore";
import { parseSourceLinkParams, refineOffset, SourceLinkTarget } from "./src/storage/sourceLink";
import { StickyNoteLane } from "./src/views/stickyNoteLane";
import { EpubReaderView, EPUB_READER_VIEW_TYPE } from "./src/epub/EpubReaderView";
import { EpubBookshelfView, EPUB_BOOKSHELF_VIEW_TYPE } from "./src/epub/EpubBookshelfView";
import { EpubAiModal } from "./src/epub/EpubAiModal";
import { EpubTocView, EPUB_TOC_VIEW_TYPE } from "./src/epub/EpubTocView";
import { registerEpubGotoHandler } from "./src/epub/EpubGotoHandler";
import { AnnotationReviewEntry, MarkdownStatsView, MARKDOWN_STATS_VIEW_TYPE } from "./src/views/markdownStatsView";
import { buildTagSuggestions, renderTagInput, TagSuggestion } from "./src/views/tagInput";
import { normalizeTag, normalizeTags, tagKey, unionTags } from "./src/storage/tags";
import { TagBoardView, TAG_BOARD_VIEW_TYPE } from "./src/views/tagBoardView";

interface CommentModalValue {
  title: string;
  content: string;
  tags: string[];
}

const NOTE_TITLE_OPTIONS = [
  { value: "Insight", label: "💡 洞见" },
  { value: "Question", label: "❓ 疑问" },
  { value: "Reminder", label: "🔔 提醒" },
] as const;

/** Markdown 打开次数统计的独立 sidecar 文件（与批注同目录，卸载插件不丢失） */
const MD_OPEN_STATS_PATH = ".obsidian-annotations/md-open-stats.json";

/** 批注回看记录的独立 sidecar：annotationId → 最近一次回看时间（ISO） */
const ANNOTATION_REVIEW_STATE_PATH = ".obsidian-annotations/annotation-review.json";

/**
 * 回看记录保留天数。批注 id 是 UUID，全局唯一，但删除批注不会回调清理记录，
 * 靠时间窗口兜底避免 sidecar 无限膨胀。
 */
const REVIEW_STATE_TTL_DAYS = 90;

/** 源文件连续写入的合并窗口：同步盘与外部程序常连续触发 modify，逐次迁移性价比极低 */
const MD_MODIFY_DEBOUNCE_MS = 300;

/**
 * 只比较锚点是否真的漂移。relocateDocumentAnchors 每次都返回新对象，
 * 不能用引用判断；用偏移与选中文本比较才能避免「文件一保存就重写 sidecar」。
 */
function anchorsUnchanged(before: FileAnnotationDocument, after: FileAnnotationDocument): boolean {
  const same = (
    left: { anchor: { startOffset: number; endOffset: number; selectedText: string }; orphaned?: boolean },
    right: { anchor: { startOffset: number; endOffset: number; selectedText: string }; orphaned?: boolean },
  ): boolean =>
    left.anchor.startOffset === right.anchor.startOffset
    && left.anchor.endOffset === right.anchor.endOffset
    && left.anchor.selectedText === right.anchor.selectedText
    && Boolean(left.orphaned) === Boolean(right.orphaned);

  return before.highlights.length === after.highlights.length
    && before.comments.length === after.comments.length
    && before.highlights.every((item, index) => same(item, after.highlights[index]))
    && before.comments.every((item, index) => same(item, after.comments[index]));
}

const YH_INKLIGHT_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect x="5" y="5" width="90" height="90" rx="20" ry="20" fill="#F5C518"/>
    <g transform="translate(50,50) rotate(-45) translate(-18,-18)"
      fill="none" stroke="#000" stroke-width="6"
      stroke-linecap="round" stroke-linejoin="round">
      <rect x="8" y="2" width="20" height="28" rx="3" fill="#000" stroke="none"/>
      <polygon points="8,30 28,30 18,42" fill="#000" stroke="none"/>
      <line x1="8" y1="10" x2="28" y2="10" stroke="#F5C518" stroke-width="3"/>
    </g>
  </svg>
`;

/** 关系类型只留四种：再多用户每次连边都要先做一道选择题，很快就懒得连了 */
const RELATION_TYPES: ReadonlyArray<readonly [RelationType, string]> = [
  ["supports", "支持"],
  ["refutes", "反驳"],
  ["example", "举例"],
  ["extends", "延伸"],
];

export default class OverlayAnnotationsPlugin extends Plugin {
  settings: AnnotationPluginSettings = DEFAULT_SETTINGS;
  store!: AnnotationStore;

  private toolbar!: SelectionToolbar;
  private popoverCard: AnnotationCard | null = null;
  /** 浮层「相关」区的展开态：存在插件上，关掉卡片再打开仍保持 */
  private readonly popoverRelatedOpen = new Set<string>();
  private pdfLayer!: PdfAnnotationLayer;
  private pdfViewerAdapter!: PdfViewerAdapter;
  private stickyLane!: StickyNoteLane;
  private lastSelection: SelectionSnapshot | null = null;
  private renameMigrationTimer: number | null = null;
  /** 每个 Markdown 文件一个 modify 防抖计时器，避免同步盘连续写入触发重复迁移 */
  private readonly mdModifyTimers = new Map<string, number>();
  private settingsSaveTimer: number | null = null;
  private statsSaveTimer: number | null = null;
  private epubTocSyncTimer: number | null = null;
  private lastCountedPath = "";
  private lastCountedAt = 0;
  /** Markdown 打开次数统计（存于独立 sidecar，插件重装不丢失） */
  mdOpenStats: Record<string, MdOpenStat> = {};
  /** 批注回看记录：annotationId → 最近一次回看 ISO 时间；当天已回看的条目不再进复习卡 */
  private reviewedAnnotations: Record<string, string> = {};

  async onload(): Promise<void> {
    addIcon("yh-inklight-icon", YH_INKLIGHT_ICON);
    await this.loadSettings();
    console.info(`yh-inklight loaded v${this.manifest.version}`);
    this.store = new AnnotationStore(this.app);
    await this.store.initialize();
    await this.loadMdOpenStats();
    await this.loadReviewedAnnotations();

    this.registerView(ANNOTATION_SIDEBAR_VIEW, (leaf) => new AnnotationSidebarView(leaf, this));
    this.registerView(TAG_BOARD_VIEW_TYPE, (leaf) => new TagBoardView(leaf, this));
    this.registerView(EPUB_READER_VIEW_TYPE, (leaf) => new EpubReaderView({
      leaf,
      store: this.store,
      settings: this.settings,
      refreshAnnotations: () => this.refreshAnnotations(),
      saveSettings: () => this.saveSettings(),
      onTocChanged: () => this.refreshEpubToc(),
      tagSuggestions: () => this.getTagSuggestions(),
      cardActions: {
        openDerivedNote: (sourcePath) => this.openDerivedNote(sourcePath),
        createAtomCard: (card) => this.createAtomCardFor(card),
        jumpToRelation: (relation) => void this.jumpToRelationTarget(relation),
        removeRelation: (sourcePath, annotationId, relation) =>
          this.removeRelationFor(sourcePath, annotationId, relation),
        relatedHost: (card) => this.createRelatedHost(card, this.popoverRelatedState()),
      },
    }));
    // 把 foliate 支持的所有电子书格式绑定到阅读器视图：registerView 只注册视图工厂，
    // 还需要 registerExtensions 告诉 Obsidian「.epub/.mobi/... 用本视图打开」。
    // 参考 ob-epub-reader 与 obsidian-weave-reader 的实现；用 try/catch 防止
    // 与其他插件扩展冲突时抛错导致插件加载失败。
    try {
      this.registerExtensions([...SUPPORTED_BOOK_EXTENSIONS], EPUB_READER_VIEW_TYPE);
    } catch (error) {
      console.warn("yh-inklight: 注册电子书扩展名失败（可能与其他插件冲突）", error);
    }
    this.registerView(
      EPUB_BOOKSHELF_VIEW_TYPE,
      (leaf) => new EpubBookshelfView(leaf, this.store, this.settings, () => this.saveSettings(), (file) => this.openEpubBook(file)),
    );
    this.registerView(
      MARKDOWN_STATS_VIEW_TYPE,
      (leaf) =>
        new MarkdownStatsView(leaf, {
          getStats: () => this.mdOpenStats,
          isTrackingEnabled: () => this.settings.mdOpenTracking,
          onOpen: (file, options) => this.openMarkdownNote(file, options),
          getAnnotationEntries: () => this.collectAnnotationReviewEntries(),
          onOpenAnnotation: (entry) => void this.openAnnotationReviewEntry(entry),
        }),
    );
    // EPUB 目录左侧栏视图：仅手机端由 syncEpubTocLeaf 挂载/摘除
    this.registerView(EPUB_TOC_VIEW_TYPE, (leaf) => new EpubTocView(leaf));
    this.app.workspace.onLayoutReady(() => this.scheduleEpubTocSync());
    this.registerEditorExtension([
      createHighlightExtension({
        getDocument: (filePath) => this.store.getCachedDocument(filePath),
        getVersion: () => this.store.version,
        rememberSelection: (filePath, startOffset, endOffset, selectedText) => {
          this.lastSelection = { filePath, startOffset, endOffset, selectedText };
        },
      }),
    ]);

    this.toolbar = new SelectionToolbar({
      onHighlight: (color) => this.createHighlight(color),
      onComment: () => this.createComment(),
      onAi: () => this.openAiForSelection(),
      onOpenSidebar: () => this.activateSidebar(),
    });
    this.pdfViewerAdapter = new PdfViewerAdapter(this.app, this);
    this.pdfLayer = new PdfAnnotationLayer({
      app: this.app,
      component: this,
      getSettings: () => this.settings,
      getDocument: (file) => this.store.getDocument(file),
      getCachedDocument: (filePath) => this.store.getCachedDocument(filePath),
      addHighlight: async (file, highlight) => {
        await this.store.addPdfHighlight(file, highlight);
        await this.refreshAnnotations();
      },
      addComment: async (file, comment) => {
        await this.store.addPdfComment(file, comment);
        await this.refreshAnnotations();
      },
      updateComment: async (file, comment) => {
        await this.store.updatePdfComment(file, comment);
        await this.refreshAnnotations();
      },
      deleteAnnotation: async (file, annotationId) => {
        await this.store.removeAnnotation(file, annotationId);
        await this.refreshAnnotations();
      },
      saveProgress: async (file, progress) => {
        await this.store.savePdfProgress(file, progress);
      },
      getProgress: (file) => this.store.getPdfProgress(file),
      viewerAdapter: this.pdfViewerAdapter,
      cardActions: {
        openDerivedNote: (sourcePath) => this.openDerivedNote(sourcePath),
        createAtomCard: (card) => this.createAtomCardFor(card),
        jumpToRelation: (relation) => void this.jumpToRelationTarget(relation),
        removeRelation: (sourcePath, annotationId, relation) =>
          this.removeRelationFor(sourcePath, annotationId, relation),
        relatedHost: (card) => this.createRelatedHost(card, this.popoverRelatedState()),
      },
      editPdfComment: async (file, comment) => {
        try {
          const value = await new CommentModal(
            this.app,
            comment.title ?? "",
            comment.content,
            normalizeTags(comment.tags ?? []),
            this.getTagSuggestions(),
          ).openAndRead();
          if (value === null) {
            return;
          }
          await this.store.updatePdfCommentContent(file, comment.id, value.content, value.title);
          if (!sameTagList(value.tags, comment.tags ?? [])) {
            await this.store.setTags([{ filePath: file.path, annotationId: comment.id }], value.tags);
          }
          await this.refreshAnnotations();
        } catch (error) {
          console.error("yh-inklight: PDF annotation edit failed", error);
          new Notice("批注保存失败");
        }
      },
      addNoteToPdfHighlight: async (file, highlight) => {
        try {
          const value = await new CommentModal(this.app, "", "", [], this.getTagSuggestions()).openAndRead();
          if (value === null) {
            return;
          }
          const now = new Date().toISOString();
          await this.store.addPdfComment(file, {
            id: crypto.randomUUID(),
            highlightId: highlight.id,
            anchor: highlight.anchor,
            title: value.title,
            content: value.content,
            color: highlight.color,
            position: { offsetX: 0, offsetY: 0 },
            collapsed: false,
            author: this.settings.defaultAuthor,
            createdAt: now,
            updatedAt: now,
            replies: [],
            resolved: false,
            ...(value.tags.length > 0 ? { tags: [...value.tags] } : {}),
          });
          await this.refreshAnnotations();
        } catch (error) {
          console.error("yh-inklight: PDF note creation failed", error);
          new Notice("笔记保存失败");
        }
      },
      setTags: async (file, annotationId, tags) => {
        try {
          await this.store.setTags([{ filePath: file.path, annotationId }], tags);
          await this.refreshAnnotations();
        } catch (error) {
          console.error("yh-inklight: PDF annotation tags update failed", error);
          new Notice("标签保存失败");
          throw error;
        }
      },
      getTagSuggestions: () => this.getTagSuggestions(),
    });

    this.stickyLane = new StickyNoteLane({
      app: this.app,
      component: this,
      getSettings: () => this.settings,
      getCachedDocument: (filePath) => this.store.getCachedDocument(filePath),
      onUpdateComment: async (file, comment, content, title) => {
        await this.store.updateCommentContent(file, comment.id, content, title);
        await this.refreshAnnotations();
      },
      onDeleteAnnotation: async (file, annotationId) => {
        await this.store.removeAnnotation(file, annotationId);
        await this.refreshAnnotations();
      },
      onToggleCollapse: async (file, comment) => {
        await this.store.updateComment(file, comment);
        await this.refreshAnnotations();
      },
      refreshAnnotations: () => this.refreshAnnotations(),
    });

    this.addSettingTab(new AnnotationSettingsTab(this));
    this.registerRibbonIcon();
    this.registerCommands();
    this.registerEvents();
    this.pdfLayer.register();
    // Phase 5：保留批注卡片跳页桥接；侧栏 PDF 工具按钮直接调用插件公开方法。
    // 用 register 注册解绑，避免热重载/启用循环时监听器累积泄漏。
    const gotoPageHandler = (event: Event): void => {
      const detail = (event as CustomEvent).detail as { page: number } | undefined;
      if (!detail?.page || detail.page < 1) return;
      void this.gotoPdfPage(detail.page);
    };
    document.addEventListener("yh-pdf-goto-page", gotoPageHandler);
    this.register(() => document.removeEventListener("yh-pdf-goto-page", gotoPageHandler));
    this.stickyLane.register();
    // Phase 4-B P1: EPUB 双向溯源 + 摘录导出
    registerEpubGotoHandler(this, (file, cfi) => this.openEpubAtCfi(file, cfi));
    this.registerObsidianProtocolHandler("inklight-epub", (params) => {
      // Obsidian 交来的参数可能已解码，再解一次会对含 `%` 的路径抛 URIError，故容错处理
      const decode = (value: unknown): string => {
        if (typeof value !== "string") return "";
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      };
      const filePath = decode(params.file);
      const cfi = decode(params.cfi);
      if (filePath && cfi) {
        void this.openEpubAtCfi(filePath, cfi);
      }
    });
    // 统一回链入口：md 带 offset + 原文片段、pdf 带 page、epub 带 CFI，三端同一套参数
    this.registerObsidianProtocolHandler("inklight", (params) => {
      void this.openSourceLink(params);
    });
    this.registerMarkdownPostProcessor((element, context) => this.renderReadingHighlights(element, context));
  }

  onunload(): void {
    if (this.renameMigrationTimer !== null) {
      window.clearTimeout(this.renameMigrationTimer);
    }
    if (this.settingsSaveTimer !== null) {
      window.clearTimeout(this.settingsSaveTimer);
    }
    if (this.statsSaveTimer !== null) {
      window.clearTimeout(this.statsSaveTimer);
      this.statsSaveTimer = null;
      // 卸载前尽力落盘，最多丢 1.5s 内的增量
      void this.saveMdOpenStats();
    }
    if (this.epubTocSyncTimer !== null) {
      window.clearTimeout(this.epubTocSyncTimer);
    }
    for (const timer of this.mdModifyTimers.values()) {
      window.clearTimeout(timer);
    }
    this.mdModifyTimers.clear();
    this.toolbar?.destroy();
    this.popoverCard?.dismiss();
    this.popoverCard = null;
    this.stickyLane?.destroy();
    this.app.workspace.detachLeavesOfType(ANNOTATION_SIDEBAR_VIEW);
    this.app.workspace.detachLeavesOfType(EPUB_BOOKSHELF_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(MARKDOWN_STATS_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(EPUB_TOC_VIEW_TYPE);
  }

  async loadSettings(): Promise<void> {
    const raw = ((await this.loadData()) ?? {}) as Record<string, unknown>;
    // 0.17.69 的布尔开关并入四档下拉：当年显式关掉的迁移成「关闭」，开着的走新默认
    if (raw.epubTapMode === undefined && raw.epubDoubleTapToPage === false) {
      raw.epubTapMode = "off";
    }
    delete raw.epubDoubleTapToPage;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(raw as Partial<AnnotationPluginSettings>),
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async refreshAnnotations(): Promise<void> {
    this.app.workspace.updateOptions();
    for (const leaf of this.app.workspace.getLeavesOfType(ANNOTATION_SIDEBAR_VIEW)) {
      const view = leaf.view;
      if (view instanceof AnnotationSidebarView) {
        view.requestRender();
      }
    }
    for (const leaf of this.app.workspace.getLeavesOfType(EPUB_BOOKSHELF_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof EpubBookshelfView) {
        view.refresh();
      }
    }
    // 从墨光批注侧栏删除/编辑 EPUB 标注后，刷新打开的 EpubReaderView 高亮层
    for (const leaf of this.app.workspace.getLeavesOfType(EPUB_READER_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof EpubReaderView) {
        view.refreshExternalAnnotations();
      }
    }
    // 刷新 Markdown 阅读视图高亮：从侧栏删除/编辑 MD 批注后，阅读区高亮 DOM 也需同步移除。
    // 只刷新当前活动 markdown 文件以控制开销（其余文件在切到时由 active-leaf-change 兜底）。
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.extension === "md") {
      await this.refreshActiveReadingViewHighlights(activeFile.path);
    }
    // 标签总览：标签增删改后重绘（内部按需读文档，成本可接受）
    for (const leaf of this.app.workspace.getLeavesOfType(TAG_BOARD_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof TagBoardView) {
        void view.render();
      }
    }
    await this.stickyLane.render();
  }

  /**
   * 把 EPUB 外观设置（字号 / 行距 / 正文字体 / 统一正文）立即刷到所有已打开的电子书视图。
   * 设置页 onChange 调用，改完无需重开电子书。
   */
  refreshEpubReaderAppearance(remeasureFontScale = false): void {
    for (const leaf of this.app.workspace.getLeavesOfType(EPUB_READER_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof EpubReaderView) {
        view.refreshAppearance(remeasureFontScale);
      }
    }
  }

  /** 手机端防抖同步左侧栏目录视图（layout-change 可能连续触发）。 */
  private scheduleEpubTocSync(): void {
    if (!Platform.isMobile) {
      return;
    }
    if (this.epubTocSyncTimer !== null) {
      window.clearTimeout(this.epubTocSyncTimer);
    }
    this.epubTocSyncTimer = window.setTimeout(() => {
      this.epubTocSyncTimer = null;
      void this.syncEpubTocLeaf();
    }, 200);
  }

  /**
   * 同步左侧栏目录视图：手机端有 EPUB 打开时确保左侧栏存在 EpubTocView
   * （左边缘右滑即可呼出），关完最后一本则摘除，不留孤儿标签页。
   * ensureSideLeaf 仅在该类型视图不存在时新建，不会覆盖文件管理器等已有标签。
   */
  private async syncEpubTocLeaf(): Promise<void> {
    if (!Platform.isMobile) {
      return;
    }
    const workspace = this.app.workspace;
    const tocLeaves = workspace.getLeavesOfType(EPUB_TOC_VIEW_TYPE);
    const hasEpub = workspace.getLeavesOfType(EPUB_READER_VIEW_TYPE).length > 0;

    if (!hasEpub) {
      if (tocLeaves.length > 0) {
        workspace.detachLeavesOfType(EPUB_TOC_VIEW_TYPE);
      }
      return;
    }
    if (tocLeaves.length > 0) {
      return;
    }

    const drawer = workspace.leftSplit;
    const wasOpen = !drawer.collapsed;
    try {
      // active: true 让目录成为左侧栏当前可见标签；不 reveal，避免同步过程把抽屉弹开
      const leaf = await workspace.ensureSideLeaf(EPUB_TOC_VIEW_TYPE, "left", { active: true, reveal: false });
      await leaf.loadIfDeferred();
    } catch (error) {
      console.warn("yh-inklight: 创建左侧栏目录视图失败", error);
      return;
    }
    if (!wasOpen) {
      drawer.collapse();
    }
  }

  /** 刷新所有已打开的左侧栏目录视图（EpubReaderView 目录/高亮变化时回调）。 */
  private refreshEpubToc(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(EPUB_TOC_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof EpubTocView) {
        view.refresh();
      }
    }
  }

  /** 跳转到 PDF 指定页（侧栏批注卡片跳转、书签等共用）。 */
  async gotoPdfPage(pageNumber: number): Promise<void> {
    const ok = await this.pdfViewerAdapter.goToPage(pageNumber, { flash: true, block: "center" });
    if (!ok) {
      new Notice(`未找到第 ${pageNumber} 页`);
    }
  }

  private registerRibbonIcon(): void {
    const icon = this.addRibbonIcon("highlighter", "打开墨光批注", () => {
      void this.activateSidebar();
    });
    icon.addClass("yh-ribbon-icon");
  }

  private registerCommands(): void {
    this.addCommand({
      id: "highlight-selection",
      name: "高亮选中文本",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "h" }],
      callback: () => this.createHighlight(this.settings.defaultHighlightColor),
    });

    this.addCommand({
      id: "add-sticky-note",
      name: "为选中文本添加便签",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "m" }],
      callback: () => this.createComment(),
    });

    this.addCommand({
      id: "check-orphan-export-blocks",
      name: "检查导出笔记里的孤儿块",
      callback: () => void this.checkOrphanBlocks(),
    });

    this.addCommand({
      id: "toggle-sticky-notes",
      name: "切换批注弹层显示",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "n" }],
      callback: async () => {
        this.settings.stickyNotesVisible = !this.settings.stickyNotesVisible;
        await this.saveSettings();
        await this.refreshAnnotations();
      },
    });

    this.addCommand({
      id: "open-annotation-sidebar",
      name: "打开批注总览",
      callback: () => this.activateSidebar(),
    });

    this.addCommand({
      id: "open-epub-bookshelf",
      name: "打开 EPUB 书架",
      callback: () => this.activateBookshelf(),
    });

    this.addCommand({
      id: "open-markdown-stats",
      name: "打开笔记使用统计",
      callback: () => this.activateMarkdownStats(),
    });

    this.addCommand({
      id: "open-tag-board",
      name: "打开标签总览",
      callback: () => this.activateTagBoard(),
    });

    // Phase 5 P3：PDF 目录
    this.addCommand({
      id: "show-pdf-outline",
      name: "显示 PDF 目录",
      callback: async () => {
        if (!this.pdfLayer.isPdfActive()) {
          new Notice("请先打开一个 PDF 文件");
          return;
        }
        const outline = await this.pdfLayer.getOutline();
        if (outline.length === 0) {
          new Notice("该 PDF 没有目录");
          return;
        }
        const lines = outline.map((item) => {
          const pageInfo = item.pageNumber > 0 ? ` → p.${item.pageNumber}` : "";
          const children = item.children
            .filter((c) => c.pageNumber > 0)
            .map((c) => `  └ ${c.title} → p.${c.pageNumber}`)
            .join("\n");
          return `${item.title}${pageInfo}${children ? "\n" + children : ""}`;
        });
        new Notice(`PDF 目录（${outline.length} 项）：\n${lines.slice(0, 8).join("\n")}`);
      },
    });

    this.addCommand({
      id: "test-annotation-storage",
      name: "测试墨光批注存储",
      callback: async () => {
        try {
          const path = await this.store.testWriteAccess();
          new Notice(`墨光批注存储可写：${path}`);
        } catch {
          new Notice("墨光批注存储不可写，请检查 .obsidian-annotations 目录权限或同步状态。");
        }
      },
    });
  }

  /**
   * 源文件被修改后迁移锚点。
   * 只有锚点真的漂移时才写盘并刷新视图——否则「保存一下 md」就会重写 sidecar 并
   * 全量重建批注侧栏（container.empty + 重新聚焦标签输入框），打断正在进行的标签输入。
   */
  private async syncMarkdownAnchors(file: TFile): Promise<void> {
    const document = await this.store.getDocument(file);
    if (document.highlights.length === 0 && document.comments.length === 0) {
      return;
    }

    const source = await this.app.vault.cachedRead(file);
    const relocated = relocateDocumentAnchors(source, document);
    if (anchorsUnchanged(document, relocated)) {
      return;
    }

    await this.store.saveDocument({
      ...relocated,
      fileHash: await this.store.hashFile(file),
      lastModified: new Date().toISOString(),
    });
    await this.refreshAnnotations();
  }

  private registerEvents(): void {
    this.registerDomEvent(document, "selectionchange", () => this.toolbar.showForSelection());
    this.registerDomEvent(document, "mousedown", (event) => {
      if (!(event.target instanceof HTMLElement) || !event.target.closest(".yh-selection-toolbar")) {
        window.setTimeout(() => this.toolbar.showForSelection(), 0);
      }
    });
    this.registerDomEvent(document, "click", (event) => {
      void this.handleAnnotationClick(event);
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") {
          return;
        }
        // 同一个文件的连续写入合并成一次迁移，避免同步盘每几秒写一次就全量刷新所有批注视图
        const path = file.path;
        const pending = this.mdModifyTimers.get(path);
        if (pending !== undefined) {
          window.clearTimeout(pending);
        }
        this.mdModifyTimers.set(path, window.setTimeout(() => {
          this.mdModifyTimers.delete(path);
          const target = this.app.vault.getAbstractFileByPath(path);
          if (target instanceof TFile) {
            void this.syncMarkdownAnchors(target);
          }
        }, MD_MODIFY_DEBOUNCE_MS));
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        if (!this.settings.migrateOnRename || !(file instanceof TFile)) {
          return;
        }

        const ext = file.extension.toLowerCase();
        const isMarkdown = ext === "md";
        const isBook = (SUPPORTED_BOOK_EXTENSIONS as readonly string[]).includes(ext);
        if (!isMarkdown && !isBook) {
          return;
        }

        if (this.renameMigrationTimer !== null) {
          window.clearTimeout(this.renameMigrationTimer);
        }

        this.renameMigrationTimer = window.setTimeout(async () => {
          await this.store.migrateFilePath(oldPath, file);
          // 迁移 Markdown 打开次数统计：key 跟随路径
          if (isMarkdown) {
            const stats = this.mdOpenStats;
            if (stats[oldPath] && file.path !== oldPath) {
              stats[file.path] = stats[oldPath];
              delete stats[oldPath];
              this.debouncedSaveMdOpenStats();
            }
            // 统计视图展示路径，即使该文件无统计记录也要刷新
            this.refreshMarkdownStatsViews();
          }
          await this.refreshAnnotations();
          this.renameMigrationTimer = null;
        }, 100);
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-open", async (file) => {
        if (file instanceof TFile && ["md", "pdf"].includes(file.extension.toLowerCase())) {
          this.popoverCard?.dismiss();
          await this.store.getDocument(file);
          await this.refreshAnnotations();
        }
      }),
    );

    // Markdown 打开次数统计：60s 冷却去重，只写 data.json，不触碰 md 原文
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        this.countMarkdownOpen(file);
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && file.extension.toLowerCase() === "md") {
          const stats = this.mdOpenStats;
          if (stats[file.path]) {
            delete stats[file.path];
            this.debouncedSaveMdOpenStats();
          }
          this.refreshMarkdownStatsViews();
        }
      }),
    );

    // 手机端：EPUB 打开/关闭时同步左侧栏目录视图（打开 EPUB 需左滑可见，关完最后一本则摘除）
    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleEpubTocSync()));
  }

  /** 加载 Markdown 打开次数统计（独立 sidecar），并迁移 data.json 中的旧数据。 */
  private async loadMdOpenStats(): Promise<void> {
    let loaded: Record<string, MdOpenStat> = {};
    try {
      const raw = await this.app.vault.adapter.read(MD_OPEN_STATS_PATH);
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        loaded = parsed;
      }
    } catch {
      /* 文件不存在或损坏 → 空统计 */
    }
    this.mdOpenStats = loaded;

    // 迁移旧版存储在 data.json settings.mdOpenStats 的数据
    const legacy = (this.settings as AnnotationPluginSettings & { mdOpenStats?: Record<string, MdOpenStat> }).mdOpenStats;
    if (legacy && Object.keys(legacy).length > 0) {
      if (Object.keys(this.mdOpenStats).length === 0) {
        this.mdOpenStats = { ...legacy };
      }
      // 清理旧位置，避免 data.json 继续膨胀
      delete (this.settings as { mdOpenStats?: unknown }).mdOpenStats;
      await this.saveSettings();
      await this.saveMdOpenStats();
    }
  }

  /** 将打开次数统计写入独立 sidecar 文件。 */
  async saveMdOpenStats(): Promise<void> {
    try {
      await this.app.vault.adapter.write(MD_OPEN_STATS_PATH, JSON.stringify(this.mdOpenStats, null, 2));
    } catch (error) {
      console.warn("yh-inklight: 写入打开次数统计失败", error);
    }
  }

  /**
   * 加载批注回看记录（独立 sidecar）。损坏或缺失都当空记录，不影响插件启动。
   * 过期条目在加载时就丢掉，避免手工改坏的数据一直留在内存里。
   */
  private async loadReviewedAnnotations(): Promise<void> {
    let loaded: Record<string, string> = {};
    try {
      const raw = await this.app.vault.adapter.read(ANNOTATION_REVIEW_STATE_PATH);
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const cutoff = Date.now() - REVIEW_STATE_TTL_DAYS * 86_400_000;
        for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === "string" && (Date.parse(value) || 0) > cutoff) {
            loaded[id] = value;
          }
        }
      }
    } catch {
      /* 文件不存在或损坏 → 空记录 */
    }
    this.reviewedAnnotations = loaded;
  }

  private async saveReviewedAnnotations(): Promise<void> {
    try {
      await this.app.vault.adapter.write(
        ANNOTATION_REVIEW_STATE_PATH,
        JSON.stringify(this.reviewedAnnotations, null, 2),
      );
    } catch (error) {
      console.warn("yh-inklight: 写入批注回看记录失败", error);
    }
  }

  /** 回看记录查询：无记录返回 0，供 buildAnnotationBuckets 判「今天已回看过」 */
  private reviewedAtOf(annotationId: string): number {
    return Date.parse(this.reviewedAnnotations[annotationId] ?? "") || 0;
  }

  /**
   * 标记一条批注已回看。每张复习卡只对应一个自然日（日差 1/7 或同号日历日），
   * 当天隐藏即可保证它不会在同一个窗口里再次冒出来。
   */
  private markAnnotationReviewed(annotationId: string): void {
    if (!annotationId) {
      return;
    }
    const now = Date.now();
    this.reviewedAnnotations[annotationId] = new Date(now).toISOString();
    const cutoff = now - REVIEW_STATE_TTL_DAYS * 86_400_000;
    for (const [id, value] of Object.entries(this.reviewedAnnotations)) {
      if ((Date.parse(value) || 0) <= cutoff) {
        delete this.reviewedAnnotations[id];
      }
    }
    void this.saveReviewedAnnotations();
  }

  /** 防抖保存打开次数统计。 */
  private debouncedSaveMdOpenStats(): void {
    if (this.statsSaveTimer !== null) {
      window.clearTimeout(this.statsSaveTimer);
    }
    this.statsSaveTimer = window.setTimeout(() => {
      this.statsSaveTimer = null;
      void this.saveMdOpenStats();
    }, 1500);
  }

  /** 记录一次 Markdown 打开（开启开关、.md 文件、60s 冷却内不重复计）。 */
  private countMarkdownOpen(file: TFile | null): void {
    if (!this.settings.mdOpenTracking || !(file instanceof TFile) || file.extension.toLowerCase() !== "md") {
      return;
    }
    const now = Date.now();
    if (file.path === this.lastCountedPath && now - this.lastCountedAt < 60_000) {
      return;
    }
    const existing = this.mdOpenStats[file.path];
    if (existing && now - (Date.parse(existing.lastOpenedAt) || 0) < 60_000) {
      return;
    }
    this.lastCountedPath = file.path;
    this.lastCountedAt = now;
    this.mdOpenStats[file.path] = {
      openCount: (existing?.openCount ?? 0) + 1,
      lastOpenedAt: new Date(now).toISOString(),
    };
    this.debouncedSaveMdOpenStats();
    this.refreshMarkdownStatsViews();
  }

  /** 防抖保存设置：合并频繁的打开计数写盘。 */
  private debouncedSaveSettings(): void {
    if (this.settingsSaveTimer !== null) {
      window.clearTimeout(this.settingsSaveTimer);
    }
    this.settingsSaveTimer = window.setTimeout(() => {
      this.settingsSaveTimer = null;
      void this.saveSettings();
    }, 1500);
  }

  /** 刷新所有已打开的「笔记使用统计」视图。 */
  refreshMarkdownStatsViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(MARKDOWN_STATS_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof MarkdownStatsView) {
        view.refresh();
      }
    }
  }


  /**
   * 强制所有打开的 Markdown 编辑器重建高亮装饰。
   * CM6 装饰重建依赖 ViewUpdate 中的 version 检查，但 store 保存完成时
   * 编辑器可能没有任何更新事件（doc/selection/viewport 均未变），
   * 派发一个空事务即可触发一次 ViewUpdate → 版本检查 → 装饰重建。
   */
  private forceEditorDecorationsRefresh(filePath?: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) {
        continue;
      }
      if (filePath && view.file?.path !== filePath) {
        continue;
      }
      const cm = (view.editor as unknown as { cm?: { dispatch: (spec: object) => void } }).cm;
      cm?.dispatch({});
    }
  }

  private async createHighlight(color: AnnotationColor): Promise<void> {
    if (this.pdfLayer.isPdfActive()) {
      await this.pdfLayer.createHighlight(color);
      this.toolbar.hide();
      return;
    }

    const snapshot = await this.resolveSelection();

    if (!snapshot) {
      new Notice("请先选中文本。");
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(snapshot.filePath);
    if (!(file instanceof TFile)) {
      return;
    }

    const highlight: HighlightAnnotation = {
      id: crypto.randomUUID(),
      color,
      anchor: createAnchorForSnapshot(await this.app.vault.cachedRead(file), snapshot),
      createdAt: new Date().toISOString(),
    };

    await this.store.addHighlight(file, highlight);
    // 编辑模式：store.version 已涨但 CM6 无更新事件，派发空事务强制装饰重建（否则需重开标签页才显示）
    this.forceEditorDecorationsRefresh(file.path);
    await this.refreshActiveReadingViewHighlights(file.path);
    await this.refreshAnnotations();
    this.toolbar.hide();
    this.clearActiveSelection();
  }

  private async createComment(): Promise<void> {
    if (this.pdfLayer.isPdfActive()) {
      const note = await new CommentModal(this.app, "", "", [], this.getTagSuggestions()).openAndRead();
      if (note !== null) {
        await this.pdfLayer.createComment(
          this.settings.defaultHighlightColor,
          note.content,
          this.settings.defaultAuthor,
          note.title,
          note.tags,
        );
      }
      this.toolbar.hide();
      return;
    }

    const snapshot = await this.resolveSelection();
    if (!snapshot) {
      new Notice("请先选中文本。");
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(snapshot.filePath);
    if (!(file instanceof TFile)) {
      return;
    }

    const note = await new CommentModal(this.app, "", "", [], this.getTagSuggestions()).openAndRead();
    if (note === null) {
      return;
    }

    await this.saveCommentForSnapshot(file, snapshot, note);
    this.toolbar.hide();
    this.clearActiveSelection();
  }

  /**
   * 工具栏「AI 助手」入口：复用 EPUB 的 EpubAiModal（解释/翻译/改写/自定义提问）。
   * 回复不落盘，用户点「存为便签」时预填进 CommentModal，走既有 md 便签流程。
   */
  private async openAiForSelection(): Promise<void> {
    const snapshot = await this.resolveSelection();
    if (!snapshot) {
      new Notice("请先选中文本。");
      return;
    }

    this.toolbar.hide();
    this.clearActiveSelection();

    new EpubAiModal(this.app, snapshot.selectedText, this.settings, (note) => {
      const file = this.app.vault.getAbstractFileByPath(snapshot.filePath);
      if (!(file instanceof TFile)) {
        return;
      }
      void new CommentModal(this.app, "", note, [], this.getTagSuggestions()).openAndRead().then(async (value) => {
        if (value === null) {
          return;
        }
        await this.saveCommentForSnapshot(file, snapshot, value);
      });
    }).open();
  }

  /** 把选区快照 + 用户（或 AI 回复预填后编辑的）笔记保存为 md 便签批注。 */
  private async saveCommentForSnapshot(
    file: TFile,
    snapshot: SelectionSnapshot,
    note: CommentModalValue,
  ): Promise<void> {
    const now = new Date().toISOString();
    const comment: CommentAnnotation = {
      id: crypto.randomUUID(),
      anchor: createAnchorForSnapshot(await this.app.vault.cachedRead(file), snapshot),
      title: note.title,
      content: note.content,
      color: this.settings.defaultHighlightColor,
      position: { offsetX: 20, offsetY: 0 },
      collapsed: false,
      author: this.settings.defaultAuthor,
      createdAt: now,
      updatedAt: now,
      replies: [],
      resolved: false,
      ...(note.tags.length > 0 ? { tags: [...note.tags] } : {}),
    };

    await this.store.addComment(file, comment);
    // 编辑模式：同 createHighlight，强制 CM6 装饰重建
    this.forceEditorDecorationsRefresh(file.path);
    await this.refreshActiveReadingViewHighlights(file.path);
    await this.refreshAnnotations();
  }

  /**
   * 收起当前选区与 Android 系统选择操作条（复制/分享/全选/网页搜索）。
   * 编辑模式下 CM6 选区折叠到光标处；阅读模式清空 DOM 选区；
   * 选区移除后系统条自动收起，工具栏也不会因后续 mouseup 回弹。
   */
  private clearActiveSelection(): void {
    const editor = this.activeEditor()?.editor;
    if (editor) {
      const selected = editor.getSelection();
      if (selected) {
        const cursor = editor.getCursor("to");
        editor.setSelection(cursor);
      }
    }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      selection.removeAllRanges();
    }
  }

  private async refreshActiveReadingViewHighlights(filePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      return;
    }

    const document = this.store.getCachedDocument(filePath) ?? (await this.store.getDocument(file));
    const marks = [...document.highlights, ...document.comments].filter((item) => !item.orphaned);
    if (!marks.length) {
      return;
    }

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file?.path !== filePath) {
        continue;
      }

      const previewRoot = findPreviewRoot(view);
      if (previewRoot) {
        refreshReadingViewHighlights(previewRoot, marks);
        continue;
      }

      const previewMode = (view as MarkdownView & { previewMode?: { rerender?: (force?: boolean) => Promise<void> } })
        .previewMode;
      if (previewMode?.rerender) {
        await previewMode.rerender(true);
        const rerenderedRoot = findPreviewRoot(view);
        if (rerenderedRoot) {
          refreshReadingViewHighlights(rerenderedRoot, marks);
        }
      }
    }
  }

  private async resolveSelection(): Promise<SelectionSnapshot | null> {
    const editor = this.activeEditor();
    if (editor?.file) {
      const selectedText = editor.editor.getSelection();
      if (selectedText) {
        const from = editor.editor.posToOffset(editor.editor.getCursor("from"));
        const to = editor.editor.posToOffset(editor.editor.getCursor("to"));
        this.lastSelection = { filePath: editor.file.path, startOffset: from, endOffset: to, selectedText };
        return this.lastSelection;
      }
    }

    const file = this.app.workspace.getActiveFile();
    const selection = window.getSelection();
    const selectedText = selection?.toString().replace(/\r\n/g, "\n").trim() ?? "";

    if (file && selectedText) {
      const source = await this.app.vault.cachedRead(file);
      const renderContext = selection ? renderedSelectionContext(selection) : null;
      const located = locateRenderedSelectionInSource(
        source,
        selectedText,
        selection ? renderedOccurrenceBeforeSelection(selection, selectedText) : 0,
        selection ? isSelectionInsideCallout(selection) : false,
        renderContext,
      );

      if (located) {
        this.lastSelection = {
          filePath: file.path,
          startOffset: located.startOffset,
          endOffset: located.endOffset,
          selectedText,
        };
        return this.lastSelection;
      }
    }

    // 定位失败兜底：仅当选区文本与上次快照【完全一致】时才复用
    // （DOM range 因焦点切换等原因失效、但选的是同一段文字的场景）。
    // 文本对不上时绝不能用旧偏移，否则高亮会落到上一次选区的位置。
    if (
      file &&
      this.lastSelection?.filePath === file.path &&
      selectedText &&
      this.lastSelection.selectedText.trim() === selectedText
    ) {
      return this.lastSelection;
    }

    if (selectedText) {
      new Notice("无法在原文中定位该选区，未创建标注。");
    }
    return null;
  }

  private activeEditor(): { editor: Editor; file: TFile | null } | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view ? { editor: view.editor, file: view.file } : null;
  }

  async activateSidebar(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(ANNOTATION_SIDEBAR_VIEW)[0];
    if (!leaf) {
      const nextLeaf = this.app.workspace.getRightLeaf(false);
      if (!nextLeaf) {
        return;
      }
      leaf = nextLeaf;
      await leaf.setViewState({ type: ANNOTATION_SIDEBAR_VIEW, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof AnnotationSidebarView) {
      view.requestRender();
    }
  }

  async activateBookshelf(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(EPUB_BOOKSHELF_VIEW_TYPE)[0];
    if (!leaf) {
      const nextLeaf = this.app.workspace.getRightLeaf(false);
      if (!nextLeaf) {
        return;
      }
      leaf = nextLeaf;
      await leaf.setViewState({ type: EPUB_BOOKSHELF_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof EpubBookshelfView) {
      view.refresh();
    }
  }

  async openEpubBook(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
  }

  async activateMarkdownStats(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(MARKDOWN_STATS_VIEW_TYPE)[0];
    if (!leaf) {
      const nextLeaf = this.app.workspace.getRightLeaf(false);
      if (!nextLeaf) {
        return;
      }
      leaf = nextLeaf;
      await leaf.setViewState({ type: MARKDOWN_STATS_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof MarkdownStatsView) {
      view.refresh();
    }
  }

  /**
   * 打开标签总览（主区域标签页）。传 tagKey 时定位到该标签。
   * 已打开则直接切过去并重绘，不重复开 tab。
   */
  async activateTagBoard(tagKey?: string): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(TAG_BOARD_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: TAG_BOARD_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);

    const view = leaf.view;
    if (!(view instanceof TagBoardView)) {
      return;
    }
    if (tagKey) {
      view.focusTag(tagKey);
    } else {
      await view.render();
    }
  }

  /**
   * 找到已经打开该 Markdown 文件的标签页（含延迟加载的），用于复用而非重复新建。
   * 用 getViewState 而非 view instanceof，能覆盖尚未加载的 deferred 标签页。
   */
  private findMarkdownLeaf(file: TFile): WorkspaceLeaf | null {
    const matches: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      const state = leaf.getViewState();
      if (state.type === "markdown" && state.state?.file === file.path) {
        matches.push(leaf);
      }
    });
    return matches[0] ?? null;
  }

  /**
   * 全库 Obsidian 标签：遍历 md 的 metadataCache 缓存逐篇收集。
   * 不走 getTags()（当前 obsidian.d.ts 未暴露该 API），顺带能覆盖 frontmatter 标签。
   * 只读内存缓存，不读文件内容；数量级与 vault 的 md 篇数相同，耗时可忽略。
   */
  private getVaultObsidianTags(): string[] {
    const tags: string[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      tags.push(...this.getFileObsidianTags(file));
    }
    return normalizeTags(tags);
  }

  /**
   * 读取一个 md 文档上的 Obsidian 标签（正文 #tag + frontmatter 的 tags/tag）。
   * 只读 metadataCache，不读文件内容；PDF/EPUB 返回空数组（它们没有 OB 标签）。
   */
  getFileObsidianTags(file: TFile | null): string[] {
    if (!file || file.extension.toLowerCase() !== "md") {
      return [];
    }
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) {
      return [];
    }
    const raw: string[] = [];
    for (const item of cache.tags ?? []) {
      raw.push(item.tag);
    }
    const fm = cache.frontmatter?.tags ?? cache.frontmatter?.tag;
    if (typeof fm === "string") {
      raw.push(fm);
    } else if (Array.isArray(fm)) {
      for (const value of fm) {
        if (typeof value === "string") {
          raw.push(value);
        }
      }
    }
    return normalizeTags(raw);
  }

  /**
   * 标签补全候选：当前文档 OB 标签（置顶）∪ 已用标签 ∪ OB 全库标签 ∪ 全库 md 文件名。
   * 全部走内存索引与 metadataCache，不读磁盘内容；开关关闭时保持原有两类候选。
   * 每次调用即时重算，因此无需监听 metadataCache 的 changed 事件。
   */
  getTagSuggestions(): TagSuggestion[] {
    const existing = this.store.getTagDictionary().map((item) => item.name);
    const basenames = this.app.vault.getMarkdownFiles().map((file) => file.basename);
    if (!this.settings.obTagBridge) {
      return buildTagSuggestions(existing, basenames);
    }
    return buildTagSuggestions(
      existing,
      basenames,
      this.getVaultObsidianTags(),
      this.getFileObsidianTags(this.app.workspace.getActiveFile()),
    );
  }

  async openMarkdownNote(file: TFile, options?: { forceCount?: boolean }): Promise<void> {
    // 优先复用已打开该文件的标签页，避免连点侧栏堆出一排重复 tab
    const leaf = this.findMarkdownLeaf(file) ?? this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
    // 手机端右侧栏是覆盖式抽屉，打开笔记后收起，避免遮挡正文
    if (Platform.isMobile) {
      this.app.workspace.rightSplit?.collapse();
    }
    if (options?.forceCount) {
      this.ensureMarkdownOpenCounted(file);
    }
  }

  /**
   * 复习卡点击兜底计数：60s 冷却会吃掉 file-open 的计数，导致条目不移出卡片。
   * openFile 之后检查，若刚才没有写入（lastOpenedAt 仍是旧的）则补记一次。
   */
  private ensureMarkdownOpenCounted(file: TFile): void {
    if (!this.settings.mdOpenTracking || file.extension.toLowerCase() !== "md") {
      return;
    }
    const now = Date.now();
    const existing = this.mdOpenStats[file.path];
    // file-open 已正常计数：lastOpenedAt 在数秒内 → 不再重复记
    if (existing && now - (Date.parse(existing.lastOpenedAt) || 0) < 5_000) {
      return;
    }
    this.mdOpenStats[file.path] = {
      openCount: (existing?.openCount ?? 0) + 1,
      lastOpenedAt: new Date(now).toISOString(),
    };
    this.lastCountedPath = file.path;
    this.lastCountedAt = now;
    this.debouncedSaveMdOpenStats();
    this.refreshMarkdownStatsViews();
  }

  /**
   * 打开 EPUB 文件并导航到指定 CFI 位置。
   * 供 EpubGotoHandler（摘录回跳）和 Obsidian 协议处理器调用。
   */
  /**
   * 批注回顾数据源：只取「有自己写的内容」的批注，纯划线不进回顾。
   * 关联数 = 出度（自己指向别人）+ 入度（别人指向自己）；0 就是孤岛，回顾时排最前。
   */
  private async collectAnnotationReviewEntries(): Promise<AnnotationReviewEntry[]> {
    const documents = await this.store.getIndexedDocuments();
    const entries: AnnotationReviewEntry[] = [];
    const inbound = new Map<string, number>();

    for (const document of documents) {
      for (const comment of document.comments) {
        entries.push({
          id: comment.id,
          filePath: document.filePath,
          mode: "md",
          quote: comment.anchor.selectedText,
          content: comment.content,
          createdAt: Date.parse(comment.updatedAt || comment.createdAt) || 0,
          linkCount: comment.relations?.length ?? 0,
          offset: comment.anchor.startOffset,
        });
      }
      for (const comment of document.pdfComments) {
        entries.push({
          id: comment.id,
          filePath: document.filePath,
          mode: "pdf",
          quote: comment.anchor.selectedText,
          content: comment.content,
          createdAt: Date.parse(comment.updatedAt || comment.createdAt) || 0,
          linkCount: comment.relations?.length ?? 0,
          pageNumber: comment.anchor.pageNumber,
        });
      }
      for (const comment of document.epubComments) {
        entries.push({
          id: comment.id,
          filePath: document.filePath,
          mode: "epub",
          quote: comment.anchor.selectedText,
          content: comment.note,
          createdAt: Date.parse(comment.createdAt) || 0,
          linkCount: comment.relations?.length ?? 0,
          cfiRange: comment.anchor.cfiRange,
        });
      }

      for (const item of [...document.comments, ...document.pdfComments, ...document.epubComments]) {
        for (const relation of item.relations ?? []) {
          const key = `${relation.targetPath}#${relation.targetId}`;
          inbound.set(key, (inbound.get(key) ?? 0) + 1);
        }
      }
    }

    return entries
      .filter((entry) => entry.content.trim().length > 0)
      .map((entry) => ({
        ...entry,
        linkCount: entry.linkCount + (inbound.get(`${entry.filePath}#${entry.id}`) ?? 0),
        reviewedAt: this.reviewedAtOf(entry.id),
      }));
  }

  private async openAnnotationReviewEntry(entry: AnnotationReviewEntry): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(entry.filePath);
    if (!(file instanceof TFile)) {
      new Notice(`找不到源文件：${entry.filePath}`);
      return;
    }
    await openAnnotationTarget(
      this.app,
      {
        file,
        offset: entry.offset ?? 0,
        pageNumber: entry.pageNumber ?? null,
        mode: entry.mode,
        cfiRange: entry.cfiRange,
      },
      (targetFile, cfi) => this.openEpubAtCfi(targetFile.path, cfi),
      { newTab: true },
    );
    // 回看已处理：记下时间戳并重绘列表，条目当天不再出现（次日窗口自然不匹配）
    this.markAnnotationReviewed(entry.id);
    this.refreshMarkdownStatsViews();
  }

  // ------------------------------------------------------------------ 卡片「相关」区

  private relationModelInstance: RelationModel | null = null;

  /**
   * 关系模型单点：侧栏与三端浮层共用同一个快照。
   * 以前只在侧栏里 new 一个，浮层想显示「相关」就得再建一份，两份快照各自失效必然不一致。
   */
  private relationModel(): RelationModel {
    if (!this.relationModelInstance) {
      this.relationModelInstance = new RelationModel(this.store);
    }
    return this.relationModelInstance;
  }

  /** 侧栏渲染前预热（documents 为当前范围；只传一个时模型会自动补拉全库） */
  async prepareRelations(documents: readonly FileAnnotationDocument[]): Promise<void> {
    if (!this.settings.contentRelations) {
      return;
    }
    await this.relationModel().prepare(documents);
  }

  invalidateRelations(): void {
    this.relationModel().invalidate();
  }

  /** 同步取命中：快照未就绪时返回空数组，不阻塞渲染 */
  getRelatedCards(card: SidebarCard): RelatedHitView[] {
    return this.settings.contentRelations ? this.relationModel().getRelated(card) : [];
  }

  /** 标签编辑器的「按内容推荐」候选（只从历史里挑，不发明新词） */
  getRecommendedTags(card: SidebarCard): TagSuggestion[] {
    if (!this.settings.contentRelations) {
      return [];
    }
    return this.relationModel().getRecommendedTags(card).map((name) => ({ name, kind: "recommended" as const }));
  }

  /** 浮层用：命中可能还没算过，先确保全库快照就绪 */
  private async relatedHitsFor(card: SidebarCard): Promise<RelatedHitView[]> {
    if (!this.settings.contentRelations) {
      return [];
    }
    await this.relationModel().prepare([]);
    return this.relationModel().getRelated(card);
  }

  /** 关联候选：命中最长短语优先，其后是历史用过的标签；已共享的不再作为候选 */
  relatedCandidates(self: SidebarCard, other: SidebarCard, reasons: readonly string[]): string[] {
    const names: string[] = [];
    if (reasons[0]) {
      names.push(reasons[0]);
    }
    for (const suggestion of this.getTagSuggestions()) {
      if (names.length >= 6) {
        break;
      }
      if (suggestion.kind === "used") {
        names.push(suggestion.name);
      }
    }
    return filterSharedCandidates(names, self, other);
  }

  private fileOf(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  /** 跳到任意卡片那句：md 带 offset、pdf 带页码、epub 走 CFI */
  async jumpToCard(card: SidebarCard): Promise<void> {
    const file = this.fileOf(card.sourcePath);
    if (!file) {
      new Notice("源文件已不存在，无法跳转");
      return;
    }
    if (card.mode === "epub" && card.cfiRange) {
      await this.openEpubAtCfi(file.path, card.cfiRange);
      return;
    }
    await openAnnotationTarget(
      this.app,
      {
        file,
        offset: card.startOffset,
        pageNumber: card.pageNumber,
        mode: card.mode,
        cfiRange: card.cfiRange,
      },
      (targetFile, cfi) => this.openEpubAtCfi(targetFile.path, cfi),
    );
  }

  private popoverRelatedState(): {
    isOpen: (cardId: string) => boolean;
    setOpen: (cardId: string, open: boolean) => void;
  } {
    return {
      isOpen: (cardId) => this.popoverRelatedOpen.has(cardId),
      setOpen: (cardId, open) => {
        if (open) {
          this.popoverRelatedOpen.add(cardId);
        } else {
          this.popoverRelatedOpen.delete(cardId);
        }
      },
    };
  }

  /**
   * 相关区的宿主：命中、跳转、确认关联、断开全部走插件单点。
   * 侧栏与浮层只提供展开态，DOM 在 views/relatedBlock。
   */
  createRelatedHost(
    self: SidebarCard,
    openState?: { isOpen: (cardId: string) => boolean; setOpen: (cardId: string, open: boolean) => void },
    options?: { prepared?: boolean },
  ): RelatedBlockHost {
    return {
      // 侧栏在渲染前已经 await 过 prepareRelations：直接同步取命中，
      // 避免每张卡再走一次 prepare（并发时会被去重，但仍有 N 次 Promise 往返）。
      // 长列表分批追加可能超过缓存 TTL，因此只认版本号（isCurrent）；
      // 只有中途被写入失效时才回退到异步准备，保证结果不空。
      load: () =>
        options?.prepared && this.relationModel().isCurrent()
          ? Promise.resolve(this.getRelatedCards(self))
          : this.relatedHitsFor(self),
      isOpen: (cardId) => openState?.isOpen(cardId) ?? false,
      setOpen: (cardId, open) => openState?.setOpen(cardId, open),
      fileName: (card) => this.fileOf(card.sourcePath)?.name ?? card.sourcePath,
      canLink: (other) => Boolean(this.fileOf(self.sourcePath) && this.fileOf(other.sourcePath)),
      candidates: (other, reasons) => this.relatedCandidates(self, other, reasons),
      onJump: (target) => void this.jumpToCard(target),
      onConfirm: (other, tag, type) => this.confirmRelationTag(self, other, tag, type),
      onRemoveSharedTag: (other, tag) => this.removeSharedRelationTag(self, other, tag),
      relationTypes: RELATION_TYPES,
    };
  }

  /** 卡片的标签 refs：高亮与其笔记共享同一份标签数组，写入时两者都要覆盖 */
  private tagRefsOf(card: SidebarCard): TagRef[] {
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
  private async readLiveTags(
    card: SidebarCard,
    action: string,
  ): Promise<{ refs: TagRef[]; live: string[] } | null> {
    const file = this.fileOf(card.sourcePath);
    if (!file) {
      new Notice(`源文件缺失，无法${action}`);
      return null;
    }
    const refs = this.tagRefsOf(card);
    const document = await this.store.getDocument(file);
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

  /**
   * 确认关联：把一个共享标签写入两侧；选了关系类型再落一条有向关系。
   * 先活读两侧最新标签取并集再覆盖，绝不拿渲染快照覆盖。
   */
  async confirmRelationTag(
    self: SidebarCard,
    other: SidebarCard,
    rawTag: string,
    relationType: RelationType | null = null,
  ): Promise<void> {
    const tag = normalizeTag(rawTag);
    if (!tag) {
      return;
    }
    const preparedSelf = await this.readLiveTags(self, "建立关联");
    if (!preparedSelf) {
      return;
    }
    const preparedOther = await this.readLiveTags(other, "建立关联");
    if (!preparedOther) {
      return;
    }
    try {
      await this.store.setTags(preparedSelf.refs, unionTags(preparedSelf.live, [tag]));
      await this.store.setTags(preparedOther.refs, unionTags(preparedOther.live, [tag]));
      const selfFile = this.fileOf(self.sourcePath);
      if (relationType && selfFile) {
        await this.store.addRelation(selfFile, self.id, {
          targetPath: other.sourcePath,
          targetId: other.id,
          targetMode: other.mode,
          type: relationType,
          createdAt: new Date().toISOString(),
          ...relationAnchorOf(other),
        });
      }
      this.invalidateRelations();
      const label = RELATION_TYPES.find(([type]) => type === relationType)?.[1];
      new Notice(label ? `已建立「${label}」关系，并共享标签「${tag}」` : `已用「${tag}」关联两侧批注`);
      await this.refreshAnnotations();
    } catch (error) {
      console.warn("yh-inklight: 写入关联标签失败", error);
      new Notice("关联标签写入失败，请检查写入权限或同步状态");
    }
  }

  /** 断开关联：把该标签从两侧移除；其他批注上的同名标签不受影响（setTags 只动指定 refs） */
  async removeSharedRelationTag(self: SidebarCard, other: SidebarCard, rawTag: string): Promise<void> {
    const key = tagKey(rawTag);
    if (!key) {
      return;
    }
    const preparedSelf = await this.readLiveTags(self, "断开关联");
    if (!preparedSelf) {
      return;
    }
    const preparedOther = await this.readLiveTags(other, "断开关联");
    if (!preparedOther) {
      return;
    }
    try {
      await this.store.setTags(
        preparedSelf.refs,
        unionTags(preparedSelf.live).filter((item) => tagKey(item) !== key),
      );
      await this.store.setTags(
        preparedOther.refs,
        unionTags(preparedOther.live).filter((item) => tagKey(item) !== key),
      );
      // 关系与标签一起断开：只删标签会在导出笔记里留下指向已断开关联的 supports:: 行
      const selfFile = this.fileOf(self.sourcePath);
      if (selfFile) {
        await this.store.removeRelation(selfFile, self.id, other.sourcePath, other.id);
      }
      const otherFile = this.fileOf(other.sourcePath);
      if (otherFile) {
        await this.store.removeRelation(otherFile, other.id, self.sourcePath, self.id);
      }
      this.invalidateRelations();
      new Notice(`已断开关联标签「${rawTag}」`);
      await this.refreshAnnotations();
    } catch (error) {
      console.warn("yh-inklight: 断开关联标签失败", error);
      new Notice("断开关联失败，请检查写入权限或同步状态");
    }
  }

  /**
   * 卡片动作「打开导出笔记」：索引里的 derivedNotePath 是唯一真相。
   * 侧栏与三端浮层共用这一条，避免各写一份之后有的入口失效。
   */
  async openDerivedNote(sourcePath: string): Promise<void> {
    const notePath = this.store.getExportRecord(sourcePath).notePath;
    if (!notePath) {
      new Notice("这条批注还没有导出过");
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) {
      new Notice(`找不到导出笔记：${notePath}`);
      return;
    }
    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  /**
   * 卡片动作「提炼成卡片」：正文只放用户自己写的那句，出处与标签进 frontmatter。
   * 不做 AI 代写、不批量生成——「用自己的话重写」才是内化发生的那一步。
   */
  async createAtomCardFor(card: SidebarCard): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(card.sourcePath);
    if (!(file instanceof TFile)) {
      new Notice("找不到源文件，无法提炼");
      return;
    }
    try {
      const result = await this.store.createAtomCard(
        file,
        {
          annotationId: card.id,
          mode: card.mode,
          quote: card.text,
          content: card.content,
          noteType: card.noteType,
          tags: card.tags,
        },
        this.settings.atomCardFolder,
      );
      if (result.status === "empty") {
        new Notice("这条批注还没写下自己的想法，提炼不出卡片");
        return;
      }
      const target = this.app.vault.getAbstractFileByPath(result.path);
      if (target instanceof TFile) {
        await this.app.workspace.getLeaf("tab").openFile(target);
      }
      new Notice(
        result.status === "created"
          ? `已提炼成卡片：${result.path}（此后卡片独立生长，不再与批注同步）`
          : `这张卡片已存在：${result.path}（已与批注分叉，不会自动同步）`,
      );
    } catch (error) {
      console.warn("yh-inklight: 生成原子卡失败", error);
      new Notice("生成卡片失败，请检查写入权限或同步状态");
    }
  }

  /** 卡片动作「关系跳转」：按关系里存的锚点快照定位，不必回查目标文档 */
  async jumpToRelationTarget(relation: AnnotationRelation): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(relation.targetPath);
    if (!(file instanceof TFile)) {
      new Notice("目标文件已不存在，可点 × 解除这条关系");
      return;
    }
    if (relation.targetMode === "epub" && relation.targetCfi) {
      await this.openEpubAtCfi(file.path, relation.targetCfi);
      return;
    }
    await openAnnotationTarget(
      this.app,
      {
        file,
        offset: relation.targetOffset ?? 0,
        pageNumber: relation.targetPage ?? null,
        mode: relation.targetMode,
        cfiRange: relation.targetCfi,
      },
      (targetFile, cfi) => this.openEpubAtCfi(targetFile.path, cfi),
      { newTab: true },
    );
  }

  /** 卡片动作「解除关系」：两侧一起断，只删一侧会在对方卡片上留下孤儿行 */
  async removeRelationFor(
    sourcePath: string,
    annotationId: string,
    relation: AnnotationRelation,
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) {
      return;
    }
    try {
      await this.store.removeRelation(file, annotationId, relation.targetPath, relation.targetId);
      const target = this.app.vault.getAbstractFileByPath(relation.targetPath);
      if (target instanceof TFile) {
        await this.store.removeRelation(target, relation.targetId, sourcePath, annotationId);
      }
      new Notice("已解除关系");
      await this.refreshAnnotations();
    } catch (error) {
      console.warn("yh-inklight: 解除关系失败", error);
      new Notice("解除关系失败，请检查写入权限或同步状态");
    }
  }

  /** 孤儿块检查：删批注后导出块会留下，这里只报告不删除，避免误删用户写在块内的内容 */
  async checkOrphanBlocks(): Promise<void> {
    const report = await this.store.findOrphanBlocks();
    if (report.length === 0) {
      new Notice("导出笔记里没有孤儿块");
      return;
    }
    const total = report.reduce((sum, item) => sum + item.blockIds.length, 0);
    console.log("yh-inklight: 孤儿块报告", report);
    new Notice(`发现 ${total} 个孤儿块（批注已删除，导出块仍在），明细见开发者控制台`);
  }

  /**
   * 统一回链跳转：解析 `obsidian://inklight` 参数后复用 openAnnotationTarget，
   * 保证「导出笔记里点回链」与「侧栏点卡片」走同一条定位逻辑，不会两套行为漂移。
   * md 的 startOffset 是裸字符下标，原文上方改过字就会偏，先用携带的原文片段就近校正。
   */
  async openSourceLink(params: Record<string, unknown>): Promise<void> {
    const target = parseSourceLinkParams(params);
    if (!target) {
      new Notice("回链参数缺失，无法定位原文");
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(target.file);
    if (!(file instanceof TFile)) {
      new Notice(`找不到源文件：${target.file}`);
      return;
    }

    if (target.mode === "epub" && target.cfi) {
      await this.openEpubAtCfi(file.path, target.cfi);
      return;
    }

    let offset = target.offset ?? 0;
    if (target.mode === "md") {
      offset = refineOffset(await this.app.vault.cachedRead(file), offset, target.quote);
    }

    await openAnnotationTarget(
      this.app,
      {
        file,
        offset,
        pageNumber: target.page,
        mode: target.mode,
        cfiRange: target.cfi ?? undefined,
      },
      (targetFile, cfi) => this.openEpubAtCfi(targetFile.path, cfi),
      { newTab: true },
    );
  }

  async openEpubAtCfi(filePath: string, cfi: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "epub") {
      new Notice("无法找到对应的电子书文件");
      return;
    }

    // 同一本书已经在读就复用那个 leaf：再 getLeaf("tab") 会开出第二个同书标签页，
    // 一个停在进度恢复点、一个停在 CFI，用户看到两本「同一本书不同进度」。
    const existing = findOpenEpubLeaf(this.app, file);
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
    } else {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(file);
      await this.app.workspace.revealLeaf(leaf);
    }
    this.navigateEpubToCfi(file, cfi);
  }

  /**
   * 在已打开的 EPUB 视图中导航到指定 CFI。
   * 统一的跳转入口：openEpubAtCfi（摘录回跳/协议跳转）与侧栏 jumpTo 的 epub 分支都走这里。
   * 这里只负责「找到正确的 leaf」；书是否加载完成由 EpubReaderView 自己暂存 pendingCfi 处理。
   */
  navigateEpubToCfi(file: TFile, cfi: string): void {
    const matchesFile = (leaf: WorkspaceLeaf): boolean => {
      const viewFile = (leaf.view as { file?: TFile } | undefined)?.file?.path;
      if (viewFile === file.path) {
        return true;
      }
      // openFile 早期 / deferred leaf 的 view.file 可能还没就绪，用 viewState 兜底
      const state = leaf.getViewState().state as { file?: unknown } | undefined;
      return state?.file === file.path;
    };

    let attempts = 0;
    const tryNavigate = (): void => {
      const leaves = this.app.workspace.getLeavesOfType(EPUB_READER_VIEW_TYPE).filter(matchesFile);
      const activeLeaf = this.app.workspace.activeLeaf;
      // 同一本书可能在多个 leaf 打开；优先激活的那个，别把跳转送到后台视图
      const epubLeaf = leaves.find((leaf) => leaf === activeLeaf) ?? leaves[0];
      const epubView = epubLeaf?.view as { navigateToCfi?: (cfi: string) => void } | undefined;
      if (typeof epubView?.navigateToCfi === "function") {
        epubView.navigateToCfi(cfi);
        return;
      }
      // 有界重试：视图晚到时等一等，但找不到视图不能无限轮询
      if (++attempts < 40) {
        window.setTimeout(tryNavigate, 200);
      }
    };
    window.setTimeout(tryNavigate, 200);
  }

  private async handleAnnotationClick(event: MouseEvent): Promise<void> {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const mark = target.closest<HTMLElement>(".yh-highlight, .yh-reading-highlight");
    if (!mark) {
      // 详情卡片自己监听外部 pointerdown 关闭，点空白处不必在这里处理
      return;
    }

    const annotationId = mark.dataset.yhId;
    const file = this.app.workspace.getActiveFile();
    if (!annotationId || !(file instanceof TFile)) {
      return;
    }

    const doc = this.store.getCachedDocument(file.path) ?? (await this.store.getDocument(file));
    const primary =
      doc.comments.find((comment) => comment.id === annotationId) ??
      doc.highlights.find((highlight) => highlight.id === annotationId);
    if (!primary) {
      unwrapStaleHighlight(mark);
      return;
    }

    const sameAnchorComments = doc.comments.filter((comment) => {
      return (
        comment.id !== primary.id &&
        !comment.orphaned &&
        comment.anchor.startOffset === primary.anchor.startOffset &&
        comment.anchor.endOffset === primary.anchor.endOffset
      );
    });

    event.preventDefault();
    event.stopPropagation();
    this.showMarkdownAnnotationCard(file, doc, primary, sameAnchorComments, mark.getBoundingClientRect());
  }

  /**
   * 点击 Markdown 高亮弹出的详情卡片：卡片数据取 buildCards（与侧栏同源），
   * 内容与动作行由 views/cardBody 统一产出，本方法只给回调。
   */
  private showMarkdownAnnotationCard(
    file: TFile,
    document: FileAnnotationDocument,
    annotation: HighlightAnnotation | CommentAnnotation,
    extras: readonly CommentAnnotation[],
    rect: DOMRect,
  ): void {
    this.popoverCard?.dismiss();
    const comment = "content" in annotation ? annotation : null;
    const highlight = comment ? null : (annotation as HighlightAnnotation);

    // 笔记是挂在高亮上的：按 id 找不到时（点的是便签）用锚点配对，和侧栏同一套配对结果
    const cards = buildCards(document);
    const cardData =
      cards.find((item) => item.id === annotation.id) ??
      cards.find(
        (item) =>
          item.startOffset === annotation.anchor.startOffset && item.text === annotation.anchor.selectedText,
      );
    if (!cardData) {
      return;
    }

    const card = new AnnotationCard(cardData, {
      fileName: file.name,
      app: this.app,
      component: this,
      onEdit: comment ? () => void this.editMarkdownComment(file, comment) : undefined,
      onAddNote: highlight ? () => void this.addNoteToMarkdownHighlight(file, highlight) : undefined,
      onDelete: () => void this.deleteMarkdownAnnotation(file, annotation.id),
      onTagsChange: (next) => this.saveMarkdownAnnotationTags(file, annotation.id, next),
      tagSuggestions: () => this.getTagSuggestions(),
      onOpenExport: () => void this.openDerivedNote(cardData.sourcePath),
      // 与侧栏同一门槛：只要自己写了内容（不限类型），否则不渲染按钮（浮层不给空卡开口子）
      ...(canExtractAtomCard(cardData)
        ? { onAtomCard: () => void this.createAtomCardFor(cardData) }
        : {}),
      onJumpRelation: (relation) => void this.jumpToRelationTarget(relation),
      onRemoveRelation: (relation) => void this.removeRelationFor(cardData.sourcePath, cardData.id, relation),
      related: this.createRelatedHost(cardData, this.popoverRelatedState()),
      extraActions:
        extras.length > 0
          ? [{ label: `同段另有 ${extras.length} 条批注`, onClick: () => void this.activateSidebar() }]
          : undefined,
      onDismiss: () => {
        if (this.popoverCard === card) {
          this.popoverCard = null;
        }
      },
    });
    card.show({ avoid: toPopoverRect(rect), isMobile: Platform.isMobile });
    this.popoverCard = card;
  }

  /** 「编辑」：复用便签弹窗改内容/类型/标签，保存后才落盘 */
  private async editMarkdownComment(file: TFile, comment: CommentAnnotation): Promise<void> {
    try {
      const value = await new CommentModal(
        this.app,
        comment.title ?? "",
        comment.content,
        normalizeTags(comment.tags ?? []),
        this.getTagSuggestions(),
      ).openAndRead();
      if (value === null) {
        return;
      }
      await this.store.updateCommentContent(file, comment.id, value.content, value.title);
      if (!sameTagList(value.tags, comment.tags ?? [])) {
        await this.store.setTags([{ filePath: file.path, annotationId: comment.id }], value.tags);
      }
      await this.afterMarkdownAnnotationChange(file);
    } catch (error) {
      console.error("yh-inklight: markdown annotation edit failed", error);
      new Notice("批注保存失败");
    }
  }

  /** 「添加笔记」：给已有纯划线补一条同锚点的便签，锚点直接复用划线本身 */
  private async addNoteToMarkdownHighlight(file: TFile, highlight: HighlightAnnotation): Promise<void> {
    try {
      const value = await new CommentModal(this.app, "", "", [], this.getTagSuggestions()).openAndRead();
      if (value === null) {
        return;
      }
      const now = new Date().toISOString();
      await this.store.addComment(file, {
        id: crypto.randomUUID(),
        highlightId: highlight.id,
        anchor: highlight.anchor,
        title: value.title,
        content: value.content,
        color: highlight.color,
        position: { offsetX: 20, offsetY: 0 },
        collapsed: false,
        author: this.settings.defaultAuthor,
        createdAt: now,
        updatedAt: now,
        replies: [],
        resolved: false,
        ...(value.tags.length > 0 ? { tags: [...value.tags] } : {}),
      });
      await this.afterMarkdownAnnotationChange(file);
    } catch (error) {
      console.error("yh-inklight: markdown note creation failed", error);
      new Notice("笔记保存失败");
    }
  }

  private async deleteMarkdownAnnotation(file: TFile, annotationId: string): Promise<void> {
    try {
      await this.store.removeAnnotation(file, annotationId);
      await this.afterMarkdownAnnotationChange(file);
    } catch (error) {
      console.error("yh-inklight: markdown annotation deletion failed", error);
      new Notice("标注删除失败");
    }
  }

  private async saveMarkdownAnnotationTags(
    file: TFile,
    annotationId: string,
    tags: readonly string[],
  ): Promise<void> {
    try {
      await this.store.setTags([{ filePath: file.path, annotationId }], tags);
      await this.refreshAnnotations();
    } catch (error) {
      console.error("yh-inklight: markdown annotation tags update failed", error);
      new Notice("标签保存失败");
      throw error;
    }
  }

  /** md 批注增删改后的统一收尾：编辑模式装饰、阅读模式高亮、侧栏/标签板都要跟着变 */
  private async afterMarkdownAnnotationChange(file: TFile): Promise<void> {
    this.forceEditorDecorationsRefresh(file.path);
    await this.refreshActiveReadingViewHighlights(file.path);
    await this.refreshAnnotations();
  }

  private async renderReadingHighlights(element: HTMLElement, context: MarkdownPostProcessorContext): Promise<void> {
    if (!context.sourcePath) {
      return;
    }

    await sleep(100);

    const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
    if (!(file instanceof TFile)) {
      return;
    }

    await this.store.getDocument(file);
    // 回调实时读取 store 缓存：新建/删除高亮后 observer 自动重绘时拿到的是最新列表，
    // 避免安装时快照把后建的高亮抹掉（重开标签页才恢复的现象）。
    // post-processor 的 element 只是预览页的单个 section（obsidian.d.ts:3837，
    // 通常只含一个段落），跨段选区的文本不在任何单个 section 内，精确定位必然失败、
    // fuzzy 只能包住其中最长的一段——必须向上取整个预览页作为高亮根节点。
    // embed 内容位于 .markdown-embed 内且同样含完整文本，优先取它，避免把整篇宿主笔记
    // 一起 collectText（宿主文本可能与 embed 文本互为候选，干扰消歧评分）。
    const root =
      element.closest<HTMLElement>(".markdown-embed") ??
      element.closest<HTMLElement>(".markdown-preview-view") ??
      element;
    installReadingViewHighlights({
      root,
      context,
      installKey: context.sourcePath,
      getMarks: () => {
        const doc = this.store.getCachedDocument(file.path);
        if (!doc) {
          return [];
        }
        return [...doc.highlights, ...doc.comments].filter((item) => !item.orphaned);
      },
    });
  }
}

/** 渲染 DOM 中选区的前后文（用于源码候选位置的消歧评分） */
interface RenderContext {
  prefix: string;
  suffix: string;
}

/**
 * 定位渲染选区在源码中的偏移。
 * 策略：①精确候选（源码中所有完全一致的位置）→ ②剥语法字符候选
 * （含 ** [[ > 表格符等渲染后消失的符号、跨行选区）→ ③引用标记投影旧算法兜底。
 * 候选多于一个时，用渲染前后文（剥字符口径）评分选最佳，评分过低则放弃
 * （宁可报"无法定位"也绝不错位）；不再依赖"第 N 次出现"计数——渲染 DOM
 * 与源码的出现次数会因 frontmatter、代码块、链接 URL 等不一致。
 */
function locateRenderedSelectionInSource(
  source: string,
  selectedText: string,
  occurrenceIndex: number,
  preferRendered: boolean,
  renderContext: RenderContext | null,
): { startOffset: number; endOffset: number } | null {
  const bestExact = pickBestCandidate(
    collectExactCandidates(source, selectedText),
    source,
    renderContext,
    occurrenceIndex,
    0.4,
  );
  if (bestExact) {
    return bestExact;
  }

  // 空白折叠归一化轮：跨段选区的换行形态两侧不一致（渲染选区段间一个 \n、
  // 源码段间空行 \n\n），折叠为单空格后精确相等，偏移经 map 还原分毫不差。
  // 比剥字符轮可靠（不抹段落边界、不产生拼接误配），故置于其前。
  const bestFolded = pickBestCandidate(
    collectFoldedCandidates(source, selectedText),
    source,
    renderContext,
    occurrenceIndex,
    0.4,
  );
  if (bestFolded) {
    return bestFolded;
  }

  const bestStripped = pickBestCandidate(
    collectStrippedCandidates(source, selectedText),
    source,
    renderContext,
    occurrenceIndex,
    0.4,
  );
  if (bestStripped) {
    return bestStripped;
  }

  if (preferRendered) {
    const rendered = locateSelectionIgnoringQuoteMarkers(source, selectedText, occurrenceIndex);
    if (rendered) {
      return rendered;
    }
  }

  return locateSelectionIgnoringQuoteMarkers(source, selectedText, occurrenceIndex);
}

/** 源码中所有与选区文本完全一致的候选位置 */
function collectExactCandidates(source: string, selectedText: string): Array<{ startOffset: number; endOffset: number }> {
  const candidates: Array<{ startOffset: number; endOffset: number }> = [];
  if (!selectedText) {
    return candidates;
  }

  let cursor = source.indexOf(selectedText);
  while (cursor >= 0) {
    candidates.push({ startOffset: cursor, endOffset: cursor + selectedText.length });
    cursor = source.indexOf(selectedText, cursor + 1);
  }
  return candidates;
}

/**
 * 源码中与选区空白折叠后一致的候选位置（折叠为单空格、统一小写后精确相等，
 * 映射还原到源码真实偏移），覆盖跨段/跨行选区的换行形态差异。
 */
function collectFoldedCandidates(source: string, selectedText: string): Array<{ startOffset: number; endOffset: number }> {
  const candidates: Array<{ startOffset: number; endOffset: number }> = [];
  const foldedSource = foldWhitespaceWithMap(source);
  const foldedSelected = foldWhitespaceWithMap(selectedText);
  if (!foldedSelected.text) {
    return candidates;
  }

  let cursor = foldedSource.text.indexOf(foldedSelected.text);
  while (cursor >= 0) {
    const endIndex = cursor + foldedSelected.text.length - 1;
    const start = foldedSource.map[cursor];
    const end = foldedSource.map[endIndex] + 1;
    if (start !== undefined && end !== undefined && start < end) {
      candidates.push({ startOffset: start, endOffset: end });
    }
    cursor = foldedSource.text.indexOf(foldedSelected.text, cursor + 1);
  }
  return candidates;
}

/**
 * 源码中所有与选区剥除空白+装饰字符后一致的候选位置
 * （映射还原到源码真实偏移），覆盖含语法字符与跨行选区。
 */
function collectStrippedCandidates(source: string, selectedText: string): Array<{ startOffset: number; endOffset: number }> {
  const candidates: Array<{ startOffset: number; endOffset: number }> = [];
  const strippedSource = stripWithMap(source);
  const strippedSelected = stripWithMap(selectedText);
  if (!strippedSelected.text) {
    return candidates;
  }

  let cursor = strippedSource.text.indexOf(strippedSelected.text);
  while (cursor >= 0) {
    const endIndex = cursor + strippedSelected.text.length - 1;
    const start = strippedSource.map[cursor];
    const end = strippedSource.map[endIndex] + 1;
    if (start !== undefined && end !== undefined && start < end) {
      candidates.push({ startOffset: start, endOffset: end });
    }
    cursor = strippedSource.text.indexOf(strippedSelected.text, cursor + 1);
  }
  return candidates;
}

/** 多候选消歧：单候选直接采用；多候选按渲染前后文评分取最佳，低于阈值放弃 */
function pickBestCandidate(
  candidates: Array<{ startOffset: number; endOffset: number }>,
  source: string,
  renderContext: RenderContext | null,
  occurrenceIndex: number,
  threshold: number,
): { startOffset: number; endOffset: number } | null {
  if (!candidates.length) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  if (!renderContext) {
    // 无上下文可比时退回旧的"第 N 次出现"策略
    return candidates[Math.min(Math.max(occurrenceIndex, 0), candidates.length - 1)];
  }

  let best: { startOffset: number; endOffset: number } | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = candidateContextScore(source, candidate, renderContext);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (!best || bestScore < threshold) {
    return null;
  }
  return best;
}

/** 候选位置与渲染前后文的相似度（剥字符口径，0~1） */
function candidateContextScore(
  source: string,
  candidate: { startOffset: number; endOffset: number },
  context: RenderContext,
): number {
  const before = source.slice(Math.max(0, candidate.startOffset - context.prefix.length), candidate.startOffset);
  const after = source.slice(candidate.endOffset, candidate.endOffset + context.suffix.length);
  return strippedScore(context.prefix, before, "suffix") * 0.5 + strippedScore(context.suffix, after, "prefix") * 0.5;
}

/** 从渲染 DOM 提取选区前后文（各 30 字符），供源码候选消歧评分 */
function renderedSelectionContext(selection: Selection): RenderContext | null {
  if (!selection.rangeCount) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const root = selectionRoot(range);
  if (!root) {
    return null;
  }

  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const prefix = before.toString().replace(/\r\n/g, "\n").slice(-30);
  before.detach();

  const after = document.createRange();
  after.selectNodeContents(root);
  after.setStart(range.endContainer, range.endOffset);
  const suffix = after.toString().replace(/\r\n/g, "\n").slice(0, 30);
  after.detach();

  return { prefix, suffix };
}

function createAnchorForSnapshot(source: string, snapshot: SelectionSnapshot) {
  const anchor = createTextAnchor(source, snapshot.startOffset, snapshot.endOffset);
  const selectedText = snapshot.selectedText.replace(/\r\n/g, "\n").trim();
  const sourceText = anchor.selectedText.replace(/\r\n/g, "\n").trim();
  if (!selectedText || selectedText === sourceText) {
    return anchor;
  }

  return {
    ...anchor,
    selectedText,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function findPreviewRoot(view: MarkdownView): HTMLElement | null {
  const previewMode = (
    view as MarkdownView & {
      previewMode?: {
        containerEl?: HTMLElement;
      };
    }
  ).previewMode;

  return (
    view.containerEl.querySelector<HTMLElement>(".markdown-preview-view") ??
    view.containerEl.querySelector<HTMLElement>(".markdown-preview-section") ??
    view.containerEl.querySelector<HTMLElement>(".mod-preview") ??
    previewMode?.containerEl?.querySelector<HTMLElement>(".markdown-preview-section") ??
    previewMode?.containerEl ??
    null
  );
}

function unwrapStaleHighlight(mark: HTMLElement): void {
  const parent = mark.parentNode;
  if (!parent) {
    mark.remove();
    return;
  }

  while (mark.firstChild) {
    parent.insertBefore(mark.firstChild, mark);
  }
  parent.removeChild(mark);
  parent.normalize();
}

function locateSelectionIgnoringQuoteMarkers(
  source: string,
  selectedText: string,
  occurrenceIndex = 0,
): { startOffset: number; endOffset: number } | null {
  const normalizedSelection = selectedText.replace(/\r\n/g, "\n");
  const sourceToRendered: number[] = [];
  let rendered = "";
  let lineStart = true;
  let quotePrefix = false;
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (lineStart && char === ">") {
      quotePrefix = true;
      lineStart = false;
      index += 1;
      continue;
    }

    if (quotePrefix && char === " ") {
      quotePrefix = false;
      index += 1;
      continue;
    }

    if (!quotePrefix && char === "[" && source.slice(index).match(/^\[![\w-]+\]/)) {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      quotePrefix = false;
      continue;
    }

    quotePrefix = false;
    rendered += char;
    sourceToRendered.push(index);
    lineStart = char === "\n";
    index += 1;
  }

  const renderedStart = nthIndexOf(rendered, normalizedSelection, occurrenceIndex);
  if (renderedStart < 0) {
    return null;
  }

  const renderedEnd = renderedStart + normalizedSelection.length - 1;
  return {
    startOffset: sourceToRendered[renderedStart],
    endOffset: sourceToRendered[renderedEnd] + 1,
  };
}

function renderedOccurrenceBeforeSelection(selection: Selection, selectedText: string): number {
  if (!selection.rangeCount || !selectedText) {
    return 0;
  }

  const range = selection.getRangeAt(0);
  const root = selectionRoot(range);
  if (!root) {
    return 0;
  }

  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const beforeText = before.toString().replace(/\r\n/g, "\n");
  before.detach();
  return countOccurrences(beforeText, selectedText);
}

function selectionRoot(range: Range): HTMLElement | null {
  const container =
    range.commonAncestorContainer instanceof HTMLElement
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;

  return (
    container?.closest<HTMLElement>(".markdown-preview-view") ??
    container?.closest<HTMLElement>(".markdown-preview-section") ??
    container?.closest<HTMLElement>(".mod-preview") ??
    null
  );
}

function isSelectionInsideCallout(selection: Selection): boolean {
  if (!selection.rangeCount) {
    return false;
  }

  const range = selection.getRangeAt(0);
  const container =
    range.commonAncestorContainer instanceof HTMLElement
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;

  return Boolean(container?.closest(".callout, .callout-content"));
}

function countOccurrences(source: string, target: string): number {
  if (!target) {
    return 0;
  }

  let count = 0;
  let cursor = source.indexOf(target);
  while (cursor >= 0) {
    count += 1;
    cursor = source.indexOf(target, cursor + target.length);
  }
  return count;
}

function nthIndexOf(source: string, target: string, occurrenceIndex: number): number {
  if (!target) {
    return -1;
  }

  let cursor = source.indexOf(target);
  let seen = 0;
  while (cursor >= 0) {
    if (seen >= occurrenceIndex) {
      return cursor;
    }
    seen += 1;
    cursor = source.indexOf(target, cursor + target.length);
  }
  return -1;
}

/** 标签顺序敏感的比较：只在真的变了才写 sidecar，避免无意义落盘 */
function sameTagList(a: readonly string[], b: readonly string[]): boolean {
  const left = normalizeTags(a);
  const right = normalizeTags(b);
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

class CommentModal extends Modal {
  private value: CommentModalValue | null = null;
  private resolve!: (value: CommentModalValue | null) => void;
  private tags: string[];

  constructor(
    app: OverlayAnnotationsPlugin["app"],
    private readonly initialTitle: string,
    private readonly initialContent: string,
    initialTags: string[] = [],
    private readonly tagSuggestions: readonly TagSuggestion[] = [],
  ) {
    super(app);
    this.tags = initialTags;
  }

  openAndRead(): Promise<CommentModalValue | null> {
    this.open();
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "便签" });

    const titleRow = this.contentEl.createDiv({ cls: "yh-modal-row" });
    titleRow.createEl("label", { cls: "yh-modal-label", text: "类型" });
    const title = titleRow.createEl("select", { cls: "yh-modal-select" });
    for (const option of NOTE_TITLE_OPTIONS) {
      title.createEl("option", { text: option.label, attr: { value: option.value } });
    }
    title.value = normalizedNoteTitle(this.initialTitle);

    const contentRow = this.contentEl.createDiv({ cls: "yh-modal-row" });
    contentRow.createEl("label", { cls: "yh-modal-label", text: "笔记" });
    const input = contentRow.createEl("textarea", {
      cls: "yh-modal-textarea",
      attr: { rows: "8", placeholder: "写下你的想法..." },
    });
    input.value = this.initialContent;

    const tagRow = this.contentEl.createDiv({ cls: "yh-modal-row yh-modal-tags" });
    tagRow.createEl("label", { cls: "yh-modal-label", text: "标签" });
    const tagField = tagRow.createDiv({ cls: "yh-modal-tag-field" });
    renderTagInput(tagField, {
      tags: this.tags,
      suggestions: this.tagSuggestions,
      placeholder: "输入标签，回车确认",
      onChange: (tags) => {
        this.tags = tags;
      },
    });

    const actions = this.contentEl.createDiv({ cls: "yh-modal-actions" });
    const cancel = actions.createEl("button", { text: "取消", cls: "yh-modal-cancel", attr: { type: "button" } });
    const save = actions.createEl("button", { text: "保存", cls: "yh-modal-save", attr: { type: "button" } });
    const cancelValue = (): void => {
      this.value = null;
      this.close();
    };
    const saveValue = (): void => {
      this.value = {
        title: title.value.trim(),
        content: input.value.trim(),
        tags: [...this.tags],
      };
      this.close();
    };
    cancel.addEventListener("click", cancelValue);
    save.addEventListener("click", saveValue);
    input.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        saveValue();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        cancelValue();
      }
    });
  }

  onClose(): void {
    this.resolve?.(this.value);
  }
}

function normalizedNoteTitle(value: string): string {
  return NOTE_TITLE_OPTIONS.some((option) => option.value === value) ? value : NOTE_TITLE_OPTIONS[0].value;
}

/**
 * [INPUT]: 依赖 Obsidian FileView/WorkspaceLeaf/TFile、foliate-js view API、
 *          storage/types 的 EPUB 标注/进度/主题类型、AnnotationStore 的 sidecar 持久化、
 *          EpubFoliateLoader 的引擎加载与 EpubStylesheetInliner 的安全过滤、
 *          EpubThemeManager 的主题颜色解析
 * [OUTPUT]: 对外提供 EpubReaderView，将 foliate-js 渲染引擎嵌入 Obsidian leaf，
 *          承载工具栏、侧边栏（目录/标注）、阅读区（iframe）、进度条、
 *          选区上下文菜单、点击高亮弹出标注详情卡片、标注 CRUD、进度持久化与阅读时间追踪
 * [POS]: epub 模块的唯一视图入口，由插件主类通过 registerView 注册
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { FileView, Notice, Platform, setIcon, TFile, WorkspaceLeaf } from "obsidian";

import {
	ANNOTATION_COLORS,
	AnnotationColor,
	AnnotationPluginSettings,
	COLOR_LABELS,
	EPUB_COLOR_MAP,
	EPUB_READING_THEMES,
	EpubCfiAnchor,
	EpubCommentAnnotation,
	EpubFlowMode,
	EpubHighlightAnnotation,
	EpubHighlightStyle,
	EpubReadingProgress,
	EpubReadingTheme,
	SUPPORTED_BOOK_EXTENSIONS,
} from "../storage/types";
import { AnnotationStore } from "../storage/annotationStore";
import {
	normalizeCfi,
	normalizePercent,
	resolveChapterLabel,
	TocSpineEntry,
} from "./EpubChapterResolver";
import { inlineBlockedStylesheets, stripScriptsFromDocument } from "./EpubStylesheetInliner";
import { EpubThemeManager } from "./EpubThemeManager";
import {
	createFoliateView,
	FoliateViewHandle,
	openBookFromBuffer,
	showFoliateStart,
} from "./EpubFoliateLoader";
import { EpubNoteModal, EpubNoteResult } from "./EpubNoteModal";
import { EpubAnnotationCard } from "./EpubAnnotationCard";
import { EpubImageViewer } from "./EpubImageViewer";

// ---- 常量 ----

/** 注册到 Obsidian workspace 的视图类型标识 */
export const EPUB_READER_VIEW_TYPE = "inklight-epub-reader";

/** 阅读时间 flush 间隔（毫秒） */
const READING_TIME_FLUSH_INTERVAL_MS = 60_000;

/** 鼠标滚轮翻页防抖延迟（毫秒） */
const WHEEL_DEBOUNCE_MS = 400;

/** 进度保存防抖延迟（毫秒） */
const PROGRESS_SAVE_DEBOUNCE_MS = 2_000;

/** 浮动上下文菜单消失延迟（毫秒） */
const CONTEXT_MENU_DISMISS_MS = 300;

/** foliate iframe 内选区稳定后再同步，参考 weave 的 SelectionToolbar 同步节奏 */
const SELECTION_SYNC_RETRY_DELAY_MS = 120;

/**
 * 通读检查点（目标 10/30/50/70/90/98）：
 * 每个检查点是「容差区间」而非精确点，避免书籍 foliate fraction 粒度粗、
 * 事件值落在检查点之间而永远无法命中。区间有界且相邻相接，
 * 必须真实经过该区间的事件才会置位——所以"重开在 90% 只读尾巴"只会置 90/末位，
 * 不会误计；而任何从 0 真正读到尾的进度必然逐个区间置满。
 * 末位（目标 0.98）由 clampedToEnd（真实滚到书末）或 rawPercent>=0.95 触发。
 */
const READ_CHECKPOINTS = [
	{ target: 0.1, lo: 0.04, hi: 0.2 },
	{ target: 0.3, lo: 0.2, hi: 0.4 },
	{ target: 0.5, lo: 0.4, hi: 0.6 },
	{ target: 0.7, lo: 0.6, hi: 0.8 },
	{ target: 0.9, lo: 0.8, hi: 0.95 },
	{ target: 0.98, lo: 0.95, hi: 1.001 },
] as const;
/** 六个检查点全部置位的掩码 */
const READ_CHECKPOINTS_ALL_MASK = (1 << READ_CHECKPOINTS.length) - 1;
/**
 * 跳转识别阈值：单次 relocated 事件 fraction 变化超过该值视为跳转
 * （目录/滚动条/跳页），跳转事件不置位任何检查点，防止"开头直跳结尾"误计。
 * 0.6 高于任何真实阅读的分节边界步进（最粗的书也只有 ~0.5），不会误伤正常阅读。
 */
const READ_CHECKPOINTS_JUMP_DELTA = 0.6;

// ---- 辅助类型 ----

/** 阅读时间追踪器状态快照 */
interface ReadingTimeSnapshot {
	readingTimeSeconds: number;
	lastFlushTimestamp: number;
}

interface FoliateTocItem {
	label?: string;
	href?: string;
	subitems?: unknown[];
}

interface FoliateRelocateDetail {
	cfi?: string;
	index?: number;
	fraction?: number;
	range?: Range;
	tocItem?: { label?: string };
	section?: { current: number; total: number };
}

interface FoliateLoadDetail {
	doc?: Document;
	index?: number;
}

interface FoliateDrawAnnotationDetail {
	annotation?: {
		value?: string;
		color?: AnnotationColor;
		style?: EpubHighlightStyle;
	};
	draw?: (
		drawer: (rects: Array<DOMRect | { left: number; top: number; width: number; height: number }>) => SVGElement,
		options?: unknown,
	) => void;
}

interface FoliateShowAnnotationDetail {
	value?: string;
	index?: number;
	range?: Range;
}

	interface EpubSelectionSnapshot {
	doc: Document;
	range: Range;
	text: string;
	cfiRange: string;
	rect: DOMRect;
}

// ---- EpubReaderView ----

/**
 * yh-inklight EPUB 阅读器核心视图。
 *
 * 继承 Obsidian FileView，将 foliate-js <foliate-view> 嵌入 leaf 容器。
 * 负责：
 * - EPUB 文件加载与安全过滤
 * - 工具栏（字号/主题/翻页模式/导航）
 * - 侧边栏（目录/标注列表）
 * - 选区上下文菜单（画线/标注/AI）
 * - 标注 CRUD（通过 AnnotationStore）
 * - 阅读进度持久化与阅读时间追踪
 * - 键盘/滚轮导航
 */
export class EpubReaderView extends FileView {
	// ---- 依赖注入 ----

	private readonly store: AnnotationStore;
	private readonly pluginSettings: AnnotationPluginSettings;
	private readonly themeManager: EpubThemeManager;
	private readonly refreshAnnotations: () => void;
	private readonly saveSettings: () => Promise<void>;

	// ---- foliate 实例 ----

	private foliateView: FoliateViewHandle | null = null;
	private loadedSectionDocs = new WeakMap<Document, number>();
	private documentSelectionCleanups = new WeakMap<Document, () => void>();
	/** 最近一次 foliate load 事件的 section doc，供工具栏全文搜索使用（getContents 不可靠时的可靠来源） */
	private currentLoadedDoc: Document | null = null;
	// 跟踪 foliate 高亮层实际已渲染的标注（id → 渲染时传入 foliate 的 meta）。
	// 全量刷新时据此 remove，不依赖 sidecar 缓存——否则外部删除（侧栏）后被删的标注无法从 foliate 层移除。
	private renderedAnnotationMeta = new Map<string, { value: string; id: string; color: AnnotationColor; style: EpubHighlightStyle }>();
	private currentCfi = "";
	private currentSectionIndex = 0;

	// ---- 状态 ----

	private tocEntries: TocSpineEntry[] = [];
	private currentChapter = "";
	private currentPercent = 0;
	/** 本会话中见到的最大 fraction（滚动模式末页达不到 1.0） */
	private maxSeenPercent = 0;
	/** 标记为已读到尾后锁定 100% */
	private clampedToEnd = false;
	/** 连续 relocate 事件中 fraction 未增长的次数（末页检测） */
	private stableCountAtEnd = 0;
	private currentFlowMode: EpubFlowMode;
	private currentFontSize: number;
	private currentTheme: EpubReadingTheme;
	/** 当前书正文是否被书内 CSS 缩放（统一正文字号设置用，每次加载测量一次） */
	private bodyFontScaled = false;
	/** 是否已完成正文缩放测量 */
	private bodyScaleMeasured = false;
	private sidebarOpen = false;
	private currentReadCount = 0;
	private completedThisCycle = false;
	/** 通读检查点位掩码（10/30/50/70/90/98 容差带），随进度持久化到 sidecar */
	private readCheckpointMask = 0;
	/** 上一次 relocated 的 fraction，用于识别跳转事件 */
	private lastRelocatedFraction = 0;
	private contextMenuEl: HTMLElement | null = null;
	private annotationCardEl: EpubAnnotationCard | null = null;
	/** 点击图片放大的全屏查看器（单例，复用同一浮层） */
	private imageViewerEl: EpubImageViewer | null = null;
		private lastSelectedCfiRange = "";
		private lastSelectedText = "";
		private searchInputEl: HTMLInputElement | null = null;
	private searchResultsEl: HTMLElement | null = null;
	private searchTimer: number | null = null;
	private readonly searchDebounce = (): void => {
		if (this.searchTimer !== null) {
			window.clearTimeout(this.searchTimer);
		}
		this.searchTimer = window.setTimeout(() => {
			this.searchTimer = null;
			void this.performSearch();
		}, 300);
	};
	private canvasSendBtn: HTMLElement | null = null;
	private documentKeyHandler: ((event: KeyboardEvent) => void) | null = null;

	// ---- 定时器 / 追踪 ----

	private readingTimeSeconds = 0;
	private readingTimeFlushTimer: number | null = null;
	private progressSaveTimer: number | null = null;
	private wheelDebounceTimer: number | null = null;
	private contextMenuDismissTimer: number | null = null;
	private visibilityHandler: (() => void) | null = null;
	private blurHandler: (() => void) | null = null;
	private focusHandler: (() => void) | null = null;
	private lastFlushTimestamp = 0;

	// ---- DOM 容器引用 ----

	private toolbarEl!: HTMLElement;
	private sidebarContainerEl!: HTMLElement;
	private sidebarContentEl!: HTMLElement;
	private readerContainerEl!: HTMLElement;
	private progressEl!: HTMLElement;

	// ================================================================
	// 构造 & 生命周期
	// ================================================================

	constructor(
		leaf: WorkspaceLeaf,
		store: AnnotationStore,
		settings: AnnotationPluginSettings,
		refreshAnnotations: () => void,
		saveSettings: () => Promise<void>,
	) {
		super(leaf);
		this.store = store;
		this.pluginSettings = settings;
		this.refreshAnnotations = refreshAnnotations;
		this.saveSettings = saveSettings;
		this.themeManager = new EpubThemeManager();
		this.currentFlowMode = settings.epubDefaultFlow;
		this.currentFontSize = settings.epubFontSize;
		this.currentTheme = settings.epubReadingTheme;
	}

	/** 视图类型标识，供 Obsidian workspace 路由 */
	override getViewType(): string {
		return EPUB_READER_VIEW_TYPE;
	}

	/** leaf 标签页显示的标题 */
	override getDisplayText(): string {
		return this.file?.basename ?? "EPUB Reader";
	}

	/** 声明此视图可以打开 EPUB 及 foliate 支持的所有电子书格式 */
	override canAcceptExtension(extension: string): boolean {
		return (SUPPORTED_BOOK_EXTENSIONS as readonly string[]).includes(extension.toLowerCase());
	}

	/** 视图打开时构建 DOM 骨架 */
	override async onOpen(): Promise<void> {
		this.containerEl.addClass("yh-epub-reader");
		this.buildLayout();
		this.startReadingTimeTracker();
	}

	/** 视图关闭时释放 foliate 资源与定时器 */
	override async onClose(): Promise<void> {
		if (this.documentKeyHandler) {
			document.removeEventListener("keydown", this.documentKeyHandler);
			this.documentKeyHandler = null;
		}
		this.stopReadingTimeTracker();
		this.dismissContextMenu();
		this.closeImageViewer();
		this.destroyRendition();
	}

	// ================================================================
	// 文件加载（FileView 核心）
	// ================================================================

	/**
	 * Obsidian FileView 文件加载钩子。
	 * 读取 EPUB 二进制内容 → foliate-js 解析 → 渲染 → 恢复进度。
	 *
	 * @param file - 用户打开的 EPUB TFile
	 */
	override async onLoadFile(file: TFile): Promise<void> {
		this.maxSeenPercent = 0;
		this.clampedToEnd = false;
		this.stableCountAtEnd = 0;
		this.readCheckpointMask = 0;
		this.lastRelocatedFraction = 0;
		this.bodyFontScaled = false;
		this.bodyScaleMeasured = false;
		this.destroyRendition();

		try {
			const arrayBuffer = await this.app.vault.readBinary(file);
			this.foliateView = await createFoliateView(this.readerContainerEl);
			this.configureFoliateView(this.foliateView);
			this.registerFoliateEvents(this.foliateView);
			await openBookFromBuffer(this.foliateView, arrayBuffer, file.name);
			this.applyFoliateLayout();
			this.tocEntries = this.buildFoliateTocEntries(this.foliateView.book?.toc ?? []);
			this.applyFoliateAppearance();

			await this.restoreProgress();

			this.renderToolbar();
			this.renderSidebar();
		} catch (error) {
			console.error("yh-inklight: EPUB load failed", error);
			new Notice(`墨光 EPUB 加载失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Obsidian FileView 文件卸载钩子。
	 * flush 阅读时间并销毁 foliate-view。
	 *
	 * @param _file - 即将卸载的 TFile（未使用）
	 */
	override async onUnloadFile(_file: TFile): Promise<void> {
		await this.flushReadingTime();
		await this.saveCurrentProgress();
		this.destroyRendition();
	}

	// ================================================================
	// 布局构建
	// ================================================================

	/**
	 * 构建完整的 DOM 布局骨架：
	 * 工具栏 → [侧边栏 | 阅读区] → 进度条
	 */
	private buildLayout(): void {
		this.containerEl.empty();

		if (Platform.isAndroidApp) {
			// Android 状态栏在 CSS 像素中通常 ~24px（env(safe-area-inset-top) 非刘海屏返回 0）
			this.containerEl.style.setProperty("--yh-safe-top", "24px");
			this.containerEl.style.setProperty("--yh-safe-bottom", "16px");
		}

		this.toolbarEl = this.containerEl.createDiv({ cls: "yh-epub-toolbar" });

		const body = this.containerEl.createDiv({ cls: "yh-epub-body" });

		this.sidebarContainerEl = body.createDiv({ cls: "yh-epub-sidebar" });
		this.sidebarContainerEl.toggleClass("is-open", this.sidebarOpen);

		const sidebarTabs = this.sidebarContainerEl.createDiv({ cls: "yh-epub-sidebar-tabs" });
		const tocTab = sidebarTabs.createEl("button", {
			cls: "yh-epub-sidebar-tab is-active",
			text: "目录",
			attr: { type: "button", "data-tab": "toc" },
		});
		tocTab.addEventListener("click", () => this.renderSidebar());

		this.sidebarContentEl = this.sidebarContainerEl.createDiv({ cls: "yh-epub-sidebar-content" });

		this.readerContainerEl = body.createDiv({ cls: "yh-epub-reader-area" });
		// 脚注预览 popover 元素（Phase 4-B P3）

		this.progressEl = this.containerEl.createDiv({ cls: "yh-epub-progress" });

		this.documentKeyHandler = (event: KeyboardEvent) => this.handleKeydown(event);
		document.addEventListener("keydown", this.documentKeyHandler);
		this.readerContainerEl.addEventListener("wheel", (event) => this.handleWheel(event), { passive: false });
	}

	// ================================================================
	// 工具栏
	// ================================================================

	/**
	 * 渲染工具栏：侧边栏切换、书名、字号、主题、翻页模式、导航按钮。
	 */
	private renderToolbar(): void {
		this.toolbarEl.empty();

		const toggleBtn = this.toolbarEl.createEl("button", {
			cls: "yh-epub-toolbar-btn",
			attr: { type: "button", title: "切换侧边栏", "aria-label": "切换侧边栏" },
		});
		setIcon(toggleBtn, "menu");
		toggleBtn.addEventListener("click", () => this.toggleSidebar());

		this.toolbarEl.createDiv({
			cls: "yh-epub-toolbar-title",
			text: this.file?.basename ?? "",
		});

		const fontSizeDec = this.toolbarEl.createEl("button", {
			cls: "yh-epub-toolbar-btn",
			attr: { type: "button", title: "缩小字号", "aria-label": "缩小字号" },
			text: "A-",
		});
		fontSizeDec.addEventListener("click", () => this.changeFontSize(-1));

		const fontSizeInc = this.toolbarEl.createEl("button", {
			cls: "yh-epub-toolbar-btn",
			attr: { type: "button", title: "放大字号", "aria-label": "放大字号" },
			text: "A+",
		});
		fontSizeInc.addEventListener("click", () => this.changeFontSize(1));

		this.renderThemeSwatches();

		// 书签按钮（Phase 4-B P2）
		const bookmarkBtn = this.toolbarEl.createEl("button", {
			cls: "yh-epub-toolbar-btn yh-epub-bookmark-btn",
			attr: { type: "button", title: "添加书签", "aria-label": "添加书签" },
		});
		setIcon(bookmarkBtn, "bookmark");
		const updateBookmarkIcon = () => {
			const hasBookmark = this.hasCurrentCfiBookmark();
			bookmarkBtn.title = hasBookmark ? "移除书签" : "添加书签";
			bookmarkBtn.toggleClass("is-active", hasBookmark);
		};
		bookmarkBtn.addEventListener("click", async () => {
			await this.toggleBookmark();
			updateBookmarkIcon();
			this.renderSidebar();
		});

			// 搜索按钮（Phase 4-B P4 - 移到工具栏）
			const searchBtn = this.toolbarEl.createEl("button", {
				cls: "yh-epub-toolbar-btn",
				attr: { type: "button", title: "搜索全文", "aria-label": "搜索全文" },
			});
			setIcon(searchBtn, "search");
			searchBtn.addEventListener("click", () => this.toggleToolbarSearch());

			
		const flowBtn = this.toolbarEl.createEl("button", {
			cls: "yh-epub-toolbar-btn",
			attr: { type: "button", title: this.currentFlowMode === "paginated" ? "切换为滚动" : "切换为分页" },
		});
		setIcon(flowBtn, this.currentFlowMode === "paginated" ? "lines-of-text" : "sheets");
		flowBtn.addEventListener("click", () => this.toggleFlowMode());

		const prevBtn = this.toolbarEl.createEl("button", {
			cls: "yh-epub-toolbar-btn",
			attr: { type: "button", title: "上一页", "aria-label": "上一页" },
		});
		setIcon(prevBtn, "chevron-left");
		prevBtn.addEventListener("click", () => this.prevPage());

		const nextBtn = this.toolbarEl.createEl("button", {
			cls: "yh-epub-toolbar-btn",
			attr: { type: "button", title: "下一页", "aria-label": "下一页" },
		});
		setIcon(nextBtn, "chevron-right");
		nextBtn.addEventListener("click", () => this.nextPage());
	}

	/**
	 * 在工具栏中渲染主题色块选择器，点击切换阅读主题。
	 */
	private renderThemeSwatches(): void {
		const container = this.toolbarEl.createDiv({ cls: "yh-epub-theme-swatches" });

		for (const theme of EPUB_READING_THEMES) {
			const swatch = container.createEl("button", {
				cls: "yh-epub-theme-swatch",
				attr: {
					type: "button",
					title: theme.label,
					"aria-label": `主题: ${theme.label}`,
					"data-theme": theme.id,
				},
			});
			swatch.style.background = theme.swatch;
			swatch.toggleClass("is-active", theme.id === this.currentTheme);
			swatch.addEventListener("click", () => this.switchTheme(theme.id));
		}
	}

	// ================================================================
	// 侧边栏
	// ================================================================

	/**
	 * 切换侧边栏显示/隐藏。
	 */
	private toggleSidebar(): void {
		this.sidebarOpen = !this.sidebarOpen;
		this.sidebarContainerEl.toggleClass("is-open", this.sidebarOpen);
		if (this.sidebarOpen) {
			this.renderSidebar();
		}
	}

	/**
	 * 渲染侧边栏内容（目录）。
	 * 标注已统一到「墨光批注」共用面板，此处仅保留目录导航。
	 */
	private renderSidebar(): void {
		this.sidebarContentEl.empty();
		this.renderTocList();
		this.renderBookmarkList();
	}

	/**
	 * 渲染目录列表，点击条目跳转到对应章节。
	 */
	private renderTocList(): void {
		if (this.tocEntries.length === 0) {
			this.sidebarContentEl.createDiv({ cls: "yh-epub-empty", text: "未找到目录信息。" });
			return;
		}

		const list = this.sidebarContentEl.createDiv({ cls: "yh-epub-toc-list" });
		const isSingleSection = this.tocEntries.every(e => e.spineIndex === this.tocEntries[0].spineIndex);
		let activeIndex = -1;

		for (let i = 0; i < this.tocEntries.length; i++) {
			const entry = this.tocEntries[i];
			const isCurrent = isSingleSection
				? entry.label === (this.currentChapter || "").trim()
				: entry.spineIndex <= this.currentSectionIndex;

			const item = list.createEl("button", {
				cls: `yh-epub-toc-item${isCurrent ? " is-current" : ""}`,
				text: entry.label,
				attr: { type: "button" },
			});
			item.addEventListener("click", () => this.navigateToSpineIndex(entry));

			if (isCurrent) {
				activeIndex = i;
			}
		}

		if (activeIndex >= 0) {
			const activeEl = list.children[activeIndex] as HTMLElement;
			setTimeout(() => activeEl?.scrollIntoView({ block: "center" }), 50);
		}
	}

	// ================================================================
	// 书签（Phase 4-B P2）
	// ================================================================

	/**
	 * 检查当前 CFI 是否已有书签。
	 */
	private hasCurrentCfiBookmark(): boolean {
		if (!this.file || !this.currentCfi) {
			return false;
		}
		const document = this.store.getCachedDocument(this.file.path);
		if (!document) {
			return false;
		}
		return document.bookmarks.some((bm) => bm.type === "epub-bookmark" && bm.position === this.currentCfi);
	}

	/**
	 * 切换书签：若当前 CFI 已有则移除，否则添加。
	 */
	private async toggleBookmark(): Promise<void> {
		if (!this.file || !this.currentCfi) {
			return;
		}
		const document = this.store.getCachedDocument(this.file.path);
		if (!document) {
			return;
		}
		const existing = document.bookmarks.find(
			(bm) => bm.type === "epub-bookmark" && bm.position === this.currentCfi,
		);
		if (existing) {
			await this.store.removeBookmark(this.file, existing.id);
			new Notice("已移除书签");
		} else {
			const bookmark: import("../storage/types").ReadingBookmark = {
				id: crypto.randomUUID(),
				type: "epub-bookmark",
				label: this.currentChapter || "当前位置",
				position: this.currentCfi,
				chapter: this.currentChapter || undefined,
				color: this.pluginSettings.defaultHighlightColor,
				createdAt: new Date().toISOString(),
			};
			await this.store.addBookmark(this.file, bookmark);
			new Notice("已添加书签");
		}
		this.refreshAnnotations();
	}

	/**
	 * 在侧边栏底部渲染书签列表，点击跳转到对应 CFI。
	 */
	private renderBookmarkList(): void {
		if (!this.file) {
			return;
		}
		const document = this.store.getCachedDocument(this.file.path);
		const bookmarks = document?.bookmarks.filter((bm) => bm.type === "epub-bookmark") ?? [];
		if (bookmarks.length === 0) {
			return;
		}

		const section = this.sidebarContentEl.createDiv({ cls: "yh-epub-bookmark-section" });
		section.createDiv({ cls: "yh-epub-bookmark-title", text: "📑 书签" });

		const list = section.createDiv({ cls: "yh-epub-bookmark-list" });
		for (const bm of bookmarks) {
			const item = list.createEl("button", {
				cls: "yh-epub-bookmark-item",
				attr: { type: "button", title: bm.chapter ?? "" },
			});
			item.createSpan({ cls: "yh-epub-bookmark-label", text: bm.label.trim() || "书签" });
			const delBtn = item.createEl("button", {
				cls: "yh-epub-bookmark-del",
				attr: { type: "button", title: "删除书签" },
				text: "✕",
			});
			delBtn.addEventListener("click", (ev) => {
				ev.stopPropagation();
				void this.store.removeBookmark(this.file!, bm.id).then(() => {
					this.renderSidebar();
					this.refreshAnnotations();
				});
			});
			item.createSpan({ cls: "yh-epub-bookmark-time", text: this.formatBookmarkDate(bm.createdAt) });
			item.addEventListener("click", () => {
				if (this.foliateView) {
					void this.foliateView.goTo(bm.position);
				}
			});
		}
	}

	private formatBookmarkDate(iso: string): string {
		try {
			const d = new Date(iso);
			const pad = (n: number) => String(n).padStart(2, "0");
			return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		} catch {
			return "";
		}
	}

	// ================================================================
	// foliate 事件注册
	// ================================================================

	/**
	 * 配置 foliate-view 的布局属性。
	 */
	private configureFoliateView(view: FoliateViewHandle): void {
		const element = view as unknown as HTMLElement;
		element.addClass("yh-epub-foliate-view");
		element.setAttribute("flow", this.currentFlowMode);
		element.setAttribute("margin", this.currentFlowMode === "paginated" ? "28px" : "0px");
		element.setAttribute("gap", "8%");
		element.setAttribute("max-inline-size", "760px");
	}

	/**
	 * 注册 foliate 事件：section load、位置变更、标注绘制、标注点击。
	 */
	private registerFoliateEvents(view: FoliateViewHandle): void {
		view.addEventListener("load", this.handleFoliateLoad as EventListener);
		view.addEventListener("relocate", this.handleFoliateRelocate as EventListener);
		view.addEventListener("draw-annotation", this.handleFoliateDrawAnnotation as EventListener);
		view.addEventListener("show-annotation", this.handleFoliateShowAnnotation as EventListener);
	}

	// ================================================================
	// 安全处理
	// ================================================================

	// （安全过滤已在 foliate load 事件中处理）

	// ================================================================
	// 选区事件 & 上下文菜单
	// ================================================================

	/**
	 * 处理 foliate 文本选区事件。
	 * 记录选区 CFI 和文本，在选区位置显示浮动上下文菜单。
	 *
	 * @param cfiRange - foliate 由 Range 生成的 CFI 范围字符串
	 * @param doc - foliate load 事件提供的 section document
	 */
	private handleTextSelected(snapshot: EpubSelectionSnapshot): void {
		if (!snapshot.text) {
			this.dismissContextMenu();
			return;
		}

		this.lastSelectedCfiRange = snapshot.cfiRange;
		this.lastSelectedText = snapshot.text;

		this.showContextMenu(
			snapshot.rect.left,
			snapshot.rect.top + snapshot.rect.height,
			snapshot.text,
			snapshot.cfiRange,
		);
	}

	/**
	 * 在指定位置显示浮动上下文菜单。
	 * 包含 5 色画线圆点、标注按钮和 AI 按钮（预留）。
	 *
	 * @param left - 菜单左侧像素位置（相对于视口）
	 * @param top - 菜单顶部像素位置（相对于视口）
	 * @param text - 选中的文本内容
	 * @param cfiRange - 选区的 CFI 范围
	 */
	private showContextMenu(left: number, top: number, text: string, cfiRange: string): void {
		this.dismissContextMenu();

		const menu = document.body.createDiv({ cls: "yh-epub-context-menu" });

		const colorRow = menu.createDiv({ cls: "yh-epub-context-colors" });
		for (const color of ANNOTATION_COLORS) {
			const dot = colorRow.createEl("button", {
				cls: `yh-epub-context-dot yh-dot--${color}`,
				attr: {
					type: "button",
					title: COLOR_LABELS[color],
					"aria-label": `${COLOR_LABELS[color]}画线`,
				},
			});
			dot.style.background = EPUB_COLOR_MAP[color];
			dot.addEventListener("click", () => {
				void this.createHighlight(color, cfiRange, text);
				this.dismissContextMenu();
			});
		}

		const noteBtn = menu.createEl("button", {
			cls: "yh-epub-context-note-btn",
			attr: { type: "button", title: "添加标注" },
			text: "\u{1F4DD}",
		});
		noteBtn.addEventListener("click", () => {
			void this.openNoteModal(cfiRange, text);
			this.dismissContextMenu();
		});

		const safeTop = parseInt(getComputedStyle(this.containerEl).getPropertyValue("--yh-safe-top")) || 0;
		const clampedLeft = Math.max(8, Math.min(left, window.innerWidth - 260));
		const clampedTop = Math.max(8 + safeTop, Math.min(top + 8, window.innerHeight - 48));
		menu.style.left = `${clampedLeft}px`;
		menu.style.top = `${clampedTop}px`;

		document.body.appendChild(menu);
		this.contextMenuEl = menu;

		// 点击菜单外部关闭（立即响应，不等 8 秒）
		this.contextMenuOutsideHandler = (ev: PointerEvent) => {
			if (this.contextMenuEl && ev.target instanceof Node && !this.contextMenuEl.contains(ev.target)) {
				this.dismissContextMenu();
			}
		};
		window.setTimeout(() => {
			if (this.contextMenuOutsideHandler) {
				document.addEventListener("pointerdown", this.contextMenuOutsideHandler, true);
			}
		}, 0);

		this.contextMenuDismissTimer = window.setTimeout(() => {
			this.dismissContextMenu();
		}, 8_000);
	}

	/**
	 * 销毁当前浮动上下文菜单。
	 */
	private contextMenuOutsideHandler: ((ev: PointerEvent) => void) | null = null;

	private dismissContextMenu(): void {
		if (this.contextMenuDismissTimer !== null) {
			window.clearTimeout(this.contextMenuDismissTimer);
			this.contextMenuDismissTimer = null;
		}
		if (this.contextMenuOutsideHandler) {
			document.removeEventListener("pointerdown", this.contextMenuOutsideHandler, true);
			this.contextMenuOutsideHandler = null;
		}

		if (this.contextMenuEl) {
			this.contextMenuEl.remove();
			this.contextMenuEl = null;
		}
	}

	// ================================================================
	// 图片查看
	// ================================================================

	/** 打开全屏图片查看器（复用单例浮层）。 */
	private showImageZoom(src: string, alt: string): void {
		if (!this.imageViewerEl) {
			this.imageViewerEl = new EpubImageViewer();
		}
		this.imageViewerEl.open(src, alt);
	}

	/** 关闭全屏图片查看器。 */
	private closeImageViewer(): void {
		this.imageViewerEl?.close();
		this.imageViewerEl = null;
	}

	// ================================================================
	// 标注 CRUD
	// ================================================================

	/**
	 * 在当前选区创建指定颜色的高亮标注。
	 * 将标注保存到 sidecar 并渲染到 foliate 高亮层。
	 *
	 * @param color - 高亮颜色
	 * @param cfiRange - CFI 范围
	 * @param text - 选中的文本
	 */
	private async createHighlight(color: AnnotationColor, cfiRange: string, text: string): Promise<void> {
		if (!this.file || !this.foliateView) {
			return;
		}

		const chapter = this.currentChapter;
		const style = this.pluginSettings.epubHighlightStyle;
		const now = new Date().toISOString();
		const id = crypto.randomUUID();

		const annotation: EpubHighlightAnnotation = {
			id,
			type: "epub-highlight",
			color,
			style,
			anchor: { cfiRange, chapter, selectedText: text },
			createdAt: now,
		};

		try {
			await this.store.addEpubHighlight(this.file, annotation);
			this.renderAnnotationOnRendition(annotation);
			this.renderSidebar();
			this.refreshAnnotations();
			new Notice(`已添加${COLOR_LABELS[color]}画线`);
		} catch (error) {
			console.error("yh-inklight: EPUB highlight creation failed", error);
			new Notice("画线创建失败");
		}
	}

	/**
	 * 打开标注弹窗，让用户输入笔记内容后保存为 EpubCommentAnnotation。
	 *
	 * @param cfiRange - CFI 范围
	 * @param text - 选中的文本
	 */
	private openNoteModal(cfiRange: string, text: string): void {
		if (!this.file || !this.foliateView) {
			return;
		}

		const chapter = this.currentChapter;

		new EpubNoteModal(
			this.app,
			text,
			{
				color: this.pluginSettings.defaultHighlightColor,
				style: this.pluginSettings.epubHighlightStyle,
			},
			async (result: EpubNoteResult) => {
				if (!result.note.trim()) {
					return;
				}
				const now = new Date().toISOString();
				const annotation: EpubCommentAnnotation = {
					id: crypto.randomUUID(),
					type: "epub-comment",
					color: result.color,
					style: result.style,
					anchor: { cfiRange, chapter, selectedText: text },
					note: result.note.trim(),
					// 保留用户在 modal 选择的分类（insight/question/reminder），否则字段丢失
					noteType: result.noteType,
					createdAt: now,
					collapsed: false,
					author: this.pluginSettings.defaultAuthor,
					updatedAt: now,
					replies: [],
					resolved: false,
				};

				try {
					await this.store.addEpubComment(this.file!, annotation);
					this.renderAnnotationOnRendition(annotation);
					this.renderSidebar();
					this.refreshAnnotations();
					new Notice("已添加标注");
				} catch (error) {
					console.error("yh-inklight: EPUB comment creation failed", error);
					new Notice("标注创建失败");
				}
			},
		).open();
	}

	/**
	 * 将单个标注渲染到 foliate 的高亮层。
	 * 根据 EpubHighlightStyle 选择填充/下划线/波浪线样式。
	 *
	 * @param annotation - 高亮或评论标注
	 */
	private renderAnnotationOnRendition(annotation: { id: string; color: AnnotationColor; style: EpubHighlightStyle; anchor: EpubCfiAnchor }): void {
		if (!this.foliateView) {
			return;
		}

		const meta = {
			value: annotation.anchor.cfiRange,
			id: annotation.id,
			color: annotation.color,
			style: annotation.style,
		};
		this.renderedAnnotationMeta.set(annotation.id, meta);

		void this.foliateView.addAnnotation(meta);
	}

	/**
	 * 恢复已保存的所有标注到 foliate 高亮层。
	 * 在 book 加载完成后调用。
	 */
	private restoreAnnotations(): void {
		if (!this.file || !this.foliateView) {
			return;
		}

		const document = this.store.getCachedDocument(this.file.path);
		if (!document) {
			return;
		}

		for (const highlight of document.epubHighlights) {
			this.renderAnnotationOnRendition(highlight);
		}

		for (const comment of document.epubComments) {
			this.renderAnnotationOnRendition(comment);
		}
	}

	/**
	 * 删除指定标注并从 foliate 高亮层移除。
	 *
	 * @param annotationId - 要删除的标注 ID
	 */
	private async deleteAnnotation(annotationId: string): Promise<void> {
		if (!this.file) {
			return;
		}

		try {
			const document = this.store.getCachedDocument(this.file.path);
			const annotation = document
				? [...document.epubHighlights, ...document.epubComments].find((item) => item.id === annotationId)
				: null;
			await this.store.removeAnnotation(this.file, annotationId);
			if (annotation) {
				this.removeFoliateAnnotation(annotation);
			}
			this.refreshRenditionAnnotations();
			this.renderSidebar();
			this.refreshAnnotations();
			new Notice("标注已删除");
		} catch (error) {
			console.error("yh-inklight: EPUB annotation deletion failed", error);
			new Notice("标注删除失败");
		}
	}

	/**
	 * 清除 foliate 上所有标注高亮，然后重新渲染已保存的标注。
	 * 用于标注增删后的全量刷新。
	 */
	private refreshRenditionAnnotations(): void {
		if (!this.foliateView || !this.file) {
			return;
		}

		// 用 tracked meta remove 所有已渲染标注，不依赖 sidecar 缓存——
		// 这样外部删除（侧栏）后被删的标注也能从 foliate 层正确移除，再按当前 sidecar 全量重绘。
		for (const meta of this.renderedAnnotationMeta.values()) {
			try {
				this.foliateView.deleteAnnotation(meta);
			} catch {
				/* foliate may already have cleared the overlay */
			}
		}
		this.renderedAnnotationMeta.clear();

		this.restoreAnnotations();
	}

	// ================================================================
	// 位置事件 & 进度
	// ================================================================

	/**
	 * 处理 foliate relocate 事件。
	 * 更新当前章节、百分比、进度条显示，并触发进度保存。
	 *
	 * @param detail - foliate relocate event detail
	 */
	private handleRelocated(detail: FoliateRelocateDetail): void {
		const cfi = normalizeCfi(detail?.cfi);
		const rawPercent = normalizePercent(detail?.fraction ?? this.currentPercent);
		const spineIndex = typeof detail.section?.current === "number" ? detail.section.current : this.currentSectionIndex;

		// 跟踪历史最高 fraction（滚动模式下末页 ≈0.9x 达不到 1.0）
		if (rawPercent > this.maxSeenPercent) {
			this.maxSeenPercent = rawPercent;
			this.clampedToEnd = false;
			this.stableCountAtEnd = 0;
		}
		// 末节 + fraction 停滞在历史高位 + 连续未增长 → 已读完全书
		const isLast = detail.section != null && detail.section.current >= detail.section.total - 1;
		if (!this.clampedToEnd && isLast && rawPercent >= 0.80) {
			if (rawPercent >= this.maxSeenPercent) {
				this.stableCountAtEnd++;
				if (this.stableCountAtEnd >= 3) {
					this.clampedToEnd = true;
				}
			} else {
				this.stableCountAtEnd = 0;
			}
		}
		// 往回翻且低于历史最高 5% → 释放末页锁定，显示真实进度
		if (this.clampedToEnd && rawPercent < this.maxSeenPercent - 0.05) {
			this.clampedToEnd = false;
			this.stableCountAtEnd = 0;
		}
		// 回到开头附近（< 15%）→ 新一轮阅读，重置末尾锁定与通读计数锁存
		if (rawPercent < 0.15) {
			this.maxSeenPercent = 0;
			this.stableCountAtEnd = 0;
			this.clampedToEnd = false;
			this.completedThisCycle = false;
		}
		const percent = this.clampedToEnd ? 1 : rawPercent;

		// 通读检查点（有界容差区间）：跳转事件（fraction 突变）不置位，防"开头直跳结尾"误计
		const prevMask = this.readCheckpointMask;
		const isJump = Math.abs(rawPercent - this.lastRelocatedFraction) > READ_CHECKPOINTS_JUMP_DELTA;
		this.lastRelocatedFraction = rawPercent;
		let newMask = prevMask;
		if (!isJump) {
			for (let i = 0; i < READ_CHECKPOINTS.length - 1; i++) {
				const cp = READ_CHECKPOINTS[i];
				if (rawPercent >= cp.lo && (cp.hi === undefined || rawPercent < cp.hi)) {
					newMask |= 1 << i;
				}
			}
			if (this.clampedToEnd || rawPercent >= READ_CHECKPOINTS[READ_CHECKPOINTS.length - 1].lo) {
				newMask |= 1 << (READ_CHECKPOINTS.length - 1);
			}
		}
		// 全部检查带到齐且本周期未计过 → 计一次通读
		if ((newMask & READ_CHECKPOINTS_ALL_MASK) === READ_CHECKPOINTS_ALL_MASK && !this.completedThisCycle) {
			this.currentReadCount++;
			this.completedThisCycle = true;
			this.readCheckpointMask = 0;
		} else {
			this.readCheckpointMask = newMask;
		}

		this.currentCfi = cfi || this.currentCfi;
		this.currentSectionIndex = Number.isFinite(spineIndex) ? spineIndex : 0;
		this.currentChapter = detail?.tocItem?.label ?? resolveChapterLabel(this.tocEntries, this.currentSectionIndex);
		this.currentPercent = percent;

		this.updateProgressBar(percent);
		this.debouncedSaveProgress(this.currentCfi, percent);
	}

	/**
	 * 更新底部进度条的填充和文本。
	 *
	 * @param percent - 当前进度百分比（0-1）
	 */
	private updateProgressBar(percent: number): void {
		this.progressEl.empty();

		const bar = this.progressEl.createDiv({ cls: "yh-epub-progress-bar" });
		bar.createDiv({
			cls: "yh-epub-progress-fill",
		});
		const fill = bar.querySelector<HTMLElement>(".yh-epub-progress-fill");
		if (fill) {
			fill.style.width = `${Math.round(percent * 100)}%`;
			const readIdx = Math.min(this.currentReadCount + 1, 6);
			fill.classList.add(`read-${readIdx}`);
		}

		const percentText = `${Math.round(percent * 100)}%`;
		const remaining = this.formatRemainingTime();

		this.progressEl.createDiv({
			cls: "yh-epub-progress-text",
			text: remaining ? `${percentText}  ·  ${remaining}` : percentText,
		});
	}

	/**
	 * 格式化剩余阅读时间文本。
	 * 基于已用阅读时间和当前百分比进行估算。
	 *
	 * @returns 剩余时间字符串，如 "剩余约 23 分钟"；若数据不足则返回空字符串
	 */
	private formatRemainingTime(): string {
		if (this.currentPercent <= 0.01 || this.readingTimeSeconds < 60) {
			return "";
		}

		const remainingFraction = 1 - this.currentPercent;
		if (remainingFraction <= 0) {
			return "已读完";
		}

		const estimatedRemainingSeconds = (this.readingTimeSeconds / this.currentPercent) * remainingFraction;
		const estimatedRemainingMinutes = Math.round(estimatedRemainingSeconds / 60);

		if (estimatedRemainingMinutes < 1) {
			return "剩余不到 1 分钟";
		}

		return `剩余约 ${estimatedRemainingMinutes} 分钟`;
	}

	/**
	 * 防抖保存阅读进度。
	 * 避免高频 relocated 事件导致过多的磁盘写入。
	 *
	 * @param cfi - 当前位置的 CFI 字符串
	 * @param percent - 当前进度百分比
	 */
	private debouncedSaveProgress(cfi: string, percent: number): void {
		if (this.progressSaveTimer !== null) {
			window.clearTimeout(this.progressSaveTimer);
		}

		this.progressSaveTimer = window.setTimeout(() => {
			this.progressSaveTimer = null;
			void this.saveCurrentProgress(cfi, percent);
		}, PROGRESS_SAVE_DEBOUNCE_MS);
	}

	/**
	 * 立即保存当前阅读进度到 sidecar。
	 *
	 * @param cfiOverride - 可选的 CFI 覆盖值
	 * @param percentOverride - 可选的百分比覆盖值
	 */
	private async saveCurrentProgress(cfiOverride?: string, percentOverride?: number): Promise<void> {
		if (!this.file) {
			return;
		}

		const cfi = cfiOverride ?? this.currentCfi;
		const percent = percentOverride ?? this.currentPercent;

		if (!cfi && percent <= 0) {
			return;
		}

		const progress: EpubReadingProgress = {
			cfi,
			chapter: this.currentChapter,
			percent,
			lastRead: new Date().toISOString(),
			readingTimeSeconds: this.readingTimeSeconds,
			estimatedRemainingMinutes: this.estimateRemainingMinutes(),
			readCount: this.currentReadCount,
			readCheckpoints: this.readCheckpointMask,
			lastCompletedAt: this.completedThisCycle && percent >= 0.98 ? new Date().toISOString() : undefined,
		};

		try {
			await this.store.saveEpubProgress(this.file, progress);
			this.refreshAnnotations();
		} catch (error) {
			console.error("yh-inklight: EPUB progress save failed", error);
		}
	}

	/**
	 * 估算剩余阅读分钟数。
	 *
	 * @returns 估算剩余分钟数；若数据不足则返回 undefined
	 */
	private estimateRemainingMinutes(): number | undefined {
		if (this.currentPercent <= 0.01 || this.readingTimeSeconds < 60) {
			return undefined;
		}

		const remainingFraction = 1 - this.currentPercent;
		if (remainingFraction <= 0) {
			return 0;
		}

		const estimatedRemainingSeconds = (this.readingTimeSeconds / this.currentPercent) * remainingFraction;
		return Math.round(estimatedRemainingSeconds / 60);
	}

	/**
	 * 从 sidecar 恢复上次阅读进度并跳转。
	 */
	private async restoreProgress(): Promise<void> {
		if (!this.file || !this.foliateView) {
			return;
		}

		const document = await this.store.getDocument(this.file);
		const progress = document.epubProgress;
		if (!progress) {
			await showFoliateStart(this.foliateView);
			this.restoreAnnotations();
			return;
		}

		this.readingTimeSeconds = progress.readingTimeSeconds ?? 0;
		this.currentReadCount = progress.readCount ?? 0;
		this.readCheckpointMask = progress.readCheckpoints ?? 0;
		this.lastRelocatedFraction = progress.percent ?? 0;

		const cfi = normalizeCfi(progress.cfi);
		if (cfi) {
			try {
				await this.foliateView.goTo(cfi);
				this.currentCfi = cfi;
			} catch {
				await showFoliateStart(this.foliateView);
			}
		} else {
			await showFoliateStart(this.foliateView);
		}

		this.currentPercent = normalizePercent(progress.percent);
		this.completedThisCycle = this.currentPercent >= 0.95;
		this.updateProgressBar(this.currentPercent);
		this.restoreAnnotations();
	}

	// ================================================================
	// 渲染事件
	// ================================================================

	/**
	 * 处理 foliate section 加载后的渲染刷新。
	 * 刷新标注渲染（确保标注在章节切换后仍然可见）。
	 */
	private handleRendered(): void {
		this.restoreAnnotations();
	}

	// ================================================================
	// 键盘 & 滚轮导航
	// ================================================================

	/**
	 * 处理键盘导航事件。
	 * 方向键左/上 = 上一页，方向键右/下 = 下一页。
	 *
	 * @param event - 键盘事件
	 */
	private handleKeydown(event: KeyboardEvent): void {
		if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) {
			return;
		}

		switch (event.key) {
			case "ArrowLeft":
			case "ArrowUp": {
				event.preventDefault();
				this.prevPage();
				break;
			}
			case "ArrowRight":
			case "ArrowDown": {
				event.preventDefault();
				this.nextPage();
				break;
			}
			default:
				break;
		}
	}

	/**
	 * 处理鼠标滚轮事件。
	 * 在分页模式下通过滚轮翻页，带防抖保护。
	 *
	 * @param event - 滚轮事件
	 */
	private handleWheel(event: WheelEvent): void {
		if (this.currentFlowMode !== "paginated") {
			return;
		}

		event.preventDefault();

		if (this.wheelDebounceTimer !== null) {
			return;
		}

		this.wheelDebounceTimer = window.setTimeout(() => {
			this.wheelDebounceTimer = null;
		}, WHEEL_DEBOUNCE_MS);

		if (event.deltaY > 0) {
			this.nextPage();
		} else if (event.deltaY < 0) {
			this.prevPage();
		}
	}

	/**
	 * 翻到下一页。
	 */
	private nextPage(): void {
		if (!this.foliateView) {
			return;
		}
		const action = this.foliateView.next ?? this.foliateView.goRight;
		void action?.call(this.foliateView);
	}

	/**
	 * 翻到上一页。
	 */
	private prevPage(): void {
		if (!this.foliateView) {
			return;
		}
		const action = this.foliateView.prev ?? this.foliateView.goLeft;
		void action?.call(this.foliateView);
	}

	// ================================================================
	// 导航
	// ================================================================

	/**
	 * 导航到目录条目位置。
	 *
	 * 带锚点的条目把原始 href（含 #锚点）字符串交给 foliate，由它解析并滚动到小节标题；
	 * 无锚点的条目退化为按 spine index 跳到章节开头。
	 *
	 * @param entry - 目录条目
	 */
	private navigateToSpineIndex(entry: TocSpineEntry): void {
		if (!this.foliateView) {
			return;
		}
		if (entry.href) {
			void this.foliateView.goTo(entry.href);
		} else {
			void this.foliateView.goTo(entry.spineIndex);
		}
	}

	/**
	 * 导航到指定标注的位置。
	 *
	 * @param annotationId - 标注 ID
	 */
	private navigateToAnnotation(annotationId: string): void {
		if (!this.file || !this.foliateView) {
			return;
		}

		const document = this.store.getCachedDocument(this.file.path);
		if (!document) {
			return;
		}

		const allAnnotations = [...document.epubHighlights, ...document.epubComments];
		const annotation = allAnnotations.find((item) => item.id === annotationId);
		if (!annotation?.anchor.cfiRange) {
			return;
		}

		void this.foliateView.goTo(annotation.anchor.cfiRange);
	}

	// ================================================================
	// 字号 & 主题
	// ================================================================

	/**
	 * 调整阅读字号。
	 *
	 * @param delta - 字号变化量（正数增大，负数缩小）
	 */
	private changeFontSize(delta: number): void {
		const nextSize = Math.max(12, Math.min(28, this.currentFontSize + delta));
		if (nextSize === this.currentFontSize) {
			return;
		}

		this.currentFontSize = nextSize;
		this.pluginSettings.epubFontSize = nextSize;
		this.applyFontSize(nextSize);
		this.renderToolbar();
		void this.saveSettings();
	}

	/**
	 * 将字号应用到 foliate 主题样式。
	 *
	 * @param size - 字号像素值
	 */
	private applyFontSize(size: number): void {
		this.applyFoliateAppearance(size);
	}

	/**
	 * 切换阅读主题。
	 *
	 * @param themeId - 目标主题 ID
	 */
	private switchTheme(themeId: EpubReadingTheme): void {
		if (themeId === this.currentTheme) {
			return;
		}

		this.currentTheme = themeId;
		this.pluginSettings.epubReadingTheme = themeId;

		this.applyFoliateAppearance();

		this.renderToolbar();
		void this.saveSettings();
	}

	/**
	 * 切换翻页模式（分页/滚动）。
	 */
	private toggleFlowMode(): void {
		const nextMode: EpubFlowMode = this.currentFlowMode === "paginated" ? "scrolled" : "paginated";
		this.currentFlowMode = nextMode;
		this.pluginSettings.epubDefaultFlow = nextMode;

		if (!this.foliateView) {
			return;
		}

		const element = this.foliateView as unknown as HTMLElement;
		element.setAttribute("flow", nextMode);
		this.applyFoliateLayout();
		this.applyFoliateAppearance();
		this.renderToolbar();
		void this.saveSettings();
	}

	// ================================================================
	// 阅读时间追踪
	// ================================================================

	/**
	 * 启动阅读时间追踪。
	 * 注册 visibilitychange/blur/focus 事件监听，启动定期 flush 定时器。
	 */
	private startReadingTimeTracker(): void {
		this.lastFlushTimestamp = Date.now();

		this.readingTimeFlushTimer = window.setInterval(() => {
			void this.flushReadingTime();
		}, READING_TIME_FLUSH_INTERVAL_MS);

		this.visibilityHandler = () => {
			if (document.hidden) {
				void this.flushReadingTime();
			} else {
				this.lastFlushTimestamp = Date.now();
			}
		};
		this.blurHandler = () => {
			void this.flushReadingTime();
		};
		this.focusHandler = () => {
			this.lastFlushTimestamp = Date.now();
		};

		document.addEventListener("visibilitychange", this.visibilityHandler);
		window.addEventListener("blur", this.blurHandler);
		window.addEventListener("focus", this.focusHandler);
	}

	/**
	 * 停止阅读时间追踪。
	 * 执行最后一次 flush，移除所有事件监听和定时器。
	 */
	private stopReadingTimeTracker(): void {
		if (this.readingTimeFlushTimer !== null) {
			window.clearInterval(this.readingTimeFlushTimer);
			this.readingTimeFlushTimer = null;
		}

		if (this.visibilityHandler) {
			document.removeEventListener("visibilitychange", this.visibilityHandler);
			this.visibilityHandler = null;
		}

		if (this.blurHandler) {
			window.removeEventListener("blur", this.blurHandler);
			this.blurHandler = null;
		}

		if (this.focusHandler) {
			window.removeEventListener("focus", this.focusHandler);
			this.focusHandler = null;
		}
	}

	/**
	 * Flush 阅读时间。
	 * 计算自上次 flush 以来的经过时间（仅在页面可见时累计），
	 * 累加到 readingTimeSeconds。
	 */
	private async flushReadingTime(): Promise<void> {
		const now = Date.now();
		const elapsed = Math.round((now - this.lastFlushTimestamp) / 1000);
		this.lastFlushTimestamp = now;

		if (elapsed > 0 && !document.hidden) {
			this.readingTimeSeconds += elapsed;
		}
	}

	/**
	 * 获取当前阅读时间快照。
	 *
	 * @returns 包含累计秒数和上次 flush 时间戳的快照
	 */
	private getReadingTimeSnapshot(): ReadingTimeSnapshot {
		return {
			readingTimeSeconds: this.readingTimeSeconds,
			lastFlushTimestamp: this.lastFlushTimestamp,
		};
	}

	// ================================================================
	// 外部跳转（供共用 AnnotationSidebarView 的 jumpTo 调用）
	// ================================================================

	/**
	 * 导航到指定 CFI 位置。
	 * 供共用 AnnotationSidebarView 的「跳转」按钮调用，
	 * 实现从总览面板跳回 EPUB 正文对应位置。
	 *
	 * @param cfiRange - CFI 范围字符串
	 */
	navigateToCfi(cfiRange: string): void {
		if (!this.foliateView) {
			return;
		}
		try {
			void this.foliateView.goTo(cfiRange);
		} catch (error) {
			console.warn("yh-inklight: navigateToCfi failed", error);
		}
	}

	/**
	 * 外部标注变更后刷新本视图。
	 * 供共用 AnnotationSidebarView 删除/编辑 EPUB 标注后调用，
	 * 重新从 sidecar 读取标注并重绘 foliate 高亮层 + 内嵌侧栏。
	 */
	refreshExternalAnnotations(): void {
		if (!this.file || !this.foliateView) {
			return;
		}
		this.refreshRenditionAnnotations();
		this.renderSidebar();
	}

	// ================================================================
	// 书内搜索（Phase 4-B P4）
	// ================================================================

	private renderSearchBox(): void {
		const container = this.sidebarContentEl.createDiv({ cls: "yh-epub-search-box" });
		this.searchInputEl = container.createEl("input", {
			cls: "yh-epub-search-input",
			attr: { type: "text", placeholder: "搜索全文…" },
		}) as HTMLInputElement;
		this.searchInputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
			ev.stopPropagation();
		}, { capture: true });
		this.searchResultsEl = container.createDiv({ cls: "yh-epub-search-results" });
		this.searchInputEl.addEventListener("input", this.searchDebounce, { passive: true });
	}

	private async performSearch(): Promise<void> {
		if (!this.searchResultsEl || !this.searchInputEl || !this.foliateView) return;
		const query = this.searchInputEl.value.trim().toLowerCase();
		this.searchResultsEl.empty();
		if (query.length < 2) return;
		let results: Array<{ cfi: string; excerpt: string }> = [];
		if (typeof (this.foliateView as any).search === "function") {
			try {
				const sr: unknown = await ((this.foliateView as any).search as (q: string) => Promise<unknown>)(query);
				if (Array.isArray(sr)) results = (sr as any[]).map((i: any) => ({ cfi: String(i.cfi || i.value || ""), excerpt: String(i.excerpt || i.text || "") }));
			} catch { /* ignore */ }
		}
		if (results.length === 0) {
			const contents = this.foliateView.renderer?.getContents?.() ?? [];
			for (const c of contents) {
				if (!c.doc?.body) continue;
				const text = c.doc.body.textContent || "";
				const lower = text.toLowerCase();
				let idx = lower.indexOf(query);
				while (idx >= 0 && results.length < 50) {
					const start = Math.max(0, idx - 40);
					const end = Math.min(text.length, idx + query.length + 60);
					let excerpt = text.slice(start, end).replace(/\n/g, " ");
					if (start > 0) excerpt = "…" + excerpt;
					if (end < text.length) excerpt = excerpt + "…";
					results.push({ cfi: "", excerpt });
					idx = lower.indexOf(query, idx + query.length);
				}
				if (results.length > 0) break;
			}
		}
		if (results.length === 0) {
			this.searchResultsEl.createDiv({ cls: "yh-epub-search-empty", text: "未找到匹配" });
			return;
		}
		for (const r of results) {
			const item = this.searchResultsEl.createEl("button", { cls: "yh-epub-search-result", attr: { type: "button" } });
			item.createSpan({ cls: "yh-epub-search-text", text: r.excerpt.slice(0, 100) });
			if (r.cfi) item.addEventListener("click", () => { if (this.foliateView) void this.foliateView.goTo(r.cfi); });
		}
	}

	// ================================================================
	// 脚注预览 & 段落模式（Phase 4-B P3，均未实现）
	// ================================================================

	// ================================================================
	// 资源清理
	// ================================================================

	/**
	 * 销毁 foliate-view 实例，释放资源。
	 */
	private destroyRendition(): void {
		if (this.progressSaveTimer !== null) {
			window.clearTimeout(this.progressSaveTimer);
			this.progressSaveTimer = null;
		}

		if (this.wheelDebounceTimer !== null) {
			window.clearTimeout(this.wheelDebounceTimer);
			this.wheelDebounceTimer = null;
		}

		if (this.foliateView) {
			try {
				this.foliateView.removeEventListener("load", this.handleFoliateLoad as EventListener);
				this.foliateView.removeEventListener("relocate", this.handleFoliateRelocate as EventListener);
				this.foliateView.removeEventListener("draw-annotation", this.handleFoliateDrawAnnotation as EventListener);
				this.foliateView.removeEventListener("show-annotation", this.handleFoliateShowAnnotation as EventListener);
				this.foliateView.close?.();
			} catch {
				/* foliate-view 可能已经销毁 */
			}
			this.foliateView = null;
		}
		this.annotationCardEl?.dismiss();
		this.annotationCardEl = null;
		this.renderedAnnotationMeta.clear();

		if (this.readerContainerEl) {
			this.readerContainerEl.empty();
		}
	}

	private buildFoliateTocEntries(tocItems: FoliateTocItem[]): TocSpineEntry[] {
		const entries: TocSpineEntry[] = [];
		const walk = (items: FoliateTocItem[]) => {
			for (const item of items) {
				const index = this.resolveFoliateHrefIndex(item.href);
				if (index !== null) {
					entries.push({ label: (item.label ?? "").trim() || `章节 ${index + 1}`, spineIndex: index, href: item.href });
				}
				if (item.subitems?.length) {
					walk(item.subitems.filter((child): child is FoliateTocItem => typeof child === "object" && child !== null));
				}
			}
		};
		walk(tocItems);
		return [...entries].sort((a, b) => a.spineIndex - b.spineIndex);
	}

	private resolveFoliateHrefIndex(href: string | undefined): number | null {
		if (!href || !this.foliateView?.book?.sections) {
			return null;
		}
		const normalizedHref = href.split("#")[0];
		const index = this.foliateView.book.sections.findIndex((section) => {
			const id = String(section.id ?? "");
			return id === href || id === normalizedHref || id.endsWith(normalizedHref);
		});
		return index >= 0 ? index : null;
	}

	private handleFoliateLoad = async (event: Event): Promise<void> => {
		const detail = (event as CustomEvent<FoliateLoadDetail>).detail;
		const doc = detail?.doc;
		if (!doc) {
			return;
		}
		const index = typeof detail.index === "number" ? detail.index : this.currentSectionIndex;
		this.loadedSectionDocs.set(doc, index);
		this.currentLoadedDoc = doc;
		stripScriptsFromDocument(doc);
		await inlineBlockedStylesheets({ document: doc });
		this.attachSelectionListeners(doc);
		this.handleRendered();
		this.maybeMeasureBodyFontScale(doc);
	};

	/**
	 * 统一正文字号：测量当前书正文段落在插件样式生效下的真实字号比例。
	 * 仅在开启设置且尚未测量时执行一次；正文确实被书内 CSS 缩放（偏离 1 超过 2%）才标记，
	 * 供 applyFoliateAppearance 注入覆盖规则。脚注/图注（font-size 非正文基准）不受影响。
	 */
	private maybeMeasureBodyFontScale(doc: Document): void {
		if (this.bodyScaleMeasured) {
			return;
		}
		if (!this.pluginSettings.epubUnifyBodyFontSize) {
			this.bodyScaleMeasured = true;
			return;
		}
		if (!doc.body) {
			return;
		}
		const bodySize = parseFloat(getComputedStyle(doc.body).fontSize);
		if (!Number.isFinite(bodySize) || bodySize <= 0) {
			return;
		}
		const textParagraphs = Array.from(doc.body.querySelectorAll("p")).filter(
			(p) => (p.textContent?.trim() ?? "") && !p.querySelector("img"),
		);
		if (textParagraphs.length === 0) {
			return;
		}
		const ratios: number[] = [];
		for (const p of textParagraphs) {
			if (ratios.length >= 30) {
				break;
			}
			const size = parseFloat(getComputedStyle(p).fontSize);
			if (!Number.isFinite(size) || size <= 0) {
				return;
			}
			ratios.push(size / bodySize);
		}
		this.bodyScaleMeasured = true;
		if (ratios.length < 3) {
			return;
		}
		ratios.sort((a, b) => a - b);
		const median = ratios[Math.floor(ratios.length / 2)];
		if (Math.abs(median - 1) > 0.02) {
			this.bodyFontScaled = true;
			this.applyFoliateAppearance();
		}
	}

	private handleFoliateRelocate = (event: Event): void => {
		this.handleRelocated((event as CustomEvent<FoliateRelocateDetail>).detail ?? {});
	};

	private handleFoliateDrawAnnotation = (event: Event): void => {
		const detail = (event as CustomEvent<FoliateDrawAnnotationDetail>).detail;
		if (!detail?.annotation || typeof detail.draw !== "function") {
			return;
		}
		const color = detail.annotation.color ?? this.pluginSettings.defaultHighlightColor;
		const style = detail.annotation.style ?? this.pluginSettings.epubHighlightStyle;
		detail.draw((rects) => this.createAnnotationOverlay(rects, color, style));
	};

	private handleFoliateShowAnnotation = (event: Event): void => {
		const detail = (event as CustomEvent<FoliateShowAnnotationDetail>).detail;
		if (!detail?.value) {
			return;
		}
		this.showAnnotationCard(detail.value, detail.index, detail.range);
	};

	/**
	 * 点击阅读区高亮后弹出标注详情卡片。
	 * 优先展示笔记（epub-comment），纯画线则提示可添加笔记。
	 *
	 * @param cfiRange - foliate show-annotation 事件携带的标注 value（= CFI 范围）
	 * @param index - 所在 spine 索引
	 * @param range - 标注覆盖的文本 Range
	 */
	private showAnnotationCard(cfiRange: string, index?: number, range?: Range): void {
		if (!this.file) {
			return;
		}
		const document = this.store.getCachedDocument(this.file.path);
		if (!document) {
			return;
		}

		const comment = document.epubComments.find((c) => c.anchor.cfiRange === cfiRange);
		const highlight = comment ?? document.epubHighlights.find((h) => h.anchor.cfiRange === cfiRange);
		if (!highlight) {
			return;
		}

		this.annotationCardEl?.dismiss();

		const anchor = this.resolveAnnotationCardAnchor(index, range);
		const card = new EpubAnnotationCard(
			{
				quote: highlight.anchor.selectedText,
				note: comment?.note,
				noteType: comment?.noteType,
				color: highlight.color,
				chapter: highlight.anchor.chapter,
				createdAt: highlight.createdAt,
				hasNote: comment != null,
			},
			{
				onEdit: () => this.editComment(cfiRange),
				onAddNote: () => this.addNoteToHighlight(cfiRange),
				onDelete: () => {
					void this.deleteAnnotation(highlight.id);
				},
			},
		);
		card.show(anchor, Platform.isMobile);
		this.annotationCardEl = card;
	}

	private resolveAnnotationCardAnchor(index?: number, range?: Range): { left: number; top: number } {
		if (range) {
			const doc =
				index != null
					? this.foliateView?.renderer?.getContents?.().find((c) => c.index === index)?.doc
					: undefined;
			if (doc) {
				const rect = this.createSelectionViewportRect(doc, range);
				if (rect) {
					return { left: rect.left + rect.width / 2, top: rect.bottom };
				}
			}
		}
		const area = this.readerContainerEl?.getBoundingClientRect();
		return {
			left: area ? area.left + area.width / 2 : window.innerWidth / 2,
			top: area ? area.top + 16 : 16,
		};
	}

	/**
	 * 编辑已有标注（epub-comment）：用现有内容预填弹窗，保存后原位更新。
	 *
	 * @param cfiRange - 标注 CFI 范围
	 */
	private editComment(cfiRange: string): void {
		if (!this.file) {
			return;
		}
		const document = this.store.getCachedDocument(this.file.path);
		const comment = document?.epubComments.find((c) => c.anchor.cfiRange === cfiRange);
		if (!comment) {
			return;
		}

		new EpubNoteModal(
			this.app,
			comment.anchor.selectedText,
			{
				note: comment.note,
				color: comment.color,
				style: comment.style,
				noteType: comment.noteType,
			},
			async (result: EpubNoteResult) => {
				if (!result.note.trim()) {
					return;
				}
				const updated: EpubCommentAnnotation = {
					...comment,
					color: result.color,
					style: result.style,
					noteType: result.noteType,
					note: result.note.trim(),
					updatedAt: new Date().toISOString(),
				};
				try {
					await this.store.updateEpubComment(this.file!, updated);
					this.refreshRenditionAnnotations();
					this.renderSidebar();
					this.refreshAnnotations();
					new Notice("标注已更新");
				} catch (error) {
					console.error("yh-inklight: EPUB comment update failed", error);
					new Notice("标注更新失败");
				}
			},
			"编辑想法",
		).open();
	}

	/**
	 * 为纯画线高亮补充笔记：删除原高亮并用相同 id 创建 epub-comment，
	 * 保证 foliate 高亮层 value（= CFI 范围）与 sidecar 保持一一对应。
	 *
	 * @param cfiRange - 高亮 CFI 范围
	 */
	private addNoteToHighlight(cfiRange: string): void {
		if (!this.file) {
			return;
		}
		const document = this.store.getCachedDocument(this.file.path);
		const highlight = document?.epubHighlights.find((h) => h.anchor.cfiRange === cfiRange);
		if (!highlight) {
			return;
		}

		new EpubNoteModal(
			this.app,
			highlight.anchor.selectedText,
			{ color: highlight.color, style: highlight.style },
			async (result: EpubNoteResult) => {
				if (!result.note.trim()) {
					return;
				}
				const now = new Date().toISOString();
				const comment: EpubCommentAnnotation = {
					id: highlight.id,
					type: "epub-comment",
					color: result.color,
					style: result.style,
					anchor: highlight.anchor,
					note: result.note.trim(),
					noteType: result.noteType,
					createdAt: highlight.createdAt,
					collapsed: false,
					author: this.pluginSettings.defaultAuthor,
					updatedAt: now,
					replies: [],
					resolved: false,
				};
				try {
					await this.store.removeAnnotation(this.file!, highlight.id);
					await this.store.addEpubComment(this.file!, comment);
					this.refreshRenditionAnnotations();
					this.renderSidebar();
					this.refreshAnnotations();
					new Notice("已添加标注");
				} catch (error) {
					console.error("yh-inklight: EPUB highlight to comment conversion failed", error);
					new Notice("标注创建失败");
				}
			},
		).open();
	}

	private attachSelectionListeners(doc: Document): void {
		if (this.documentSelectionCleanups.has(doc)) {
			return;
		}

		let pendingFrame = 0;
		let pendingRetry = 0;
		const scheduleEmit = () => {
			if (pendingFrame) {
				window.cancelAnimationFrame(pendingFrame);
			}
			pendingFrame = window.requestAnimationFrame(() => {
				pendingFrame = 0;
				const emitted = this.emitFoliateSelection(doc);
				if (!emitted) {
					if (pendingRetry) {
						window.clearTimeout(pendingRetry);
					}
					pendingRetry = window.setTimeout(() => {
						pendingRetry = 0;
						this.emitFoliateSelection(doc);
					}, SELECTION_SYNC_RETRY_DELAY_MS);
				}
			});
		};

		const eventOptions: AddEventListenerOptions = { capture: true };
		const win = doc.defaultView;

		const handleImageClick = (ev: Event): void => {
			const target = ev.target as Element | null;
			const img = target && typeof target.closest === "function" ? target.closest("img") : null;
			if (!img) {
				return;
			}
			const src = img.getAttribute("src");
			if (!src) {
				return;
			}
			ev.preventDefault();
			ev.stopPropagation();
			this.showImageZoom(src, img.getAttribute("alt") ?? "");
		};
		doc.addEventListener("click", handleImageClick, eventOptions);

		doc.addEventListener("selectionchange", scheduleEmit, eventOptions);
		doc.addEventListener("mouseup", scheduleEmit, eventOptions);
		doc.addEventListener("pointerup", scheduleEmit, eventOptions);
		doc.addEventListener("touchend", scheduleEmit, eventOptions);
		doc.addEventListener("keyup", scheduleEmit, eventOptions);
		doc.addEventListener("contextmenu", scheduleEmit, eventOptions);
		win?.addEventListener("mouseup", scheduleEmit, eventOptions);
		win?.addEventListener("pointerup", scheduleEmit, eventOptions);
		win?.addEventListener("touchend", scheduleEmit, eventOptions);

		const cleanup = () => {
			if (pendingFrame) {
				window.cancelAnimationFrame(pendingFrame);
			}
			if (pendingRetry) {
				window.clearTimeout(pendingRetry);
			}
			doc.removeEventListener("click", handleImageClick, true);
			doc.removeEventListener("selectionchange", scheduleEmit, true);
			doc.removeEventListener("mouseup", scheduleEmit, true);
			doc.removeEventListener("pointerup", scheduleEmit, true);
			doc.removeEventListener("touchend", scheduleEmit, true);
			doc.removeEventListener("keyup", scheduleEmit, true);
			doc.removeEventListener("contextmenu", scheduleEmit, true);
			win?.removeEventListener("mouseup", scheduleEmit, true);
			win?.removeEventListener("pointerup", scheduleEmit, true);
			win?.removeEventListener("touchend", scheduleEmit, true);
		};
		this.documentSelectionCleanups.set(doc, cleanup);
	}

	private emitFoliateSelection(doc: Document): boolean {
		const selection = doc.getSelection?.() ?? doc.defaultView?.getSelection?.();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			return false;
		}
		const range = selection.getRangeAt(0);
		const text = selection.toString().trim();
		if (!text || !this.foliateView?.getCFI) {
			return false;
		}
		const cfiRange = this.resolveSelectionCfi(doc, range);
		if (!cfiRange) {
			return false;
		}
		const rect = this.createSelectionViewportRect(doc, range);
		if (!rect) {
			return false;
		}
		this.handleTextSelected({ doc, range: range.cloneRange(), text, cfiRange, rect });
		return true;
	}

	private resolveSelectionCfi(doc: Document, range: Range): string {
		if (!this.foliateView?.getCFI) {
			return "";
		}

		const knownIndex = this.loadedSectionDocs.get(doc);
		const contentsIndex = this.foliateView.renderer?.getContents?.()
			.find((content) => content.doc === doc)?.index;
		const index = knownIndex ?? contentsIndex ?? this.currentSectionIndex;

		try {
			return normalizeCfi(this.foliateView.getCFI(index, range.cloneRange()));
		} catch (error) {
			console.warn("yh-inklight: EPUB selection CFI failed", { index, error });
			return "";
		}
	}

	private createSelectionViewportRect(doc: Document, range: Range): DOMRect | null {
		const rawRect = this.extractVisibleRangeRect(range);
		if (!rawRect) {
			return null;
		}

		const frame = this.findIframeForDocument(doc);
		const frameRect = frame?.getBoundingClientRect();
		if (!frameRect) {
			return rawRect;
		}

		return new DOMRect(
			rawRect.left + frameRect.left,
			rawRect.top + frameRect.top,
			rawRect.width,
			rawRect.height,
		);
	}

	private extractVisibleRangeRect(range: Range): DOMRect | null {
		const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
		const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
		if (!rect || rect.width <= 0 || rect.height <= 0) {
			return null;
		}
		return new DOMRect(rect.left, rect.top, rect.width, rect.height);
	}

	private createAnnotationOverlay(
		rects: Array<DOMRect | { left: number; top: number; width: number; height: number }>,
		color: AnnotationColor,
		style: EpubHighlightStyle,
	): SVGElement {
		const svgNS = "http://www.w3.org/2000/svg";
		const group = activeDocument.createElementNS(svgNS, "g");
		const rgba = EPUB_COLOR_MAP[color];

		for (const rect of rects) {
			const x = Number(rect.left) || 0;
			const y = Number(rect.top) || 0;
			const width = Number(rect.width) || 0;
			const height = Number(rect.height) || 0;
			if (width <= 0 || height <= 0) {
				continue;
			}

			if (style === "fill") {
				const highlight = activeDocument.createElementNS(svgNS, "rect");
				highlight.setAttribute("x", String(x));
				highlight.setAttribute("y", String(y));
				highlight.setAttribute("width", String(width));
				highlight.setAttribute("height", String(height));
				highlight.setAttribute("rx", "2");
				highlight.setAttribute("fill", rgba);
				highlight.setAttribute("style", "mix-blend-mode:multiply;pointer-events:none");
				group.appendChild(highlight);
				continue;
			}

			const line = activeDocument.createElementNS(svgNS, "line");
			line.setAttribute("x1", String(x));
			line.setAttribute("x2", String(x + width));
			line.setAttribute("y1", String(y + height - 2));
			line.setAttribute("y2", String(y + height - 2));
			line.setAttribute("stroke", rgba);
			line.setAttribute("stroke-width", style === "wavy" ? "1.5" : "2");
			line.setAttribute("stroke-linecap", "round");
			if (style === "wavy") {
				line.setAttribute("stroke-dasharray", "2 2");
			}
			line.setAttribute("style", "pointer-events:none");
			group.appendChild(line);
		}

		return group;
	}

	private removeFoliateAnnotation(annotation: { id: string; color: AnnotationColor; style: EpubHighlightStyle; anchor: EpubCfiAnchor }): void {
		if (!this.foliateView) {
			return;
		}
		const meta = this.renderedAnnotationMeta.get(annotation.id) ?? {
			value: annotation.anchor.cfiRange,
			id: annotation.id,
			color: annotation.color,
			style: annotation.style,
		};
		try {
			this.foliateView.deleteAnnotation(meta);
		} catch {
			/* foliate may already have cleared the visible overlay */
		}
		this.renderedAnnotationMeta.delete(annotation.id);
	}

	private applyFoliateAppearance(size = this.currentFontSize): void {
		if (!this.foliateView) {
			return;
		}
		const colors = this.themeManager.resolveThemeColors(this.currentTheme);
		const css = [
			":root { color-scheme: light dark; }",
			"body {",
			`  background-color: ${colors.background} !important;`,
			`  color: ${colors.textColor} !important;`,
			`  font-size: ${size}px !important;`,
			`  line-height: ${this.pluginSettings.epubLineHeight} !important;`,
			...(Platform.isMobile ? ["  padding-bottom: 60px !important;"] : []),
			"}",
			"p, div, span, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dt, dd {",
			`  color: ${colors.textColor} !important;`,
			`  line-height: ${this.pluginSettings.epubLineHeight} !important;`,
			"}",
			...(this.pluginSettings.epubUnifyBodyFontSize && this.bodyFontScaled
				? ["p, li, td, th, dd, dt { font-size: 1em !important; }"]
				: []),
			`a, a:link, a:visited { color: ${colors.linkColor} !important; }`,
			`::selection { background: ${colors.selectionBg} !important; }`,
			"img { max-width: 100% !important; height: auto !important; }",
			"pre, code {",
			`  line-height: ${this.pluginSettings.epubLineHeight} !important;`,
			"}",
		].join("\n");
		this.foliateView.renderer?.setStyles?.(css);
		this.foliateView.renderer?.render?.();
		(this.foliateView as unknown as HTMLElement).style.backgroundColor = colors.background;
		this.readerContainerEl.style.backgroundColor = colors.background;
	}

	private applyFoliateLayout(): void {
		if (!this.foliateView) {
			return;
		}
		const attrs: Record<string, string> = {
			flow: this.currentFlowMode,
			margin: this.currentFlowMode === "paginated" ? "28px" : "0px",
			gap: "8%",
			"max-inline-size": "760px",
		};
		const host = this.foliateView as unknown as HTMLElement;
		const renderer = this.foliateView.renderer as unknown as HTMLElement | undefined;
		for (const [name, value] of Object.entries(attrs)) {
			host.setAttribute(name, value);
			renderer?.setAttribute?.(name, value);
		}
		this.foliateView.renderer?.render?.();
	}

	private findIframeForDocument(doc: Document): HTMLIFrameElement | null {
		const frameElement = doc.defaultView?.frameElement;
		if (frameElement instanceof HTMLIFrameElement) {
			return frameElement;
		}

		const contentFrame = this.foliateView?.renderer?.getContents?.()
			.find((content) => content.doc === doc)?.doc?.defaultView?.frameElement;
		if (contentFrame instanceof HTMLIFrameElement) {
			return contentFrame;
		}

		const visit = (root: ParentNode): HTMLIFrameElement | null => {
			const iframes = Array.from(root.querySelectorAll("iframe"));
			for (const iframe of iframes) {
				try {
					if (iframe.contentDocument === doc) {
						return iframe as HTMLIFrameElement;
					}
				} catch {
					/* cross-origin iframes are not expected, but ignore defensively */
				}
			}
			const elements = Array.from(root.querySelectorAll("*"));
			for (const element of elements) {
				const shadowRoot = (element as HTMLElement).shadowRoot;
				if (!shadowRoot) {
					continue;
				}
				const found = visit(shadowRoot);
				if (found) {
					return found;
				}
			}
			return null;
		};
		return visit(this.readerContainerEl);
	}

	/**
	 * 穿透 shadow DOM 收集所有 foliate iframe 的 contentDocument，供全文搜索使用。
	 * currentLoadedDoc 可能因翻页被 foliate 清空，这里实时遍历最可靠。
	 */
	private collectFoliateDocs(): Document[] {
		const docs: Document[] = [];
		const seen = new Set<Document>();
		const visit = (root: ParentNode): void => {
			const iframes = Array.from(root.querySelectorAll("iframe"));
			for (const iframe of iframes) {
				try {
					const d = (iframe as HTMLIFrameElement).contentDocument;
					if (d && d.body && !seen.has(d)) {
						seen.add(d);
						docs.push(d);
					}
				} catch {
					/* cross-origin iframe, ignore */
				}
			}
			const elements = Array.from(root.querySelectorAll("*"));
			for (const element of elements) {
				const shadowRoot = (element as HTMLElement).shadowRoot;
				if (shadowRoot) {
					visit(shadowRoot);
				}
			}
		};
		visit(this.readerContainerEl);
		// 加上缓存的 currentLoadedDoc 兜底
		if (this.currentLoadedDoc?.body && !seen.has(this.currentLoadedDoc)) {
			docs.push(this.currentLoadedDoc);
		}
		return docs;
	}

	// ================================================================
	// 工具栏搜索（从侧栏移到工具栏）
	// ================================================================

	private toggleToolbarSearch(): void {
		const existing = this.toolbarEl.querySelector(".yh-epub-toolbar-search");
		if (existing) { existing.remove(); return; }
		const container = this.toolbarEl.createDiv({ cls: "yh-epub-toolbar-search" });
		const input = container.createEl("input", {
			cls: "yh-epub-toolbar-search-input",
			attr: { type: "text", placeholder: "搜索正文…" },
		}) as HTMLInputElement;
		const results = container.createDiv({ cls: "yh-epub-toolbar-search-results" });
		input.addEventListener("keydown", (ev: KeyboardEvent) => { ev.stopPropagation(); }, { capture: true });
		let timer: number | null = null;
		input.addEventListener("input", () => {
			if (timer !== null) window.clearTimeout(timer);
			timer = window.setTimeout(() => { timer = null; void this.doToolbarSearch(input.value, results); }, 300);
		}, { passive: true });
		input.addEventListener("keydown", (ev) => {
			if (ev.key === "Escape") { container.remove(); }
			if (ev.key === "Enter") { void this.doToolbarSearch(input.value, results); }
		});
		input.focus();
	}

	private async doToolbarSearch(query: string, resultsEl: HTMLElement): Promise<void> {
		resultsEl.empty();
		if (!query.trim() || query.trim().length < 2 || !this.foliateView) return;

		// 使用 foliate 内置全书搜索（支持跨章节、返回 CFI 可直接导航）
		const searchGen = (this.foliateView as any).search?.({ query: query.trim() });
		if (!searchGen || typeof searchGen[Symbol.asyncIterator] !== 'function') {
			// foliate 不支持 search，回退到当前 section
			resultsEl.createDiv({ cls: "yh-epub-toolbar-search-empty", text: "搜索功能不支持" });
			return;
		}

		const hits: Array<{ cfi: string; label: string; excerpt: { pre: string; match: string; post: string } }> = [];
		let searching = true;

		// 添加进度指示
		const progressEl = resultsEl.createDiv({ cls: "yh-epub-toolbar-search-progress", text: "搜索中..." });

		try {
			for await (const result of searchGen) {
				if (result === 'done') break;
				if (result.progress !== undefined) {
					progressEl.textContent = `搜索中 ${Math.round(result.progress * 100)}%`;
					continue;
				}
				if (result.subitems) {
					for (const item of result.subitems) {
						hits.push({ cfi: item.cfi, label: result.label || '', excerpt: item.excerpt });
						if (hits.length >= 100) break;
					}
				} else if (result.cfi) {
					hits.push({ cfi: result.cfi, label: result.label || '', excerpt: result.excerpt });
				}
				if (hits.length >= 100) break;
			}
		} catch (e) {
			console.error("yh-inklight: search error", e);
		}

		progressEl.remove();

		if (hits.length === 0) {
			resultsEl.createDiv({ cls: "yh-epub-toolbar-search-empty", text: "未找到匹配内容" });
			return;
		}

		// 按章节分组显示
		let currentLabel = '';
		for (const h of hits) {
			if (h.label && h.label !== currentLabel) {
				currentLabel = h.label;
				resultsEl.createDiv({ cls: "yh-epub-toolbar-search-chapter", text: currentLabel });
			}
			const btn = resultsEl.createEl("button", { cls: "yh-epub-toolbar-search-hit", attr: { type: "button" } });
			btn.innerHTML = `${this.escapeHtml(h.excerpt.pre)}<strong>${this.escapeHtml(h.excerpt.match)}</strong>${this.escapeHtml(h.excerpt.post)}`;
			btn.addEventListener("click", () => {
				if (this.foliateView) {
					void this.foliateView.goTo(h.cfi);
				}
			});
		}
	}

	private escapeHtml(text: string): string {
		return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}
}

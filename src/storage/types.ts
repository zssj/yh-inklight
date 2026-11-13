/**
 * [INPUT]: 依赖 Obsidian 插件设置与 sidecar JSON 存储协议的领域约束
 * [OUTPUT]: 对外提供 Markdown/PDF 注释、高亮、锚点、响应式阅读设置、索引与存储文档类型
 * [POS]: storage 模块的类型真相源，被 editor、views、anchor、settings 和 store 共享
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

export const ANNOTATION_COLORS = [
  "yellow",
  "green",
  "blue",
  "pink",
  "orange",
  "purple",
] as const;

export const COLOR_LABELS: Record<AnnotationColor, string> = {
  yellow: "黄色",
  green: "绿色",
  blue: "蓝色",
  pink: "粉色",
  orange: "橙色",
  purple: "紫色",
};

export type AnnotationColor = (typeof ANNOTATION_COLORS)[number];
export type SidebarSide = "left" | "right";
export type AnnotationSortMode = "newest" | "oldest" | "document";
export type AnnotationExportFormat = "summary" | "by-color" | "notes-only" | "reading-notes";

/** 笔记类型。Markdown/PDF 存 PascalCase，EPUB 存 camelCase，读取时统一走 NOTE_TYPE_LABELS */
export type NoteTypeKey = "insight" | "question" | "reminder";

/** 类型展示文案的唯一真相源；键同时接受 camelCase 与 PascalCase */
export const NOTE_TYPE_LABELS: Record<string, string> = {
  insight: "洞见",
  question: "疑问",
  reminder: "提醒",
  Insight: "洞见",
  Question: "疑问",
  Reminder: "提醒",
};

/** 带图标版本，用于下拉选项与卡片角标 */
export const NOTE_TYPE_LABELS_WITH_ICON: Record<string, string> = {
  insight: "💡 洞见",
  question: "❓ 疑问",
  reminder: "🔔 提醒",
  Insight: "💡 洞见",
  Question: "❓ 疑问",
  Reminder: "🔔 提醒",
};

/** 把任意写法的笔记类型转成小写键；未知值返回 undefined */
export function toNoteTypeKey(raw: string | null | undefined): NoteTypeKey | undefined {
  if (!raw) {
    return undefined;
  }
  const lower = raw.toLowerCase();
  return lower === "insight" || lower === "question" || lower === "reminder" ? lower : undefined;
}

export interface TextAnchor {
  startOffset: number;
  endOffset: number;
  selectedText: string;
  prefix: string;
  suffix: string;
  isCode?: boolean;
}

export interface LocatedAnchor {
  anchor: TextAnchor;
  orphaned: boolean;
  confidence: number;
}

export interface HighlightAnnotation {
  id: string;
  color: AnnotationColor;
  anchor: TextAnchor;
  createdAt: string;
  orphaned?: boolean;
  /** 自由标签；空数组在序列化时被清成 undefined，与老数据完全一致 */
  tags?: string[];
}

export interface PdfRectAnchor {
  pageNumber: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PdfAnchor {
  pageNumber: number;
  selectedText: string;
  rects: PdfRectAnchor[];
}

export interface PdfHighlightAnnotation {
  id: string;
  color: AnnotationColor;
  anchor: PdfAnchor;
  createdAt: string;
  orphaned?: boolean;
  /** 自由标签；空数组在序列化时被清成 undefined */
  tags?: string[];
}

export interface ReplyAnnotation {
  id: string;
  content: string;
  createdAt: string;
}

export interface StickyPosition {
  offsetX: number;
  offsetY: number;
}

export interface CommentAnnotation {
  id: string;
  highlightId?: string;
  anchor: TextAnchor;
  title?: string;
  content: string;
  color: AnnotationColor;
  position: StickyPosition;
  collapsed: boolean;
  author: string;
  createdAt: string;
  updatedAt: string;
  replies: ReplyAnnotation[];
  resolved: boolean;
  orphaned?: boolean;
  /** 自由标签；空数组在序列化时被清成 undefined */
  tags?: string[];
}

export interface PdfCommentAnnotation {
  id: string;
  highlightId?: string;
  anchor: PdfAnchor;
  title?: string;
  content: string;
  color: AnnotationColor;
  position: StickyPosition;
  collapsed: boolean;
  author: string;
  createdAt: string;
  updatedAt: string;
  replies: ReplyAnnotation[];
  resolved: boolean;
  orphaned?: boolean;
  /** 自由标签；空数组在序列化时被清成 undefined */
  tags?: string[];
}

export interface FileAnnotationDocument {
  filePath: string;
  fileHash: string;
  lastModified: string;
  highlights: HighlightAnnotation[];
  comments: CommentAnnotation[];
  pdfHighlights: PdfHighlightAnnotation[];
  pdfComments: PdfCommentAnnotation[];
  epubHighlights: EpubHighlightAnnotation[];
  epubComments: EpubCommentAnnotation[];
  epubProgress?: EpubReadingProgress;
  pdfProgress?: PdfReadingProgress;
  bookmarks: ReadingBookmark[];
  canvasBinding?: CanvasBinding;
  canvasNodes: CanvasExcerptNode[];
}

export interface AnnotationIndexEntry {
  filePath: string;
  sidecarPath: string;
  fileHash: string;
  highlightCount: number;
  commentCount: number;
  epubHighlightCount: number;
  epubCommentCount: number;
  bookmarkCount: number;
  updatedAt: string;
  /** 该文件内出现过的标签比较键（小写、去重、已排序）；无标签时省略该字段 */
  tags?: string[];
}

export interface AnnotationIndex {
  /** 1 = 无标签索引；2 = 含 files[].tags 与 tagNames */
  version: number;
  files: Record<string, AnnotationIndexEntry>;
  /** 标签比较键 → 展示名（保留用户最初写法的那个） */
  tagNames?: Record<string, string>;
}

export interface AnnotationPluginSettings {
  defaultHighlightColor: AnnotationColor;
  stickyWidth: number;
  stickySide: SidebarSide;
  stickyCollapseWidth: number;
  showLeaderLines: boolean;
  defaultAuthor: string;
  migrateOnRename: boolean;
  stickyNotesVisible: boolean;
  // --- EPUB 阅读 ---
  epubDefaultFlow: EpubFlowMode;
  /** 翻页模式下的 300ms 滑动过渡（foliate 的 animated 属性），滚动模式不受影响 */
  epubPageAnimation: boolean;
  /** 点击书页如何翻页：关闭 / 单击分区 / 单击一律后翻 / 双击后翻（见 EpubTapMode） */
  epubTapMode: EpubTapMode;
  epubFontSize: number;
  epubLineHeight: number;
  epubUnifyBodyFontSize: boolean;
  /** EPUB 正文字体："" | "obsidian" | 通用族关键字 | 字体名（见 EpubFontCatalog） */
  epubFontFamily: string;
  /** 手填的 EPUB 正文字体名，非空时覆盖 epubFontFamily */
  epubFontFamilyCustom: string;
  epubReadingTheme: EpubReadingTheme;
  epubHighlightStyle: EpubHighlightStyle;
  epubBookshelfSort: EpubBookshelfSortMode;
  // --- PDF 增强 ---
  pdfProgressTracking: boolean;
  // --- Markdown 打开统计（数据存于独立 sidecar，见 main.ts）---
  mdOpenTracking: boolean;
  // --- EPUB 手机端沉浸式导航栏 ---
  epubHideMobileNavbar: boolean;
  /** EPUB 底部进度条与安卓系统导航条的间距（px），遮挡时调大 */
  epubMobileBottomInset: number;
  // --- EPUB 标注锁定 ---
  annotationLocked: boolean;
  // --- AI 助手（OpenAI 兼容接口，见 ai/EpubAiClient）---
  /** 服务商预设 id，仅用于回填下拉；实际请求只看下面的 baseUrl/model */
  aiProvider: string;
  aiBaseUrl: string;
  /** API Key 明文存于本机 data.json */
  aiApiKey: string;
  aiModel: string;
  /** 单次回复的输出 token 上限 */
  aiMaxTokens: number;
  aiTemperature: number;
  /** 附加系统提示词，追加在内置动作提示词之后；留空则只用内置 */
  aiSystemPrompt: string;
}

export interface SelectionSnapshot {
  filePath: string;
  startOffset: number;
  endOffset: number;
  selectedText: string;
}

/** Markdown 打开次数统计（key = vault 路径，存于插件 data.json） */
export interface MdOpenStat {
  openCount: number;
  lastOpenedAt: string;
}

export const DEFAULT_SETTINGS: AnnotationPluginSettings = {
  defaultHighlightColor: "yellow",
  stickyWidth: 280,
  stickySide: "right",
  stickyCollapseWidth: 800,
  showLeaderLines: true,
  defaultAuthor: "读者",
  migrateOnRename: true,
  stickyNotesVisible: true,
  // EPUB
  epubDefaultFlow: "scrolled",
  epubPageAnimation: true,
  epubTapMode: "single-zone",
  epubFontSize: 16,
  epubLineHeight: 1.72,
  epubUnifyBodyFontSize: false,
  epubFontFamily: "",
  epubFontFamilyCustom: "",
  epubReadingTheme: "obsidian",
  epubHighlightStyle: "fill",
  epubBookshelfSort: "name",
  // PDF 增强
  pdfProgressTracking: true,
  // Markdown 打开统计
  mdOpenTracking: true,
  // EPUB 手机端沉浸式导航栏
  epubHideMobileNavbar: true,
  epubMobileBottomInset: 32,
  // EPUB 标注锁定
  annotationLocked: false,
  // AI 助手
  aiProvider: "mimo",
  aiBaseUrl: "https://api.xiaomimimo.com/v1",
  aiApiKey: "",
  aiModel: "mimo-v2.6-flash",
    aiMaxTokens: 1024,
  aiTemperature: 0.4,
  aiSystemPrompt: "",
};

export const EMPTY_INDEX: AnnotationIndex = {
  version: 2,
  files: {},
  tagNames: {},
};

// ===== EPUB / 电子书锚点与标注 =====

export interface EpubCfiAnchor {
  cfiRange: string;
  chapter: string;
  selectedText: string;
}

export type EpubHighlightStyle = "fill" | "underline" | "wavy";

export interface EpubHighlightAnnotation {
  id: string;
  type: "epub-highlight";
  color: AnnotationColor;
  style: EpubHighlightStyle;
  anchor: EpubCfiAnchor;
  createdAt: string;
  orphaned?: boolean;
  /** 自由标签；空数组在序列化时被清成 undefined */
  tags?: string[];
}

export interface EpubCommentAnnotation {
  id: string;
  type: "epub-comment";
  color: AnnotationColor;
  style: EpubHighlightStyle;
  anchor: EpubCfiAnchor;
  note: string;
  noteType?: "insight" | "question" | "reminder";
  createdAt: string;
  collapsed: boolean;
  author: string;
  updatedAt: string;
  replies: ReplyAnnotation[];
  resolved: boolean;
  orphaned?: boolean;
  /** 自由标签；空数组在序列化时被清成 undefined */
  tags?: string[];
}

export interface EpubReadingProgress {
  cfi: string;
  chapter: string;
  percent: number;
  lastRead: string;
  readingTimeSeconds: number;
  estimatedRemainingMinutes?: number;
  readCount: number;
  lastCompletedAt?: string;
  /**
   * 通读检查点位掩码：10/30/50/70/90/98 六个检查点各占一位，
   * 全满（含末位）且末位为新置时计一次 readCount。旧数据无此字段视为 0。
   */
  readCheckpoints?: number;
}

// ===== PDF 进度 =====

export interface PdfReadingProgress {
  pageNumber: number;
  totalPages: number;
  percent: number;
  lastRead: string;
}

// ===== 书签（EPUB/PDF 通用）=====

export interface ReadingBookmark {
  id: string;
  type: "epub-bookmark" | "pdf-bookmark";
  label: string;
  position: string;
  chapter?: string;
  createdAt: string;
  color?: AnnotationColor;
}

// ===== Canvas 集成 =====

export interface CanvasBinding {
  bookPath: string;
  canvasPath: string;
  autoCreate: boolean;
  layoutDirection: "horizontal" | "vertical";
}

export interface CanvasExcerptNode {
  annotationId: string;
  nodeId: string;
  position: { x: number; y: number };
}

// ===== EPUB 设置 =====

export type EpubReadingTheme = "obsidian" | "white" | "warm" | "green" | "sepia" | "dark";
export type EpubFlowMode = "paginated" | "scrolled";
/**
 * EPUB 点击翻页手势。四档互斥——单击与双击无法同时成立（双击 = 两次单击）。
 * - off：关闭
 * - single-zone：顶部 1/3 全宽下一页；其下左 1/3 上一页、右 1/3 下一页、中间不翻（默认）
 * - single-next：任意位置单击一律往后翻（不能用触摸往回翻）
 * - double：单击无效，双击往后翻
 */
export type EpubTapMode = "off" | "single-zone" | "single-next" | "double";
export type EpubBookshelfSortMode = "name" | "recent" | "progress" | "readCount";

export const EPUB_READING_THEMES: { id: EpubReadingTheme; label: string; background: string; text: string; swatch: string }[] = [
  { id: "obsidian", label: "跟随 Obsidian", background: "", text: "", swatch: "linear-gradient(135deg, #ffffff 50%, #1e1e1e 50%)" },
  { id: "white", label: "默认白", background: "#FFFFFF", text: "#333333", swatch: "#FFFFFF" },
  { id: "warm", label: "暖光", background: "#FAF9DE", text: "#333333", swatch: "#FAF9DE" },
  { id: "green", label: "护眼绿", background: "#E3EDCD", text: "#333333", swatch: "#E3EDCD" },
  { id: "sepia", label: "羊皮纸", background: "#F4ECD8", text: "#5C4B37", swatch: "#F4ECD8" },
  { id: "dark", label: "夜间", background: "#1C1C1E", text: "#A8A8A8", swatch: "#1C1C1E" },
];

export const EPUB_HIGHLIGHT_STYLES: { id: EpubHighlightStyle; label: string }[] = [
  { id: "fill", label: "填充" },
  { id: "underline", label: "下划线" },
  { id: "wavy", label: "波浪线" },
];

export const EPUB_COLOR_MAP: Record<AnnotationColor, string> = {
  yellow: "rgba(245, 197, 24, 0.38)",
  green: "rgba(82, 196, 26, 0.38)",
  blue: "rgba(22, 119, 255, 0.38)",
  pink: "rgba(255, 105, 180, 0.38)",
  orange: "rgba(255, 140, 0, 0.38)",
  purple: "rgba(114, 46, 209, 0.38)",
};

export const SUPPORTED_BOOK_EXTENSIONS = ["epub", "mobi", "azw3", "fb2", "fbz", "cbz", "txt"] as const;
export type BookFileExtension = (typeof SUPPORTED_BOOK_EXTENSIONS)[number];

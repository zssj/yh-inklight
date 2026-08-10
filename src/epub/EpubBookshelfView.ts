/**
 * [INPUT]: 依赖 Obsidian ItemView API 和 storage/annotationStore 的进度查询
 * [OUTPUT]: 提供 EpubBookshelfView，展示 vault 中所有电子书的进度
 * [POS]: EPUB 书架侧栏视图
 */

import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import { AnnotationStore } from "../storage/annotationStore";
import { EpubReadingProgress, SUPPORTED_BOOK_EXTENSIONS } from "../storage/types";

export const EPUB_BOOKSHELF_VIEW_TYPE = "inklight-epub-bookshelf";

type SortMode = "name" | "recent" | "progress" | "readCount";

const SORT_OPTIONS: Array<[SortMode, string]> = [
  ["name", "书名"],
  ["recent", "最近阅读"],
  ["progress", "阅读进度"],
  ["readCount", "已读遍数"],
];

interface BookshelfEntry {
  file: TFile;
  progress: EpubReadingProgress | null;
  lastReadTime: number;
}

/**
 * 解析 lastRead 时间戳。当前写入的是 ISO 8601（"2026-08-10T05:12:00.000Z"），
 * 但旧版本 sidecar 里可能是本地时间 "2026/7/18 0:30:26"，字符串比较会错乱，
 * 因此统一解析为数值时间戳再排序。
 */
function parseLastReadTime(value: string): number {
  if (!value) {
    return 0;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return Date.parse(value) || 0;
  }
  const legacy = /^(\d{4})\/(\d{1,2})\/(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(value);
  if (legacy) {
    return Date.UTC(
      Number(legacy[1]),
      Number(legacy[2]) - 1,
      Number(legacy[3]),
      Number(legacy[4]) || 0,
      Number(legacy[5]) || 0,
      legacy[6] ? Number(legacy[6]) : 0,
    );
  }
  return 0;
}

export class EpubBookshelfView extends ItemView {
  private store: AnnotationStore;
  private openCallback: (file: TFile) => void;
  private books: BookshelfEntry[] = [];
  private searchQuery = "";
  private sortMode: SortMode = "name";
  private headingEl!: HTMLElement;
  private listEl!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    store: AnnotationStore,
    onOpen: (file: TFile) => void,
  ) {
    super(leaf);
    this.store = store;
    this.openCallback = onOpen;
  }

  getViewType(): string {
    return EPUB_BOOKSHELF_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "EPUB 书架";
  }

  getIcon(): string {
    return "book-open";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  refresh(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("yh-epub-bookshelf-view");

    this.headingEl = container.createEl("h4", { cls: "bookshelf-heading" });

    const bookFiles = this.app.vault
      .getFiles()
      .filter((f) => (SUPPORTED_BOOK_EXTENSIONS as readonly string[]).includes(f.extension.toLowerCase()));

    if (bookFiles.length === 0) {
      this.headingEl.setText("📚 电子书书架");
      this.books = [];
      container.createEl("p", {
        cls: "bookshelf-empty",
        text: "Vault 中没有找到电子书文件。",
      });
      return;
    }

    this.buildControls(container);
    this.listEl = container.createDiv({ cls: "bookshelf-list" });

    // 并行加载所有电子书的 sidecar 数据（从磁盘读取，仅本次 render 加载一次）
    const docs = await Promise.all(bookFiles.map((f) => this.store.getDocument(f)));
    if (!container.isConnected) {
      return;
    }
    this.books = bookFiles.map((file, i) => ({
      file,
      progress: docs[i].epubProgress ?? null,
      lastReadTime: docs[i].epubProgress ? parseLastReadTime(docs[i].epubProgress!.lastRead) : 0,
    }));
    this.updateHeading();
    this.applyFilterAndSort();
  }

  private buildControls(container: HTMLElement): void {
    const controls = container.createDiv({ cls: "bookshelf-controls" });

    const searchInput = controls.createEl("input", {
      cls: "bookshelf-search",
      attr: { type: "text", placeholder: "搜索书名…", value: this.searchQuery },
    });
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value.trim().toLowerCase();
      this.updateHeading();
      this.applyFilterAndSort();
    });

    const sortSelect = controls.createEl("select", { cls: "bookshelf-sort" });
    for (const [value, label] of SORT_OPTIONS) {
      sortSelect.createEl("option", { text: label, value });
    }
    sortSelect.value = this.sortMode;
    sortSelect.addEventListener("change", () => {
      this.sortMode = sortSelect.value as SortMode;
      this.applyFilterAndSort();
    });
  }

  private updateHeading(): void {
    const total = this.books.length;
    const shown = this.getFiltered().length;
    this.headingEl.setText(
      this.searchQuery ? `📚 电子书书架 · 共 ${shown} / ${total} 本` : `📚 电子书书架 · 共 ${total} 本`,
    );
  }

  /** 按书名过滤（搜索词小写化后子串匹配），返回新数组。 */
  private getFiltered(): BookshelfEntry[] {
    if (!this.searchQuery) {
      return [...this.books];
    }
    return this.books.filter(({ file }) => file.basename.toLowerCase().includes(this.searchQuery));
  }

  private applyFilterAndSort(): void {
    if (!this.listEl) {
      return;
    }
    const filtered = this.getFiltered().sort(this.makeComparator());

    this.listEl.empty();
    if (filtered.length === 0) {
      this.listEl.createEl("p", {
        cls: "bookshelf-empty",
        text: "没有找到匹配的书名。",
      });
      return;
    }

    for (const entry of filtered) {
      this.renderItem(entry);
    }
  }

  private makeComparator(): (a: BookshelfEntry, b: BookshelfEntry) => number {
    const byName = (a: BookshelfEntry, b: BookshelfEntry) =>
      a.file.basename.localeCompare(b.file.basename, "zh-CN");
    switch (this.sortMode) {
      case "recent": {
        return (a, b) => (b.lastReadTime - a.lastReadTime) || byName(a, b);
      }
      case "progress": {
        return (a, b) => (b.progress?.percent ?? -1) - (a.progress?.percent ?? -1) || byName(a, b);
      }
      case "readCount": {
        return (a, b) => (b.progress?.readCount ?? 0) - (a.progress?.readCount ?? 0) || byName(a, b);
      }
      default:
        return byName;
    }
  }

  private renderItem(entry: BookshelfEntry): void {
    const { file, progress } = entry;
    const percent = progress ? Math.round(progress.percent * 100) : 0;

    const item = this.listEl.createDiv({ cls: "bookshelf-item" });

    const info = item.createDiv({ cls: "bookshelf-info" });
    info.createEl("div", { cls: "bookshelf-title", text: file.basename });
    info.createEl("div", {
      cls: "bookshelf-path",
      text: `${file.extension.toUpperCase()} · ${file.path}`,
    });

    const meta = item.createDiv({ cls: "bookshelf-meta" });

    // 进度条
    const progressBar = meta.createDiv({ cls: "bookshelf-progress-wrap" });
    const barOuter = progressBar.createDiv({ cls: "bookshelf-progress-bar" });
    const fill = barOuter.createDiv({ cls: "bookshelf-progress-fill" });
    fill.style.width = `${percent}%`;
    const readCount = progress?.readCount ?? 0;
    const readIdx = Math.min(readCount + 1, 6);
    const COLORS = ["", "#f5c518", "#4a9eff", "#4caf50", "#9c27b0", "#ff9800", "#e53935"];
    fill.classList.add(`read-${readIdx}`);
    fill.style.background = COLORS[readIdx];
    progressBar.createEl("span", {
      cls: "bookshelf-percent",
      text: `${percent}%`,
    });

    if (progress) {
      meta.createEl("div", {
        cls: "bookshelf-last-read",
        text: `上次阅读：${progress.chapter || "未知章节"} · ${progress.lastRead.slice(0, 10).trim()}`,
      });

      const readingSeconds = progress.readingTimeSeconds ?? 0;
      if (readingSeconds > 0) {
        meta.createEl("div", {
          cls: "bookshelf-reading-time",
          text: `已读 ${this.formatReadingTime(readingSeconds)}`,
        });
      }

      if (progress.estimatedRemainingMinutes != null && progress.estimatedRemainingMinutes > 0) {
        meta.createEl("div", {
          cls: "bookshelf-remaining",
          text: `剩余约 ${Math.ceil(progress.estimatedRemainingMinutes)} 分钟`,
        });
      }

      const cycle = readCount + 1;
      let readLabel = `第 ${cycle} 遍`;
      if (progress?.lastCompletedAt) {
        readLabel += ` · ${progress.lastCompletedAt.slice(0, 10)}`;
      }
      meta.createEl("div", {
        cls: "bookshelf-read-count",
        text: readLabel,
      });
    }

    item.addEventListener("click", () => {
      this.openCallback(file);
    });
  }

  private formatReadingTime(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const parts: string[] = [];
    if (hours > 0) {
      parts.push(`${hours}小时`);
    }
    if (minutes > 0 || hours > 0) {
      parts.push(`${minutes}分`);
    }
    parts.push(`${secs}秒`);
    return parts.join("");
  }
}

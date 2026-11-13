/**
 * [INPUT]: 依赖 Obsidian ItemView/Modal API、storage/types 的打开次数统计
 * [OUTPUT]: 提供 MarkdownStatsView，按打开次数展示全库 md 笔记，并在顶部按遗忘曲线提供 1 天 / 7 天 复习卡片（各 Top 5）
 * [POS]: Markdown 笔记使用统计侧栏视图
 */

import { App, ItemView, Modal, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { MdOpenStat } from "../storage/types";

export const MARKDOWN_STATS_VIEW_TYPE = "inklight-md-stats";

const DAY_MS = 86_400_000;
/** 每张复习卡片最多展示条数 */
export const REVIEW_LIMIT = 5;
/** 遗忘曲线检查点（自然日）：1 天 / 7 天 */
export const REVIEW_CHECKPOINTS = [1, 7] as const;

export interface StatsEntry {
  file: TFile;
  openCount: number;
  lastOpenedAt: number;
}

export interface ReviewEntry extends StatsEntry {
  /** 上次阅读距今的自然日数，精确等于某个检查点 */
  daysAgo: number;
}

export interface ReviewBucket {
  daysAgo: number;
  entries: ReviewEntry[];
}

/** 本地自然日差：今天零点 - 上次阅读零点；非法时间返回 NaN */
export function diffCalendarDays(now: number, then: number): number {
  const today = new Date(now);
  const past = new Date(then);
  if (Number.isNaN(today.getTime()) || Number.isNaN(past.getTime())) {
    return Number.NaN;
  }
  today.setHours(0, 0, 0, 0);
  past.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - past.getTime()) / DAY_MS);
}

/**
 * 按检查点分组：只收「恰好 1 天 / 恰好 7 天」读过的笔记，互斥且精确。
 * 桶内按打开次数降序、同次数按标题中文排序，各截断到 limit 条。
 */
export function computeReviewBuckets(
  entries: readonly StatsEntry[],
  now: number,
  checkpoints: readonly number[] = REVIEW_CHECKPOINTS,
  limit: number = REVIEW_LIMIT,
): ReviewBucket[] {
  const buckets: ReviewBucket[] = checkpoints.map((daysAgo) => ({ daysAgo, entries: [] }));
  const byDays = new Map<number, ReviewBucket>(buckets.map((bucket) => [bucket.daysAgo, bucket]));

  for (const entry of entries) {
    if (entry.openCount <= 0 || !(entry.lastOpenedAt > 0)) {
      continue;
    }
    const daysAgo = diffCalendarDays(now, entry.lastOpenedAt);
    const bucket = byDays.get(daysAgo);
    if (!bucket) {
      continue;
    }
    bucket.entries.push({ ...entry, daysAgo });
  }

  for (const bucket of buckets) {
    bucket.entries.sort(
      (a, b) =>
        b.openCount - a.openCount ||
        a.file.basename.localeCompare(b.file.basename, "zh-CN"),
    );
    if (bucket.entries.length > limit) {
      bucket.entries.length = limit;
    }
  }
  return buckets;
}

/** 删除确认弹窗 */
class ConfirmDeleteModal extends Modal {
  constructor(
    app: App,
    private readonly file: TFile,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "删除笔记" });
    contentEl.createEl("p", { text: `确定删除「${this.file.basename}」吗？将移入回收站，可在 vault 的 .trash 目录找回。` });
    const actions = contentEl.createDiv({ cls: "yh-md-stats-modal-actions" });
    actions.createEl("button", { cls: "mod-cta", text: "删除" }).addEventListener("click", () => {
      this.onConfirm();
      this.close();
    });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export interface MarkdownStatsViewOptions {
  /** 每次读取都取插件当前引用，避免清空统计后视图仍读旧对象 */
  getStats: () => Record<string, MdOpenStat>;
  isTrackingEnabled: () => boolean;
  onOpen?: (file: TFile) => void;
}

export class MarkdownStatsView extends ItemView {
  private readonly getStats: () => Record<string, MdOpenStat>;
  private readonly isTrackingEnabled: () => boolean;
  private readonly openCallback: ((file: TFile) => void) | null;
  private entries: StatsEntry[] = [];
  private ascending = true;
  private listEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, options: MarkdownStatsViewOptions) {
    super(leaf);
    this.getStats = options.getStats;
    this.isTrackingEnabled = options.isTrackingEnabled;
    this.openCallback = options.onOpen ?? null;
  }

  getViewType(): string {
    return MARKDOWN_STATS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "笔记使用统计";
  }

  getIcon(): string {
    return "bar-chart-3";
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
    const scrollTop = container.scrollTop;
    container.empty();
    container.addClass("yh-md-stats-view");

    const heading = container.createEl("h4", { cls: "md-stats-heading" });

    const files = this.app.vault.getMarkdownFiles();
    if (files.length === 0) {
      heading.setText("📊 笔记使用统计");
      container.createEl("p", { cls: "md-stats-empty", text: "Vault 中没有 Markdown 笔记。" });
      return;
    }

    const stats = this.getStats();
    this.entries = files.map((file) => {
      const stat: MdOpenStat | undefined = stats[file.path];
      return {
        file,
        openCount: stat?.openCount ?? 0,
        lastOpenedAt: stat ? Date.parse(stat.lastOpenedAt) || 0 : 0,
      };
    });

    const total = this.entries.length;
    const opened = this.entries.filter((e) => e.openCount > 0).length;
    heading.setText(`📊 笔记使用统计 · 共 ${total} 条 · 已打开 ${opened}`);

    this.buildControls(container);
    this.buildReviewSection(container);
    this.buildAllListHeader(container, total);
    this.listEl = container.createDiv({ cls: "md-stats-list" });
    this.applySort();

    container.scrollTop = scrollTop;
  }

  private buildControls(container: HTMLElement): void {
    const controls = container.createDiv({ cls: "md-stats-controls" });
    const toggleBtn = controls.createEl("button", {
      cls: "md-stats-sort-toggle",
      text: this.sortLabel(),
    });
    toggleBtn.addEventListener("click", () => {
      this.ascending = !this.ascending;
      toggleBtn.setText(this.sortLabel());
      this.applySort();
    });
  }

  private sortLabel(): string {
    return this.ascending ? "升序 ↑ · 从未打开在前" : "降序 ↓ · 打开最多在前";
  }

  private buildAllListHeader(container: HTMLElement, total: number): void {
    const head = container.createDiv({ cls: "md-stats-section-head md-stats-section-head-all" });
    head.createEl("div", { cls: "md-stats-section-title", text: "全部笔记" });
    head.createEl("div", { cls: "md-stats-section-hint", text: `${total} 条` });
  }

  /** 1 天 / 7 天复习卡：精确匹配自然日，空卡隐藏；两卡皆空时给一行提示 */
  private buildReviewSection(container: HTMLElement): void {
    const hasHistory = this.entries.some((entry) => entry.openCount > 0);
    if (!hasHistory) {
      return;
    }

    if (!this.isTrackingEnabled()) {
      container.createDiv({
        cls: "md-stats-review-empty",
        text: "打开次数统计已关闭，复习卡片暂不可用。",
      });
      return;
    }

    const buckets = computeReviewBuckets(this.entries, Date.now()).filter(
      (bucket) => bucket.entries.length > 0,
    );

    if (buckets.length === 0) {
      container.createDiv({
        cls: "md-stats-review-empty",
        text: "今天没有到期的复习笔记。",
      });
      return;
    }

    for (const bucket of buckets) {
      this.renderReviewCard(container, bucket);
    }
  }

  private renderReviewCard(container: HTMLElement, bucket: ReviewBucket): void {
    const section = container.createDiv({ cls: "md-stats-section md-stats-review" });
    const head = section.createDiv({ cls: "md-stats-section-head" });
    head.createEl("div", { cls: "md-stats-section-title", text: `${bucket.daysAgo} 天复习` });
    head.createEl("div", {
      cls: "md-stats-section-hint",
      text: bucket.daysAgo === 1 ? "昨天读过" : `${bucket.daysAgo} 天前读过`,
    });

    const list = section.createDiv({ cls: "md-stats-list md-stats-review-list" });
    for (const entry of bucket.entries) {
      this.renderItem(entry, list, entry.daysAgo);
    }
  }

  private applySort(): void {
    if (!this.listEl) {
      return;
    }
    this.entries.sort((a, b) => {
      const diff = a.openCount - b.openCount;
      if (diff !== 0) {
        return this.ascending ? diff : -diff;
      }
      return a.file.basename.localeCompare(b.file.basename, "zh-CN");
    });

    this.listEl.empty();
    for (const entry of this.entries) {
      this.renderItem(entry, this.listEl);
    }
  }

  private renderItem(entry: StatsEntry, target: HTMLElement, daysAgo?: number): void {
    const { file, openCount, lastOpenedAt } = entry;
    const isReview = daysAgo !== undefined;

    const item = target.createDiv({
      cls: isReview ? "md-stats-item md-stats-review-item" : "md-stats-item",
    });
    if (openCount === 0) {
      item.classList.add("md-stats-unopened");
    }

    const info = item.createDiv({ cls: "md-stats-info" });
    info.createEl("div", { cls: "md-stats-title", text: file.basename });

    const lastOpenLabel = lastOpenedAt > 0 ? new Date(lastOpenedAt).toLocaleDateString() : "";
    if (isReview) {
      info.createEl("div", {
        cls: "md-stats-path md-stats-review-meta",
        text: lastOpenLabel ? `上次 ${lastOpenLabel}` : "上次阅读时间未知",
      });
      item.title = file.path;
    } else {
      const recent = lastOpenLabel ? ` · 最近 ${lastOpenLabel}` : "";
      info.createEl("div", { cls: "md-stats-path", text: `${file.path}${recent}` });
      item.title = file.path;
    }

    item.createDiv({
      cls: `md-stats-badge${openCount > 0 ? " md-stats-badge-hot" : ""}`,
      text: `${openCount} 次`,
    });

    const delBtn = item.createEl("button", {
      cls: "md-stats-delete",
      attr: { "aria-label": "删除笔记" },
    });
    delBtn.setText("删除");
    delBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void this.confirmDelete(file);
    });

    item.addEventListener("click", () => {
      this.openCallback?.(file);
    });
  }

  private async confirmDelete(file: TFile): Promise<void> {
    new ConfirmDeleteModal(this.app, file, async () => {
      try {
        await this.app.vault.trash(file, false);
        new Notice(`已删除「${file.basename}」`);
        this.refresh();
      } catch (err) {
        new Notice(`删除失败：${String(err)}`);
      }
    }).open();
  }
}

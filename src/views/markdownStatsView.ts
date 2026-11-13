/**
 * [INPUT]: 依赖 Obsidian ItemView/Modal API、storage/types 的打开次数统计
 * [OUTPUT]: 提供 MarkdownStatsView，按打开次数展示全库 md 笔记，并在顶部提供 1 天/7 天/上月今日/去年今日 四张复习卡片（各 Top 5）
 * [POS]: Markdown 笔记使用统计侧栏视图
 */

import { App, ItemView, Modal, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { MdOpenStat } from "../storage/types";

export const MARKDOWN_STATS_VIEW_TYPE = "inklight-md-stats";

const DAY_MS = 86_400_000;
/** 每张复习卡片最多展示条数 */
export const REVIEW_LIMIT = 5;

/** 四类复习卡：两张间隔卡 + 两张日历追溯卡 */
export type ReviewKind = "day1" | "day7" | "lastMonth" | "lastYear";

interface ReviewRule {
  kind: ReviewKind;
  title: string;
  hint: string;
}

/** 渲染顺序即数组顺序 */
export const REVIEW_RULES: readonly ReviewRule[] = [
  { kind: "day1", title: "1 天复习", hint: "只读过 1 次" },
  { kind: "day7", title: "7 天复习", hint: "已复习过" },
  { kind: "lastMonth", title: "上月今日", hint: "上个月的同一天" },
  { kind: "lastYear", title: "去年今日", hint: "去年的同一天" },
];

export interface StatsEntry {
  file: TFile;
  openCount: number;
  lastOpenedAt: number;
}

export interface ReviewEntry extends StatsEntry {
  /** 上次阅读距今的自然日数 */
  daysAgo: number;
}

export interface ReviewBucket {
  kind: ReviewKind;
  title: string;
  hint: string;
  entries: ReviewEntry[];
}

interface Ymd {
  y: number;
  m: number;
  d: number;
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

/** 该年月日是否存在（用于排除 2/31、平年 2/29 这类溢出日期） */
function isValidYmd(y: number, m: number, d: number): boolean {
  const dt = new Date(y, m, d);
  return dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d;
}

/** 上个月的同一天；该日不存在（如 3/31 的上月今日）返回 null */
function lastMonthSameDay(now: Date): Ymd | null {
  const y = now.getFullYear();
  const m = now.getMonth();
  const prevY = m === 0 ? y - 1 : y;
  const prevM = m === 0 ? 11 : m - 1;
  const d = now.getDate();
  return isValidYmd(prevY, prevM, d) ? { y: prevY, m: prevM, d } : null;
}

/** 去年的同一天；闰日无对应（如平年无 2/29）返回 null */
function lastYearSameDay(now: Date): Ymd | null {
  const y = now.getFullYear() - 1;
  const m = now.getMonth();
  const d = now.getDate();
  return isValidYmd(y, m, d) ? { y, m, d } : null;
}

function isSameYmd(date: Date, target: Ymd): boolean {
  return date.getFullYear() === target.y && date.getMonth() === target.m && date.getDate() === target.d;
}

/**
 * 判定一条笔记归属哪张复习卡，互斥（最多命中一张）。
 * - 1 天卡：只读过 1 次，且自然日差恰好 1
 * - 7 天卡：读过 2 次及以上，且自然日差恰好 7
 * - 上月今日 / 去年今日：日历同号，不限打开次数
 */
export function classifyReview(
  entry: StatsEntry,
  now: Date,
): { kind: ReviewKind; daysAgo: number } | null {
  if (entry.openCount <= 0 || !(entry.lastOpenedAt > 0)) {
    return null;
  }
  const past = new Date(entry.lastOpenedAt);
  if (Number.isNaN(past.getTime())) {
    return null;
  }
  const daysAgo = diffCalendarDays(now.getTime(), entry.lastOpenedAt);
  if (!Number.isFinite(daysAgo) || daysAgo < 0) {
    return null;
  }

  if (entry.openCount === 1 && daysAgo === 1) {
    return { kind: "day1", daysAgo };
  }
  if (entry.openCount >= 2 && daysAgo === 7) {
    return { kind: "day7", daysAgo };
  }

  const lastMonth = lastMonthSameDay(now);
  if (lastMonth && isSameYmd(past, lastMonth)) {
    return { kind: "lastMonth", daysAgo };
  }

  const lastYear = lastYearSameDay(now);
  if (lastYear && isSameYmd(past, lastYear)) {
    return { kind: "lastYear", daysAgo };
  }

  return null;
}

/**
 * 按 REVIEW_RULES 顺序分组，丢弃空桶，每桶按打开次数降序截断到 limit。
 * 精确匹配下桶内日差相同，故另以标题做稳定次序。
 */
export function computeReviewBuckets(
  entries: readonly StatsEntry[],
  now: Date,
  limit: number = REVIEW_LIMIT,
): ReviewBucket[] {
  const grouped = new Map<ReviewKind, ReviewEntry[]>();
  for (const rule of REVIEW_RULES) {
    grouped.set(rule.kind, []);
  }

  for (const entry of entries) {
    const hit = classifyReview(entry, now);
    if (!hit) {
      continue;
    }
    const bucket = grouped.get(hit.kind);
    if (bucket) {
      bucket.push({ ...entry, daysAgo: hit.daysAgo });
    }
  }

  const result: ReviewBucket[] = [];
  for (const rule of REVIEW_RULES) {
    const list = grouped.get(rule.kind) ?? [];
    if (list.length === 0) {
      continue;
    }
    list.sort(
      (a, b) =>
        b.openCount - a.openCount ||
        a.file.basename.localeCompare(b.file.basename, "zh-CN"),
    );
    if (list.length > limit) {
      list.length = limit;
    }
    result.push({ kind: rule.kind, title: rule.title, hint: rule.hint, entries: list });
  }
  return result;
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
  onOpen?: (file: TFile, options?: { forceCount?: boolean }) => void;
}

export class MarkdownStatsView extends ItemView {
  private readonly getStats: () => Record<string, MdOpenStat>;
  private readonly isTrackingEnabled: () => boolean;
  private readonly openCallback: ((file: TFile, options?: { forceCount?: boolean }) => void) | null;
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

  /** 四张复习卡：严格「恰好」命中，空卡隐藏；四卡皆空时给一行提示 */
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

    const buckets = computeReviewBuckets(this.entries, new Date());

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
    head.createEl("div", { cls: "md-stats-section-title", text: bucket.title });
    head.createEl("div", { cls: "md-stats-section-hint", text: bucket.hint });

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

  private renderItem(entry: StatsEntry, target: HTMLElement, reviewDaysAgo?: number): void {
    const { file, openCount, lastOpenedAt } = entry;
    const isReview = reviewDaysAgo !== undefined;

    const item = target.createDiv({
      cls: isReview ? "md-stats-item md-stats-review-item" : "md-stats-item",
    });
    if (openCount === 0) {
      item.classList.add("md-stats-unopened");
    }

    const info = item.createDiv({ cls: "md-stats-info" });
    info.createEl("div", { cls: "md-stats-title", text: file.basename });
    item.title = file.path;

    const lastOpenLabel = lastOpenedAt > 0 ? new Date(lastOpenedAt).toLocaleDateString() : "";
    if (isReview) {
      const suffix = lastOpenLabel ? ` · 上次 ${lastOpenLabel}` : "";
      info.createEl("div", {
        cls: "md-stats-path md-stats-review-meta",
        text: `间隔 ${reviewDaysAgo} 天${suffix}`,
      });
    } else {
      const recent = lastOpenLabel ? ` · 最近 ${lastOpenLabel}` : "";
      info.createEl("div", { cls: "md-stats-path", text: `${file.path}${recent}` });
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
      // 复习卡点击：绕过 60s 冷却强制计数，否则条目不会移出卡片
      this.openCallback?.(file, isReview ? { forceCount: true } : undefined);
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

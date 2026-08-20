/**
 * [INPUT]: 依赖 Obsidian ItemView/Modal API 和 storage/types 的打开次数统计
 * [OUTPUT]: 提供 MarkdownStatsView，按打开次数展示全库 md 笔记，支持升/降序与删除
 * [POS]: Markdown 笔记使用统计侧栏视图
 */

import { App, ItemView, Modal, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { MdOpenStat } from "../storage/types";

export const MARKDOWN_STATS_VIEW_TYPE = "inklight-md-stats";

interface StatsEntry {
  file: TFile;
  openCount: number;
  lastOpenedAt: number;
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

export class MarkdownStatsView extends ItemView {
  private stats: Record<string, MdOpenStat>;
  private saveSettings: () => Promise<void>;
  private openCallback: (file: TFile) => void;
  private entries: StatsEntry[] = [];
  private ascending = true;
  private listEl!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    stats: Record<string, MdOpenStat>,
    saveSettings: () => Promise<void>,
    onOpen: (file: TFile) => void,
  ) {
    super(leaf);
    this.stats = stats;
    this.saveSettings = saveSettings;
    this.openCallback = onOpen;
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
    container.empty();
    container.addClass("yh-md-stats-view");

    const heading = container.createEl("h4", { cls: "md-stats-heading" });

    const files = this.app.vault.getMarkdownFiles();
    if (files.length === 0) {
      heading.setText("📊 笔记使用统计");
      container.createEl("p", { cls: "md-stats-empty", text: "Vault 中没有 Markdown 笔记。" });
      return;
    }

    this.buildControls(container);
    this.listEl = container.createDiv({ cls: "md-stats-list" });

    this.entries = files.map((file) => {
      const stat: MdOpenStat | undefined = this.stats[file.path];
      return {
        file,
        openCount: stat?.openCount ?? 0,
        lastOpenedAt: stat ? Date.parse(stat.lastOpenedAt) || 0 : 0,
      };
    });

    const total = this.entries.length;
    const opened = this.entries.filter((e) => e.openCount > 0).length;
    heading.setText(`📊 笔记使用统计 · 共 ${total} 条 · 已打开 ${opened}`);
    this.applySort();
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
      this.renderItem(entry);
    }
  }

  private renderItem(entry: StatsEntry): void {
    const { file, openCount, lastOpenedAt } = entry;

    const item = this.listEl.createDiv({ cls: "md-stats-item" });
    if (openCount === 0) {
      item.classList.add("md-stats-unopened");
    }

    const info = item.createDiv({ cls: "md-stats-info" });
    info.createEl("div", { cls: "md-stats-title", text: file.basename });
    const lastOpen = lastOpenedAt > 0 ? ` · 最近 ${new Date(lastOpenedAt).toLocaleDateString()}` : "";
    info.createEl("div", { cls: "md-stats-path", text: `${file.path}${lastOpen}` });

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
      this.openCallback(file);
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
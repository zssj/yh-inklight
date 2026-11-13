/**
 * [INPUT]: storage/types 的颜色类型、storage/tags 的归一化、views/tagInput 的 chip/输入组件、
 *          EpubPopoverPlacement 的定位算法、EpubReaderView 传入的选区矩形与回调
 * [OUTPUT]: EpubAnnotationCard —— 点击 EPUB 高亮后弹出的标注详情浮层
 * [POS]: EPUB 标注详情 UI；展示原文/想法/标签，提供「添加笔记 / 添加标签 / 删除」，
 *        并按选区矩形定位，避开划线文本、工具栏与屏幕边界
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { AnnotationColor, COLOR_LABELS, EPUB_COLOR_MAP } from "../storage/types";
import { normalizeTags } from "../storage/tags";
import { renderTagChips, renderTagInput, TagInputHandle, TagSuggestion } from "../views/tagInput";
import { computePopoverPlacement, EpubRect } from "./EpubPopoverPlacement";

const NOTE_TYPE_LABELS: Record<string, string> = {
  insight: "💡 洞见",
  question: "❓ 疑问",
  reminder: "🔔 提醒",
};

export interface EpubAnnotationCardData {
  quote: string;
  note?: string;
  noteType?: "insight" | "question" | "reminder";
  /** 已落盘的标签；卡片内编辑后由 onTagsChange 回写 */
  tags: readonly string[];
  color: AnnotationColor;
  chapter?: string;
  createdAt?: string;
  hasNote: boolean;
}

export interface EpubAnnotationCardOptions {
  onEdit?: () => void;
  onAddNote?: () => void;
  onDelete?: () => void;
  onDismiss?: () => void;
  /** 标签与标注的关联入口：由视图按 annotationId 持久化，失败时抛错以保留编辑态 */
  onTagsChange?: (tags: string[]) => Promise<void> | void;
  /** 标签补全候选（已有标签 ∪ 概念页名等），由视图注入 */
  tagSuggestions?: () => readonly TagSuggestion[];
}

export interface EpubAnnotationCardAnchor {
  /** 划线/选区在视口坐标下的外接矩形（多行取并集），定位时整块避开 */
  avoid: EpubRect;
  /** 可用区域：视口 ∩ 阅读区 − 安全区；不传时退化为视口 */
  bounds?: EpubRect;
  isMobile?: boolean;
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

/**
 * 点击 EPUB 高亮后弹出的标注详情卡片。
 * 桌面端按选区四侧择优定位，移动端为底部弹出卡片（跟随软键盘上移）。
 */
export class EpubAnnotationCard {
  private readonly el: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly tagsRowEl: HTMLElement;
  private readonly emptyHintEl: HTMLElement;
  private readonly data: EpubAnnotationCardData;
  private readonly options: EpubAnnotationCardOptions;

  // 视图状态一律存类字段，任何重绘都不丢编辑态
  private savedTags: string[];
  private draftTags: string[];
  private tagQuery = "";
  private tagEditing = false;
  private saving = false;
  private dismissPending = false;
  private dismissed = false;
  private tagInput: TagInputHandle | null = null;
  private anchor: EpubAnnotationCardAnchor | null = null;

  private outsideHandler: ((ev: PointerEvent) => void) | null = null;
  private keydownHandler: ((ev: KeyboardEvent) => void) | null = null;
  private rafId = 0;
  private readonly handleViewportChange = (): void => this.schedulePlace();

  constructor(data: EpubAnnotationCardData, options: EpubAnnotationCardOptions = {}) {
    this.options = options;
    this.data = data;
    this.savedTags = normalizeTags(data.tags);
    this.draftTags = [...this.savedTags];

    this.el = document.body.createDiv({ cls: "yh-epub-annotation-popover" });
    const accent = this.el.createDiv({ cls: "yh-epub-card-accent" });
    accent.style.background = EPUB_COLOR_MAP[data.color];

    this.bodyEl = this.el.createDiv({ cls: "yh-epub-card-body" });
    this.buildHeader();
    this.bodyEl.createDiv({ cls: "yh-epub-card-quote", text: data.quote });

    if (data.hasNote && data.note) {
      this.bodyEl.createDiv({ cls: "yh-epub-card-note", text: data.note });
      this.emptyHintEl = this.bodyEl.createDiv({ cls: "yh-hidden" });
    } else {
      this.bodyEl.createDiv({ cls: "yh-hidden" });
      this.emptyHintEl = this.bodyEl.createDiv({ cls: "yh-epub-card-note is-empty", text: "此高亮暂无笔记" });
    }

    this.tagsRowEl = this.bodyEl.createDiv({ cls: "yh-epub-card-tags" });
    this.bodyEl.createDiv({ cls: "yh-epub-card-meta", text: this.buildMeta() });
    this.renderTagRow();
    this.buildActions();
  }

  private buildHeader(): void {
    const top = this.bodyEl.createDiv({ cls: "yh-epub-card-top" });
    const badgeText =
      this.data.noteType && NOTE_TYPE_LABELS[this.data.noteType] ? NOTE_TYPE_LABELS[this.data.noteType] : "📝 画线";
    top.createSpan({ cls: "yh-epub-card-badge", text: badgeText });
    top.createSpan({ cls: "yh-epub-card-color-label", text: COLOR_LABELS[this.data.color] });
    const closeBtn = top.createEl("button", {
      cls: "yh-epub-card-close",
      attr: { type: "button", title: "关闭", "aria-label": "关闭" },
      text: "✕",
    });
    closeBtn.addEventListener("click", () => this.requestDismiss());
  }

  private buildMeta(): string {
    const parts: string[] = [];
    if (this.data.chapter) parts.push(this.data.chapter);
    if (this.data.createdAt) parts.push(this.formatDate(this.data.createdAt));
    return parts.join(" · ");
  }

  private buildActions(): void {
    const actions = this.bodyEl.createDiv({ cls: "yh-epub-card-actions" });

    const primary = actions.createEl("button", {
      cls: "yh-epub-card-btn is-edit",
      attr: { type: "button" },
      text: this.data.hasNote ? "编辑" : "添加笔记",
    });
    primary.addEventListener("click", () => {
      this.runAfterCommit(() => {
        if (this.data.hasNote) this.options.onEdit?.();
        else this.options.onAddNote?.();
      });
    });

    const tagBtn = actions.createEl("button", {
      cls: "yh-epub-card-btn is-tag",
      attr: { type: "button", title: "给这条标注添加或编辑标签" },
      text: "添加标签",
    });
    tagBtn.addEventListener("click", () => this.enterTagEditing());

    const delBtn = actions.createEl("button", {
      cls: "yh-epub-card-btn is-delete",
      attr: { type: "button" },
      text: "删除",
    });
    delBtn.addEventListener("click", () => {
      this.runAfterCommit(() => this.options.onDelete?.());
    });
  }

  /** 「添加笔记 / 删除」等跳转动作：先落盘正在编辑的标签，失败就留在卡片里 */
  private runAfterCommit(action: () => void): void {
    if (!this.tagEditing) {
      this.dismiss();
      action();
      return;
    }
    void this.commitTagEditing().then((ok) => {
      if (!ok) return;
      this.dismiss();
      action();
    });
  }

  /** 标签行：只读 chip ↔ 内联编辑器，两态都由类字段驱动，可反复重绘 */
  private renderTagRow(): void {
    this.tagsRowEl.empty();
    this.tagInput = null;
    this.emptyHintEl.toggleClass("yh-hidden", this.savedTags.length > 0);

    if (!this.tagEditing) {
      if (this.savedTags.length === 0) return;
      this.tagsRowEl.createSpan({ cls: "yh-epub-card-tags-label", text: "标签" });
      renderTagChips(this.tagsRowEl, this.savedTags, {
        max: 6,
        onChipClick: () => this.enterTagEditing(),
        onOverflowClick: () => this.enterTagEditing(),
      });
      return;
    }

    const editor = this.tagsRowEl.createDiv({ cls: "yh-epub-card-tag-editor" });
    editor.createSpan({ cls: "yh-epub-card-tags-label", text: "标签" });
    const field = editor.createDiv({ cls: "yh-epub-card-tag-field" });
    this.tagInput = renderTagInput(field, {
      tags: this.draftTags,
      suggestions: this.options.tagSuggestions?.() ?? [],
      initialQuery: this.tagQuery,
      placeholder: "输入标签，回车确认",
      showSuggestionsOnOpen: true,
      onQueryChange: (value) => {
        this.tagQuery = value;
      },
      onChange: (tags) => {
        this.draftTags = tags;
      },
    });

    const buttons = editor.createDiv({ cls: "yh-epub-card-tag-actions" });
    const cancel = buttons.createEl("button", {
      cls: "yh-epub-card-btn",
      attr: { type: "button" },
      text: "取消",
    });
    const done = buttons.createEl("button", {
      cls: "yh-epub-card-btn is-primary",
      attr: { type: "button" },
      text: "完成",
    });
    cancel.addEventListener("click", () => this.cancelTagEditing());
    done.addEventListener("click", () => void this.commitTagEditing());
    this.tagInput.focus();
  }

  private enterTagEditing(): void {
    if (this.tagEditing || this.dismissed) return;
    this.draftTags = [...this.savedTags];
    this.tagQuery = "";
    this.tagEditing = true;
    this.renderTagRow();
    this.schedulePlace();
  }

  private cancelTagEditing(): void {
    this.tagEditing = false;
    this.draftTags = [...this.savedTags];
    this.tagQuery = "";
    this.renderTagRow();
    this.schedulePlace();
  }

  /** 提交标签；返回是否已收起编辑态。保存失败保留编辑态与草稿，绝不静默吞掉用户输入 */
  private async commitTagEditing(): Promise<boolean> {
    if (!this.tagEditing || this.saving) return false;
    this.tagInput?.flush(); // 兜住输入框里未回车的文本
    const next = normalizeTags(this.draftTags);
    if (!this.options.onTagsChange || sameTags(next, this.savedTags)) {
      this.savedTags = next;
      this.draftTags = [...next];
      this.tagEditing = false;
      this.renderTagRow();
      this.schedulePlace();
      return true;
    }

    this.saving = true;
    try {
      await this.options.onTagsChange(next);
      this.savedTags = next;
      this.draftTags = [...next];
      this.tagEditing = false;
      this.renderTagRow();
      return true;
    } catch {
      // 视图侧已给出 Notice；这里保持编辑态，草稿不回滚
      return false;
    } finally {
      this.saving = false;
      this.schedulePlace();
    }
  }

  /** 关闭前先把正在编辑的标签落盘；失败则留在编辑态，不吞输入 */
  private requestDismiss(): void {
    if (this.dismissed || this.dismissPending) return;
    if (!this.tagEditing) {
      this.dismiss();
      return;
    }
    this.dismissPending = true;
    void this.commitTagEditing().then((ok) => {
      if (ok) this.dismiss();
      else this.dismissPending = false;
    });
  }

  show(anchor: EpubAnnotationCardAnchor): void {
    this.anchor = anchor;
    if (anchor.isMobile) {
      this.el.addClass("is-mobile");
    }
    document.body.appendChild(this.el);
    this.place();
    this.registerListeners();
  }

  /** 实测尺寸后再定位，不用估算高度；视口/软键盘变化会重新计算 */
  private place(): void {
    if (this.dismissed || !this.anchor) return;

    if (this.anchor.isMobile) {
      const vv = window.visualViewport;
      const keyboardInset = vv ? Math.max(0, window.innerHeight - vv.height - (vv.offsetTop ?? 0)) : 0;
      // 键盘弹出时可视区底边就是键盘顶；导航栏若被键盘盖住则不重复扣减
      const visualBottom = window.innerHeight - keyboardInset;
      const bottomInset = Math.min(
        window.innerHeight,
        keyboardInset + this.measureMobileBarInset(visualBottom),
      );
      this.el.style.bottom = `${bottomInset}px`;
      const available = Math.max(160, window.innerHeight - bottomInset - 12);
      this.el.style.maxHeight = `min(70vh, ${available}px)`;
      return;
    }

    this.el.style.visibility = "hidden";
    this.el.style.maxHeight = "";
    this.el.style.width = "";
    const rect = this.el.getBoundingClientRect();
    const bounds: EpubRect = this.anchor.bounds ?? {
      left: 8,
      top: 8,
      right: window.innerWidth - 8,
      bottom: window.innerHeight - 8,
    };
    const placement = computePopoverPlacement(this.anchor.avoid, { width: rect.width, height: rect.height }, bounds);
    this.el.style.width = `${placement.width}px`;
    this.el.style.left = `${placement.left}px`;
    this.el.style.top = `${placement.top}px`;
    this.el.style.maxHeight = `${placement.maxHeight}px`;
    this.el.dataset.side = placement.side;
    this.el.style.visibility = "";
  }

  /**
   * 移动端底部固定栏（Obsidian 导航栏/工具栏）在可视区内实际占用的高度。
   *
   * 只认「压在可视区底部」的栏：沉浸式隐藏时导航栏被 translateY 推出屏外
   * （rect.top ≥ 可视区底边）或 pointer-events:none，此时返回 0，卡片照常贴底。
   */
  private measureMobileBarInset(visualBottom: number): number {
    let inset = 0;
    document.querySelectorAll<HTMLElement>(".mobile-navbar, .mobile-toolbar").forEach((bar) => {
      const rect = bar.getBoundingClientRect();
      if (rect.height <= 0) return;
      const style = getComputedStyle(bar);
      if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") {
        return;
      }
      if (rect.top >= visualBottom - 1) return; // 已滑出可视区
      inset = Math.max(inset, visualBottom - Math.max(0, rect.top));
    });
    return Math.ceil(inset);
  }

  private schedulePlace(): void {
    if (this.rafId || this.dismissed) return;
    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = 0;
      this.place();
    });
  }

  private registerListeners(): void {
    // 延迟一个 tick 注册，避免「打开卡片的那一下 pointerdown」把自己关掉
    this.outsideHandler = (ev: PointerEvent) => {
      if (this.dismissed || this.dismissPending || !this.el.isConnected) return;
      if (ev.target instanceof Node && this.el.contains(ev.target)) return;
      this.requestDismiss();
    };
    window.setTimeout(() => {
      if (!this.dismissed && this.outsideHandler) {
        document.addEventListener("pointerdown", this.outsideHandler, true);
      }
    }, 0);

    this.keydownHandler = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      if (this.tagEditing) this.cancelTagEditing();
      else this.requestDismiss();
    };
    document.addEventListener("keydown", this.keydownHandler, true);

    window.addEventListener("resize", this.handleViewportChange);
    window.visualViewport?.addEventListener("resize", this.handleViewportChange);
    window.visualViewport?.addEventListener("scroll", this.handleViewportChange);
  }

  dismiss(): void {
    if (this.dismissed) return;
    this.dismissed = true;
    if (this.outsideHandler) document.removeEventListener("pointerdown", this.outsideHandler, true);
    if (this.keydownHandler) document.removeEventListener("keydown", this.keydownHandler, true);
    window.removeEventListener("resize", this.handleViewportChange);
    window.visualViewport?.removeEventListener("resize", this.handleViewportChange);
    window.visualViewport?.removeEventListener("scroll", this.handleViewportChange);
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.el.remove();
    this.options.onDismiss?.();
  }

  private formatDate(iso: string): string {
    try {
      const d = new Date(iso);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch {
      return "";
    }
  }
}

/**
 * [INPUT]: cardModel 的 SidebarCard、views/cardBody 的唯一卡片渲染器、
 *          views/popoverPlacement 的定位算法、调用方传入的划线矩形与动作回调
 * [OUTPUT]: AnnotationCard —— Markdown / PDF / EPUB 三端「点击高亮 → 标注详情」浮层；
 *           本文件只负责浮层外壳（定位、点外关闭、Esc、移动端整屏留白居中），
 *           卡片内容与动作行一律由 views/cardBody 产出，与侧栏列表保持同一套 DOM
 * [POS]: views 模块唯一的标注详情浮层。三端只负责用 buildCards 取到卡片数据并给回调，
 *        不再各自映射字段——历史教训是两处映射会漂移（noteType 曾在浮层里丢过）
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { App, Component } from "obsidian";
import { AnnotationRelation } from "../storage/types";
import { SidebarCard } from "./cardModel";
import { CardExtraAction, renderCardBody } from "./cardBody";
import { RelatedBlockHost } from "./relatedBlock";
import { TagSuggestion } from "./tagInput";
import {
  computeMobileSheet,
  computePopoverPlacement,
  PopoverRect,
  readMobileSheetGutters,
  viewportRect,
} from "./popoverPlacement";

export interface AnnotationCardOptions {
  /** 来源行左侧的文件名；宿主已解析过 TFile，传入 basename 即可 */
  fileName: string;
  app?: App;
  component?: Component;
  onEdit?: () => void;
  onAddNote?: () => void;
  onDelete?: () => void;
  onOpenExport?: () => void;
  onAtomCard?: () => void;
  /** 标签落盘：失败时抛错，错误由宿主给 Notice */
  onTagsChange?: (tags: string[]) => Promise<void> | void;
  tagSuggestions?: () => readonly TagSuggestion[];
  /** 按需 AI 推荐：只有用户点标签下拉里的 AI 行才会调用 */
  onRequestAiTag?: (force: boolean) => Promise<readonly string[]>;
  onJumpRelation?: (relation: AnnotationRelation) => void;
  onRemoveRelation?: (relation: AnnotationRelation) => void;
  /** 字面相关区宿主：与侧栏同一份 DOM，命中/写入走插件单点 */
  related?: RelatedBlockHost;
  /** 容器专有按钮（Markdown 的「同段另有 N 条批注」） */
  extraActions?: readonly CardExtraAction[];
  onDismiss?: () => void;
}

export interface AnnotationCardAnchor {
  /**
   * 划线/选区在视口坐标下的外接矩形（多行取并集）。
   * 移动端只在「浮动卡片」不一致时作参考；当前 v0.19.10 的移动端定位与它无关，
   * 桌面端仍用它做四侧择优与覆盖判定。
   */
  avoid: PopoverRect;
  /** 可用区域：视口 ∩ 阅读区 − 安全区；不传时退化为视口 */
  bounds?: PopoverRect;
  isMobile?: boolean;
}

/**
 * 点击高亮后弹出的标注详情卡片，Markdown / PDF / EPUB 三端共用。
 * 内容、字段顺序、动作行与侧栏卡片完全一致（同一渲染器），差异只有外壳：
 * 桌面端按选区四侧择优定位，实在放不下才覆盖选区换完整高度；移动端按高亮重心
 * 决定顶/底对齐并压住高亮，四边留白（底 40px 避开手势区），键盘弹起时跟随上移；
 * 点卡片外即关闭。
 */
export class AnnotationCard {
  private readonly el: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly card: SidebarCard;
  private readonly options: AnnotationCardOptions;

  // 视图状态一律存类字段，任何重绘都不丢编辑态
  private tagEditing = false;
  private dismissed = false;
  private anchor: AnnotationCardAnchor | null = null;

  private outsideHandler: ((ev: PointerEvent) => void) | null = null;
  private keydownHandler: ((ev: KeyboardEvent) => void) | null = null;
  private rafId = 0;
  private readonly handleViewportChange = (): void => this.schedulePlace();

  constructor(card: SidebarCard, options: AnnotationCardOptions) {
    this.card = card;
    this.options = options;

    this.el = document.body.createDiv({ cls: "yh-annotation-card yh-epub-annotation-popover" });
    this.bodyEl = this.el.createDiv();
    this.renderBody();
  }

  private renderBody(): void {
    renderCardBody(this.bodyEl, this.card, {
      host: "popover",
      fileName: this.options.fileName,
      ...(this.options.app ? { app: this.options.app } : {}),
      ...(this.options.component ? { component: this.options.component } : {}),
      tags: {
        isTagEditing: () => this.tagEditing,
        onStartTagEdit: () => {
          this.tagEditing = true;
        },
        suggestions: () => this.options.tagSuggestions?.() ?? [],
        ...(this.options.onRequestAiTag ? { requestAi: this.options.onRequestAiTag } : {}),
        onChange: (tags) => this.options.onTagsChange?.(tags),
        // 浮层只有一条卡，没有「重绘重建」的场景：进编辑态就聚焦
        onEditorReady: (row) => {
          // 标签编辑器比 chip 行高，尺寸变了要重新量一次，否则会撑出 max-height
          this.schedulePlace();
          window.requestAnimationFrame(() => {
            row.querySelector<HTMLInputElement>(".yh-tag-input-field")?.focus();
            this.schedulePlace();
          });
        },
      },
      actions: {
        "open-export": this.wrap(this.options.onOpenExport),
        "atom-card": this.wrap(this.options.onAtomCard),
        "edit-note": this.card.note ? this.wrap(this.options.onEdit) : undefined,
        "add-note": this.card.note ? undefined : this.wrap(this.options.onAddNote),
        delete: this.wrap(this.options.onDelete),
      },
      ...(this.options.extraActions ? { extraActions: this.options.extraActions } : {}),
      // 浮层是游离节点，不会跟着侧栏整表重绘，写入后自己重画一次
      ...(this.options.related
        ? { related: { ...this.options.related, afterMutate: () => this.refreshBody() } }
        : {}),
      ...(this.options.onJumpRelation ? { onJumpRelation: this.options.onJumpRelation } : {}),
      ...(this.options.onRemoveRelation ? { onRemoveRelation: this.options.onRemoveRelation } : {}),
      onClose: () => this.dismiss(),
    });
  }

  /** 标签/关联写入落地后重画卡片：不改动定位，只重排内容 */
  private refreshBody(): void {
    if (this.dismissed) {
      return;
    }
    this.renderBody();
    this.schedulePlace();
  }

  /**
   * 浮层里的动作跳转前先收掉自己：编辑会开弹窗、删除会重绘阅读区，
   * 卡片留在原地会盖住刚打开的内容。
   */
  private wrap(action: (() => void) | undefined): (() => void) | undefined {
    if (!action) {
      return undefined;
    }
    return () => {
      this.dismiss();
      action();
    };
  }

  show(anchor: AnnotationCardAnchor): void {
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
      this.placeMobile();
      return;
    }

    this.el.style.visibility = "hidden";
    this.el.style.maxHeight = "";
    this.el.style.width = "";
    const rect = this.el.getBoundingClientRect();
    const bounds: PopoverRect = this.anchor.bounds ?? viewportRect();
    const placement = computePopoverPlacement(this.anchor.avoid, { width: rect.width, height: rect.height }, bounds);
    this.el.style.width = `${placement.width}px`;
    this.el.style.left = `${placement.left}px`;
    this.el.style.top = `${placement.top}px`;
    this.el.style.maxHeight = `${placement.maxHeight}px`;
    this.el.dataset.side = placement.side;
    this.el.style.visibility = "";
  }

  /**
   * 移动端定位：**固定占满屏幕，四边留白，不再按内容高度测量**。
   *
   * 演进：v0.19.8 之前贴屏幕底（留 10px），最后一行落在手势区点不中；
   * v0.19.8 贴着高亮且坚持不遮挡，单侧空间只有一小条，卡片被压成一条缝；
   * v0.19.9 允许压住高亮，但高度仍取 `min(自然高度, 可用高度)`——依赖一次 DOM 测量，
   * 而卡片里的想法是 Markdown 异步渲染的，show() 当场测量时内容还没落地，
   * 量出来的高度偏小，卡片就只剩一小块（v0.19.10 修的就是这个）。
   *
   * 现在：高度只由视口决定——左右各 20px、上下各 40px，中间全部给卡片。
   * 内容少时是一张大卡片，内容多时内部滚动；键盘弹起时边距收紧到 12px 贴住键盘上方。
   * 位置与高亮无关，固定可预期，不会「点不同高亮弹到不同地方」。
   */
  private placeMobile(): void {
    const el = this.el;
    const viewportH = window.innerHeight;
    const vv = window.visualViewport;
    const keyboardInset = vv ? Math.max(0, viewportH - vv.height - (vv.offsetTop ?? 0)) : 0;
    // 键盘弹出时可视区底边就是键盘顶；导航栏若被键盘盖住则不重复扣减
    const visualBottom = viewportH - keyboardInset;
    const bottomInset = Math.min(
      viewportH,
      keyboardInset + this.measureMobileBarInset(visualBottom),
    );

    const sheet = computeMobileSheet({
      viewportHeight: viewportH,
      visualOffsetTop: vv?.offsetTop ?? 0,
      bottomInset,
      compact: keyboardInset > 0,
      // 留白与安全区都来自样式/浏览器（--yh-sheet-gutter-* + env(safe-area-inset-*)），
      // 代码不假设任何机型；换手机、横竖屏、手势条高度都会自动跟着变
      gutters: readMobileSheetGutters(el),
    });

    el.style.top = `${sheet.top}px`;
    el.style.bottom = "auto";
    // 高度写死：卡片不会因内容异步渲染而忽大忽小，也不会溢出屏幕
    el.style.height = `${sheet.height}px`;
    el.style.maxHeight = `${sheet.height}px`;
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
      if (this.dismissed || !this.el.isConnected) return;
      if (ev.target instanceof Node && this.el.contains(ev.target)) return;
      this.dismiss();
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
      this.dismiss();
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
}

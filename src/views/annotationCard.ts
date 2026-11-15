/**
 * [INPUT]: cardModel 的 SidebarCard、views/cardBody 的唯一卡片渲染器、
 *          views/popoverPlacement 的定位算法、调用方传入的划线矩形与动作回调
 * [OUTPUT]: AnnotationCard —— Markdown / PDF / EPUB 三端「点击高亮 → 标注详情」浮层；
 *           本文件只负责浮层外壳（定位、点外关闭、Esc、移动端底部弹出），
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
import { computePopoverPlacement, PopoverRect, viewportRect } from "./popoverPlacement";

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
  onJumpRelation?: (relation: AnnotationRelation) => void;
  onRemoveRelation?: (relation: AnnotationRelation) => void;
  /** 字面相关区宿主：与侧栏同一份 DOM，命中/写入走插件单点 */
  related?: RelatedBlockHost;
  /** 容器专有按钮（Markdown 的「同段另有 N 条批注」） */
  extraActions?: readonly CardExtraAction[];
  onDismiss?: () => void;
}

/** 移动端浮层与屏幕边缘的间距：左右由 CSS 的同名变量控制，底部在这里加 */
const SHEET_GUTTER = 10;

export interface AnnotationCardAnchor {
  /** 划线/选区在视口坐标下的外接矩形（多行取并集），定位时整块避开 */
  avoid: PopoverRect;
  /** 可用区域：视口 ∩ 阅读区 − 安全区；不传时退化为视口 */
  bounds?: PopoverRect;
  isMobile?: boolean;
}

/**
 * 点击高亮后弹出的标注详情卡片，Markdown / PDF / EPUB 三端共用。
 * 内容、字段顺序、动作行与侧栏卡片完全一致（同一渲染器），差异只有外壳：
 * 桌面端按选区四侧择优定位，移动端为底部弹出卡片（跟随软键盘上移），点卡片外即关闭。
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
      const vv = window.visualViewport;
      const keyboardInset = vv ? Math.max(0, window.innerHeight - vv.height - (vv.offsetTop ?? 0)) : 0;
      // 键盘弹出时可视区底边就是键盘顶；导航栏若被键盘盖住则不重复扣减
      const visualBottom = window.innerHeight - keyboardInset;
      const bottomInset = Math.min(
        window.innerHeight,
        keyboardInset + this.measureMobileBarInset(visualBottom),
      );
      // 不贴屏幕底边：键盘/导航栏之外再让出一个间距，四边都不挨边
      this.el.style.bottom = `${bottomInset + SHEET_GUTTER}px`;
      const available = Math.max(160, window.innerHeight - bottomInset - SHEET_GUTTER * 2);
      this.el.style.maxHeight = `min(70vh, ${available}px)`;
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

/**
 * [INPUT]: 宿主给的锚点元素、views/popoverPlacement 的桌面定位纯函数、views/tagInput 的标签输入组件、Platform
 * [OUTPUT]: FloatingPanel（定位 / 点外关闭 / Esc / 键盘避让 / 视口重排 / 单例）、
 *           openTagEditorPanel（标签）、openNoteEditorPanel（想法）、dismissFloatingPanel 与 activeFloatingPanel
 * [POS]: views 模块所有「点卡片上的按钮唤起的编辑」的唯一宿主。
 *        铁律：面板挂在 document.body，**绝不进入 .yh-ov-list 的 DOM**——
 *        卡片高度因此不会因为开编辑器而变化（列表零抖动），整表重绘也删不掉输入框。
 *        历史上的抖动全部来自「把输入框塞进卡片文档流」：只读标签行 20px，换成输入框 + 候选列表
 *        立刻变成 200px，下面所有卡片必然位移；再叠上 content-visibility、延迟正文绘制、
 *        软键盘避让滚动，才需要一堆守卫去防「输入框被顶走 / 一闪就没」。换容器后这些问题一起消失。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { Platform } from "obsidian";
import { computePopoverPlacement, PopoverRect, viewportRect } from "./popoverPlacement";
import { renderTagInput, TagInputHandle, TagSuggestion } from "./tagInput";

/** 关闭原因：宿主据此决定要不要落盘（Esc 取消不 flush） */
export type PanelCloseReason = "outside" | "escape" | "anchor-gone" | "programmatic";

/** 面板与屏幕边缘的最小留白 */
const EDGE = 12;
/** 打开后这段时间内的 pointerdown 不判「点外面」：软键盘弹出时移动端 WebView 会补发一次 target=body 的 pointerdown */
const OPEN_GRACE_MS = 700;

/**
 * 可视视口矩形。键盘弹起时它比 window.innerHeight 矮（iOS 甚至不压缩 innerHeight，
 * 只平移 offsetTop），拿 layout 视口当可用区会把面板算到键盘后面去。
 */
function visualViewportRect(): PopoverRect {
  const vv = window.visualViewport;
  if (!vv) {
    return viewportRect();
  }
  return {
    left: vv.offsetLeft + EDGE,
    top: vv.offsetTop + EDGE,
    right: vv.offsetLeft + vv.width - EDGE,
    bottom: vv.offsetTop + vv.height - EDGE,
  };
}

export interface FloatingPanelOptions {
  /** 定位锚点：一般是「+」或动作按钮，面板贴着它出现 */
  anchor: HTMLElement;
  /** 桌面宽度；移动端固定为「视口宽 − 两侧留白」 */
  width: number;
  /** 额外类名，按内容微调内边距/宽度 */
  className?: string;
  /** 构建面板内容；返回「首帧回调」（通常是聚焦输入框） */
  build: (host: HTMLElement) => (() => void) | void;
  onClose?: (reason: PanelCloseReason) => void;
}

/**
 * 浮动编辑面板外壳。
 *
 * 桌面：贴着锚点四侧择优（复用 computePopoverPlacement），锚点被滚出视口即关闭。
 * 移动端：贴住「可视区底边 − 软键盘高度」的底部卡片，宽度吃满视口减留白。
 * 两种情况都只动自己的位置，**不碰列表的内边距、不调用 scrollIntoView**，
 * 所以背后的列表不会因为「开个编辑器」而位移或滚动。
 */
export class FloatingPanel {
  readonly el: HTMLElement;

  private readonly options: FloatingPanelOptions;
  private closed = false;
  private openedAt = 0;
  private rafId = 0;
  private resizeObserver: ResizeObserver | null = null;
  private outsideHandler: ((event: PointerEvent) => void) | null = null;
  private keydownHandler: ((event: KeyboardEvent) => void) | null = null;
  private readonly handleViewportChange = (event?: Event): void => {
    // 面板自己的内部滚动不改变它相对锚点的位置，重排一次纯属浪费
    if (event?.target instanceof Node && this.el.contains(event.target)) {
      return;
    }
    this.schedulePlace();
  };

  constructor(options: FloatingPanelOptions) {
    this.options = options;
    this.el = document.body.createDiv({ cls: `yh-float-panel ${options.className ?? ""}`.trim() });
  }

  isOpen(): boolean {
    return !this.closed;
  }

  open(): void {
    this.openedAt = Date.now();
    if (Platform.isMobile) {
      this.el.addClass("is-mobile");
    }
    const mount = this.options.build(this.el);
    this.place();
    // place() 在桌面端发现锚点已滚出视口时会直接收掉自己：此时不能再挂监听，
    // 否则一个已移除的面板会留着 document 上的 keydown/pointerdown，抢在真正打开的面板前面 preventDefault
    if (this.closed) {
      return;
    }
    this.el.addClass("is-visible");
    this.watchLayout();
    this.listenOutside();
    // 聚焦必须等面板完成首次布局：先 focus 再定位会让移动端输入法在错误的位置弹起
    window.requestAnimationFrame(() => {
      if (!this.closed) {
        mount?.();
      }
    });
  }

  dismiss(reason: PanelCloseReason = "programmatic"): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unwatchLayout();
    if (this.outsideHandler) {
      document.removeEventListener("pointerdown", this.outsideHandler, true);
      this.outsideHandler = null;
    }
    if (this.keydownHandler) {
      document.removeEventListener("keydown", this.keydownHandler, true);
      this.keydownHandler = null;
    }
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.el.remove();
    this.options.onClose?.(reason);
  }

  // ---- 定位 ----

  private schedulePlace(): void {
    if (this.closed || this.rafId) {
      return;
    }
    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = 0;
      this.place();
    });
  }

  private place(): void {
    if (this.closed || !this.el.isConnected) {
      return;
    }
    // 移动端的可用区必须是**可视视口**（键盘弹起时它比 innerHeight 矮），
    // 否则面板会算进被键盘盖住的那一块里，看起来像「点完什么都没出现」。
    const bounds = Platform.isMobile ? visualViewportRect() : viewportRect();
    this.placeAnchored(bounds);
  }

  /**
   * 贴着锚点四侧择优。桌面与移动端只差 bounds：
   * 桌面用整窗，移动端用可视视口（键盘顶上来时自动往可视区里挤）。
   */
  private placeAnchored(bounds: PopoverRect): void {
    const anchorRect = this.options.anchor.getBoundingClientRect();
    const inView = anchorRect.bottom >= bounds.top && anchorRect.top <= bounds.bottom;

    // 桌面上锚点滚出视口就收掉：面板停在没有指向物的位置只会让人以为卡住了。
    // 移动端不收——键盘把卡片顶出可视区是常态，此时贴着可视区底边显示，
    // 用户还能继续把自己正在打的标签写完。
    if (!inView) {
      if (!Platform.isMobile) {
        this.dismiss("anchor-gone");
        return;
      }
    }

    const avoid: PopoverRect = inView
      ? anchorRect
      : { left: bounds.left, right: bounds.left + 1, top: bounds.bottom - 1, bottom: bounds.bottom };

    const availableWidth = Math.max(160, bounds.right - bounds.left - 2 * EDGE);
    this.el.style.maxWidth = "";
    this.el.style.maxHeight = "";
    this.el.style.width = `${Math.min(this.options.width, availableWidth)}px`;
    this.el.style.left = "0px";
    this.el.style.top = "0px";

    // 量尺寸时先隐藏：这一帧内同步写回，不会真的闪
    const previousVisibility = this.el.style.visibility;
    this.el.style.visibility = "hidden";
    const rect = this.el.getBoundingClientRect();
    const placement = computePopoverPlacement(avoid, { width: rect.width, height: rect.height }, bounds);
    this.el.style.visibility = previousVisibility;

    this.el.style.left = `${placement.left}px`;
    this.el.style.top = `${placement.top}px`;
    this.el.style.maxWidth = `${placement.width}px`;
    this.el.style.maxHeight = `${placement.maxHeight}px`;
    this.el.dataset.side = placement.side;
  }

  // ---- 监听 ----

  private watchLayout(): void {
    window.addEventListener("resize", this.handleViewportChange);
    window.visualViewport?.addEventListener("resize", this.handleViewportChange);
    window.visualViewport?.addEventListener("scroll", this.handleViewportChange);
    // 捕获阶段收列表滚动：锚点会跟着列表走，面板得跟上
    document.addEventListener("scroll", this.handleViewportChange, true);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.schedulePlace());
      this.resizeObserver.observe(this.el);
    }
  }

  private unwatchLayout(): void {
    window.removeEventListener("resize", this.handleViewportChange);
    window.visualViewport?.removeEventListener("resize", this.handleViewportChange);
    window.visualViewport?.removeEventListener("scroll", this.handleViewportChange);
    document.removeEventListener("scroll", this.handleViewportChange, true);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private listenOutside(): void {
    const openedAt = this.openedAt;
    this.outsideHandler = (event: PointerEvent) => {
      if (this.closed || !this.el.isConnected) {
        return;
      }
      if (event.target instanceof Node && this.el.contains(event.target)) {
        return;
      }
      // 刚打开的一小段时间内不判外点：软键盘弹出时部分移动端 WebView 会补发 pointerdown
      if (Date.now() - openedAt < OPEN_GRACE_MS) {
        return;
      }
      this.dismiss("outside");
    };
    document.addEventListener("pointerdown", this.outsideHandler, true);

    this.keydownHandler = (event: KeyboardEvent) => {
      if (this.closed || event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      // 移动端没有 Esc 键：这个 Escape 来自输入法的「收起键盘 / 切换输入法」，
      // 不是「取消编辑」。照收就是「键盘一弹出来面板就没了」。
      if (Platform.isMobile) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.dismiss("escape");
    };
    document.addEventListener("keydown", this.keydownHandler, true);
  }
}

// ---- 单例：同一时刻只允许一个编辑面板 ----

let activePanel: FloatingPanel | null = null;

function adopt(panel: FloatingPanel): FloatingPanel {
  activePanel = panel;
  return panel;
}

/** 关掉当前面板（视图关闭、切页时调用） */
export function dismissFloatingPanel(): void {
  activePanel?.dismiss("programmatic");
  activePanel = null;
}

export interface TagEditorPanelOptions {
  anchor: HTMLElement;
  tags: readonly string[];
  suggestions: readonly TagSuggestion[];
  quickApply?: { label: string; tags: readonly string[] };
  /** 按需 AI 推荐：只有用户点下拉里的 AI 行才会调用 */
  requestAi?: (force: boolean) => Promise<readonly string[]>;
  onChange: (tags: string[]) => void;
  onClose?: (reason: PanelCloseReason) => void;
}

/**
 * 标签编辑面板。内容沿用 views/tagInput 的组件（三端同一套补全、IME、AI 推荐），
 * 只是把它放进浮动外壳——候选列表在面板内滚动，不会撑高卡片。
 */
export function openTagEditorPanel(options: TagEditorPanelOptions): FloatingPanel {
  activePanel?.dismiss("programmatic");

  let handle: TagInputHandle | null = null;
  const panel: FloatingPanel = new FloatingPanel({
    anchor: options.anchor,
    width: 320,
    className: "yh-float-panel--tags",
    build: (host) => {
      handle = renderTagInput(host, {
        tags: [...options.tags],
        suggestions: options.suggestions,
        showSuggestionsOnOpen: true,
        ...(options.quickApply ? { quickApply: options.quickApply } : {}),
        ...(options.requestAi ? { onRequestAi: options.requestAi } : {}),
        onChange: options.onChange,
        placeholder: "添加标签…",
      });
      return () => handle?.focus();
    },
    onClose: (reason) => {
      if (activePanel === panel) {
        activePanel = null;
      }
      // 输入框里已经打了字但没回车：点外面关闭时补提交；Esc 视为放弃
      if (reason !== "escape") {
        handle?.flush();
      }
      options.onClose?.(reason);
    },
  });
  adopt(panel);
  panel.open();
  return panel;
}

export interface NoteEditorPanelOptions {
  anchor: HTMLElement;
  /** 初始内容（编辑已有想法时是原文） */
  value: string;
  placeholder?: string;
  /** 保存：面板在 Promise 完成前保持打开，失败由宿主抛错并给 Notice */
  onSave: (value: string) => Promise<void> | void;
  onClose?: (reason: PanelCloseReason) => void;
}

/**
 * 想法编辑面板：textarea + 保存/取消。
 * 与标签面板同一外壳——卡片高度不变，列表不抖；保存成功后关闭。
 */
export function openNoteEditorPanel(options: NoteEditorPanelOptions): FloatingPanel {
  activePanel?.dismiss("programmatic");

  let textarea: HTMLTextAreaElement | null = null;
  let panel: FloatingPanel;

  const runSave = async (): Promise<void> => {
    if (!textarea) {
      return;
    }
    const value = textarea.value;
    const saveButton = panel.el.querySelector<HTMLButtonElement>(".yh-ov-save");
    saveButton?.setAttribute("disabled", "true");
    try {
      await options.onSave(value);
    } catch (error) {
      console.warn("yh-inklight: 保存想法失败", error);
      saveButton?.removeAttribute("disabled");
      textarea.focus();
      return;
    }
    // 保存成功：内容已落盘，直接收起
    panel.dismiss("programmatic");
  };

  panel = new FloatingPanel({
    anchor: options.anchor,
    width: 380,
    className: "yh-float-panel--note",
    build: (host) => {
      const title = host.createDiv({ cls: "yh-float-panel-title" });
      title.createSpan({ text: "想法" });
      const close = title.createSpan({ cls: "yh-float-panel-close", text: "✕" });
      close.setAttribute("role", "button");
      close.setAttribute("aria-label", "关闭");
      close.addEventListener("click", () => panel.dismiss("programmatic"));

      const field = host.createEl("textarea", {
        cls: "yh-float-panel-textarea",
        attr: { placeholder: options.placeholder ?? "写下你的想法…", rows: "4" },
      });
      field.value = options.value;
      textarea = field;

      const actions = host.createDiv({ cls: "yh-float-panel-actions" });
      const cancel = actions.createEl("button", { cls: "yh-ov-cancel", attr: { type: "button" }, text: "取消" });
      const save = actions.createEl("button", { cls: "yh-ov-save", attr: { type: "button" }, text: "保存" });
      cancel.addEventListener("click", () => panel.dismiss("programmatic"));
      save.addEventListener("click", () => void runSave());

      field.addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void runSave();
        }
      });
      return () => {
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      };
    },
    onClose: (reason) => {
      if (activePanel === panel) {
        activePanel = null;
      }
      options.onClose?.(reason);
    },
  });

  adopt(panel);
  panel.open();
  return panel;
}

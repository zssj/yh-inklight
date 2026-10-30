/**
 * [INPUT]: 依赖 DOM selection 与 Obsidian 命令回调，接收高亮颜色与便签动作
 * [OUTPUT]: 对外提供 SelectionToolbar，在选中文本附近显示非侵入式阅读工具条
 * [POS]: editor 模块的交互入口，被 main.ts 装配并调用
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { Platform } from "obsidian";
import { ANNOTATION_COLORS, AnnotationColor, COLOR_LABELS } from "../storage/types";

interface SelectionToolbarOptions {
  onHighlight: (color: AnnotationColor) => void;
  onComment: () => void;
  onAi: () => void;
  onOpenSidebar: () => void;
}

export class SelectionToolbar {
  private readonly element: HTMLElement;
  private visible = false;
  private shownStartContainer: Node | null = null;
  private shownStartOffset = 0;
  private shownEndContainer: Node | null = null;
  private shownEndOffset = 0;
  private readonly handleMouseUp = (): void => {
    window.setTimeout(() => this.showForSelection(), 0);
  };
  // 用户重新开始拖动选区（手指按住手柄移动）时选区边界会连续变化：
  // 立即隐藏工具栏，使其完全退出命中测试，避免 Chrome 拖动手柄的实时
  // 命中测试砸到工具栏实体导致选区端点跳变（向下拖必经其下边缘路径）。
  private readonly handleSelectionChange = (): void => {
    if (!this.visible) {
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      this.hide();
      return;
    }

    const range = selection.getRangeAt(0);
    if (
      range.startContainer === this.shownStartContainer &&
      range.startOffset === this.shownStartOffset &&
      range.endContainer === this.shownEndContainer &&
      range.endOffset === this.shownEndOffset
    ) {
      return;
    }

    this.hide();
  };

  constructor(private readonly options: SelectionToolbarOptions) {
    this.element = document.body.createDiv({ cls: "yh-toolbar yh-selection-toolbar" });
    this.render();
    this.hide();
    document.addEventListener("mouseup", this.handleMouseUp);
    document.addEventListener("selectionchange", this.handleSelectionChange);
  }

  destroy(): void {
    document.removeEventListener("mouseup", this.handleMouseUp);
    document.removeEventListener("selectionchange", this.handleSelectionChange);
    this.element.remove();
  }

  showForSelection(): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      this.hide();
      return;
    }

    const text = selection.toString().trim();
    const range = selection.getRangeAt(0);
    if (!text || !isSelectionInsideWorkspace(range)) {
      this.hide();
      return;
    }

    const rect = range.getBoundingClientRect();
    // 记录触发显示的选区边界：后续 selectionchange 若边界不变（如系统自身微调）则不隐藏，
    // 边界变化（用户重新拖动）则由 handleSelectionChange 立即隐藏。
    this.shownStartContainer = range.startContainer;
    this.shownStartOffset = range.startOffset;
    this.shownEndContainer = range.endContainer;
    this.shownEndOffset = range.endOffset;
    // 移动端 md：工具栏锚定在选区【下方】（参考 EPUB 选区菜单 rect.bottom 定位），
    // 避开 Android 系统选择操作条（复制/分享/全选/网页搜索，通常悬于选区上方）；
    // 选区贴近屏幕底部放不下时翻转到选区上方。PDF 与桌面端维持原选区上方悬浮。
    if (Platform.isMobile && isSelectionInsideMarkdown(range)) {
      const offset = 16;
      const height = this.element.offsetHeight || 44;
      let top = rect.bottom + offset;
      if (top + height > window.innerHeight - offset) {
        top = Math.max(offset, rect.top - height - offset);
      }
      this.element.style.bottom = "";
      this.element.style.top = `${top}px`;
      this.element.style.left = `${Math.min(Math.max(8, rect.left + rect.width / 2), window.innerWidth - 8)}px`;
      this.element.toggleClass("is-visible", true);
      this.visible = true;
      return;
    }
    this.element.style.bottom = "";
    this.element.style.left = `${Math.max(8, rect.left + rect.width / 2)}px`;
    this.element.style.top = `${Math.max(8, rect.top - 46)}px`;
    this.element.toggleClass("is-visible", true);
    this.visible = true;
  }

  hide(): void {
    this.element.toggleClass("is-visible", false);
    this.visible = false;
  }

  isVisible(): boolean {
    return this.visible;
  }

  private render(): void {
    for (const color of ANNOTATION_COLORS) {
      const button = this.element.createEl("button", {
        cls: `yh-toolbar-color yh-toolbar-color--${color}`,
        attr: {
          type: "button",
          "aria-label": `高亮 ${COLOR_LABELS[color]}`,
          "data-yh-color": color,
        },
      });
      button.addEventListener("click", () => this.options.onHighlight(color));
    }

    this.element.createDiv({ cls: "yh-toolbar-sep" });

    const commentButton = this.iconButton("添加便签", NOTE_ICON);
    commentButton.addEventListener("click", () => this.options.onComment());

    // AI 助手入口：复用 EPUB 的 EpubAiModal（解释/翻译/改写/自定义提问），
    // 未配置 Key 时弹窗内会给出「去设置」指引，故始终显示
    const aiButton = this.iconButton("AI 助手", AI_ICON);
    aiButton.addEventListener("click", () => this.options.onAi());

    const sidebarButton = this.iconButton("打开总览", OVERVIEW_ICON);
    sidebarButton.addEventListener("click", () => this.options.onOpenSidebar());
  }

  private iconButton(label: string, svg: string): HTMLButtonElement {
    const button = this.element.createEl("button", {
      cls: "yh-toolbar-action",
      attr: {
        type: "button",
        "aria-label": label,
        title: label,
      },
    });
    button.innerHTML = svg;
    return button;
  }
}

function isSelectionInsideWorkspace(range: Range): boolean {
  const container =
    range.commonAncestorContainer instanceof HTMLElement
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;

  if (!container) {
    return false;
  }

  return Boolean(
    container.closest(".workspace") ||
      container.closest(".callout-content") ||
      container.closest(".markdown-preview-view"),
  );
}

/** 选区是否位于 Markdown 视图内（编辑模式 CM6 容器或阅读模式预览容器）。 */
function isSelectionInsideMarkdown(range: Range): boolean {
  const container =
    range.commonAncestorContainer instanceof HTMLElement
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;

  if (!container) {
    return false;
  }

  return Boolean(container.closest(".markdown-source-view") || container.closest(".markdown-preview-view"));
}

const NOTE_ICON = `
  <svg width="14" height="14" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5
      a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
`;

const AI_ICON = `
  <svg width="14" height="14" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>
    <path d="M19 15l.9 2.4L22 18l-2.1.6L19 21l-.9-2.4L16 18l2.1-.6z"/>
  </svg>
`;

const OVERVIEW_ICON = `
  <svg width="14" height="14" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">
    <line x1="8" y1="6" x2="21" y2="6"/>
    <line x1="8" y1="12" x2="21" y2="12"/>
    <line x1="8" y1="18" x2="21" y2="18"/>
    <line x1="3" y1="6" x2="3.01" y2="6"/>
    <line x1="3" y1="12" x2="3.01" y2="12"/>
    <line x1="3" y1="18" x2="3.01" y2="18"/>
  </svg>
`;

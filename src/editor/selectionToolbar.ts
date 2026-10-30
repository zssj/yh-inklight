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
  onCopy: () => void;
  onOpenSidebar: () => void;
}

export class SelectionToolbar {
  private readonly element: HTMLElement;
  private visible = false;
  private readonly handleMouseUp = (): void => {
    window.setTimeout(() => this.showForSelection(), 0);
  };

  constructor(private readonly options: SelectionToolbarOptions) {
    this.element = document.body.createDiv({ cls: "yh-toolbar yh-selection-toolbar" });
    this.render();
    this.hide();
    document.addEventListener("mouseup", this.handleMouseUp);
  }

  destroy(): void {
    document.removeEventListener("mouseup", this.handleMouseUp);
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
    // 移动端 md：工具栏锚定在选区【下方】（参考 EPUB 选区菜单 rect.bottom 定位），
    // 避开 Android 系统选择操作条（复制/分享/全选/网页搜索，通常悬于选区上方）；
    // 选区贴近屏幕底部放不下时翻转到选区上方。PDF 与桌面端维持原选区上方悬浮。
    if (Platform.isMobile && isSelectionInsideMarkdown(range)) {
      const offset = 8;
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

    const copyButton = this.iconButton("复制", COPY_ICON);
    copyButton.addEventListener("click", () => this.options.onCopy());

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

const COPY_ICON = `
  <svg width="14" height="14" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="9" width="13" height="13"
      rx="2" ry="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4
      a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
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

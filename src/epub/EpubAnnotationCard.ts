/**
 * [INPUT]: 依赖 storage/types 的标注颜色/想法类型定义
 * [OUTPUT]: 提供 EpubAnnotationCard，EPUB 阅读器中点击高亮弹出的标注详情卡片
 * [POS]: EPUB 标注详情 UI，负责展示引用文本/笔记/分类/颜色并提供编辑、删除操作
 */

import { AnnotationColor, COLOR_LABELS, EPUB_COLOR_MAP } from "../storage/types";

const NOTE_TYPE_LABELS: Record<string, string> = {
  insight: "💡 洞见",
  question: "❓ 疑问",
  reminder: "🔔 提醒",
};

export interface EpubAnnotationCardData {
  quote: string;
  note?: string;
  noteType?: "insight" | "question" | "reminder";
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
}

export interface EpubAnnotationCardAnchor {
  left: number;
  top: number;
}

/**
 * 点击 EPUB 高亮后弹出的标注详情卡片。
 * 桌面端浮在高亮位置附近，移动端为底部弹出卡片。
 */
export class EpubAnnotationCard {
  private el: HTMLElement;
  private outsideHandler: ((ev: PointerEvent) => void) | null = null;
  private options: EpubAnnotationCardOptions;

  constructor(data: EpubAnnotationCardData, options: EpubAnnotationCardOptions = {}) {
    this.options = options;
    this.el = document.body.createDiv({ cls: "yh-epub-annotation-card" });
    this.build(data);
  }

  private build(data: EpubAnnotationCardData): void {
    const accent = this.el.createDiv({ cls: "yh-epub-card-accent" });
    accent.style.background = EPUB_COLOR_MAP[data.color];

    const body = this.el.createDiv({ cls: "yh-epub-card-body" });

    const top = body.createDiv({ cls: "yh-epub-card-top" });
    const badgeText =
      data.noteType && NOTE_TYPE_LABELS[data.noteType] ? NOTE_TYPE_LABELS[data.noteType] : "📝 画线";
    top.createSpan({ cls: "yh-epub-card-badge", text: badgeText });
    top.createSpan({ cls: "yh-epub-card-color-label", text: COLOR_LABELS[data.color] });
    const closeBtn = top.createEl("button", {
      cls: "yh-epub-card-close",
      attr: { type: "button", title: "关闭", "aria-label": "关闭" },
      text: "✕",
    });
    closeBtn.addEventListener("click", () => this.dismiss());

    body.createDiv({ cls: "yh-epub-card-quote", text: data.quote });

    if (data.hasNote && data.note) {
      body.createDiv({ cls: "yh-epub-card-note", text: data.note });
    } else {
      body.createDiv({ cls: "yh-epub-card-note is-empty", text: "此高亮暂无笔记" });
    }

    const metaParts: string[] = [];
    if (data.chapter) {
      metaParts.push(data.chapter);
    }
    if (data.createdAt) {
      metaParts.push(this.formatDate(data.createdAt));
    }
    if (metaParts.length > 0) {
      body.createDiv({ cls: "yh-epub-card-meta", text: metaParts.join(" · ") });
    }

    const actions = body.createDiv({ cls: "yh-epub-card-actions" });
    if (data.hasNote) {
      const editBtn = actions.createEl("button", {
        cls: "yh-epub-card-btn is-edit",
        attr: { type: "button" },
        text: "编辑",
      });
      editBtn.addEventListener("click", () => {
        this.options.onEdit?.();
        this.dismiss();
      });
    } else {
      const addBtn = actions.createEl("button", {
        cls: "yh-epub-card-btn is-edit",
        attr: { type: "button" },
        text: "添加笔记",
      });
      addBtn.addEventListener("click", () => {
        this.options.onAddNote?.();
        this.dismiss();
      });
    }
    const delBtn = actions.createEl("button", {
      cls: "yh-epub-card-btn is-delete",
      attr: { type: "button" },
      text: "删除",
    });
    delBtn.addEventListener("click", () => {
      this.options.onDelete?.();
      this.dismiss();
    });
  }

  show(anchor: EpubAnnotationCardAnchor, isMobile: boolean): void {
    if (isMobile) {
      this.el.addClass("is-mobile");
    } else {
      const width = Math.min(320, window.innerWidth - 24);
      const left = Math.max(8, Math.min(anchor.left - width / 2, window.innerWidth - width - 8));
      const estimatedHeight = 260;
      const top = Math.max(8, Math.min(anchor.top + 10, window.innerHeight - estimatedHeight - 8));
      this.el.style.left = `${left}px`;
      this.el.style.top = `${top}px`;
    }
    document.body.appendChild(this.el);
    this.registerOutsideClick();
  }

  private registerOutsideClick(): void {
    this.outsideHandler = (ev: PointerEvent) => {
      if (this.el.isConnected && ev.target instanceof Node && !this.el.contains(ev.target)) {
        this.dismiss();
      }
    };
    window.setTimeout(() => {
      if (this.outsideHandler) {
        document.addEventListener("pointerdown", this.outsideHandler, true);
      }
    }, 0);
  }

  dismiss(): void {
    if (this.outsideHandler) {
      document.removeEventListener("pointerdown", this.outsideHandler, true);
      this.outsideHandler = null;
    }
    if (this.el.isConnected) {
      this.el.remove();
    }
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

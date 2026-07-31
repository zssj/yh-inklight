/**
 * [INPUT]: 依赖 Obsidian Modal API 和 storage/types 的标注颜色/想法类型定义
 * [OUTPUT]: 提供 EpubNoteModal，用于 EPUB 阅读器中创建/编辑想法
 * [POS]: EPUB 想法输入 UI，与 yh-inklight 的 CommentModal 保持一致的风格
 */

import { App, Modal, Platform } from "obsidian";
import {
  AnnotationColor,
  ANNOTATION_COLORS,
  COLOR_LABELS,
  EPUB_COLOR_MAP,
  EpubHighlightStyle,
  EPUB_HIGHLIGHT_STYLES,
} from "../storage/types";

export interface EpubNoteResult {
  note: string;
  color: AnnotationColor;
  style: EpubHighlightStyle;
  noteType: "insight" | "question" | "reminder";
}

const NOTE_TYPE_OPTIONS = [
  { value: "insight" as const, label: "💡 洞见" },
  { value: "question" as const, label: "❓ 疑问" },
  { value: "reminder" as const, label: "🔔 提醒" },
];

/**
 * Modal for writing a personal note (想法) attached to an EPUB text selection.
 */
export class EpubNoteModal extends Modal {
  private selectedText: string;
  private note: string;
  private color: AnnotationColor;
  private style: EpubHighlightStyle;
  private noteType: "insight" | "question" | "reminder";
  private onSubmit: (result: EpubNoteResult) => void;
  private titleText: string;
  private keyboardCleanup?: () => void;

  constructor(
    app: App,
    selectedText: string,
    initial: {
      note?: string;
      color?: AnnotationColor;
      style?: EpubHighlightStyle;
      noteType?: "insight" | "question" | "reminder";
    },
    onSubmit: (result: EpubNoteResult) => void,
    titleText = "写下你的想法",
  ) {
    super(app);
    this.selectedText = selectedText;
    this.note = initial.note ?? "";
    this.color = initial.color ?? "yellow";
    this.style = initial.style ?? "fill";
    this.noteType = initial.noteType ?? "insight";
    this.onSubmit = onSubmit;
    this.titleText = titleText;
  }

  private submit(ta: HTMLTextAreaElement): void {
    this.note = ta.value.trim();
    this.close();
    this.onSubmit({
      note: this.note,
      color: this.color,
      style: this.style,
      noteType: this.note ? this.noteType : "insight",
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("yh-epub-note-modal");

    const body = contentEl.createDiv({ cls: "yh-epub-note-body" });

    body.createEl("h3", { text: this.titleText });

    // 引用选中文本
    const quote = body.createDiv({ cls: "yh-epub-note-quote" });
    quote.setText(
      this.selectedText.length > 240
        ? this.selectedText.slice(0, 240) + "…"
        : this.selectedText,
    );

    // 颜色选择行
    const colorRow = body.createDiv({ cls: "yh-epub-note-colors" });
    colorRow.createEl("span", { cls: "yh-epub-note-label", text: "画线颜色" });
    const dots = colorRow.createDiv({ cls: "yh-epub-color-dots" });
    const dotEls: Record<string, HTMLElement> = {};
    for (const c of ANNOTATION_COLORS) {
      const dot = dots.createDiv({ cls: "yh-epub-color-dot" });
      dot.setAttribute("data-color", c);
      dot.style.background = EPUB_COLOR_MAP[c];
      dot.title = COLOR_LABELS[c];
      if (c === this.color) {
        dot.addClass("is-active");
      }
      dot.addEventListener("click", () => {
        this.color = c;
        Object.values(dotEls).forEach((d) => d.removeClass("is-active"));
        dot.addClass("is-active");
      });
      dotEls[c] = dot;
    }

    // 高亮样式选择行
    const styleRow = body.createDiv({ cls: "yh-epub-note-styles" });
    styleRow.createEl("span", { cls: "yh-epub-note-label", text: "标注样式" });
    const styleChips = styleRow.createDiv({ cls: "yh-epub-style-chips" });
    const styleEls: Record<string, HTMLElement> = {};
    for (const s of EPUB_HIGHLIGHT_STYLES) {
      const chip = styleChips.createDiv({ cls: "yh-epub-style-chip" });
      chip.setText(s.label);
      chip.title = s.label;
      chip.setAttribute("data-style", s.id);
      if (s.id === this.style) {
        chip.addClass("is-active");
      }
      chip.addEventListener("click", () => {
        this.style = s.id;
        Object.values(styleEls).forEach((c) => c.removeClass("is-active"));
        chip.addClass("is-active");
      });
      styleEls[s.id] = chip;
    }

    // 想法类型选择行
    const typeRow = body.createDiv({ cls: "yh-epub-note-type-row" });
    typeRow.createEl("span", { cls: "yh-epub-note-label", text: "想法类型" });
    const chips = typeRow.createDiv({ cls: "yh-epub-note-type-chips" });
    const chipEls: Record<string, HTMLElement> = {};
    for (const t of NOTE_TYPE_OPTIONS) {
      const chip = chips.createDiv({ cls: "yh-epub-note-type-chip" });
      chip.setText(t.label);
      chip.title = t.label;
      chip.setAttribute("data-type", t.value);
      if (t.value === this.noteType) {
        chip.addClass("is-active");
      }
      chip.addEventListener("click", () => {
        this.noteType = t.value;
        Object.values(chipEls).forEach((c) => c.removeClass("is-active"));
        chip.addClass("is-active");
      });
      chipEls[t.value] = chip;
    }

    // 文本输入区域
    const ta = body.createEl("textarea", { cls: "yh-epub-note-textarea" });
    ta.placeholder = "在这里写下你的想法、疑问或联想…";
    ta.value = this.note;
    ta.rows = Platform.isMobile ? 4 : 6;
    window.setTimeout(() => ta.focus(), 30);

    // 按钮行（放入可滚动主体，测量失败时也能下滑到按钮）
    const actions = body.createDiv({ cls: "yh-epub-note-actions" });
    const cancelBtn = actions.createEl("button", {
      text: "取消",
      cls: "yh-epub-note-cancel",
    });
    const saveBtn = actions.createEl("button", {
      text: "保存",
      cls: "yh-epub-note-save",
    });
    saveBtn.addClass("mod-cta");

    cancelBtn.addEventListener("click", () => this.close());
    saveBtn.addEventListener("click", () => this.submit(ta));
    ta.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        this.submit(ta);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });

    if (Platform.isMobile) {
      this.setupKeyboardAwareness();
    }
  }

  /**
   * 移动端软键盘感知（Android 优先）。
   *
   * 通过多路测量源交叉取"键盘上方可视区高度"，再把 Modal 容器钉进该区域：
   * 1. navigator.virtualKeyboard.geometrychange → boundingRect 精确键盘高度
   * 2. window.visualViewport.resize/scroll → 视觉视口高度（覆盖键盘模式）
   * 3. window.resize + window.innerHeight（adjustResize 模式下布局视口被压缩）
   * 4. focusin + 延迟重测，兜底事件漏发
   *
   * 按钮已放进可滚动主体：即使所有测量都失效，用户也能下滑到"取消/保存"。
   */
  private setupKeyboardAwareness(): void {
    const vv = window.visualViewport;
    const vk = (navigator as unknown as {
      virtualKeyboard?: {
        boundingRect?: { height: number };
        addEventListener?: (type: "geometrychange", listener: () => void) => void;
        removeEventListener?: (type: "geometrychange", listener: () => void) => void;
      };
    }).virtualKeyboard;

    const apply = (): void => {
      const innerH = window.innerHeight;
      const vvH = vv?.height ?? innerH;
      const vkH = vk?.boundingRect?.height ?? 0;

      let height = Math.max(120, Math.min(vvH, innerH));
      if (vkH > 0 && height >= innerH - 4) {
        // 视口未收缩（vv 不更新且非 adjustResize 模式），用键盘矩形估算
        height = Math.max(120, innerH - vkH);
      }

      this.containerEl.style.top = "0px";
      this.containerEl.style.height = `${height}px`;
      this.containerEl.style.alignItems = "flex-start";
      this.modalEl.style.marginTop = "calc(env(safe-area-inset-top, 0px) + 10px)";
      this.modalEl.style.maxHeight = `${height - 20}px`;
      this.modalEl.style.overflow = "hidden";
    };

    apply();
    vk?.addEventListener?.("geometrychange", apply);
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);

    const focusApply = (): void => {
      window.setTimeout(apply, 120);
      window.setTimeout(apply, 450);
    };
    document.addEventListener("focusin", focusApply);

    this.keyboardCleanup = () => {
      vk?.removeEventListener?.("geometrychange", apply);
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      document.removeEventListener("focusin", focusApply);
      this.containerEl.style.top = "";
      this.containerEl.style.height = "";
      this.containerEl.style.alignItems = "";
      this.modalEl.style.marginTop = "";
      this.modalEl.style.maxHeight = "";
      this.modalEl.style.overflow = "";
    };
  }

  onClose(): void {
    this.keyboardCleanup?.();
    this.contentEl.empty();
  }
}

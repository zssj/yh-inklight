/**
 * [INPUT]: 依赖 Obsidian Modal/App/Platform/Notice 与 ai/EpubAiClient 的请求能力、storage/types 的设置字段
 * [OUTPUT]: EpubAiModal —— 对选中文字发起 AI 解释/翻译/改写/自定义提问，回复可复制或存为便签
 * [POS]: EPUB 阅读器的 AI 交互 UI，由 EpubReaderView 的选区菜单唤起
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { App, Modal, Notice, Platform } from "obsidian";

import {
  AI_ACTION_PRESETS,
  chatWithAi,
  composeSystemPrompt,
  isAiConfigured,
  resolveAiConfig,
  truncateSelectedText,
  type AiActionPreset,
} from "../ai/EpubAiClient";
import type { AnnotationPluginSettings } from "../storage/types";

/** 引用区最多显示的字符数 */
const QUOTE_MAX = 240;

/**
 * Modal for asking the AI to explain / translate / rewrite an EPUB text selection.
 * 回复不落盘，只有用户点「存为便签」时才交给父层走既有标注流程。
 */
export class EpubAiModal extends Modal {
  private readonly selectedText: string;
  private readonly settings: AnnotationPluginSettings;
  private readonly onSave: (note: string) => void;
  private currentAction: AiActionPreset | null = null;
  private result = "";
  private busy = false;
  private keyboardCleanup?: () => void;

  private actionChipEls: Record<string, HTMLElement> = {};
  private customRowEl!: HTMLElement;
  private customInputEl!: HTMLInputElement;
  private resultEl!: HTMLElement;
  private saveBtnEl!: HTMLButtonElement;
  private copyBtnEl!: HTMLButtonElement;

  constructor(
    app: App,
    selectedText: string,
    settings: AnnotationPluginSettings,
    onSave: (note: string) => void,
  ) {
    super(app);
    this.selectedText = selectedText;
    this.settings = settings;
    this.onSave = onSave;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("yh-epub-note-modal", "yh-epub-ai-modal");

    const body = contentEl.createDiv({ cls: "yh-epub-note-body" });
    body.createEl("h3", { text: "AI 助手" });

    const quote = body.createDiv({ cls: "yh-epub-note-quote" });
    quote.setText(
      this.selectedText.length > QUOTE_MAX
        ? this.selectedText.slice(0, QUOTE_MAX) + "…"
        : this.selectedText,
    );

    // 动作选择行
    const chipRow = body.createDiv({ cls: "yh-epub-note-type-row" });
    chipRow.createEl("span", { cls: "yh-epub-note-label", text: "让 AI 做什么" });
    const chips = chipRow.createDiv({ cls: "yh-epub-note-type-chips" });
    for (const action of AI_ACTION_PRESETS) {
      const chip = chips.createDiv({ cls: "yh-epub-note-type-chip" });
      chip.setText(action.label);
      chip.setAttribute("data-action", action.id);
      chip.addEventListener("click", () => {
        this.currentAction = action;
        Object.values(this.actionChipEls).forEach((c) => c.removeClass("is-active"));
        chip.addClass("is-active");
        this.customRowEl.style.display = action.id === "ask" ? "" : "none";
        if (action.id === "ask") {
          window.setTimeout(() => this.customInputEl.focus(), 30);
        }
        void this.run(action);
      });
      this.actionChipEls[action.id] = chip;
    }

    // 自定义提问输入行（仅「自定义」时显示）
    this.customRowEl = body.createDiv({ cls: "yh-epub-ai-custom-row" });
    this.customRowEl.style.display = "none";
    this.customRowEl.createEl("span", { cls: "yh-epub-note-label", text: "你的问题" });
    this.customInputEl = this.customRowEl.createEl("input", {
      cls: "yh-epub-ai-custom-input",
      attr: { type: "text", placeholder: "例如：这句话在说什么？" },
    });
    this.customInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.currentAction) {
        e.preventDefault();
        void this.run(this.currentAction);
      }
    });

    // 结果区
    body.createEl("span", { cls: "yh-epub-note-label", text: "结果" });
    this.resultEl = body.createDiv({ cls: "yh-epub-ai-result" });

    // 按钮行
    const actions = body.createDiv({ cls: "yh-epub-note-actions" });
    const cancelBtn = actions.createEl("button", { text: "关闭", cls: "yh-epub-note-cancel" });
    this.copyBtnEl = actions.createEl("button", { text: "复制", cls: "yh-epub-note-cancel" });
    this.saveBtnEl = actions.createEl("button", { text: "存为便签", cls: "yh-epub-note-save" });
    this.saveBtnEl.addClass("mod-cta");
    this.syncActionButtons();

    cancelBtn.addEventListener("click", () => this.close());
    this.copyBtnEl.addEventListener("click", () => void this.copyResult());
    this.saveBtnEl.addEventListener("click", () => {
      if (!this.result.trim()) {
        return;
      }
      const note = this.result.trim();
      this.close();
      this.onSave(note);
    });

    if (Platform.isMobile) {
      this.setupKeyboardAwareness();
    }
  }

  /** 选中内置动作之一并请求 */
  private async run(action: AiActionPreset): Promise<void> {
    if (this.busy) {
      return;
    }
    const cfg = resolveAiConfig(this.settings);
    if (!isAiConfigured(cfg)) {
      this.result = "还没配置 AI。请到 设置 → 第三方插件 → 墨光批注 →「AI 助手」填写服务商与 API Key。";
      this.busy = false;
      this.renderResult();
      return;
    }

    this.busy = true;
    try {
      this.result = "思考中…";
      this.renderResult();

      const reply = await chatWithAi(
        cfg,
        composeSystemPrompt(action, this.settings.aiSystemPrompt),
        action.buildUserText(truncateSelectedText(this.selectedText), this.customInputEl.value),
      );
      this.result = reply.truncated
        ? `${reply.content}\n\n（回复被截断，可调大「最大 Token」）`
        : reply.content;
    } catch (error) {
      this.result = `失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.busy = false;
      // 渲染本身再出异常也不能吞掉已拿到的结果，故单独兜一层
      try {
        this.renderResult();
      } catch {
        /* ignore secondary render failure */
      }
    }
  }

  private async copyResult(): Promise<void> {
    const text = this.result.trim();
    if (!text || this.busy) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      new Notice("已复制到剪贴板");
    } catch {
      new Notice("复制失败，请手动长按选中结果文字");
    }
  }

  private renderResult(): void {
    this.resultEl.setText(this.result);
    this.syncActionButtons();
  }

  private syncActionButtons(): void {
    // 按钮元素可能尚未创建（onOpen 中途异常），判空避免把整个流程卡死
    if (!this.saveBtnEl || !this.copyBtnEl) {
      return;
    }
    const hasResult = !!this.result.trim() && !this.busy;
    this.saveBtnEl.disabled = !hasResult;
    this.copyBtnEl.disabled = !hasResult;
    this.saveBtnEl.toggleClass("is-disabled", !hasResult);
    this.copyBtnEl.toggleClass("is-disabled", !hasResult);
  }

  /**
   * 移动端软键盘感知（与 EpubNoteModal 同一套思路的精简版）。
   * 按钮已放进可滚动主体：即使测量全部失效，也能下滑到「复制/存为便签」。
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

      let height = Math.max(140, Math.min(vvH, innerH));
      if (vkH > 0 && height >= innerH - 4) {
        height = Math.max(140, innerH - vkH);
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

    this.keyboardCleanup = () => {
      vk?.removeEventListener?.("geometrychange", apply);
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
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

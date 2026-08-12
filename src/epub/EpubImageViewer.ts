/**
 * [INPUT]: 依赖原生 DOM / Obsidian createDiv 等 DOM 助手，无需 Obsidian API
 * [OUTPUT]: 提供 EpubImageViewer，EPUB 阅读器中点击图片放大的全屏查看器
 * [POS]: EPUB 图片查看 UI，黑底全屏展示原图，点击/Esc 关闭
 */

/**
 * 点击 EPUB 内容图片后的全屏放大查看器。
 * 简单的"仅放大查看"：显示原图（object-fit: contain 适配屏幕），点击任意处或按 Esc 关闭。
 * 由调用方持有单一实例，重复打开复用同一浮层，不叠加。
 */
export class EpubImageViewer {
  private el: HTMLElement | null = null;
  private keyHandler: ((ev: KeyboardEvent) => void) | null = null;

  open(src: string, alt = ""): void {
    if (!this.el) {
      this.el = document.body.createDiv({ cls: "yh-epub-image-viewer" });

      const canvas = this.el.createDiv({ cls: "yh-epub-image-canvas" });
      canvas.createEl("img", { cls: "yh-epub-image-big" });

      this.el.createDiv({ cls: "yh-epub-image-caption" });

      const closeBtn = this.el.createEl("button", {
        cls: "yh-epub-image-close",
        attr: { type: "button", title: "关闭", "aria-label": "关闭" },
        text: "✕",
      });
      closeBtn.addEventListener("click", () => this.close());

      this.el.addEventListener("click", (ev) => {
        if (
          ev.target === this.el ||
          (ev.target instanceof HTMLElement && ev.target.classList.contains("yh-epub-image-canvas"))
        ) {
          this.close();
        }
      });
    }

    const img = this.el.querySelector<HTMLImageElement>("img");
    if (img) {
      img.src = src;
    }
    const caption = this.el.querySelector<HTMLElement>(".yh-epub-image-caption");
    if (caption) {
      caption.setText(alt || "");
    }

    document.body.appendChild(this.el);
    this.registerKeyHandler();
  }

  private registerKeyHandler(): void {
    if (this.keyHandler) {
      return;
    }
    this.keyHandler = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        this.close();
      }
    };
    document.addEventListener("keydown", this.keyHandler, true);
  }

  close(): void {
    if (this.keyHandler) {
      document.removeEventListener("keydown", this.keyHandler, true);
      this.keyHandler = null;
    }
    if (this.el?.isConnected) {
      this.el.remove();
    }
  }
}
/**
 * [INPUT]: jsdom 提供的 HTMLElement（不含 Obsidian 追加的 DOM 便捷方法）
 * [OUTPUT]: installObsidianDom() —— 把 Obsidian 给 HTMLElement 原型补的
 *           empty / addClass / removeClass / toggleClass / hasClass / setText /
 *           createDiv / createSpan / createEl 装到 jsdom 上，只实现当前被测代码用到的语义
 * [POS]: tests/helpers 的 DOM 垫片。真实环境里这些方法由 Obsidian 注入，
 *        凡是直接跑 DOM 渲染的用例（views/editPanel）都必须在文件顶部先调用它，
 *        否则第一行 root.empty() 就会炸。
 * [PROTOCOL]: 被测代码用到新的 DOM 便捷方法时在这里补齐，不要在各测试文件里各写一份
 */

interface ElOptions {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string | number | boolean | null>;
  title?: string;
}

function applyOptions(el: HTMLElement, options?: ElOptions): void {
  if (!options) {
    return;
  }
  if (options.cls) {
    for (const name of Array.isArray(options.cls) ? options.cls : [options.cls]) {
      for (const token of name.split(/\s+/)) {
        if (token) {
          el.classList.add(token);
        }
      }
    }
  }
  if (typeof options.text === "string") {
    el.textContent = options.text;
  }
  if (typeof options.title === "string") {
    el.setAttribute("title", options.title);
  }
  for (const [name, value] of Object.entries(options.attr ?? {})) {
    if (value === null || value === undefined || value === false) {
      continue;
    }
    el.setAttribute(name, String(value));
  }
}

function createIn(parent: HTMLElement, tag: string, options?: ElOptions): HTMLElement {
  const el = document.createElement(tag);
  applyOptions(el, options);
  parent.appendChild(el);
  return el;
}

/** 幂等：多个测试文件同时调用也没问题 */
export function installObsidianDom(): void {
  const proto = HTMLElement.prototype as HTMLElement & Record<string, unknown>;
  if (proto.__yhDomPatched) {
    return;
  }
  proto.__yhDomPatched = true;

  proto.empty = function empty(this: HTMLElement): HTMLElement {
    while (this.firstChild) {
      this.removeChild(this.firstChild);
    }
    return this;
  };
  proto.addClass = function addClass(this: HTMLElement, ...names: Array<string | string[]>): HTMLElement {
    for (const name of names.flat()) {
      for (const token of String(name).split(/\s+/)) {
        if (token) {
          this.classList.add(token);
        }
      }
    }
    return this;
  };
  proto.removeClass = function removeClass(this: HTMLElement, ...names: Array<string | string[]>): HTMLElement {
    for (const name of names.flat()) {
      for (const token of String(name).split(/\s+/)) {
        if (token) {
          this.classList.remove(token);
        }
      }
    }
    return this;
  };
  proto.toggleClass = function toggleClass(this: HTMLElement, name: string, value?: boolean): HTMLElement {
    this.classList.toggle(name, value);
    return this;
  };
  proto.hasClass = function hasClass(this: HTMLElement, name: string): boolean {
    return this.classList.contains(name);
  };
  proto.setText = function setText(this: HTMLElement, text: string): HTMLElement {
    this.textContent = text;
    return this;
  };
  proto.createDiv = function createDiv(this: HTMLElement, options?: ElOptions): HTMLElement {
    return createIn(this, "div", options);
  };
  proto.createSpan = function createSpan(this: HTMLElement, options?: ElOptions): HTMLElement {
    return createIn(this, "span", options);
  };
  proto.createEl = function createEl(this: HTMLElement, tag: string, options?: ElOptions): HTMLElement {
    return createIn(this, tag, options);
  };
}

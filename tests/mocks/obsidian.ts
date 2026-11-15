/**
 * [INPUT]: 无外部依赖
 * [OUTPUT]: 提供 obsidian 模块的测试替身：TFile / TFolder / Notice / normalizePath 及若干空壳类
 * [POS]: tests/mocks 的模块替身，由 vitest.config.ts 的 alias 挂到 `obsidian` 上，
 *        使 src/storage、src/views 等依赖 App 抽象的模块可在 Node 下直接测试
 * [PROTOCOL]: 只补齐被测代码实际用到的 API；新增被测模块若引用新符号，在此追加并保持行为与真实 Obsidian 一致
 */

/** 记录所有 Notice 文本，供断言「是否提示了用户」 */
export const noticeLog: string[] = [];

export function normalizePath(path: string): string {
  if (!path) {
    return "/";
  }

  const replaced = path.replace(/\\/g, "/");
  const segments: string[] = [];
  for (const segment of replaced.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.join("/") || "/";
}

export class TAbstractFile {
  path = "";
  name = "";
  parent: TFolder | null = null;
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  vault: unknown = null;

  constructor(path = "") {
    super();
    this.path = path;
    this.name = path.split("/").pop() ?? "";
  }
}

export class TFile extends TAbstractFile {
  basename = "";
  extension = "";
  stat = { ctime: 0, mtime: 0, size: 0 };
  vault: unknown = null;

  constructor(path = "", mtime = Date.now()) {
    super();
    this.path = path;
    const name = path.split("/").pop() ?? "";
    this.name = name;
    const dot = name.lastIndexOf(".");
    this.basename = dot > 0 ? name.slice(0, dot) : name;
    this.extension = dot > 0 ? name.slice(dot + 1) : "";
    this.stat = { ctime: mtime, mtime, size: 0 };
  }
}

export class Notice {
  constructor(public readonly message: string, public readonly timeout?: number) {
    noticeLog.push(message);
  }

  setMessage(message: string): this {
    noticeLog.push(message);
    return this;
  }

  hide(): void {}
}

export class Component {
  load(): void {}
  unload(): void {}
  onload(): void {}
  onunload(): void {}
  register(): void {}
  addChild<T>(child: T): T {
    return child;
  }
}

export class App {
  workspace: any = {};
  vault: any = {};
  metadataCache: any = {};
  fileManager: any = {};
}

export class Platform {
  static isMobile = false;
  static isDesktop = true;
  static isMacOS = false;
}

export class Modal {
  containerEl: any = {};
  constructor(public readonly app: unknown) {}
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}

export class Plugin extends Component {
  constructor(public readonly app: unknown, public readonly manifest: unknown) {
    super();
  }
  addRibbonIcon(): any {
    return {};
  }
  addCommand(): any {
    return {};
  }
  addSettingTab(): void {}
  registerView(): void {}
  registerEvent(): void {}
  registerDomEvent(): void {}
  async loadData(): Promise<unknown> {
    return {};
  }
  async saveData(): Promise<void> {}
}

export class PluginSettingTab {
  containerEl: any = { empty: () => {}, createDiv: () => ({}) };
  constructor(public readonly app: unknown, public readonly plugin: unknown) {}
  display(): void {}
  hide(): void {}
}

export class ItemView extends Component {
  containerEl: any = {};
  contentEl: any = {};
  constructor(public readonly leaf: unknown) {
    super();
  }
  getViewType(): string {
    return "";
  }
  getDisplayText(): string {
    return "";
  }
}

export class MarkdownView {}

export function debounce<T extends (...args: any[]) => any>(fn: T): T {
  return fn;
}

export function setIcon(): void {}

/**
 * [INPUT]: 依赖 tests/mocks/obsidian 的 TFile/TFolder/normalizePath 替身
 * [OUTPUT]: 提供 FakeVault（内存文件系统 + 可注入写入失败）与 createApp()，用于 storage 层契约测试
 * [POS]: tests/helpers 的存储测试基座；只实现 AnnotationStore 实际调用的 vault/adapter API
 * [PROTOCOL]: 新增被调用的 vault API 时在此补齐，保持「与真实 Obsidian 一样会因目录不存在而失败」的严格性
 */

import { TFile, TFolder, normalizePath } from "obsidian";

export interface FakeVaultOptions {
  /** 初始文件：路径 → 文本内容 */
  files?: Record<string, string>;
  /** 初始文件夹（含祖先路径需自行列出） */
  folders?: string[];
  /** 返回 true 时该路径写入抛错，用于验证写入失败保护 */
  failWrite?: (path: string) => boolean;
}

export class FakeVault {
  private readonly contents = new Map<string, string>();
  private readonly mtimes = new Map<string, number>();
  private readonly folders = new Set<string>();
  private readonly options: FakeVaultOptions;
  readonly adapter: FakeAdapter;

  /** 记录 adapter.write 的调用路径，便于断言「不该写的没写」 */
  readonly writeLog: string[] = [];

  constructor(options: FakeVaultOptions = {}) {
    this.options = options;
    this.adapter = new FakeAdapter(this);
    for (const folder of options.folders ?? []) {
      this.folders.add(normalizePath(folder));
    }
    for (const [path, content] of Object.entries(options.files ?? {})) {
      const normalized = normalizePath(path);
      this.contents.set(normalized, content);
      this.mtimes.set(normalized, Date.now());
      this.ensureParentFolders(normalized);
    }
  }

  // ---- vault API ----

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    const normalized = normalizePath(path);
    if (this.contents.has(normalized)) {
      return this.fileAt(normalized);
    }
    if (this.folders.has(normalized)) {
      return new TFolder(normalized);
    }
    return null;
  }

  async cachedRead(file: TFile): Promise<string> {
    const content = this.contents.get(normalizePath(file.path));
    if (content === undefined) {
      throw new Error(`ENOENT: ${file.path}`);
    }
    return content;
  }

  async read(file: TFile): Promise<string> {
    return this.cachedRead(file);
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const content = await this.cachedRead(file);
    return new TextEncoder().encode(content).buffer;
  }

  async create(path: string, content: string): Promise<TFile> {
    const normalized = normalizePath(path);
    if (this.contents.has(normalized)) {
      throw new Error(`File already exists: ${normalized}`);
    }
    this.contents.set(normalized, content);
    this.mtimes.set(normalized, Date.now());
    return this.fileAt(normalized);
  }

  async modify(file: TFile, content: string): Promise<void> {
    const normalized = normalizePath(file.path);
    this.contents.set(normalized, content);
    this.mtimes.set(normalized, Date.now());
    file.stat.mtime = Date.now();
  }

  async createFolder(path: string): Promise<TFolder> {
    const normalized = normalizePath(path);
    this.folders.add(normalized);
    return new TFolder(normalized);
  }

  // ---- 测试辅助 ----

  has(path: string): boolean {
    return this.contents.has(normalizePath(path));
  }

  readText(path: string): string {
    const content = this.contents.get(normalizePath(path));
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  }

  readJson<T = unknown>(path: string): T {
    return JSON.parse(this.readText(path)) as T;
  }

  writeText(path: string, content: string): void {
    const normalized = normalizePath(path);
    this.contents.set(normalized, content);
    this.mtimes.set(normalized, Date.now());
  }

  /** 删除文件，模拟用户在 Obsidian 里删掉源文件 */
  removeFile(path: string): void {
    const normalized = normalizePath(path);
    this.contents.delete(normalized);
    this.mtimes.delete(normalized);
  }

  listFiles(): string[] {
    return Array.from(this.contents.keys()).sort();
  }

  /** 测试专用：直接给定文件对象的 mtime，绕过写入时间 */
  setMtime(path: string, mtime: number): void {
    const normalized = normalizePath(path);
    this.mtimes.set(normalized, mtime);
  }

  fileAt(path: string): TFile {
    const normalized = normalizePath(path);
    const file = new TFile(normalized, this.mtimes.get(normalized) ?? Date.now());
    const parentPath = normalized.split("/").slice(0, -1).join("/");
    file.parent = new TFolder(parentPath);
    file.stat.size = (this.contents.get(normalized) ?? "").length;
    return file;
  }

  /** 供 adapter 使用：不做存在性检查的底层写入 */
  rawWrite(path: string, data: string): void {
    if (this.options.failWrite?.(normalizePath(path))) {
      throw new Error(`EACCES: ${path}`);
    }
    const normalized = normalizePath(path);
    const parentPath = normalized.split("/").slice(0, -1).join("/");
    if (parentPath && !this.folders.has(parentPath)) {
      throw new Error(`ENOENT: parent folder missing for ${normalized}`);
    }
    this.rawWriteUnchecked(normalized, data);
  }

  rawWriteUnchecked(path: string, data: string): void {
    this.contents.set(path, data);
    this.mtimes.set(path, Date.now());
  }

  rawRead(path: string): string {
    const content = this.contents.get(normalizePath(path));
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  }

  rawExists(path: string): boolean {
    const normalized = normalizePath(path);
    return this.contents.has(normalized) || this.folders.has(normalized);
  }

  rawMkdir(path: string): void {
    const normalized = normalizePath(path);
    if (this.folders.has(normalized)) {
      throw new Error(`Folder already exists: ${normalized}`);
    }
    this.folders.add(normalized);
  }

  rawRemove(path: string): void {
    const normalized = normalizePath(path);
    if (!this.contents.delete(normalized)) {
      throw new Error(`ENOENT: ${path}`);
    }
    this.mtimes.delete(normalized);
  }

  rawList(path: string): { files: string[]; folders: string[] } {
    const prefix = path ? `${normalizePath(path)}/` : "";
    const files: string[] = [];
    const folders: string[] = [];
    for (const file of this.contents.keys()) {
      if (file.startsWith(prefix) && !file.slice(prefix.length).includes("/")) {
        files.push(file);
      }
    }
    for (const folder of this.folders) {
      if (folder.startsWith(prefix) && !folder.slice(prefix.length).includes("/")) {
        folders.push(folder);
      }
    }
    return { files, folders };
  }

  private ensureParentFolders(path: string): void {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      this.folders.add(current);
    }
  }
}

export class FakeAdapter {
  constructor(private readonly vault: FakeVault) {}

  async exists(path: string): Promise<boolean> {
    return this.vault.rawExists(path);
  }

  async read(path: string): Promise<string> {
    return this.vault.rawRead(path);
  }

  async write(path: string, data: string): Promise<void> {
    this.vault.writeLog.push(normalizePath(path));
    this.vault.rawWrite(path, data);
  }

  async mkdir(path: string): Promise<void> {
    this.vault.rawMkdir(path);
  }

  async remove(path: string): Promise<void> {
    this.vault.rawRemove(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    return this.vault.rawList(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const content = this.vault.rawRead(from);
    this.vault.rawWriteUnchecked(normalizePath(to), content);
    this.vault.rawRemove(from);
  }
}

/** 构造一个只含 vault 的 App 替身，够 AnnotationStore 使用 */
export function createApp(options: FakeVaultOptions = {}): { app: any; vault: FakeVault } {
  const vault = new FakeVault(options);
  return { app: { vault }, vault };
}

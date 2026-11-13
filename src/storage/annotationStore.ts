/**
 * [INPUT]: 依赖 obsidian App/Vault/Adapter 的文件读写能力，依赖 storage/types 的 sidecar JSON 合约
 * [OUTPUT]: 对外提供 AnnotationStore，负责 Markdown/PDF/EPUB 的 .obsidian-annotations sidecar 文件、索引、标签索引与标签字典、缓存、导出、孤立批注清理与文件哈希校验迁移
 * [POS]: storage 模块的唯一持久化入口，隔离原始 Markdown 与注释数据
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { App, normalizePath, Notice, TFile } from "obsidian";

import { relocateDocumentAnchors } from "../anchor/textAnchor";
import {
  AnnotationIndex,
  AnnotationIndexEntry,
  AnnotationColor,
  AnnotationExportFormat,
  CommentAnnotation,
  EMPTY_INDEX,
  FileAnnotationDocument,
  HighlightAnnotation,
  PdfCommentAnnotation,
  PdfHighlightAnnotation,
  PdfReadingProgress,
  EpubHighlightAnnotation,
  EpubCommentAnnotation,
  EpubReadingProgress,
  ReadingBookmark,
} from "./types";
import { normalizeTags, sortTagKeys, tagKey } from "./tags";

const STORE_DIR = ".obsidian-annotations";
const INDEX_PATH = normalizePath(`${STORE_DIR}/index.json`);
const MAX_LEGACY_SIDECAR_NAME_LENGTH = 180;
const MAX_COMPACT_SIDECAR_PREFIX_LENGTH = 96;

interface ExportDocumentSource {
  filePath: string;
  document: FileAnnotationDocument;
}

interface ExportEntry {
  id: string;
  kind: "highlight" | "note";
  mode: "md" | "pdf" | "epub";
  sourcePath: string;
  color: AnnotationColor;
  text: string;
  content: string;
  createdAt: string;
  pageNumber: number | null;
  chapter?: string;
  cfiRange?: string;
  startOffset: number;
}

/** 一条待改标签的批注定位（跨文档批量操作用） */
export interface TagRef {
  filePath: string;
  annotationId: string;
}

/** 标签字典项：key 用于比较，name 用于展示 */
export interface TagDictionaryEntry {
  key: string;
  name: string;
  /** 含该标签的文件数（来自索引，O(文件数) 即可得出） */
  fileCount: number;
}

/** 某个标签命中的文件 */
export interface TaggedFileEntry {
  filePath: string;
  /** 该文件内的批注总数，用于排序与展示 */
  totalAnnotations: number;
}

export class AnnotationStoreReadError extends Error {
  constructor(readonly path: string, readonly originalError: unknown) {
    super(`Failed to read annotation sidecar JSON: ${path}`);
    this.name = "AnnotationStoreReadError";
  }
}

export class AnnotationStoreWriteError extends Error {
  constructor(readonly path: string, readonly originalError: unknown) {
    super(`Failed to write annotation sidecar JSON: ${path}`);
    this.name = "AnnotationStoreWriteError";
  }
}

export class AnnotationStore {
  private readonly documents = new Map<string, FileAnnotationDocument>();
  private index: AnnotationIndex = EMPTY_INDEX;
  private changeVersion = 0;

  constructor(private readonly app: App) {}

  get version(): number {
    return this.changeVersion;
  }

  async initialize(): Promise<void> {
    await this.ensureStoreDir();
    this.index = await this.readJson<AnnotationIndex>(INDEX_PATH, EMPTY_INDEX, { allowCorruptFallback: true });
  }

  getCachedDocument(filePath: string): FileAnnotationDocument | null {
    return this.documents.get(this.toCacheKey(filePath)) ?? null;
  }

  async getIndexedDocuments(): Promise<FileAnnotationDocument[]> {
    const documents: FileAnnotationDocument[] = [];
    const filePaths = Object.keys(this.index.files).sort((left, right) => left.localeCompare(right));

    for (const filePath of filePaths) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) {
        continue;
      }

      documents.push(await this.getDocument(file));
    }

    return documents;
  }

  /** 统计「源文件已删除、批注 sidecar 仍残留」的条目数（只读，不修改数据） */
  countOrphanedDocuments(): number {
    let count = 0;
    for (const filePath of Object.keys(this.index.files)) {
      if (!(this.app.vault.getAbstractFileByPath(filePath) instanceof TFile)) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * 清理源文件已删除的批注条目：删除对应 sidecar JSON 与 index 条目，返回清理数量。
   * 只处理索引中存在、但库中已不存在的文件；现存文件的批注一个都不动。
   * 由设置页手动触发（不做自动删除，避免误删文件后回收站恢复时批注已被清掉）。
   */
  async cleanupOrphanedDocuments(): Promise<number> {
    const nextFiles: AnnotationIndex["files"] = { ...this.index.files };
    let removed = 0;

    for (const [filePath, entry] of Object.entries(this.index.files)) {
      if (this.app.vault.getAbstractFileByPath(filePath) instanceof TFile) {
        continue;
      }

      try {
        // 索引记录的路径 + 当前命名规则算出的两套路径都尝试删除，
        // 覆盖历史 legacy/compact 命名差异导致的残留。
        const candidates = new Set<string>([
          entry?.sidecarPath,
          this.toSidecarPath(filePath),
          this.toLegacySidecarPath(filePath),
        ]);
        for (const candidate of candidates) {
          if (candidate) {
            await this.deleteIfExists(candidate);
          }
        }
      } catch (error) {
        console.warn("yh-inklight: 删除孤儿批注 sidecar 失败", filePath, error);
      }

      delete nextFiles[filePath];
      this.documents.delete(this.toCacheKey(filePath));
      removed += 1;
    }

    if (removed > 0) {
      this.index = { ...this.index, files: nextFiles };
      await this.writeIndex();
      this.changeVersion += 1;
    }

    return removed;
  }

  async getDocument(file: TFile): Promise<FileAnnotationDocument> {
    const filePath = this.normalizeVaultPath(file.path);
    const cacheKey = this.toCacheKey(filePath);
    const cached = this.documents.get(cacheKey);
    if (cached) {
      return cached;
    }

    const sidecarPath = this.toSidecarPath(filePath);
    const fallback = await this.createEmptyDocument(file);
    const document = await this.readJson<FileAnnotationDocument>(sidecarPath, fallback);
    const normalized = await this.reconcileDocumentHash(file, this.normalizeDocument(document, filePath));
    this.documents.set(cacheKey, normalized);
    return normalized;
  }

  /**
   * 校验 sidecar 记录的文件哈希：源文件被外部修改、同步覆盖，或删除后在同路径
   * 新建同名文件（旧批注"复活"到无关内容上）时，哈希会与 sidecar 不一致。
   * 此时按当前正文重新迁移锚点——仍能定位的保留，定位不到的标记 orphaned
   * （阅读视图不渲染、侧栏置灰仍可见，数据不删），并写入新哈希避免重复计算。
   * 仅当存在批注且文件 mtime 晚于 sidecar 保存时间时才读全文算哈希，避免每次加载都开销。
   */
  private async reconcileDocumentHash(
    file: TFile,
    document: FileAnnotationDocument,
  ): Promise<FileAnnotationDocument> {
    if (file.extension.toLowerCase() !== "md" || !document.fileHash) {
      return document;
    }

    const hasAnnotations = document.highlights.length > 0 || document.comments.length > 0;
    if (!hasAnnotations) {
      return document;
    }

    const savedAt = Date.parse(document.lastModified);
    // 插件运行期间的正常编辑由 vault modify 监听即时迁移并刷新 lastModified，
    // mtime 通常早于它；只有文件在插件未运行时被改动（同步/外部编辑/删除重建）
    // 才会出现 mtime 明显晚于 sidecar 保存时间。留 2s 余量防时钟误差。
    const fileChanged = Number.isFinite(savedAt) ? file.stat.mtime > savedAt + 2000 : true;
    if (!fileChanged) {
      return document;
    }

    const fileHash = await this.hashFile(file);
    if (fileHash === document.fileHash) {
      return document;
    }

    const source = await this.app.vault.cachedRead(file);
    const relocated: FileAnnotationDocument = {
      ...relocateDocumentAnchors(source, document),
      fileHash,
      lastModified: new Date().toISOString(),
    };

    const orphanedCount = [...relocated.highlights, ...relocated.comments].filter((item) => item.orphaned).length;
    if (orphanedCount > 0) {
      console.warn(`yh-inklight: ${file.path} 内容已变化，${orphanedCount} 条批注无法定位（已标记失效，数据保留）`);
    }

    try {
      await this.saveDocument(relocated);
    } catch (error) {
      console.warn("yh-inklight: 保存迁移后的批注失败", error);
    }

    return relocated;
  }

  async saveDocument(document: FileAnnotationDocument): Promise<void> {
    const filePath = this.normalizeVaultPath(document.filePath);
    const sidecarPath = this.toSidecarPath(filePath);
    const normalized = this.normalizeDocument(document, filePath);
    const entry = this.toIndexEntry(normalized, sidecarPath);
    const nextIndex: AnnotationIndex = {
      version: 2,
      files: {
        ...this.index.files,
        [normalized.filePath]: entry,
      },
      tagNames: this.mergeTagNames(normalized, entry),
    };

    try {
      await this.ensureStoreDir();
      await this.app.vault.adapter.write(sidecarPath, JSON.stringify(normalized, null, 2));
      const persisted = await this.readExistingJson<FileAnnotationDocument>(sidecarPath);
      this.verifyPersistedDocument(normalized, persisted, sidecarPath);
      await this.writeIndex(nextIndex);
    } catch (error) {
      new Notice(`墨光批注未保存，请检查写入权限或同步状态：${sidecarPath}`);
      throw new AnnotationStoreWriteError(sidecarPath, error);
    }

    this.documents.set(this.toCacheKey(normalized.filePath), normalized);
    this.index = nextIndex;
    this.changeVersion += 1;
  }

  async addHighlight(file: TFile, highlight: HighlightAnnotation): Promise<FileAnnotationDocument> {
    const document = await this.getDocument(file);
    const nextDocument: FileAnnotationDocument = {
      ...document,
      highlights: [...document.highlights, highlight].sort((a, b) => a.anchor.startOffset - b.anchor.startOffset),
      lastModified: new Date().toISOString(),
    };
    await this.saveDocument(nextDocument);
    return nextDocument;
  }

  async addComment(file: TFile, comment: CommentAnnotation): Promise<FileAnnotationDocument> {
    const document = await this.getDocument(file);
    const nextDocument: FileAnnotationDocument = {
      ...document,
      comments: [...document.comments, comment].sort((a, b) => a.anchor.startOffset - b.anchor.startOffset),
      lastModified: new Date().toISOString(),
    };
    await this.saveDocument(nextDocument);
    return nextDocument;
  }

  async addPdfHighlight(file: TFile, highlight: PdfHighlightAnnotation): Promise<FileAnnotationDocument> {
    const document = await this.getDocument(file);
    const nextDocument: FileAnnotationDocument = {
      ...document,
      pdfHighlights: [...document.pdfHighlights, highlight].sort((a, b) => a.anchor.pageNumber - b.anchor.pageNumber),
      lastModified: new Date().toISOString(),
    };
    await this.saveDocument(nextDocument);
    return nextDocument;
  }

  async addPdfComment(file: TFile, comment: PdfCommentAnnotation): Promise<FileAnnotationDocument> {
    const document = await this.getDocument(file);
    const nextDocument: FileAnnotationDocument = {
      ...document,
      pdfComments: [...document.pdfComments, comment].sort((a, b) => a.anchor.pageNumber - b.anchor.pageNumber),
      lastModified: new Date().toISOString(),
    };
    await this.saveDocument(nextDocument);
    return nextDocument;
  }

  async updatePdfComment(file: TFile, comment: PdfCommentAnnotation): Promise<FileAnnotationDocument> {
    const document = await this.getDocument(file);
    const nextDocument: FileAnnotationDocument = {
      ...document,
      pdfComments: document.pdfComments.map((item) => (item.id === comment.id ? comment : item)),
      lastModified: new Date().toISOString(),
    };
    await this.saveDocument(nextDocument);
    return nextDocument;
  }

  async updateComment(file: TFile, comment: CommentAnnotation): Promise<FileAnnotationDocument> {
    const document = await this.getDocument(file);
    const nextDocument: FileAnnotationDocument = {
      ...document,
      comments: document.comments.map((item) => (item.id === comment.id ? comment : item)),
      lastModified: new Date().toISOString(),
    };
    await this.saveDocument(nextDocument);
    return nextDocument;
  }

  async updateCommentContent(
    file: TFile,
    commentId: string,
    content: string,
    title?: string,
  ): Promise<FileAnnotationDocument> {
    const document = await this.getDocument(file);
    const now = new Date().toISOString();
    const nextDocument: FileAnnotationDocument = {
      ...document,
      comments: document.comments.map((item) => {
        if (item.id !== commentId) {
          return item;
        }

        return {
          ...item,
          title,
          content,
          updatedAt: now,
        };
      }),
      lastModified: now,
    };
    await this.saveDocument(nextDocument);
    return nextDocument;
  }

  async updatePdfCommentContent(
    file: TFile,
    commentId: string,
    content: string,
    title?: string,
  ): Promise<FileAnnotationDocument> {
    const document = await this.getDocument(file);
    const now = new Date().toISOString();
    const nextDocument: FileAnnotationDocument = {
      ...document,
      pdfComments: document.pdfComments.map((item) => {
        if (item.id !== commentId) {
          return item;
        }

        return {
          ...item,
          title,
          content,
          updatedAt: now,
        };
      }),
      lastModified: now,
    };
    await this.saveDocument(nextDocument);
    return nextDocument;
  }

  async removeAnnotation(file: TFile, annotationId: string): Promise<FileAnnotationDocument> {
    const document = await this.getDocument(file);
    const nextDocument: FileAnnotationDocument = {
      ...document,
      highlights: document.highlights.filter((item) => item.id !== annotationId),
      comments: document.comments.filter((item) => item.id !== annotationId),
      pdfHighlights: document.pdfHighlights.filter((item) => item.id !== annotationId),
      pdfComments: document.pdfComments.filter((item) => item.id !== annotationId),
      epubHighlights: document.epubHighlights.filter((item) => item.id !== annotationId),
      epubComments: document.epubComments.filter((item) => item.id !== annotationId),
      bookmarks: document.bookmarks.filter((item) => item.id !== annotationId),
      lastModified: new Date().toISOString(),
    };
    await this.saveDocument(nextDocument);
    return nextDocument;
  }

  /**
   * 给一组批注写入同一份标签（覆盖式）。
   * 按 filePath 分组，每个文件只 saveDocument 一次，避免重复落盘。
   * tags 为空数组时删除字段，使数据回到「无标签」状态。
   */
  async setTags(refs: readonly TagRef[], tags: readonly string[]): Promise<void> {
    if (refs.length === 0) {
      return;
    }

    const nextTags = normalizeTags(tags);
    const grouped = new Map<string, Set<string>>();
    for (const ref of refs) {
      const path = this.normalizeVaultPath(ref.filePath);
      const ids = grouped.get(path) ?? new Set<string>();
      ids.add(ref.annotationId);
      grouped.set(path, ids);
    }

    for (const [path, ids] of grouped) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        continue;
      }

      const document = await this.getDocument(file);
      const applyTags = <T extends { id: string; tags?: string[] }>(item: T): T => {
        if (!ids.has(item.id)) {
          return item;
        }
        const clone: T = { ...item };
        if (nextTags.length > 0) {
          clone.tags = [...nextTags];
        } else {
          delete clone.tags;
        }
        return clone;
      };

      const nextDocument: FileAnnotationDocument = {
        ...document,
        highlights: document.highlights.map(applyTags),
        comments: document.comments.map(applyTags),
        pdfHighlights: document.pdfHighlights.map(applyTags),
        pdfComments: document.pdfComments.map(applyTags),
        epubHighlights: document.epubHighlights.map(applyTags),
        epubComments: document.epubComments.map(applyTags),
        lastModified: new Date().toISOString(),
      };
      await this.saveDocument(nextDocument);
    }
  }

  /**
   * 标签字典（含文件数），按文件数降序；数据来自内存索引，不读磁盘。
   * 会过滤掉源文件已删除的条目，保证「字典里的数字」与「点进去看到的文件」一致
   * （否则删除文件后左栏仍显示该标签，点进去却是空的）。
   */
  getTagDictionary(): TagDictionaryEntry[] {
    const counts = new Map<string, number>();
    for (const [filePath, entry] of Object.entries(this.index.files)) {
      if (!(this.app.vault.getAbstractFileByPath(filePath) instanceof TFile)) {
        continue;
      }
      for (const key of entry.tags ?? []) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    const names = this.index.tagNames ?? {};
    return Array.from(counts.entries())
      .map(([key, fileCount]) => ({ key, name: names[key] ?? key, fileCount }))
      .sort((left, right) => right.fileCount - left.fileCount || left.name.localeCompare(right.name));
  }

  /** 某标签命中的文件（已过滤掉源文件已删除的条目），按批注总数降序 */
  getFilesForTag(key: string): TaggedFileEntry[] {
    const result: TaggedFileEntry[] = [];
    for (const [filePath, entry] of Object.entries(this.index.files)) {
      if (!(entry.tags ?? []).includes(key)) {
        continue;
      }
      if (!(this.app.vault.getAbstractFileByPath(filePath) instanceof TFile)) {
        continue;
      }
      result.push({
        filePath,
        totalAnnotations:
          entry.highlightCount + entry.commentCount + entry.epubHighlightCount + entry.epubCommentCount,
      });
    }

    return result.sort(
      (left, right) =>
        right.totalAnnotations - left.totalAnnotations || left.filePath.localeCompare(right.filePath),
    );
  }

  /** 标签比较键 → 展示名，未登记时回退到 key 本身 */
  getTagDisplayName(key: string): string {
    return this.index.tagNames?.[key] ?? key;
  }

  /**
   * v1 → v2 索引升级。
   * 标签是 v2 新增字段，v1 数据不可能含标签，因此无需扫描 sidecar，
   * 只推进版本号并落盘即可，实测零耗时。
   */
  async ensureTagIndex(): Promise<boolean> {
    if (this.index.version >= 2) {
      return false;
    }

    this.index = {
      version: 2,
      files: this.index.files,
      tagNames: this.index.tagNames ?? {},
    };
    await this.writeIndex(this.index);
    return true;
  }

  async migrateFilePath(oldPath: string, file: TFile): Promise<void> {
    const normalizedOldPath = this.normalizeVaultPath(oldPath);
    const oldSidecar = this.toSidecarPath(normalizedOldPath);
    const oldDocument = await this.readJson<FileAnnotationDocument | null>(oldSidecar, null);
    if (!oldDocument) {
      return;
    }

    const nextDocument: FileAnnotationDocument = {
      ...oldDocument,
      filePath: this.normalizeVaultPath(file.path),
      fileHash: await this.hashFile(file),
      lastModified: new Date().toISOString(),
    };

    await this.saveDocument(nextDocument);
    await this.deleteIfExists(oldSidecar);
    delete this.index.files[normalizedOldPath];
    await this.writeIndex();
    this.documents.delete(this.toCacheKey(normalizedOldPath));

    // 同步迁移摘录导出文件（*-notes.md / 《名》摘录.md）：更新内部 source 路径引用 + 重命名文件。
    await this.migrateExcerptFile(normalizedOldPath, this.normalizeVaultPath(file.path));
  }

  /**
   * 重命名/移动源文件后，把对应的摘录导出文件一并迁移：
   * 1. 文件名从旧 basename 派生改为新 basename 派生（兼容 {-notes.md} 与 《名》摘录.md 两种历史格式）；
   * 2. 文件内容里所有指向旧路径的 source 引用（标题、[[wikilink]]、data-yh-source-path）替换为新路径。
   * 摘录文件不存在时静默跳过。
   */
  private async migrateExcerptFile(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) {
      return;
    }
    const oldBase = oldPath.replace(/\.[^.]+$/, "");
    const newBase = newPath.replace(/\.[^.]+$/, "");
    const parent = newPath.split(/[\\/]/).slice(0, -1).join("/") || "/";
    // 候选文件名：v0.16.3 起统一 {basename}-notes.md；早期为 《basename》摘录.md
    const candidates = [
      `${oldBase.split(/[\\/]/).pop()}-notes.md`,
      `《${oldBase.split(/[\\/]/).pop()}》摘录.md`,
    ];
    for (const candidate of candidates) {
      const candidatePath = normalizePath(`${parent}/${candidate}`);
      const excerptFile = this.app.vault.getAbstractFileByPath(candidatePath);
      if (!(excerptFile instanceof TFile)) {
        continue;
      }
      try {
        const content = await this.app.vault.read(excerptFile);
        // 替换内容中所有旧路径引用（标题、wikilink、hidden anchor）
        const updated = content.split(oldPath).join(newPath);
        const newName = candidate.replace(oldBase.split(/[\\/]/).pop()!, newBase.split(/[\\/]/).pop()!);
        const targetPath = normalizePath(`${parent}/${newName}`);
        if (updated !== content) {
          await this.app.vault.modify(excerptFile, updated);
        }
        if (targetPath !== candidatePath && !this.app.vault.getAbstractFileByPath(targetPath)) {
          await this.app.vault.rename(excerptFile, targetPath);
        }
      } catch (error) {
        console.warn("yh-inklight: migrate excerpt file failed", candidatePath, error);
      }
    }
  }

  // ===== EPUB 标注 CRUD =====

  async addEpubHighlight(file: TFile, highlight: EpubHighlightAnnotation): Promise<FileAnnotationDocument> {
    const document = await this.getDocument(file);
    const nextDocument: FileAnnotationDocument = {
      ...document,
      epubHighlights: [...document.epubHighlights, highlight],
      lastModified: new Date().toISOString(),
    };
    await this.saveDocument(nextDocument);
    return nextDocument;
  }

  async addEpubComment(file: TFile, comment: EpubCommentAnnotation): Promise<FileAnnotationDocument> {
    const document = await this.getDocument(file);
    const nextDocument: FileAnnotationDocument = {
      ...document,
      epubComments: [...document.epubComments, comment],
      lastModified: new Date().toISOString(),
    };
    await this.saveDocument(nextDocument);
    return nextDocument;
  }

  async updateEpubComment(file: TFile, comment: EpubCommentAnnotation): Promise<FileAnnotationDocument> {
    const document = await this.getDocument(file);
    const nextDocument: FileAnnotationDocument = {
      ...document,
      epubComments: document.epubComments.map((item) => (item.id === comment.id ? comment : item)),
      lastModified: new Date().toISOString(),
    };
    await this.saveDocument(nextDocument);
    return nextDocument;
  }

  /**
   * 原位更新一条 epub 划线（颜色/样式/标签）。
   * 给「只打标签、不写笔记」的场景用：高亮不必被迫转成 comment。
   */
  async updateEpubHighlight(file: TFile, highlight: EpubHighlightAnnotation): Promise<FileAnnotationDocument> {
    const document = await this.getDocument(file);
    const nextDocument: FileAnnotationDocument = {
      ...document,
      epubHighlights: document.epubHighlights.map((item) => (item.id === highlight.id ? highlight : item)),
      lastModified: new Date().toISOString(),
    };
    await this.saveDocument(nextDocument);
    return nextDocument;
  }

  // ===== EPUB 进度 =====

  async getEpubProgress(file: TFile): Promise<EpubReadingProgress | null> {
    const cacheKey = this.toCacheKey(file.path);
    const cached = this.documents.get(cacheKey);
    if (cached) {
      return cached.epubProgress ?? null;
    }
    const sidecarPath = this.toSidecarPath(file.path);
    const sidecar = await this.readJson<FileAnnotationDocument | null>(sidecarPath, null);
    if (!sidecar) {
      return null;
    }
    const normalized = this.normalizeDocument(sidecar, this.normalizeVaultPath(file.path));
    this.documents.set(cacheKey, normalized);
    return normalized.epubProgress ?? null;
  }

  async saveEpubProgress(file: TFile, progress: EpubReadingProgress): Promise<void> {
    const document = await this.getDocument(file);
    await this.saveDocument({
      ...document,
      epubProgress: progress,
      lastModified: new Date().toISOString(),
    });
  }
  // ===== PDF 进度 =====

  async getPdfProgress(file: TFile): Promise<PdfReadingProgress | null> {
    const document = await this.getDocument(file);
    return document.pdfProgress ?? null;
  }

  async savePdfProgress(file: TFile, progress: PdfReadingProgress): Promise<void> {
    const document = await this.getDocument(file);
    await this.saveDocument({
      ...document,
      pdfProgress: progress,
      lastModified: new Date().toISOString(),
    });
  }

  // ===== 书签（EPUB/PDF 通用）=====

  async addBookmark(file: TFile, bookmark: ReadingBookmark): Promise<FileAnnotationDocument> {
    const document = await this.getDocument(file);
    const nextDocument: FileAnnotationDocument = {
      ...document,
      bookmarks: [...document.bookmarks, bookmark],
      lastModified: new Date().toISOString(),
    };
    await this.saveDocument(nextDocument);
    return nextDocument;
  }

  async removeBookmark(file: TFile, bookmarkId: string): Promise<FileAnnotationDocument> {
    const document = await this.getDocument(file);
    const nextDocument: FileAnnotationDocument = {
      ...document,
      bookmarks: document.bookmarks.filter((item) => item.id !== bookmarkId),
      lastModified: new Date().toISOString(),
    };
    await this.saveDocument(nextDocument);
    return nextDocument;
  }

  async exportNotes(file: TFile, format: AnnotationExportFormat = "summary"): Promise<TFile> {
    const document = await this.getDocument(file);
    const baseName = file.basename || file.name.replace(/\.md$/i, "");
    const suffix = format === "summary" ? "" : `-${format}`;
    const targetPath = normalizePath(`${file.parent?.path ?? ""}/${baseName}-notes${suffix}.md`);
    const lines = buildExportLines(`Notes for ${file.path}`, [{ filePath: file.path, document }], format);

    const existing = this.app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, lines.join("\n"));
      return existing;
    }

    return this.app.vault.create(targetPath, lines.join("\n"));
  }

  async exportAllNotes(format: AnnotationExportFormat = "summary"): Promise<TFile> {
    const documents = await this.getIndexedDocuments();
    const suffix = format === "summary" ? "" : `-${format}`;
    const targetPath = normalizePath(`inklight-all-notes${suffix}.md`);
    const sources = documents.map((document) => ({ filePath: document.filePath, document }));
    const lines = buildExportLines("墨光批注全库汇总", sources, format);

    const existing = this.app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, lines.join("\n"));
      return existing;
    }

    return this.app.vault.create(targetPath, lines.join("\n"));
  }

  async testWriteAccess(): Promise<string> {
    await this.ensureStoreDir();
    const testPath = normalizePath(`${STORE_DIR}/.write-test.json`);
    const payload = JSON.stringify({ ok: true, timestamp: new Date().toISOString() }, null, 2);

    try {
      await this.app.vault.adapter.write(testPath, payload);
      const persisted = await this.app.vault.adapter.read(testPath);
      if (persisted !== payload) {
        throw new Error("Write test content mismatch");
      }
      await this.deleteIfExists(testPath);
      return testPath;
    } catch (error) {
      new Notice(`墨光批注存储测试失败：${testPath}`);
      throw new AnnotationStoreWriteError(testPath, error);
    }
  }


  async hashFile(file: TFile): Promise<string> {
    if (file.extension === "md") {
      return this.hashString(await this.app.vault.cachedRead(file));
    }

    const bytes = await this.app.vault.readBinary(file);
    return this.hashBytes(bytes);
  }

  toSidecarPath(filePath: string): string {
    const legacyPath = this.toLegacySidecarPath(filePath);
    const legacyName = legacyPath.split("/").pop() ?? "";
    if (legacyName.length <= MAX_LEGACY_SIDECAR_NAME_LENGTH) {
      return legacyPath;
    }

    return this.toCompactSidecarPath(filePath);
  }

  private toLegacySidecarPath(filePath: string): string {
    const safeName = this.normalizeVaultPath(filePath)
      .toLowerCase()
      .split(/[\\/]/)
      .map((part) => encodeURIComponent(part))
      .join("__");
    return normalizePath(`${STORE_DIR}/${safeName}.json`);
  }

  private toCompactSidecarPath(filePath: string): string {
    const normalizedPath = this.normalizeVaultPath(filePath).toLowerCase();
    const fileName = normalizedPath.split(/[\\/]/).pop() ?? "annotation";
    const encodedName = encodeURIComponent(fileName).replace(/%/g, "_").replace(/[^a-z0-9._-]/g, "_");
    const prefix = encodedName.slice(0, MAX_COMPACT_SIDECAR_PREFIX_LENGTH).replace(/[._-]+$/g, "") || "annotation";
    return normalizePath(`${STORE_DIR}/${prefix}--${hashPath(normalizedPath)}.json`);
  }

  private async createEmptyDocument(file: TFile): Promise<FileAnnotationDocument> {
    return {
      filePath: this.normalizeVaultPath(file.path),
      fileHash: "",
      lastModified: new Date().toISOString(),
      highlights: [],
      comments: [],
      pdfHighlights: [],
      pdfComments: [],
      epubHighlights: [],
      epubComments: [],
      bookmarks: [],
      canvasNodes: [],
    };
  }

  private normalizeDocument(document: FileAnnotationDocument, filePath: string): FileAnnotationDocument {
    return {
      filePath,
      fileHash: document.fileHash ?? "",
      lastModified: document.lastModified ?? new Date().toISOString(),
      highlights: (document.highlights ?? []).map((item) => this.sanitizeTags(item)),
      comments: (document.comments ?? []).map((item) => this.sanitizeTags(item)),
      pdfHighlights: (document.pdfHighlights ?? []).map((item) => this.sanitizeTags(item)),
      pdfComments: (document.pdfComments ?? []).map((item) => this.sanitizeTags(item)),
      epubHighlights: (document.epubHighlights ?? []).map((item) => this.sanitizeTags(item)),
      epubComments: (document.epubComments ?? []).map((item) => this.sanitizeTags(item)),
      epubProgress: document.epubProgress,
      pdfProgress: document.pdfProgress,
      bookmarks: document.bookmarks ?? [],
      canvasBinding: document.canvasBinding,
      canvasNodes: document.canvasNodes ?? [],
    };
  }

  /**
   * 标签清洗：归一化 + 去重 + 截断；结果为空时删掉字段，
   * 使「无标签」与「老数据」在 JSON 层面完全一致（无需迁移脚本）。
   */
  private sanitizeTags<T extends { tags?: string[] }>(item: T): T {
    if (!item || item.tags === undefined) {
      return item;
    }

    const tags = normalizeTags(item.tags);
    if (tags.length > 0) {
      return { ...item, tags };
    }

    const clone = { ...item };
    delete clone.tags;
    return clone;
  }

  /** 汇总一份文档里出现过的标签：比较键 → 用户最初写法的展示名 */
  private collectTagDisplayNames(document: FileAnnotationDocument): Map<string, string> {
    const names = new Map<string, string>();
    const push = (tags?: string[]) => {
      for (const tag of tags ?? []) {
        const key = tagKey(tag);
        if (key && !names.has(key)) {
          names.set(key, tag);
        }
      }
    };

    for (const item of document.highlights) push(item.tags);
    for (const item of document.comments) push(item.tags);
    for (const item of document.pdfHighlights) push(item.tags);
    for (const item of document.pdfComments) push(item.tags);
    for (const item of document.epubHighlights) push(item.tags);
    for (const item of document.epubComments) push(item.tags);

    return names;
  }

  /** 把本文档的标签并入全局标签字典，保留最早出现的展示名 */
  private mergeTagNames(document: FileAnnotationDocument, entry: AnnotationIndexEntry): Record<string, string> {
    const names: Record<string, string> = { ...(this.index.tagNames ?? {}) };
    const keys = entry.tags ?? [];
    if (keys.length === 0) {
      return names;
    }

    const displayNames = this.collectTagDisplayNames(document);
    for (const key of keys) {
      if (!names[key]) {
        names[key] = displayNames.get(key) ?? key;
      }
    }
    return names;
  }

  private toIndexEntry(document: FileAnnotationDocument, sidecarPath: string): AnnotationIndexEntry {
    const tagKeys = sortTagKeys(Array.from(this.collectTagDisplayNames(document).keys()));
    return {
      filePath: document.filePath,
      sidecarPath,
      fileHash: document.fileHash,
      highlightCount: document.highlights.length + document.pdfHighlights.length,
      commentCount: document.comments.length + document.pdfComments.length,
      epubHighlightCount: document.epubHighlights.length,
      epubCommentCount: document.epubComments.length,
      bookmarkCount: document.bookmarks.length,
      updatedAt: document.lastModified,
      ...(tagKeys.length > 0 ? { tags: tagKeys } : {}),
    };
  }

  private async ensureStoreDir(): Promise<void> {
    await this.ensureDir(STORE_DIR);
  }

  private async ensureDir(path: string): Promise<void> {
    const normalizedPath = normalizePath(path);
    if (!(await this.app.vault.adapter.exists(normalizedPath))) {
      await this.app.vault.adapter.mkdir(normalizedPath);
    }
  }

  private async writeIndex(nextIndex: AnnotationIndex = this.index): Promise<void> {
    await this.ensureStoreDir();
    await this.app.vault.adapter.write(INDEX_PATH, JSON.stringify(nextIndex, null, 2));
  }

  private verifyPersistedDocument(expected: FileAnnotationDocument, persisted: FileAnnotationDocument, sidecarPath: string): void {
    const normalizedPersisted = this.normalizeDocument(persisted, expected.filePath);
    const countsMatch =
      normalizedPersisted.highlights.length === expected.highlights.length &&
      normalizedPersisted.comments.length === expected.comments.length &&
      normalizedPersisted.pdfHighlights.length === expected.pdfHighlights.length &&
      normalizedPersisted.pdfComments.length === expected.pdfComments.length &&
      normalizedPersisted.epubHighlights.length === expected.epubHighlights.length &&
      normalizedPersisted.epubComments.length === expected.epubComments.length &&
      normalizedPersisted.bookmarks.length === expected.bookmarks.length;

    if (
      normalizedPersisted.filePath !== expected.filePath ||
      normalizedPersisted.lastModified !== expected.lastModified ||
      !countsMatch
    ) {
      throw new Error(`Persisted sidecar verification failed: ${sidecarPath}`);
    }
  }

  private async readJson<T>(
    path: string,
    fallback: T,
    options: { allowCorruptFallback?: boolean } = {},
  ): Promise<T> {
    const normalizedPath = normalizePath(path);
    if (!(await this.app.vault.adapter.exists(normalizedPath))) {
      return fallback;
    }

    try {
      return JSON.parse(await this.app.vault.adapter.read(normalizedPath)) as T;
    } catch (error) {
      if (options.allowCorruptFallback) {
        return fallback;
      }
      new Notice(`墨光批注无法读取 ${normalizedPath}，已停止写入以保护批注数据。`);
      throw new AnnotationStoreReadError(normalizedPath, error);
    }
  }

  private async readExistingJson<T>(path: string): Promise<T> {
    const normalizedPath = normalizePath(path);
    if (!(await this.app.vault.adapter.exists(normalizedPath))) {
      throw new Error(`Expected JSON file does not exist: ${normalizedPath}`);
    }

    return JSON.parse(await this.app.vault.adapter.read(normalizedPath)) as T;
  }

  private async deleteIfExists(path: string): Promise<void> {
    const normalizedPath = normalizePath(path);
    if (await this.app.vault.adapter.exists(normalizedPath)) {
      await this.app.vault.adapter.remove(normalizedPath);
    }
  }

  private normalizeVaultPath(filePath: string): string {
    return normalizePath(filePath);
  }

  private toCacheKey(filePath: string): string {
    return this.normalizeVaultPath(filePath).toLowerCase();
  }

  private async hashString(content: string): Promise<string> {
    return this.hashBytes(new TextEncoder().encode(content));
  }

  private async hashBytes(bytes: BufferSource): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
}

function hashPath(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function buildExportLines(
  title: string,
  sources: ExportDocumentSource[],
  format: AnnotationExportFormat,
): string[] {
  const entries = sources.flatMap((source) => collectExportEntries(source));
  const lines = [`# ${title}`, "", `Exported: ${new Date().toISOString()}`, ""];

  if (!entries.length) {
    return [...lines, "No annotations found.", ""];
  }

  if (format === "by-color") {
    return [...lines, ...renderByColor(entries)];
  }

  if (format === "notes-only") {
    return [...lines, ...renderNotesOnly(entries)];
  }

  if (format === "reading-notes") {
    return [...lines, ...renderReadingNotes(entries)];
  }

  return [...lines, ...renderSummary(entries)];
}

function collectExportEntries(source: ExportDocumentSource): ExportEntry[] {
  return [
    ...source.document.highlights.map((highlight): ExportEntry => ({
      id: highlight.id,
      kind: "highlight",
      mode: "md",
      sourcePath: source.filePath,
      color: highlight.color,
      text: highlight.anchor.selectedText,
      content: "",
      createdAt: highlight.createdAt,
      pageNumber: null,
      startOffset: highlight.anchor.startOffset,
    })),
    ...source.document.comments.map((comment): ExportEntry => ({
      id: comment.id,
      kind: "note",
      mode: "md",
      sourcePath: source.filePath,
      color: comment.color,
      text: comment.anchor.selectedText,
      content: comment.content,
      createdAt: comment.updatedAt || comment.createdAt,
      pageNumber: null,
      startOffset: comment.anchor.startOffset,
    })),
    ...source.document.pdfHighlights.map((highlight): ExportEntry => ({
      id: highlight.id,
      kind: "highlight",
      mode: "pdf",
      sourcePath: source.filePath,
      color: highlight.color,
      text: highlight.anchor.selectedText,
      content: "",
      createdAt: highlight.createdAt,
      pageNumber: highlight.anchor.pageNumber,
      startOffset: Number.MAX_SAFE_INTEGER,
    })),
    ...source.document.pdfComments.map((comment): ExportEntry => ({
      id: comment.id,
      kind: "note",
      mode: "pdf",
      sourcePath: source.filePath,
      color: comment.color,
      text: comment.anchor.selectedText,
      content: comment.content,
      createdAt: comment.updatedAt || comment.createdAt,
      pageNumber: comment.anchor.pageNumber,
      startOffset: Number.MAX_SAFE_INTEGER,
    })),
    ...source.document.epubHighlights.map((highlight): ExportEntry => ({
      id: highlight.id,
      kind: "highlight",
      mode: "epub",
      sourcePath: source.filePath,
      color: highlight.color,
      text: highlight.anchor.selectedText,
      content: "",
      createdAt: highlight.createdAt,
      pageNumber: null,
      chapter: highlight.anchor.chapter,
      cfiRange: highlight.anchor.cfiRange,
      startOffset: Number.MAX_SAFE_INTEGER,
    })),
    ...source.document.epubComments.map((comment): ExportEntry => ({
      id: comment.id,
      kind: "note",
      mode: "epub",
      sourcePath: source.filePath,
      color: comment.color,
      text: comment.anchor.selectedText,
      content: comment.note,
      createdAt: comment.createdAt,
      pageNumber: null,
      chapter: comment.anchor.chapter,
      cfiRange: comment.anchor.cfiRange,
      startOffset: Number.MAX_SAFE_INTEGER,
    })),
  ].sort((left, right) => {
    return left.sourcePath.localeCompare(right.sourcePath) || left.startOffset - right.startOffset;
  });
}

function renderSummary(entries: ExportEntry[]): string[] {
  const highlights = entries.filter((entry) => entry.kind === "highlight");
  const notes = entries.filter((entry) => entry.kind === "note");
  return [
    "## Highlights",
    "",
    ...highlights.flatMap((entry) => renderAnnotationBlock(entry)),
    "",
    "## Sticky Notes",
    "",
    ...notes.flatMap((entry) => renderAnnotationBlock(entry)),
  ];
}

function renderByColor(entries: ExportEntry[]): string[] {
  const colors: AnnotationColor[] = ["yellow", "green", "blue", "pink", "orange", "purple"];
  return colors.flatMap((color) => {
    const colorEntries = entries.filter((entry) => entry.color === color);
    if (!colorEntries.length) {
      return [];
    }
    return [
      `## ${color}`,
      "",
      ...colorEntries.flatMap((entry) => {
        return renderAnnotationBlock(entry);
      }),
    ];
  });
}

function renderNotesOnly(entries: ExportEntry[]): string[] {
  const notes = entries.filter((entry) => entry.kind === "note" && entry.content.trim());
  if (!notes.length) {
    return ["No sticky notes found.", ""];
  }
  return ["## Sticky Notes", "", ...notes.flatMap((entry) => renderAnnotationBlock(entry))];
}

function renderReadingNotes(entries: ExportEntry[]): string[] {
  return [
    "## Reading Notes",
    "",
    ...entries.flatMap((entry) => {
      return [`### ${entrySource(entry)}`, "", ...renderAnnotationBlock(entry)];
    }),
  ];
}

function renderAnnotationBlock(entry: ExportEntry): string[] {
  const blockId = `${entry.mode}-${entry.id}`;
  const calloutType = entry.mode === "epub" ? "inklight-epub" : entry.mode === "pdf" ? "inklight-pdf" : "inklight-md";
  const header = `> [!${calloutType}|${entry.color}] ${entrySource(entry)} - ${entry.createdAt} ^${blockId}`;
  const lines = [header];

  for (const line of entry.text.split(/\r?\n/)) {
    lines.push(`> ${line}`);
  }

  if (entry.content.trim()) {
    lines.push(">");
    for (const line of entry.content.split(/\r?\n/)) {
      lines.push(`> Note: ${line}`);
    }
  }

  const backLink = entryBackLink(entry, blockId);
  if (backLink) {
    lines.push(">");
    lines.push(`> ${backLink}`);
  }

  const anchor = hiddenAnchor(entry);
  if (anchor) {
    lines.push(anchor);
  }

  lines.push("");
  return lines;
}

function entryBackLink(entry: ExportEntry, blockId: string): string {
  if (entry.mode === "pdf" && entry.pageNumber) {
    return `[[${entry.sourcePath}#page=${entry.pageNumber}|Back to source]]`;
  }
  if (entry.mode === "epub" && entry.cfiRange) {
    return `[Back to source](#^${blockId})`;
  }
  if (entry.mode === "md") {
    return `[[${entry.sourcePath}|Back to source]]`;
  }
  return "";
}

function hiddenAnchor(entry: ExportEntry): string {
  if (entry.mode === "epub" && entry.cfiRange) {
    return `> <span style="display:none" data-yh-cfi="${escapeHtmlAttribute(entry.cfiRange)}" data-yh-source-path="${escapeHtmlAttribute(entry.sourcePath)}"></span>`;
  }
  if (entry.mode === "pdf" && entry.pageNumber) {
    return `> <span style="display:none" data-yh-pdf-page="${entry.pageNumber}" data-yh-source-path="${escapeHtmlAttribute(entry.sourcePath)}" data-yh-pdf-id="${escapeHtmlAttribute(entry.id)}"></span>`;
  }
  return "";
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function entrySource(entry: ExportEntry): string {
  if (entry.pageNumber) {
    return `${entry.sourcePath} p.${entry.pageNumber}`;
  }
  if (entry.mode === "epub" && entry.chapter?.trim()) {
    return `${entry.sourcePath} · ${entry.chapter.trim()}`;
  }
  return entry.sourcePath;
}

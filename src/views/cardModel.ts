/**
 * [INPUT]: 依赖 storage/types 的批注文档结构、storage/tags 的标签并集
 * [OUTPUT]: 对外提供 SidebarCard 类型与 buildCards 纯函数，把一份 sidecar 文档拍平成可渲染的卡片数组
 * [POS]: views 模块的卡片模型层，被 sidebarView（侧栏）与 tagBoardView（标签总览）共享，避免配对逻辑重复
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import {
  AnnotationColor,
  CommentAnnotation,
  EpubCommentAnnotation,
  EpubHighlightAnnotation,
  FileAnnotationDocument,
  HighlightAnnotation,
  PdfCommentAnnotation,
  PdfHighlightAnnotation,
} from "../storage/types";
import { unionTags } from "../storage/tags";

export type AnnotationKind = "highlight" | "note";
export type AnnotationMode = "md" | "pdf" | "epub";

interface SidebarCardBase {
  id: string;
  kind: AnnotationKind;
  mode: AnnotationMode;
  sourcePath: string;
  color: AnnotationColor;
  text: string;
  content: string;
  createdAt: string;
  startOffset: number;
  pageNumber: number | null;
  cfiRange?: string;
  chapter?: string;
  orphaned?: boolean;
  isCode: boolean;
  /** 卡片级标签：高亮与其笔记的并集，编辑时对两者写同一份数组 */
  tags: string[];
}

export type SidebarCard =
  | (SidebarCardBase & {
      kind: "highlight";
      highlight: HighlightAnnotation | PdfHighlightAnnotation | EpubHighlightAnnotation;
      note: CommentAnnotation | PdfCommentAnnotation | EpubCommentAnnotation | null;
    })
  | (SidebarCardBase & {
      kind: "note";
      highlight: null;
      note: CommentAnnotation | PdfCommentAnnotation | EpubCommentAnnotation;
    });

type TagCarrier = { tags?: string[] };

/** 高亮与笔记的标签并集；两者任一为空都能正确处理 */
function collectTags(highlight: TagCarrier | null, note: TagCarrier | null): string[] {
  return unionTags(highlight?.tags, note?.tags);
}

/**
 * 把一份文档拍平成卡片：每条高亮一张卡（挂上它对应的笔记），
 * 没被任何高亮认领的笔记单独成卡。
 * 纯函数，不依赖 App / View，便于复用与测试。
 */
export function buildCards(document: FileAnnotationDocument): SidebarCard[] {
  const usedNotes = new Set<string>();
  const cards: SidebarCard[] = [];

  for (const highlight of document.highlights) {
    const note = findAttachedMarkdownNote(highlight, document.comments, usedNotes);
    if (note) {
      usedNotes.add(note.id);
    }
    cards.push({
      id: highlight.id,
      kind: "highlight",
      mode: "md",
      sourcePath: document.filePath,
      color: highlight.color,
      text: highlight.anchor.selectedText,
      content: note?.content ?? "",
      createdAt: highlight.createdAt,
      startOffset: highlight.anchor.startOffset,
      pageNumber: null,
      orphaned: highlight.orphaned || note?.orphaned,
      isCode: isCodeAnchor(highlight.anchor),
      tags: collectTags(highlight, note),
      highlight,
      note,
    });
  }

  for (const highlight of document.pdfHighlights) {
    const note = findAttachedPdfNote(highlight, document.pdfComments, usedNotes);
    if (note) {
      usedNotes.add(note.id);
    }
    cards.push({
      id: highlight.id,
      kind: "highlight",
      mode: "pdf",
      sourcePath: document.filePath,
      color: highlight.color,
      text: highlight.anchor.selectedText,
      content: note?.content ?? "",
      createdAt: highlight.createdAt,
      startOffset: Number.MAX_SAFE_INTEGER,
      pageNumber: highlight.anchor.pageNumber,
      orphaned: highlight.orphaned || note?.orphaned,
      isCode: false,
      tags: collectTags(highlight, note),
      highlight,
      note,
    });
  }

  for (const highlight of document.epubHighlights) {
    const note = findAttachedEpubNote(highlight, document.epubComments, usedNotes);
    if (note) {
      usedNotes.add(note.id);
    }
    cards.push({
      id: highlight.id,
      kind: "highlight",
      mode: "epub",
      sourcePath: document.filePath,
      color: highlight.color,
      text: highlight.anchor.selectedText,
      content: note?.note ?? "",
      createdAt: highlight.createdAt,
      startOffset: Number.MAX_SAFE_INTEGER,
      pageNumber: null,
      cfiRange: highlight.anchor.cfiRange,
      chapter: highlight.anchor.chapter,
      orphaned: highlight.orphaned || note?.orphaned,
      isCode: false,
      tags: collectTags(highlight, note),
      highlight,
      note,
    });
  }

  for (const note of document.comments.filter((item) => !usedNotes.has(item.id))) {
    cards.push({
      id: note.id,
      kind: "note",
      mode: "md",
      sourcePath: document.filePath,
      color: note.color,
      text: note.anchor.selectedText,
      content: note.content,
      createdAt: note.createdAt,
      startOffset: note.anchor.startOffset,
      pageNumber: null,
      orphaned: note.orphaned,
      isCode: isCodeAnchor(note.anchor),
      tags: collectTags(null, note),
      highlight: null,
      note,
    });
  }

  for (const note of document.pdfComments.filter((item) => !usedNotes.has(item.id))) {
    cards.push({
      id: note.id,
      kind: "note",
      mode: "pdf",
      sourcePath: document.filePath,
      color: note.color,
      text: note.anchor.selectedText,
      content: note.content,
      createdAt: note.createdAt,
      startOffset: Number.MAX_SAFE_INTEGER,
      pageNumber: note.anchor.pageNumber,
      orphaned: note.orphaned,
      isCode: false,
      tags: collectTags(null, note),
      highlight: null,
      note,
    });
  }

  for (const note of document.epubComments.filter((item) => !usedNotes.has(item.id))) {
    cards.push({
      id: note.id,
      kind: "note",
      mode: "epub",
      sourcePath: document.filePath,
      color: note.color,
      text: note.anchor.selectedText,
      content: note.note,
      createdAt: note.createdAt,
      startOffset: Number.MAX_SAFE_INTEGER,
      pageNumber: null,
      cfiRange: note.anchor.cfiRange,
      chapter: note.anchor.chapter,
      orphaned: note.orphaned,
      isCode: false,
      tags: collectTags(null, note),
      highlight: null,
      note,
    });
  }

  return cards;
}

function findAttachedMarkdownNote(
  highlight: HighlightAnnotation,
  comments: CommentAnnotation[],
  usedNotes: Set<string>,
): CommentAnnotation | null {
  return (
    comments.find((note) => !usedNotes.has(note.id) && note.highlightId === highlight.id) ??
    comments.find((note) => {
      return (
        !usedNotes.has(note.id) &&
        !note.highlightId &&
        note.anchor.startOffset === highlight.anchor.startOffset &&
        note.anchor.selectedText === highlight.anchor.selectedText
      );
    }) ??
    null
  );
}

function findAttachedPdfNote(
  highlight: PdfHighlightAnnotation,
  comments: PdfCommentAnnotation[],
  usedNotes: Set<string>,
): PdfCommentAnnotation | null {
  return (
    comments.find((note) => !usedNotes.has(note.id) && note.highlightId === highlight.id) ??
    comments.find((note) => {
      return (
        !usedNotes.has(note.id) &&
        !note.highlightId &&
        note.anchor.pageNumber === highlight.anchor.pageNumber &&
        note.anchor.selectedText === highlight.anchor.selectedText
      );
    }) ??
    null
  );
}

function findAttachedEpubNote(
  highlight: EpubHighlightAnnotation,
  comments: EpubCommentAnnotation[],
  usedNotes: Set<string>,
): EpubCommentAnnotation | null {
  return comments.find((note) => !usedNotes.has(note.id) && note.anchor.cfiRange === highlight.anchor.cfiRange) ?? null;
}

export function isCodeAnchor(anchor: HighlightAnnotation["anchor"] | PdfHighlightAnnotation["anchor"]): boolean {
  return "isCode" in anchor && Boolean(anchor.isCode);
}

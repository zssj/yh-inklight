/**
 * [INPUT]: 被测 src/views/cardModel.ts
 * [OUTPUT]: 覆盖高亮与笔记的配对规则、孤儿卡片、三端字段映射与标签并集
 * [POS]: L1 纯逻辑测试——侧栏「一条高亮一张卡 + 未认领笔记单独成卡」的契约
 */

import { describe, expect, it } from "vitest";

import { buildCards, isCodeAnchor } from "../../src/views/cardModel";
import {
  CommentAnnotation,
  EpubCommentAnnotation,
  EpubHighlightAnnotation,
  FileAnnotationDocument,
  HighlightAnnotation,
  PdfCommentAnnotation,
  PdfHighlightAnnotation,
  TextAnchor,
} from "../../src/storage/types";

function anchor(text: string, start = 0, isCode = false): TextAnchor {
  return { startOffset: start, endOffset: start + text.length, selectedText: text, prefix: "", suffix: "", isCode };
}

function emptyDocument(): FileAnnotationDocument {
  return {
    filePath: "读书笔记/复利.md",
    fileHash: "",
    lastModified: "2026-01-01T00:00:00.000Z",
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

function highlight(id: string, text: string, start = 0): HighlightAnnotation {
  return { id, color: "yellow", anchor: anchor(text, start), createdAt: "2026-01-01T00:00:00.000Z" };
}

function comment(id: string, text: string, start = 0, highlightId?: string): CommentAnnotation {
  return {
    id,
    highlightId,
    anchor: anchor(text, start),
    content: `笔记-${id}`,
    color: "yellow",
    position: { offsetX: 0, offsetY: 0 },
    collapsed: false,
    author: "me",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    replies: [],
    resolved: false,
  };
}

describe("buildCards - Markdown", () => {
  it("高亮与其笔记合成一张卡，卡片内容取笔记正文", () => {
    const document: FileAnnotationDocument = {
      ...emptyDocument(),
      highlights: [{ ...highlight("h1", "复利效应"), tags: ["金融"] }],
      comments: [{ ...comment("c1", "复利效应", 0, "h1"), tags: ["长期"] }],
    };

    const cards = buildCards(document);

    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe("highlight");
    expect(cards[0].mode).toBe("md");
    expect(cards[0].text).toBe("复利效应");
    expect(cards[0].content).toBe("笔记-c1");
    // 卡片级标签 = 高亮 ∪ 笔记
    expect(cards[0].tags).toEqual(["金融", "长期"]);
  });

  it("笔记没有 highlightId 时，offset 与文字都相同也能配对", () => {
    const document: FileAnnotationDocument = {
      ...emptyDocument(),
      highlights: [highlight("h1", "复利效应", 12)],
      comments: [comment("c1", "复利效应", 12)],
    };

    const cards = buildCards(document);
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe("highlight");
  });

  it("同一位置文字不同则不配对（避免张冠李戴）", () => {
    const document: FileAnnotationDocument = {
      ...emptyDocument(),
      highlights: [highlight("h1", "复利效应", 12)],
      comments: [comment("c1", "完全不同", 12)],
    };

    const cards = buildCards(document);
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.kind)).toEqual(["highlight", "note"]);
  });

  it("一条笔记不会被两张高亮重复认领", () => {
    const document: FileAnnotationDocument = {
      ...emptyDocument(),
      highlights: [highlight("h1", "复利效应", 0), highlight("h2", "复利效应", 0)],
      comments: [comment("c1", "复利效应", 0)],
    };

    const cards = buildCards(document);
    expect(cards.filter((card) => card.content === "笔记-c1")).toHaveLength(1);
    expect(cards).toHaveLength(2);
  });

  it("孤儿笔记单独成卡，标签取自身", () => {
    const document: FileAnnotationDocument = {
      ...emptyDocument(),
      comments: [{ ...comment("c1", "只有笔记"), tags: ["想法"] }],
    };

    const cards = buildCards(document);
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe("note");
    expect(cards[0].highlight).toBeNull();
    expect(cards[0].tags).toEqual(["想法"]);
  });

  it("高亮或笔记任一被标记 orphaned，卡片都置灰", () => {
    const orphanHighlight: FileAnnotationDocument = {
      ...emptyDocument(),
      highlights: [{ ...highlight("h1", "复利效应"), orphaned: true }],
    };
    expect(buildCards(orphanHighlight)[0].orphaned).toBe(true);

    const orphanNote: FileAnnotationDocument = {
      ...emptyDocument(),
      highlights: [highlight("h1", "复利效应")],
      comments: [{ ...comment("c1", "复利效应", 0, "h1"), orphaned: true }],
    };
    expect(buildCards(orphanNote)[0].orphaned).toBe(true);
  });

  it("代码选区的高亮带 isCode 标记", () => {
    const document: FileAnnotationDocument = {
      ...emptyDocument(),
      highlights: [{ id: "h1", color: "blue", anchor: anchor("const a = 1", 0, true), createdAt: "2026-01-01T00:00:00.000Z" }],
    };
    expect(buildCards(document)[0].isCode).toBe(true);
  });
});

describe("buildCards - PDF / EPUB", () => {
  it("PDF 卡片带页码，startOffset 固定为最大值", () => {
    const pdfHighlight: PdfHighlightAnnotation = {
      id: "p1",
      color: "green",
      anchor: { pageNumber: 7, selectedText: "PDF 选区", rects: [] },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const pdfComment: PdfCommentAnnotation = {
      ...comment("pc1", "PDF 选区"),
      anchor: { pageNumber: 7, selectedText: "PDF 选区", rects: [] },
      highlightId: "p1",
    };

    const cards = buildCards({ ...emptyDocument(), pdfHighlights: [pdfHighlight], pdfComments: [pdfComment] });

    expect(cards).toHaveLength(1);
    expect(cards[0].mode).toBe("pdf");
    expect(cards[0].pageNumber).toBe(7);
    expect(cards[0].startOffset).toBe(Number.MAX_SAFE_INTEGER);
    expect(cards[0].content).toBe("笔记-pc1");
  });

  it("EPUB 卡片带 cfiRange 与章节，正文取 note 字段", () => {
    const epubHighlight: EpubHighlightAnnotation = {
      id: "e1",
      color: "pink",
      anchor: { cfiRange: "epubcfi(/6/4!/2/10)", selectedText: "电子书选区", chapter: "第三章" },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const epubComment: EpubCommentAnnotation = {
      id: "ec1",
      anchor: { cfiRange: "epubcfi(/6/4!/2/10)", selectedText: "电子书选区", chapter: "第三章" },
      note: "电子书笔记",
      color: "pink",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const cards = buildCards({ ...emptyDocument(), epubHighlights: [epubHighlight], epubComments: [epubComment] });

    expect(cards).toHaveLength(1);
    expect(cards[0].mode).toBe("epub");
    expect(cards[0].cfiRange).toBe("epubcfi(/6/4!/2/10)");
    expect(cards[0].chapter).toBe("第三章");
    expect(cards[0].content).toBe("电子书笔记");
  });

  it("EPUB 笔记与高亮按 cfiRange 配对", () => {
    const document: FileAnnotationDocument = {
      ...emptyDocument(),
      epubHighlights: [
        {
          id: "e1",
          color: "pink",
          anchor: { cfiRange: "cfi-a", selectedText: "A", chapter: "第一章" },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      epubComments: [
        {
          id: "ec1",
          anchor: { cfiRange: "cfi-a", selectedText: "A", chapter: "第一章" },
          note: "配对成功",
          color: "pink",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };

    const cards = buildCards(document);
    expect(cards).toHaveLength(1);
    expect(cards[0].content).toBe("配对成功");
  });
});

describe("isCodeAnchor", () => {
  it("只有带 isCode 的 MD 锚点返回 true", () => {
    expect(isCodeAnchor(anchor("code", 0, true))).toBe(true);
    expect(isCodeAnchor(anchor("text"))).toBe(false);
    expect(isCodeAnchor({ pageNumber: 1, selectedText: "x", rects: [] })).toBe(false);
  });
});

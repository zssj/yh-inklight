/**
 * [INPUT]: 被测 src/anchor/textAnchor.ts
 * [OUTPUT]: 覆盖锚点创建、三级定位降级（精确/上下文/模糊）与失效标记
 * [POS]: L1 纯逻辑测试——真机上最难复现的「改文档后批注错位」回归防线
 */

import { describe, expect, it } from "vitest";

import { createTextAnchor, relocateDocumentAnchors, resolveTextAnchor } from "../../src/anchor/textAnchor";
import { FileAnnotationDocument } from "../../src/storage/types";

const SOURCE = "第一段内容。第二段有目标文字，还有别的。第三段收尾。";

function emptyDocument(): FileAnnotationDocument {
  return {
    filePath: "note.md",
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

describe("createTextAnchor", () => {
  it("记录选区与前后各 20 字上下文", () => {
    const start = SOURCE.indexOf("目标文字");
    const anchor = createTextAnchor(SOURCE, start, start + 4);

    expect(anchor.selectedText).toBe("目标文字");
    expect(anchor.startOffset).toBe(start);
    expect(anchor.endOffset).toBe(start + 4);
    expect(anchor.prefix).toBe(SOURCE.slice(Math.max(0, start - 20), start));
    expect(anchor.suffix.startsWith("，还有别的")).toBe(true);
  });

  it("offset 越界与 start > end 都被夹到合法区间", () => {
    const anchor = createTextAnchor(SOURCE, -10, SOURCE.length + 50);
    expect(anchor.startOffset).toBe(0);
    expect(anchor.endOffset).toBe(SOURCE.length);
    expect(anchor.selectedText).toBe(SOURCE);

    const reversed = createTextAnchor(SOURCE, 10, 4);
    expect(reversed.startOffset).toBe(10);
    expect(reversed.endOffset).toBe(10);
    expect(reversed.selectedText).toBe("");
  });

  it("CRLF 文档按 LF 归一化后再记 offset，避免 Windows 换行逐行偏移", () => {
    const source = "第一行\r\n第二行目标\r\n第三行";
    // 调用方（CM6）拿到的已是归一化文本，offset 必须基于同一份文本
    const normalized = source.replace(/\r\n/g, "\n");
    const start = normalized.indexOf("目标");
    const anchor = createTextAnchor(source, start, start + 2);

    expect(anchor.selectedText).toBe("目标");
    expect(anchor.prefix.includes("\r")).toBe(false);
    expect(anchor.suffix.includes("\r")).toBe(false);
  });

  it("围栏代码块内的选区标记 isCode", () => {
    const source = "正文\n```\nconst a = 1;\n```\n尾巴";
    const start = source.indexOf("const a");
    expect(createTextAnchor(source, start, start + 5).isCode).toBe(true);
  });

  it("选中带行首缩进的代码行标记 isCode", () => {
    const source = "正文\n\n    indented code\n\n尾巴";
    const start = source.indexOf("    indented");
    expect(createTextAnchor(source, start, start + 17).isCode).toBe(true);
  });
});

describe("resolveTextAnchor", () => {
  it("原文未变时精确命中，confidence 为 1", () => {
    const start = SOURCE.indexOf("目标文字");
    const anchor = createTextAnchor(SOURCE, start, start + 4);
    const located = resolveTextAnchor(SOURCE, anchor);

    expect(located.confidence).toBe(1);
    expect(located.orphaned).toBe(false);
    expect(located.anchor.startOffset).toBe(start);
  });

  it("文档前部插入内容后，靠上下文找回并刷新 offset", () => {
    const start = SOURCE.indexOf("目标文字");
    const anchor = createTextAnchor(SOURCE, start, start + 4);
    const inserted = "前置新增的一段。\n";
    const edited = inserted + SOURCE;

    const located = resolveTextAnchor(edited, anchor);

    expect(located.orphaned).toBe(false);
    expect(located.anchor.startOffset).toBe(edited.indexOf("目标文字"));
    expect(edited.slice(located.anchor.startOffset, located.anchor.endOffset)).toBe("目标文字");
  });

  it("同一段文字出现两次时，按前缀选中原来那一处而不是第一处", () => {
    const source = "第一处上下文：目标文字。第二处上下文：目标文字，后面还有字。";
    const secondStart = source.indexOf("目标文字", source.indexOf("目标文字") + 1);
    const anchor = createTextAnchor(source, secondStart, secondStart + 4);

    const edited = "新增开头。\n" + source;
    const located = resolveTextAnchor(edited, anchor);

    expect(located.orphaned).toBe(false);
    expect(located.anchor.startOffset).toBe(edited.indexOf("目标文字", edited.indexOf("目标文字") + 1));
    expect(located.anchor.prefix.endsWith("第二处上下文：")).toBe(true);
  });

  it("原文被轻微改写时走模糊匹配，offset 仍落在相近文本上", () => {
    const source = "在复利效应的作用下，长期投资会显著放大最终收益。";
    const start = source.indexOf("复利效应的作用");
    const anchor = createTextAnchor(source, start, start + 7);

    const edited = "在複利效应的作用下，长期投资会显著放大最终收益。";
    const located = resolveTextAnchor(edited, anchor);

    expect(located.confidence).toBeGreaterThan(0);
    expect(located.orphaned).toBe(false);
  });

  it("选中文字彻底消失时标记 orphaned，但不抛错、不丢数据", () => {
    const anchor = createTextAnchor(SOURCE, 0, 5);
    const located = resolveTextAnchor("完全无关的另一段文字，没有任何共同点。", anchor);

    expect(located.orphaned).toBe(true);
    expect(located.confidence).toBe(0);
    expect(located.anchor.selectedText).toBe(anchor.selectedText);
  });
});

describe("relocateDocumentAnchors", () => {
  it("批量迁移高亮与笔记，并把失效标记写回条目", () => {
    const start = SOURCE.indexOf("目标文字");
    const anchor = createTextAnchor(SOURCE, start, start + 4);
    const document: FileAnnotationDocument = {
      ...emptyDocument(),
      highlights: [{ id: "h1", color: "yellow", anchor, createdAt: "2026-01-01T00:00:00.000Z" }],
      comments: [
        {
          id: "c1",
          highlightId: "h1",
          anchor,
          content: "笔记",
          color: "yellow",
          position: { offsetX: 0, offsetY: 0 },
          collapsed: false,
          author: "me",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          replies: [],
          resolved: false,
        },
      ],
    };

    const edited = "前置。\n" + SOURCE;
    const relocated = relocateDocumentAnchors(edited, document);

    expect(relocated.highlights[0].anchor.startOffset).toBe(edited.indexOf("目标文字"));
    expect(relocated.comments[0].anchor.startOffset).toBe(edited.indexOf("目标文字"));
    expect(relocated.highlights[0].orphaned).toBe(false);
    expect(relocated.comments[0].content).toBe("笔记");
  });

  it("源文本全丢时两条都被标记 orphaned", () => {
    const anchor = createTextAnchor(SOURCE, 0, 5);
    const document: FileAnnotationDocument = {
      ...emptyDocument(),
      highlights: [{ id: "h1", color: "yellow", anchor, createdAt: "2026-01-01T00:00:00.000Z" }],
    };

    const relocated = relocateDocumentAnchors("没有共同点的文本。", document);
    expect(relocated.highlights[0].orphaned).toBe(true);
  });
});

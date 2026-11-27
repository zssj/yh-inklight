/**
 * [INPUT]: views/sidebarView 的就地更新路径（refreshCardInPlace，私有，测试直取）、views/cardModel 的 buildCards、obsidian 替身
 * [OUTPUT]: 锁住「保存想法不重建列表」：只换那一张卡的 DOM、其余卡片节点原样、随后 requestRender 不重建整表
 * [POS]: L2 视图测试（jsdom）。滚动位置本身要靠真机布局量测，这里锁的是**结构**——
 *        只要列表被整表重建，滚动位置就要靠 contain-intrinsic-size 的估算高度去恢复，
 *        那一步正是用户看到的「保存想法后进度条跳到别处」。
 */

// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { installObsidianDom } from "../helpers/dom";
import { buildCards } from "../../src/views/cardModel";
import { AnnotationSidebarView } from "../../src/views/sidebarView";
import type { CommentAnnotation, FileAnnotationDocument, HighlightAnnotation } from "../../src/storage/types";

installObsidianDom();

function anchor(text: string, start = 0) {
  return { startOffset: start, endOffset: start + text.length, selectedText: text, prefix: "", suffix: "", isCode: false };
}

function highlight(id: string, text: string, start = 0): HighlightAnnotation {
  return { id, color: "yellow", anchor: anchor(text, start), createdAt: "2026-01-01T00:00:00.000Z" };
}

function note(id: string, highlightId: string, content: string): CommentAnnotation {
  return {
    id,
    highlightId,
    anchor: anchor("复利"),
    content,
    color: "yellow",
    position: { offsetX: 0, offsetY: 0 },
    collapsed: false,
    author: "me",
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    replies: [],
    resolved: false,
  };
}

function documentWith(comments: CommentAnnotation[]): FileAnnotationDocument {
  return {
    filePath: "读书笔记/复利.md",
    fileHash: "",
    lastModified: "2026-01-01T00:00:00.000Z",
    highlights: [highlight("h1", "复利", 0), highlight("h2", "复利效应", 20)],
    comments,
    pdfHighlights: [],
    pdfComments: [],
    epubHighlights: [],
    epubComments: [],
    bookmarks: [],
    canvasNodes: [],
  };
}

/** 只提供 sidebarView 真正会碰到的成员：多给的桩会把「谁在用插件」这件事藏起来 */
function makeView(documents: FileAnnotationDocument[]) {
  const store = {
    version: 1,
    getIndexedDocuments: async () => documents,
    getDocument: async () => documents[0],
    getExportRecord: () => ({ notePath: null }),
    getTagDictionary: () => [],
  };
  const plugin = {
    store,
    settings: { contentRelations: false, obTagBridge: false, defaultAuthor: "me" },
    annotationScopeFile: () => null,
    prepareRelations: async () => undefined,
    createRelatedHost: () => ({}) as never,
    getRecommendedTags: () => [],
    getTagSuggestions: () => [],
    refreshAnnotations: async () => undefined,
    getFileObsidianTags: () => [],
    invalidateRelations: () => undefined,
    openFileInNewTab: async () => undefined,
    createAtomCardFor: async () => undefined,
    openEpubAtCfi: async () => undefined,
    activateTagBoard: async () => undefined,
    suggestTagsForCard: async () => [],
  };

  const view = new AnnotationSidebarView({} as never, plugin as never);
  const containerEl = document.createElement("div");
  containerEl.createDiv({ cls: "view-header" });
  containerEl.createDiv({ cls: "view-content" });
  Object.assign(view as unknown as Record<string, unknown>, {
    containerEl,
    app: { vault: { getAbstractFileByPath: () => null } },
    annotationScope: "all",
  });
  return { view, containerEl, store, plugin };
}

describe("保存想法：只换那一张卡，不重建列表", () => {
  it("就地换上带想法的卡，其它卡片节点原样保留，随后的 requestRender 不重建", async () => {
    const before = documentWith([]);
    const { view, containerEl, store } = makeView([before]);
    await view.render();

    const list = containerEl.querySelector<HTMLElement>(".yh-ov-list");
    expect(list).not.toBeNull();
    const otherCard = (): HTMLElement | undefined =>
      Array.from(list!.querySelectorAll<HTMLElement>(".yh-ov-card")).find((card) => card.dataset.id === "h2");
    const untouched = otherCard();
    expect(untouched).toBeDefined();

    // 保存动作已经落盘：文档多了想法、store.version 前进一步
    const previous = buildCards(before).find((card) => card.id === "h1")!;
    const after = documentWith([note("c1", "h1", "复利的关键是时间")]);
    store.version = 2;
    (view as unknown as { plugin: { store: typeof store } }).plugin.store = store;
    const documents = [after];
    (store as unknown as { getIndexedDocuments: () => Promise<FileAnnotationDocument[]> }).getIndexedDocuments =
      async () => documents;
    (store as unknown as { getDocument: () => Promise<FileAnnotationDocument> }).getDocument = async () => after;

    const updated = await (view as unknown as { refreshCardInPlace: (card: unknown) => Promise<boolean> })
      .refreshCardInPlace(previous);
    expect(updated).toBe(true);

    // 新的卡：同一张 DOM 位置、已经带上想法的 data-note-id，且没有走整表重建
    // （想法正文由 MarkdownRenderer 异步渲染，jsdom 里是空实现，只能断结构性字段）
    const refreshed = Array.from(list!.querySelectorAll<HTMLElement>(".yh-ov-card")).find(
      (card) => card.dataset.id === "h1",
    );
    expect(refreshed?.dataset.noteId).toBe("c1");
    expect(containerEl.querySelector(".yh-ov-list")).toBe(list);
    expect(otherCard()).toBe(untouched);

    // 面板关闭时真的会调 requestRender()：指纹已对齐，这次不能再重建（重建 = 滚动位置重算）
    await view.render();
    expect(containerEl.querySelector(".yh-ov-list")).toBe(list);
    expect(otherCard()).toBe(untouched);
    expect(containerEl.querySelector(".yh-ov-count")?.textContent).toContain("1 notes");
  });

  it("卡片当前不在已渲染范围内时返回 false，交给整表重建兜底", async () => {
    const before = documentWith([]);
    const { view } = makeView([before]);
    await view.render();

    // 传一张列表里不存在的卡：simulates 用户滚到很深处、被点的那张卡已不在 DOM
    const ghost = { ...buildCards(before)[0]!, id: "not-rendered" };
    const updated = await (view as unknown as { refreshCardInPlace: (card: unknown) => Promise<boolean> })
      .refreshCardInPlace(ghost);
    expect(updated).toBe(false);
  });
});

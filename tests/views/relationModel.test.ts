/**
 * [INPUT]: 被测 src/views/relationModel.ts 的快照构建与命中读取
 * [OUTPUT]: 覆盖并发构建去重、慢构建的缓存时间、构建期间失效丢弃旧结果、短语命中不回归
 * [POS]: L1 纯逻辑测试——全库侧栏卡顿的护栏：同一时刻只能构建一次，
 *        构建完成时间必须晚于开始时间，否则每张卡都会以为快照过期并重复触发全库计算
 */

import { describe, expect, it, vi } from "vitest";

import type { AnnotationStore } from "../../src/storage/annotationStore";
import type { FileAnnotationDocument, HighlightAnnotation } from "../../src/storage/types";
import { buildCards } from "../../src/views/cardModel";
import { RelationModel } from "../../src/views/relationModel";

function makeHighlight(id: string, text: string, offset = 0): HighlightAnnotation {
  return {
    id,
    color: "yellow",
    anchor: {
      startOffset: offset,
      endOffset: offset + text.length,
      selectedText: text,
      prefix: "",
      suffix: "",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeDocument(filePath: string, highlights: HighlightAnnotation[]): FileAnnotationDocument {
  return {
    filePath,
    fileHash: `hash-${filePath}`,
    lastModified: "2026-01-01T00:00:00.000Z",
    highlights,
    comments: [],
    pdfHighlights: [],
    pdfComments: [],
    epubHighlights: [],
    epubComments: [],
    bookmarks: [],
    canvasNodes: [],
  };
}

interface FakeStore {
  store: AnnotationStore;
  calls: () => number;
  setDocuments: (next: FileAnnotationDocument[]) => void;
}

/** getIndexedDocuments 按调用顺序等待对应 gate，并在调用瞬间快照文档 */
function makeFakeStore(
  documents: FileAnnotationDocument[],
  gates: Promise<void>[] = [],
): FakeStore {
  let current = documents;
  let calls = 0;
  const store = {
    version: 1,
    async getIndexedDocuments(): Promise<FileAnnotationDocument[]> {
      const snapshot = current;
      const gate = gates[calls];
      calls += 1;
      if (gate) {
        await gate;
      }
      return snapshot;
    },
    getTagDisplayName: (key: string) => key,
  };
  return {
    store: store as unknown as AnnotationStore,
    calls: () => calls,
    setDocuments: (next) => {
      current = next;
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("RelationModel 快照构建", () => {
  it("并发 prepare 共享同一次构建，不会每张卡重算全库", async () => {
    const gate = deferred();
    const documents = [makeDocument("a.md", [makeHighlight("h1", "理解复利效应需要时间")])];
    const fake = makeFakeStore(documents, [gate.promise]);
    const model = new RelationModel(fake.store);

    const pending = Array.from({ length: 12 }, () => model.prepare([]));
    gate.resolve();
    await Promise.all(pending);

    expect(fake.calls()).toBe(1);
    expect(model.isReady()).toBe(true);
  });

  it("构建耗时超过缓存 TTL，完成时仍算新鲜（计时从算完开始）", async () => {
    const gate = deferred();
    const documents = [makeDocument("a.md", [makeHighlight("h1", "理解复利效应需要时间")])];
    const fake = makeFakeStore(documents, [gate.promise]);
    const model = new RelationModel(fake.store);

    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const pending = model.prepare([]);
    // 模拟构建花了 40 秒：旧实现把 builtAt 记成开始时间，构建一完成就判定过期
    now.mockReturnValue(41_000);
    gate.resolve();
    await pending;

    expect(model.isReady()).toBe(true);
    now.mockRestore();
  });

  it("构建期间被 invalidate：丢弃旧快照并用新数据重建", async () => {
    const gate = deferred();
    const oldDoc = makeDocument("old.md", [makeHighlight("h1", "旧的复利效应需要时间积累")]);
    const newLeft = makeDocument("new-a.md", [makeHighlight("h2", "新的复利效应需要时间验证")]);
    const newRight = makeDocument("new-b.md", [makeHighlight("h3", "复利效应常被低估")]);
    const fake = makeFakeStore([oldDoc], [gate.promise]);
    const model = new RelationModel(fake.store);

    const pending = model.prepare([]);
    fake.setDocuments([newLeft, newRight]);
    model.invalidate();
    gate.resolve();
    await pending;

    expect(fake.calls()).toBe(2);
    const hits = model.getRelated(buildCards(newLeft)[0]);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("预计算种子表后，跨文档共享术语仍能命中", async () => {
    const left = makeDocument("a.md", [makeHighlight("h1", "理解复利效应需要时间", 0)]);
    const right = makeDocument("b.md", [makeHighlight("h2", "复利效应常被低估", 0)]);
    const fake = makeFakeStore([left, right]);
    const model = new RelationModel(fake.store);

    await model.prepare([left, right]);
    const hits = model.getRelated(buildCards(left)[0]);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].reasons.join("")).toContain("复利效应");
  });
});

/**
 * [INPUT]: 被测 src/epub/EpubChapterResolver.ts
 * [OUTPUT]: 覆盖 TOC→spine 映射、章节名解析、CFI 规范化与进度百分比兼容
 * [POS]: L1 纯逻辑测试——CFI 是脆弱锚点，规范化与百分比误判都会静默跳错章节
 */

import { describe, expect, it } from "vitest";

import {
  buildTocSpineIndex,
  normalizeCfi,
  normalizePercent,
  resolveChapterLabel,
  spineIndexFromLocation,
} from "../../src/epub/EpubChapterResolver";

const book = {
  spine: {
    get: (target: string) => {
      const map: Record<string, { index: number }> = {
        "chap1.xhtml": { index: 1 },
        "chap2.xhtml": { index: 2 },
        "chap2.xhtml#sec1": { index: 2 },
        "chap3.xhtml": { index: 3 },
      };
      return map[target] ?? null;
    },
  },
};

describe("buildTocSpineIndex", () => {
  it("深度优先展开子项并按 spine index 排序", () => {
    const toc = [
      { label: " 第三章 ", href: "chap3.xhtml" },
      { label: "第一章", href: "chap1.xhtml", subitems: [{ label: "第一节", href: "chap2.xhtml#sec1" }] },
      { label: "第二章", href: "chap2.xhtml" },
    ];

    const entries = buildTocSpineIndex(book, toc);

    expect(entries).toEqual([
      { label: "第一章", spineIndex: 1 },
      { label: "第一节", spineIndex: 2 },
      { label: "第二章", spineIndex: 2 },
      { label: "第三章", spineIndex: 3 },
    ]);
  });

  it("无法解析 href 的条目被跳过，不产生 NaN", () => {
    const entries = buildTocSpineIndex(book, [{ label: "封面", href: "cover.xhtml" }]);
    expect(entries).toEqual([]);
  });
});

describe("resolveChapterLabel", () => {
  const entries = [
    { label: "序", spineIndex: 0 },
    { label: "第一章", spineIndex: 2 },
    { label: "第二章", spineIndex: 5 },
  ];

  it("取 spineIndex <= 当前值的最后一条", () => {
    expect(resolveChapterLabel(entries, 0)).toBe("序");
    expect(resolveChapterLabel(entries, 1)).toBe("序");
    expect(resolveChapterLabel(entries, 2)).toBe("第一章");
    expect(resolveChapterLabel(entries, 9)).toBe("第二章");
  });

  it("空列表或非法 index 返回空串", () => {
    expect(resolveChapterLabel([], 3)).toBe("");
    expect(resolveChapterLabel(entries, Number.NaN)).toBe("");
  });
});

describe("spineIndexFromLocation", () => {
  it("优先用 location.start.index", () => {
    expect(spineIndexFromLocation({ start: { index: 3 } })).toBe(3);
  });

  it("缺 index 时用 CFI 反查 spine", () => {
    expect(spineIndexFromLocation({ start: { cfi: "chap2.xhtml" } }, undefined, book)).toBe(2);
  });

  it("都拿不到时返回 null", () => {
    expect(spineIndexFromLocation({}, undefined, book)).toBeNull();
    expect(spineIndexFromLocation(null)).toBeNull();
  });
});

describe("normalizeCfi", () => {
  it("字符串原样返回", () => {
    expect(normalizeCfi("epubcfi(/6/4!/2/10)")).toBe("epubcfi(/6/4!/2/10)");
  });

  it("epubjs 的 { str } 与 toString 都能取出 CFI", () => {
    expect(normalizeCfi({ str: "epubcfi(/6/4)" })).toBe("epubcfi(/6/4)");
    expect(normalizeCfi({ toString: () => "epubcfi(/6/8)" })).toBe("epubcfi(/6/8)");
  });

  it("非 CFI 内容与空值返回空串（避免把垃圾写进 sidecar）", () => {
    expect(normalizeCfi({ str: "#chapter-1" })).toBe("");
    expect(normalizeCfi({ toString: () => "plain" })).toBe("");
    expect(normalizeCfi(null)).toBe("");
    expect(normalizeCfi(undefined)).toBe("");
    expect(normalizeCfi("")).toBe("");
  });
});

describe("normalizePercent", () => {
  it("0–1 原样保留", () => {
    expect(normalizePercent(0)).toBe(0);
    expect(normalizePercent(0.42)).toBe(0.42);
    expect(normalizePercent(1)).toBe(1);
  });

  it("兼容历史误存的 0–100 数据", () => {
    expect(normalizePercent(50)).toBe(0.5);
    expect(normalizePercent(100)).toBe(1);
  });

  it("钳到 [0,1]，非法值归零", () => {
    expect(normalizePercent(1.5)).toBe(1);
    expect(normalizePercent(500)).toBe(1);
    expect(normalizePercent(-3)).toBe(0);
    expect(normalizePercent(Number.NaN)).toBe(0);
    expect(normalizePercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

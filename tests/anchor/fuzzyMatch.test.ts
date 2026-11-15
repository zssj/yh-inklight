/**
 * [INPUT]: 被测 src/anchor/fuzzyMatch.ts
 * [OUTPUT]: 覆盖精确命中、局部窗口容错、阈值拒绝与空目标
 * [POS]: L1 纯逻辑测试——锚点恢复的兜底层，阈值改动会直接放大误配
 */

import { describe, expect, it } from "vitest";

import { findBestFuzzyMatch } from "../../src/anchor/fuzzyMatch";

describe("findBestFuzzyMatch", () => {
  it("空目标返回 null", () => {
    expect(findBestFuzzyMatch("任意文本", "", 0)).toBeNull();
    expect(findBestFuzzyMatch("任意文本", "   ", 0)).toBeNull();
  });

  it("原文完整包含目标时按精确匹配返回，confidence 为 1", () => {
    const source = "在复利效应的作用下，长期投资会放大收益。";
    const result = findBestFuzzyMatch(source, "复利效应", 0);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(1);
    expect(source.slice(result!.startOffset, result!.endOffset)).toBe("复利效应");
  });

  it("多一个字符的轻微改写仍能匹配到附近", () => {
    const source = "an apples a day keeps the doctor away";
    const result = findBestFuzzyMatch(source, "an apple a day", 0);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result!.startOffset).toBe(0);
  });

  it("目标与原文毫无共同点时不返回结果", () => {
    const source = "在复利效应的作用下，长期投资会放大收益。";
    expect(findBestFuzzyMatch(source, "zzzzzzzzzzzzzz", 0)).toBeNull();
  });

  it("优先在期望位置附近搜索，而不是全局找第一个相似片段", () => {
    const filler = "无关内容".repeat(50);
    const near = filler + "目标短语在这里" + filler;
    const far = "目标短语在这里" + "无关内容".repeat(400);

    const nearOffset = near.indexOf("目标短语在这里");
    const result = findBestFuzzyMatch(near + far, "目标短语在则里", nearOffset);

    expect(result).not.toBeNull();
    expect(result!.startOffset).toBe(nearOffset);
  });

  it("结果区间不越界", () => {
    const source = "短文本";
    const result = findBestFuzzyMatch(source, "短文本内容", 0);
    if (result) {
      expect(result.startOffset).toBeGreaterThanOrEqual(0);
      expect(result.endOffset).toBeLessThanOrEqual(source.length);
      expect(result.endOffset).toBeGreaterThan(result.startOffset);
    }
  });
});

/**
 * [INPUT]: 被测 src/views/relatedBlock.ts 的纯函数
 * [OUTPUT]: 覆盖「多长的摘录才值得折叠」这条判定（DOM 渲染在 L2/真机验证）
 * [POS]: L1 纯逻辑测试——相关行的折叠按钮只在长文本上出现，短文本不该多一个点了没反应的按钮
 */

import { describe, expect, it } from "vitest";

import { RELATED_TEXT_COLLAPSE_LENGTH, shouldCollapseRelatedText } from "../../src/views/relatedBlock";

describe("shouldCollapseRelatedText", () => {
  it("短摘录不折叠：不给一个点了没反应的展开按钮", () => {
    expect(shouldCollapseRelatedText("复利效应")).toBe(false);
    expect(shouldCollapseRelatedText("a".repeat(RELATED_TEXT_COLLAPSE_LENGTH))).toBe(false);
  });

  it("超过阈值才折叠", () => {
    expect(shouldCollapseRelatedText("a".repeat(RELATED_TEXT_COLLAPSE_LENGTH + 1))).toBe(true);
  });

  it("按去空白后的长度判断：首尾空格不会把短句判成长文", () => {
    const padded = `   ${"a".repeat(RELATED_TEXT_COLLAPSE_LENGTH)}   `;
    expect(shouldCollapseRelatedText(padded)).toBe(false);
  });
});

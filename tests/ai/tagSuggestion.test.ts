/**
 * [INPUT]: 被测 src/ai/EpubAiClient.ts 的标签推荐解析
 * [OUTPUT]: 覆盖「只认候选表已有标签」的边界：前缀/括号/无结果/发明新词
 * [POS]: L1 纯逻辑测试——AI 输出一旦被误当成标签写库，标签体系会立刻分叉
 */

import { describe, expect, it } from "vitest";

import { parseSuggestedTag } from "../../src/ai/EpubAiClient";

const CANDIDATES = ["确认偏误", "认知偏差", "Coolidge Effect"];

describe("parseSuggestedTag", () => {
  it("精确命中候选标签", () => {
    expect(parseSuggestedTag("确认偏误", CANDIDATES)).toBe("确认偏误");
  });

  it("剥掉常见前缀、引号与句末标点", () => {
    expect(parseSuggestedTag("标签：确认偏误。", CANDIDATES)).toBe("确认偏误");
    expect(parseSuggestedTag("“认知偏差”", CANDIDATES)).toBe("认知偏差");
  });

  it("剥掉标签后的括号解释", () => {
    expect(parseSuggestedTag("确认偏误（因为只看支持自己的证据）", CANDIDATES)).toBe("确认偏误");
  });

  it("大小写不敏感，但返回候选表里的原始写法", () => {
    expect(parseSuggestedTag("coolidge effect", CANDIDATES)).toBe("Coolidge Effect");
  });

  it("多候选用逗号分隔时取第一个能对上的", () => {
    expect(parseSuggestedTag("不存在的标签，认知偏差", CANDIDATES)).toBe("认知偏差");
  });

  it("输出「无」或发明新词时返回 null", () => {
    expect(parseSuggestedTag("无", CANDIDATES)).toBeNull();
    expect(parseSuggestedTag("认知失调", CANDIDATES)).toBeNull();
    expect(parseSuggestedTag("", CANDIDATES)).toBeNull();
  });
});

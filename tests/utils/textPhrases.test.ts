/**
 * [INPUT]: 被测 src/utils/textPhrases.ts
 * [OUTPUT]: 覆盖文本清洗、切词段、噪音短语过滤、术语特征与短语扩展
 * [POS]: L1 纯逻辑测试——「相关批注」全靠这套启发式，规则微调很容易让整屏推荐变成套话
 */

import { describe, expect, it } from "vitest";

import {
  MAX_TEXT_CHARS,
  cleanText,
  expandPhrase,
  hasTermSuffix,
  isNoisePhrase,
  isRelationEligible,
  splitSegments,
  startsWithWeakToken,
  trimPhrase,
} from "../../src/utils/textPhrases";

describe("cleanText", () => {
  it("去掉 Markdown 强调标记并折叠空白", () => {
    expect(cleanText("**工业革命** 的核心")).toBe("工业革命 的核心");
  });

  it("去掉 wiki 链接、HTML 标签与实体", () => {
    expect(cleanText("参见[[某笔记]] 与 <b>重点</b>&nbsp;内容")).toBe("参见 与 重点 内容");
  });

  it("代码块整体丢弃", () => {
    expect(cleanText("正文\n```\nconst a = 1;\n```\n结尾")).toBe("正文 结尾");
  });

  it("标点转成断句空格，不跨句拼短语", () => {
    expect(cleanText("第一句。第二句，第三句")).toBe("第一句 第二句 第三句");
  });

  it("统一小写并截断到上限", () => {
    expect(cleanText("ABC")).toBe("abc");
    expect(cleanText("字".repeat(MAX_TEXT_CHARS + 100))).toHaveLength(MAX_TEXT_CHARS);
  });
});

describe("splitSegments", () => {
  it("中文在功能字处断开，保留术语整体", () => {
    expect(splitSegments(cleanText("工业革命的核心是能源转换"))).toEqual(["工业革命", "核心", "能源转换"]);
  });

  it("连续英文单词合并成一个词段，避免退化成碎片", () => {
    expect(splitSegments(cleanText("the coolidge effect"))).toEqual(["the coolidge effect"]);
  });

  it("单字段与纯数字段被丢弃", () => {
    const segments = splitSegments(cleanText("2024 年 的 数据"));
    expect(segments.join(" ")).not.toContain("2024");
    expect(segments.every((segment) => segment.length >= 2)).toBe(true);
  });

  it("空文本返回空数组", () => {
    expect(splitSegments("")).toEqual([]);
  });
});

describe("isNoisePhrase", () => {
  it("过短、套话、元话语、代词都是噪音", () => {
    expect(isNoisePhrase("这句话")).toBe(true);
    expect(isNoisePhrase("一般来说")).toBe(true);
    expect(isNoisePhrase("原文摘录")).toBe(true);
    expect(isNoisePhrase("影响到人们")).toBe(true);
  });

  it("含具体术语的短语不是噪音", () => {
    expect(isNoisePhrase("复利效应")).toBe(false);
    expect(isNoisePhrase("coolidge effect")).toBe(false);
  });

  it("过短的纯英文单词是噪音", () => {
    expect(isNoisePhrase("market")).toBe(true);
  });
});

describe("trimPhrase", () => {
  it("剪掉首尾虚词残段", () => {
    expect(trimPhrase("人际关系中")).toBe("人际关系");
    expect(trimPhrase("中人际关系")).toBe("人际关系");
  });

  it("短到下限时不再剪，避免剪成空串", () => {
    expect(trimPhrase("中中中中")).toBe("中中中中");
  });
});

describe("hasTermSuffix / startsWithWeakToken", () => {
  it("术语后缀能识别概念词", () => {
    expect(hasTermSuffix("复利效应")).toBe(true);
    expect(hasTermSuffix("亲密关系")).toBe(true);
    expect(hasTermSuffix("最佳方法")).toBe(false);
  });

  it("数量词开头没有区分度", () => {
    expect(startsWithWeakToken("一篇文章")).toBe(true);
    expect(startsWithWeakToken("第二个问题")).toBe(true);
    expect(startsWithWeakToken("复利效应")).toBe(false);
    expect(startsWithWeakToken("")).toBe(true);
  });
});

describe("expandPhrase", () => {
  it("把共享种子向两侧扩展成最长公共短语", () => {
    const left = "工业革命核心";
    const right = "前文工业革命核心后续";
    expect(expandPhrase(left, 0, right, 2, 10)).toBe("工业革命核心");
  });

  it("受 maxLength 限制，不会无限扩到整段", () => {
    const left = "abcdefghij";
    const right = "abcdefghij";
    expect(expandPhrase(left, 0, right, 0, 6)).toHaveLength(6);
  });
});

describe("isRelationEligible", () => {
  it("短划线不参与关联", () => {
    expect(isRelationEligible("太短", false)).toBe(false);
    expect(isRelationEligible("       ", false)).toBe(false);
  });

  it("代码选区不参与关联", () => {
    expect(isRelationEligible("这是一段足够长的代码选区内容", true)).toBe(false);
  });

  it("足够长的普通文字参与关联", () => {
    expect(isRelationEligible("这是一段足够长的划线文字", false)).toBe(true);
  });
});

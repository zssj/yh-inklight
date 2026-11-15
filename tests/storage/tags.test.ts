/**
 * [INPUT]: 被测 src/storage/tags.ts
 * [OUTPUT]: 覆盖标签归一化、去重排序、Obsidian 语法转换（导出桥接的关键边界）
 * [POS]: L1 纯逻辑测试——导出到 md 时标签被截断/丢弃都源于这里，真机只看得到结果看不到原因
 */

import { describe, expect, it } from "vitest";

import {
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_ANNOTATION,
  hasTag,
  normalizeTag,
  normalizeTags,
  sortTagKeys,
  tagKey,
  toObsidianTag,
  toObsidianTags,
  unionTags,
} from "../../src/storage/tags";

describe("normalizeTag", () => {
  it("剥掉前导 # 并保留嵌套斜杠", () => {
    expect(normalizeTag("#认知/偏差")).toBe("认知/偏差");
    expect(normalizeTag("###认知")).toBe("认知");
  });

  it("折叠空白并去掉首尾空格", () => {
    expect(normalizeTag("  coolidge   effect  ")).toBe("coolidge effect");
  });

  it("剔除非法字符", () => {
    expect(normalizeTag("a#b")).toBe("ab");
    expect(normalizeTag("a|b*c?d")).toBe("abcd");
    expect(normalizeTag('引号"与<尖括号>')).toBe("引号与尖括号");
  });

  it("超过上限时按码点截断（中文一字一码点，不切坏字符）", () => {
    const long = "字".repeat(MAX_TAG_LENGTH + 8);
    const result = normalizeTag(long);
    expect(Array.from(result!)).toHaveLength(MAX_TAG_LENGTH);
  });

  it("空串、纯符号、非字符串都返回 null", () => {
    expect(normalizeTag("")).toBeNull();
    expect(normalizeTag("   ")).toBeNull();
    expect(normalizeTag("###")).toBeNull();
    expect(normalizeTag(undefined)).toBeNull();
    expect(normalizeTag(null)).toBeNull();
  });
});

describe("tagKey / hasTag", () => {
  it("英文大小写视为同一标签", () => {
    expect(tagKey("Foo")).toBe("foo");
    expect(tagKey("#FOO")).toBe("foo");
  });

  it("无效标签的比较键为空串", () => {
    expect(tagKey("###")).toBe("");
  });

  it("hasTag 按比较键匹配", () => {
    expect(hasTag(["认知/偏差"], "认知/偏差")).toBe(true);
    expect(hasTag(["Foo"], "foo")).toBe(true);
    expect(hasTag(["foo"], "bar")).toBe(false);
    expect(hasTag(undefined, "foo")).toBe(false);
    expect(hasTag(["foo"], "")).toBe(false);
  });
});

describe("normalizeTags", () => {
  it("按比较键去重并保留首次出现的写法", () => {
    expect(normalizeTags(["Foo", "foo", "FOO", "bar"])).toEqual(["Foo", "bar"]);
  });

  it("丢弃无效项", () => {
    expect(normalizeTags(["", "  ", "###", "有效"])).toEqual(["有效"]);
  });

  it("截断到单条批注上限", () => {
    const input = Array.from({ length: MAX_TAGS_PER_ANNOTATION + 5 }, (_, index) => `tag${index}`);
    expect(normalizeTags(input)).toHaveLength(MAX_TAGS_PER_ANNOTATION);
  });

  it("非数组输入返回空数组（兼容老数据）", () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
  });
});

describe("unionTags", () => {
  it("合并多条来源并保序去重", () => {
    expect(unionTags(["b", "a"], ["A", "c"], undefined)).toEqual(["b", "a", "c"]);
  });

  it("全空时返回空数组", () => {
    expect(unionTags(undefined, null, [])).toEqual([]);
  });
});

describe("sortTagKeys", () => {
  it("去重后按字典序升序", () => {
    expect(sortTagKeys(["b", "a", "b", ""])).toEqual(["a", "b"]);
  });
});

describe("toObsidianTag", () => {
  it("保留嵌套斜杠", () => {
    expect(toObsidianTag("认知/偏差")).toBe("认知/偏差");
  });

  it("空格转连字符，标点剔除，输出小写", () => {
    expect(toObsidianTag("Coolidge Effect")).toBe("coolidge-effect");
    expect(toObsidianTag("复利效应！")).toBe("复利效应");
  });

  it("纯数字加 tag- 前缀，否则 Obsidian 不索引", () => {
    expect(toObsidianTag("2024")).toBe("tag-2024");
    expect(toObsidianTag("认知/2024")).toBe("认知/2024");
  });

  it("转不出有效内容时返回 null", () => {
    expect(toObsidianTag("---")).toBeNull();
    expect(toObsidianTag("！！！")).toBeNull();
    expect(toObsidianTag(undefined)).toBeNull();
  });

  it("多段里的空段被丢弃", () => {
    expect(toObsidianTag("认知//偏差/")).toBe("认知/偏差");
  });
});

describe("toObsidianTags", () => {
  it("逐项转换并按结果去重", () => {
    expect(toObsidianTags(["Coolidge Effect", "coolidge effect", "认知/偏差"])).toEqual([
      "coolidge-effect",
      "认知/偏差",
    ]);
  });

  it("非数组输入返回空数组", () => {
    expect(toObsidianTags(undefined)).toEqual([]);
  });
});

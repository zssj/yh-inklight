/**
 * [INPUT]: 被测 src/storage/sourceLink.ts（纯函数，无 Obsidian 依赖）
 * [OUTPUT]: 覆盖回链 URL 的编码/解析往返，以及 offset 漂移后的就近校正
 * [POS]: L1 纯逻辑测试——回链「写了却点不动」这类故障只能在真机上发现，这里先把契约锁死
 */

import { describe, expect, it } from "vitest";

import { buildSourceLinkUrl, parseSourceLinkParams, refineOffset } from "../../src/storage/sourceLink";

describe("buildSourceLinkUrl", () => {
  it("md 链接带 mode / offset / 原文片段", () => {
    const url = buildSourceLinkUrl({
      sourcePath: "读书笔记/复利.md",
      mode: "md",
      offset: 128,
      quote: "复利效应需要长期不中断",
    });

    const parsed = new URL(url);
    expect(parsed.protocol).toBe("obsidian:");
    expect(parsed.hostname).toBe("inklight");
    expect(parsed.searchParams.get("mode")).toBe("md");
    expect(parsed.searchParams.get("offset")).toBe("128");
    expect(parsed.searchParams.get("text")).toBe("复利效应需要长期不中断");
  });

  it("pdf 带 page、epub 带 cfi，互不串字段", () => {
    const pdf = new URL(buildSourceLinkUrl({ sourcePath: "papers/成本.pdf", mode: "pdf", pageNumber: 7 }));
    expect(pdf.searchParams.get("page")).toBe("7");
    expect(pdf.searchParams.get("offset")).toBeNull();
    expect(pdf.searchParams.get("cfi")).toBeNull();

    const epub = new URL(buildSourceLinkUrl({ sourcePath: "books/书.epub", mode: "epub", cfiRange: "epubcfi(/6/28!/4/2/1:0)" }));
    expect(epub.searchParams.get("cfi")).toBe("epubcfi(/6/28!/4/2/1:0)");
    expect(epub.searchParams.get("offset")).toBeNull();
  });

  it("括号与引号被转义，链接不会在第一个 ) 处截断", () => {
    const url = buildSourceLinkUrl({
      sourcePath: "books/底层逻辑 (刘润).epub",
      mode: "epub",
      cfiRange: "epubcfi(/6/28!/4[BE6O0-4c9d]/140,/1:0,/1:118)",
    });

    // Markdown 链接体里不能出现裸括号，否则 [text](url) 会提前闭合
    expect(url).not.toMatch(/[()']/);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("file")).toBe("books/底层逻辑 (刘润).epub");
    expect(parsed.searchParams.get("cfi")).toBe("epubcfi(/6/28!/4[BE6O0-4c9d]/140,/1:0,/1:118)");
  });
});

describe("parseSourceLinkParams", () => {
  it("与 buildSourceLinkUrl 往返一致", () => {
    const url = buildSourceLinkUrl({
      sourcePath: "读书笔记/复利.md",
      mode: "md",
      offset: 0,
      quote: "复利效应",
    });
    const params = Object.fromEntries(new URL(url).searchParams.entries());

    expect(parseSourceLinkParams(params)).toEqual({
      file: "读书笔记/复利.md",
      mode: "md",
      offset: 0,
      page: null,
      cfi: null,
      quote: "复利效应",
    });
  });

  it("文件路径缺失时返回 null，不抛异常", () => {
    expect(parseSourceLinkParams({})).toBeNull();
    expect(parseSourceLinkParams({ file: "" })).toBeNull();
  });

  it("缺 mode 时按扩展名推断，非法数值降级为 null", () => {
    const target = parseSourceLinkParams({ file: "papers/成本.pdf", page: "abc", offset: "-3" });
    expect(target?.mode).toBe("pdf");
    expect(target?.page).toBeNull();
    expect(target?.offset).toBeNull();
  });

  it("已被解码一次的值不会因裸 % 抛出 URIError", () => {
    expect(() => parseSourceLinkParams({ file: "笔记/50% 完成.md" })).not.toThrow();
    expect(parseSourceLinkParams({ file: "笔记/50% 完成.md" })?.file).toBe("笔记/50% 完成.md");
  });
});

describe("refineOffset", () => {
  const content = "开头一段。\n复利效应需要长期不中断，这是长期主义的核心。\n结尾一段。";

  it("偏移正确时原地返回", () => {
    const offset = content.indexOf("复利效应");
    expect(refineOffset(content, offset, "复利效应需要长期不中断")).toBe(offset);
  });

  it("原文上方插入文字导致偏移漂移时，按片段就近校正", () => {
    const offset = content.indexOf("复利效应");
    // 原文前面多插了 20 个字，历史 offset 已指向错误位置
    const shifted = `新增的二十个字内容在这里。\n${content}`;
    expect(refineOffset(shifted, offset, "复利效应需要长期不中断")).toBe(offset + 14);
  });

  it("片段里的空白与大小写差异不影响匹配", () => {
    const text = "Hello   World 复利效应";
    expect(refineOffset(text, 0, "hello world")).toBe(0);
  });

  it("同一片段出现多次时取离原偏移最近的那一处", () => {
    const repeated = "复利效应在这里。中间隔了一大段文字。复利效应又在末尾。";
    const second = repeated.lastIndexOf("复利效应");
    expect(refineOffset(repeated, second, "复利效应")).toBe(second);
    expect(refineOffset(repeated, 0, "复利效应")).toBe(0);
  });

  it("片段过短或找不到时退回原偏移，不瞎跳", () => {
    expect(refineOffset(content, 5, "复利")).toBe(5);
    expect(refineOffset(content, 5, "这段原文已经不存在了")).toBe(5);
  });

  it("偏移超出正文长度时收敛到末尾", () => {
    expect(refineOffset(content, 99999, "")).toBe(content.length - 1);
    expect(refineOffset(content, -5, "")).toBe(0);
  });
});

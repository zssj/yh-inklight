/**
 * [INPUT]: 读 src/epub/EpubFoliateLoader.ts 源码文本（本仓库自有文件）
 * [OUTPUT]: 守住 transformFoliateMarkup 的解析器判定与 DOCTYPE 剥离契约
 * [POS]: L1 静态守卫——"application/xhtml+xml" 含 "html" 子串，旧代码用
 *        mediaType.includes("html") 判定，会把合法 XHTML 当 HTML 解析并序列化，
 *        却仍以 xhtml+xml MIME 建 blob → iframe 严格解析失败 → 旧式 XHTML 书正文空白。
 *        另需先剥离 PUBLIC 外部 DTD，否则 Obsidian CSP 下拉取 DTD 失败同样白屏。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const LOADER = "src/epub/EpubFoliateLoader.ts";

function source(): string {
  return readFileSync(join(ROOT, LOADER), "utf8");
}

describe("foliate XHTML transform 守卫", () => {
  it("不得用 includes(\"html\") 判定解析器类型（xhtml+xml 含 html 子串）", () => {
    // 只检查 transformFoliateMarkup 函数体；attachFoliateTransformPipeline 里用
    // includes 判断「是否 HTML/XML/SVG 资源」是合法的，注释里解释 bug 也允许。
    const src = source();
    const start = src.indexOf("async function transformFoliateMarkup");
    const end = src.indexOf("function attachFoliateTransformPipeline", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fn = src.slice(start, end)
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(fn).not.toMatch(/includes\(\s*["']html["']\s*\)/);
  });

  it("XHTML 与 HTML 用精确相等判定，分别走 XMLSerializer / outerHTML", () => {
    const src = source();
    expect(src).toMatch(/isHtml\s*=\s*mediaType\s*===\s*["']text\/html["']/);
    expect(src).toMatch(/parserType\s*=\s*isHtml\s*\?\s*["']text\/html["']\s*:\s*["']application\/xhtml\+xml["']/);
    expect(src).toMatch(/isHtml\s*\?\s*doc\.documentElement\.outerHTML\s*:\s*new XMLSerializer\(\)\.serializeToString\(doc\)/);
  });

  it("解析前先剥离 PUBLIC 外部 DOCTYPE", () => {
    const src = source();
    expect(src).toMatch(/safeMarkup\s*=\s*markup\.replace\(\/<!DOCTYPE/);
    // 剥离必须发生在 parseFromString 之前
    const safeIdx = src.indexOf("const safeMarkup");
    const parseIdx = src.indexOf("parseFromString(safeMarkup", safeIdx);
    expect(safeIdx).toBeGreaterThan(-1);
    expect(parseIdx).toBeGreaterThan(safeIdx);
  });

  it("parsererror 时不得降级成 HTML 序列化（会重演内容/MIME 不匹配）", () => {
    const src = source();
    // 降级分支里只允许原样返回 safeMarkup，不得再 parseFromString(..., "text/html")
    const guard = src.match(/if \(doc\.querySelector\("parsererror"\)[\s\S]*?\n\s*\}/)?.[0] ?? "";
    expect(guard).toContain("return safeMarkup");
    expect(guard).not.toMatch(/parseFromString\(/);
  });

  it("transform hook 必须兜底异常，不让 detail.data reject（否则整章空白）", () => {
    const src = source();
    const start = src.indexOf("function attachFoliateTransformPipeline");
    const fn = src.slice(start);
    // detail.data 的转换链里必须有 try/catch，且 catch 中返回原始 payload
    expect(fn).toMatch(/try\s*\{[\s\S]*?normalizeFoliateCss[\s\S]*?transformFoliateMarkup[\s\S]*?\}\s*catch\s*\(/);
    expect(fn).toMatch(/catch\s*\([^)]*\)[\s\S]{0,200}?return payload/);
  });

  it("readBlobUrlAsDataUrl 的 xhr 操作必须包 try（自引用 blob 会同步抛）", () => {
    const src = source();
    const start = src.indexOf("function readBlobUrlAsDataUrl");
    const end = src.indexOf("async function inlineBlobCssImports", start);
    const fn = src.slice(start, end);
    expect(fn).toMatch(/try\s*\{[\s\S]*?xhr\.open[\s\S]*?\}\s*catch\s*\(/);
    expect(fn).toMatch(/resolve\(null\)/);
  });
});

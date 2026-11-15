/**
 * [INPUT]: 依赖 src/epub/EpubGotoHandler 的导出页识别与接管判定
 * [OUTPUT]: 固定「标签 MOC 页（MOC/<标签>.md）不在导出页路径白名单、必须靠页内 CFI 锚点兜底接管」的契约
 * [POS]: L1 纯逻辑测试，覆盖 EPUB 回链在 MOC 页点击无反应的回归点
 */

import { describe, expect, it } from "vitest";

import { isExportedAnnotationPath, shouldHandleAnnotationPage } from "../../src/epub/EpubGotoHandler";

describe("导出页识别", () => {
  it("单文件 / 全库导出的命名命中白名单", () => {
    expect(isExportedAnnotationPath("wiki1/papers/人类简史-notes.md")).toBe(true);
    expect(isExportedAnnotationPath("wiki1/papers/人类简史-notes-by-color.md")).toBe(true);
    expect(isExportedAnnotationPath("《人类简史》摘录.md")).toBe(true);
    expect(isExportedAnnotationPath("小说/excerpt.md")).toBe(true);
  });

  it("标签 MOC 页不命中白名单——这是回链点击无反应的触发条件", () => {
    expect(isExportedAnnotationPath("MOC/增强回路.md")).toBe(false);
  });

  it("普通笔记不命中白名单", () => {
    expect(isExportedAnnotationPath("我的笔记.md")).toBe(false);
  });
});

describe("回链接管判定", () => {
  it("页内存在 CFI 锚点时，MOC 页也必须接管", () => {
    expect(shouldHandleAnnotationPage("MOC/增强回路.md", true)).toBe(true);
  });

  it("用户改过名的导出页同样靠锚点接管", () => {
    expect(shouldHandleAnnotationPage("我的摘录合集.md", true)).toBe(true);
  });

  it("既不在白名单、也没有 CFI 锚点时不接管（不误伤普通笔记）", () => {
    expect(shouldHandleAnnotationPage("MOC/增强回路.md", false)).toBe(false);
    expect(shouldHandleAnnotationPage("我的笔记.md", false)).toBe(false);
  });

  it("白名单命中时即使没有锚点也接管（保持历史行为）", () => {
    expect(shouldHandleAnnotationPage("人类简史-notes.md", false)).toBe(true);
  });
});

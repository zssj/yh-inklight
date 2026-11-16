/**
 * [INPUT]: 被测 src/views/navigation 的 openAnnotationTarget（跳转单点）
 * [OUTPUT]: 覆盖 EPUB 分支的「只开一个标签页」契约：有 CFI 时不在本层 openFile
 * [POS]: L1 纯逻辑测试——重复建 tab 曾导致同书两个标签页、进度互不相同
 */

import { describe, expect, it, vi } from "vitest";

import { TFile } from "obsidian";
import { openAnnotationTarget } from "../../src/views/navigation";

function epubFile(path = "书/深度工作.epub"): TFile {
  return new TFile(path);
}

function fakeApp(leaves: unknown[] = []) {
  const getLeaf = vi.fn(() => {
    throw new Error("不应在本层新建标签页");
  });
  const revealLeaf = vi.fn(async () => undefined);
  const app = {
    workspace: {
      getLeaf,
      revealLeaf,
      getLeavesOfType: vi.fn(() => leaves),
    },
  };
  return { app: app as never, getLeaf, revealLeaf };
}

describe("openAnnotationTarget — EPUB", () => {
  it("带 CFI：只交给 navigateEpub，本层不 openFile、不新建 tab", async () => {
    const { app, getLeaf } = fakeApp();
    const navigate = vi.fn();

    await openAnnotationTarget(
      app,
      { file: epubFile(), offset: 0, pageNumber: null, mode: "epub", cfiRange: "epubcfi(/6/2!/4/2)" },
      navigate,
    );

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][1]).toBe("epubcfi(/6/2!/4/2)");
    expect(getLeaf).not.toHaveBeenCalled();
  });

  it("无 CFI 且书已打开：只 reveal 已有 leaf，不新建 tab", async () => {
    const file = epubFile();
    const leaf = { view: { file }, getViewState: () => ({ state: { file: file.path } }) };
    const { app, getLeaf, revealLeaf } = fakeApp([leaf]);

    await openAnnotationTarget(app, { file, offset: 0, pageNumber: null, mode: "epub" }, vi.fn());

    expect(revealLeaf).toHaveBeenCalledTimes(1);
    expect(getLeaf).not.toHaveBeenCalled();
  });
});

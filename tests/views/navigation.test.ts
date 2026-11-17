/**
 * [INPUT]: 被测 src/views/navigation 的 openAnnotationTarget（跳转单点）
 * [OUTPUT]: 覆盖两类契约：EPUB 分支「只开一个标签页」；md/PDF「跳转落在主区域 leaf、同一文件复用已有标签页」
 * [POS]: L1 纯逻辑测试——重复建 tab 曾导致同书两个标签页、进度互不相同；
 *        跳转也不能再用 getLeaf(false)（它返回当前活动 leaf，从侧栏/标签总览点跳转会开进那一分组）
 */

import { describe, expect, it, vi } from "vitest";

import type { App, WorkspaceLeaf } from "obsidian";
import { MarkdownView, TFile } from "obsidian";
import { openAnnotationTarget } from "../../src/views/navigation";

// 定位后会挂 160/520/850ms 的补定位定时器；测试里不需要它们真的跑，换成空实现即可（无 jsdom 依赖）
vi.stubGlobal("window", { setTimeout: () => 0 });

function epubFile(path = "书/深度工作.epub"): TFile {
  return new TFile(path);
}

function fakeApp(leaves: unknown[] = [], extra: Record<string, unknown> = {}) {
  const getLeaf = vi.fn((kind?: unknown) => {
    if (kind === undefined || kind === false) {
      throw new Error("不应在本层用 getLeaf(false) 选 leaf");
    }
    return extra.fallbackLeaf;
  });
  const revealLeaf = vi.fn(async () => undefined);
  const app = {
    workspace: {
      getLeaf,
      revealLeaf,
      getLeavesOfType: vi.fn(() => leaves),
      iterateAllLeaves: (callback: (leaf: WorkspaceLeaf) => void) => {
        for (const leaf of [...leaves, ...((extra.extraLeaves as unknown[]) ?? [])]) {
          callback(leaf as WorkspaceLeaf);
        }
      },
      getMostRecentLeaf: () => extra.mostRecent ?? null,
      getActiveViewOfType: () => null,
    },
  };
  return { app: app as never as App, getLeaf, revealLeaf };
}

function mdLeaf(file: TFile) {
  const editor = {
    offsetToPos: (offset: number) => ({ line: Math.floor(offset / 10), ch: offset % 10 }),
    setCursor: vi.fn(),
    scrollIntoView: vi.fn(),
    getValue: () => "x".repeat(400),
  };
  const applyScroll = vi.fn();
  const view = Object.assign(new MarkdownView(), {
    file,
    editor,
    previewMode: { applyScroll },
    containerEl: { addClass: vi.fn(), removeClass: vi.fn() },
  });
  const openFile = vi.fn(async () => undefined);
  return { leaf: { view, openFile }, editor, applyScroll, openFile };
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

describe("openAnnotationTarget — Markdown", () => {
  it("目标文件已有标签页：切过去即可，不重复 openFile，但定位仍生效", async () => {
    const file = new TFile("笔记/复利.md");
    const { leaf, editor, applyScroll } = mdLeaf(file);
    const { app, revealLeaf, getLeaf } = fakeApp([leaf]);

    await openAnnotationTarget(app, { file, offset: 120, pageNumber: null, mode: "md" }, vi.fn());

    expect(revealLeaf).toHaveBeenCalledTimes(1);
    expect(leaf.openFile).not.toHaveBeenCalled();
    expect(getLeaf).not.toHaveBeenCalled();
    expect(editor.setCursor).toHaveBeenCalledWith({ line: 12, ch: 0 });
    expect(applyScroll).toHaveBeenCalledWith(12);
  });

  it("没有已开标签页：用主区域最近 leaf 打开，绝不用 getLeaf(false)", async () => {
    const file = new TFile("笔记/复利.md");
    const { leaf, editor } = mdLeaf(file);
    const { app } = fakeApp([], { mostRecent: leaf });

    await openAnnotationTarget(app, { file, offset: 30, pageNumber: null, mode: "md" }, vi.fn());

    expect(leaf.openFile).toHaveBeenCalledTimes(1);
    expect(editor.setCursor).toHaveBeenCalledWith({ line: 3, ch: 0 });
  });

  it("主区域没有可用 leaf：退回新标签页", async () => {
    const file = new TFile("笔记/复利.md");
    const { leaf } = mdLeaf(file);
    const { app, getLeaf } = fakeApp([], { mostRecent: null, fallbackLeaf: leaf });

    await openAnnotationTarget(app, { file, offset: 0, pageNumber: null, mode: "md" }, vi.fn());

    expect(getLeaf).toHaveBeenCalledWith("tab");
    expect(leaf.openFile).toHaveBeenCalledTimes(1);
  });
});

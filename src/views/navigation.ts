/**
 * [INPUT]: 依赖 Obsidian App/WorkspaceLeaf/MarkdownView 与 cardModel 的 AnnotationMode
 * [OUTPUT]: 对外提供 openAnnotationTarget，统一处理 Markdown 偏移定位、PDF 翻页、EPUB CFI 三类跳转
 * [POS]: views 模块的跳转单点，被 sidebarView 与 tagBoardView 共用，避免两份实现漂移
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { App, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";

import type { AnnotationMode } from "./cardModel";

/** 与 EpubReaderView.EPUB_READER_VIEW_TYPE 一致；跳转层不反向依赖 epub 渲染层，避免模块图扰动 */
const EPUB_READER_VIEW_TYPE = "inklight-epub-reader";

export interface AnnotationTarget {
  file: TFile;
  /** Markdown 字符偏移；PDF/EPUB 传 Number.MAX_SAFE_INTEGER 即可 */
  offset: number;
  pageNumber: number | null;
  mode: AnnotationMode;
  cfiRange?: string;
}

/**
 * 打开批注所在位置。三类载体走各自的定位方式：
 * - EPUB：复用已打开的阅读器 leaf，交给插件的 CFI 跳转（见 main.navigateEpubToCfi）
 * - PDF：派发自定义事件，由 PDF 层翻页
 * - Markdown：编辑器偏移 → 光标 + 滚动 + 短暂高亮闪烁
 *
 * EPUB 必须先复用已有 leaf：重复 openFile 会二次触发 onLoadFile，
 * 进度恢复的 goTo 与批注跳转互相覆盖，还会同时留下两个同文件视图。
 */
export async function openAnnotationTarget(
  app: App,
  target: AnnotationTarget,
  navigateEpub: (file: TFile, cfiRange: string) => void,
): Promise<void> {
  if (target.mode === "epub") {
    const existing = findOpenEpubLeaf(app, target.file);
    if (existing) {
      app.workspace.revealLeaf(existing);
      if (target.cfiRange) {
        navigateEpub(target.file, target.cfiRange);
      }
      return;
    }
  }

  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(target.file);

  if (target.mode === "epub" && target.cfiRange) {
    navigateEpub(target.file, target.cfiRange);
    return;
  }

  if (target.file.extension.toLowerCase() === "pdf") {
    window.setTimeout(() => {
      document.dispatchEvent(new CustomEvent("yh-pdf-goto-page", { detail: { page: target.pageNumber } }));
    }, 120);
    return;
  }

  const view = leaf.view instanceof MarkdownView ? leaf.view : app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) {
    return;
  }

  const pos = view.editor.offsetToPos(target.offset);
  view.editor.setCursor(pos);
  view.editor.scrollIntoView({ from: pos, to: pos }, true);
  view.containerEl.addClass("yh-flash-target");
  window.setTimeout(() => view.containerEl.removeClass("yh-flash-target"), 850);
}

/** 找到已打开目标 EPUB 的 leaf；viewState 兜底覆盖尚未加载的 deferred leaf。 */
function findOpenEpubLeaf(app: App, file: TFile): WorkspaceLeaf | null {
  const matches = app.workspace.getLeavesOfType(EPUB_READER_VIEW_TYPE).filter((leaf) => {
    const viewFile = (leaf.view as { file?: TFile } | undefined)?.file?.path;
    if (viewFile === file.path) {
      return true;
    }
    const state = leaf.getViewState().state as { file?: unknown } | undefined;
    return state?.file === file.path;
  });
  return matches[0] ?? null;
}

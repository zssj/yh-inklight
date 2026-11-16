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

/** Obsidian 内置 Markdown 视图类型 */
const MARKDOWN_VIEW_TYPE = "markdown";

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
 * - EPUB：打开与定位整体交给插件（openEpubAtCfi：先复用已打开的阅读器，没有才新建），
 *   本层不碰 openFile
 * - PDF：派发自定义事件，由 PDF 层翻页
 * - Markdown：编辑器偏移 → 光标 + 滚动 + 短暂高亮闪烁
 *
 * EPUB 不能在这里先 openFile：openEpubAtCfi 内部会自己建 tab，
 * 两边各建一个就会留下两个同书标签页——一个只恢复进度、一个定位到 CFI，进度互不相同。
 */
export interface OpenAnnotationTargetOptions {
  /** 协议回链（外部点击）用新标签页打开，避免把正在读的导出笔记顶掉 */
  newTab?: boolean;
}

export async function openAnnotationTarget(
  app: App,
  target: AnnotationTarget,
  navigateEpub: (file: TFile, cfiRange: string) => void,
  options?: OpenAnnotationTargetOptions,
): Promise<void> {
  if (target.mode === "epub") {
    // 有 CFI：打开 + 定位一律交给插件，避免本层与 openEpubAtCfi 各开一个标签页
    if (target.cfiRange) {
      navigateEpub(target.file, target.cfiRange);
      return;
    }
    const existing = findOpenEpubLeaf(app, target.file);
    if (existing) {
      app.workspace.revealLeaf(existing);
      return;
    }
  }

  const leaf = app.workspace.getLeaf(options?.newTab ? "tab" : false);
  await leaf.openFile(target.file);

  // 无 CFI 的 EPUB：打开即可，不能继续走下面的 Markdown 定位（会白等 2s 拿不到 MarkdownView）
  if (target.mode === "epub") {
    return;
  }

  if (target.file.extension.toLowerCase() === "pdf") {
    window.setTimeout(() => {
      document.dispatchEvent(new CustomEvent("yh-pdf-goto-page", { detail: { page: target.pageNumber } }));
    }, 120);
    return;
  }

  // 新开标签页时 leaf.view 往往还不是 MarkdownView，直接取会拿到 null 并静默早退，
  // 表现就是「文件打开了但停在开头」——协议回链最容易踩这一条。
  const view = await resolveMarkdownView(app, leaf, target.file);
  if (!view) {
    return;
  }

  applyMarkdownTarget(view, target.offset);
  // 新标签页随后还会做一次滚动位置恢复，会把刚才的定位冲掉；布局稳定后补两次，
  // 160ms 覆盖常见情况，520ms 兜移动端慢设备（只重试，不改用户后续的滚动）。
  for (const delay of [160, 520]) {
    window.setTimeout(() => {
      if (view.editor) {
        applyMarkdownTarget(view, target.offset);
      }
    }, delay);
  }
}

/** 轮询等待目标文件的 MarkdownView 就绪：先看刚打开的 leaf，再扫一遍已打开的 md 标签页 */
async function resolveMarkdownView(
  app: App,
  leaf: WorkspaceLeaf,
  file: TFile,
  timeoutMs = 2000,
): Promise<MarkdownView | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
      return leaf.view;
    }
    const opened = app.workspace
      .getLeavesOfType(MARKDOWN_VIEW_TYPE)
      .find((item) => item.view instanceof MarkdownView && item.view.file?.path === file.path);
    if (opened?.view instanceof MarkdownView) {
      return opened.view;
    }
    await sleep(40);
  }
  // 兜底只认同一个文件：活动视图可能是别的笔记，往那儿定位比不定位更糟
  const active = app.workspace.getActiveViewOfType(MarkdownView);
  return active && active.file?.path === file.path ? active : null;
}

function applyMarkdownTarget(view: MarkdownView, offset: number): void {
  const editor = view.editor;
  const length = editor.getValue().length;
  const pos = editor.offsetToPos(Math.max(0, Math.min(offset, length)));
  editor.setCursor(pos);
  editor.scrollIntoView({ from: pos, to: pos }, true);
  // 阅读视图下编辑器不可见，scrollIntoView 不生效，要单独滚预览（API 未公开，做存在性保护）
  const preview = (view as unknown as { previewMode?: { applyScroll?: (line: number) => void } }).previewMode;
  preview?.applyScroll?.(pos.line);
  view.containerEl.addClass("yh-flash-target");
  window.setTimeout(() => view.containerEl.removeClass("yh-flash-target"), 850);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** 找到已打开目标 EPUB 的 leaf；viewState 兜底覆盖尚未加载的 deferred leaf。 */
export function findOpenEpubLeaf(app: App, file: TFile): WorkspaceLeaf | null {
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

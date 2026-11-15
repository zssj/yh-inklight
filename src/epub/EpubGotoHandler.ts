/**
 * [INPUT]: Obsidian Markdown post processors and exported Inklight callout anchors
 * [OUTPUT]: Wires exported EPUB annotation callouts/links back to the source CFI
 * [POS]: EPUB backlink handler for unified "export annotations" Markdown files
 * [PROTOCOL]: When changed, update this header and check AGENTS.md
 */

import { App, MarkdownPostProcessorContext, Plugin } from "obsidian";

const CALLOUT_TYPE = "inklight-epub";
const CFI_COMMENT_RE = /<!--\s*yh-epub-cfi:\s*(epubcfi\([\s\S]*?\))\s*-->/;
const SOURCE_EXTENSIONS = ["epub", "mobi", "azw3", "fb2", "fbz", "cbz", "txt"];

export interface EpubGotoResolver {
  (annId: string, excerptPath: string): Promise<{ file: string; cfi: string } | null>;
}

export function registerEpubGotoHandler(
  plugin: Plugin,
  openAtCfi: (file: string, cfi: string) => Promise<void>,
  resolveAnn?: EpubGotoResolver,
): void {
  plugin.registerMarkdownPostProcessor((el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
    // 路径白名单只是快速通道：标签 MOC 页（MOC/<标签>.md）不在其中，
    // 但它同样含墨光写的 [data-yh-cfi] 锚点，必须靠页内特征兜底接管，否则回链点击无反应。
    const hasCfiAnchor = el.querySelector("[data-yh-cfi]") !== null;
    if (!shouldHandleAnnotationPage(ctx.sourcePath, hasCfiAnchor)) {
      return;
    }

    el.querySelectorAll("p, pre, code").forEach((node) => {
      const htmlEl = node as HTMLElement;
      if (CFI_COMMENT_RE.test(htmlEl.textContent?.trim() ?? "")) {
        htmlEl.addClass("yh-epub-cfi-hidden");
      }
    });

    wireBackLinks(el, ctx.sourcePath, openAtCfi, resolveAnn, plugin.app);
  });
}

/**
 * 是否接管该区块的 EPUB 回链。
 * 路径命中导出命名规则（`-notes*.md` / `*摘录.md` / `excerpt.md`）时直接接管；
 * 否则只要区块内出现 `[data-yh-cfi]`（只有墨光导出会写）也接管——这条覆盖 MOC 页与用户改过名的导出页。
 */
export function shouldHandleAnnotationPage(sourcePath: string, hasCfiAnchor: boolean): boolean {
  return hasCfiAnchor || isExportedAnnotationPath(sourcePath);
}

export function isExportedAnnotationPath(sourcePath: string): boolean {
  const basename = sourcePath.split("/").pop() ?? sourcePath;
  return /-notes(?:-[^.]+)?\.md$/i.test(basename) || basename.endsWith("摘录.md") || basename.endsWith("excerpt.md");
}

function wireBackLinks(
  el: HTMLElement,
  sourcePath: string,
  goto: (file: string, cfi: string) => Promise<void>,
  resolveAnn: EpubGotoResolver | undefined,
  app: App,
): void {
  el.querySelectorAll("a").forEach((node) => {
    const anchor = node as HTMLAnchorElement;
    const text = anchor.textContent?.trim();
    if (text !== "Back to source" && text !== "回到原文") {
      return;
    }
    wireGotoAnchor(anchor, sourcePath, goto, resolveAnn, app);
  });
}

function wireGotoAnchor(
  anchor: HTMLAnchorElement,
  sourcePath: string,
  goto: (file: string, cfi: string) => Promise<void>,
  resolveAnn: EpubGotoResolver | undefined,
  app: App,
): void {
  if (anchor.dataset.yhEpubGotoWired === "1") {
    return;
  }

  const callout = anchor.closest(".callout");
  const target = callout ? findTargetNear(callout as HTMLElement, sourcePath, app) : null;

  // 解析不到目标时不劫持：新导出的回链本身是 obsidian://inklight-epub 协议链接，原生点击即可跳；
  // 老导出页（href 为 #^<blockId> 自引用锚点）本来也无效，保持原样不会更差。
  if (!target) {
    return;
  }

  anchor.dataset.yhEpubGotoWired = "1";
  anchor.addClass("yh-epub-goto-link");
  anchor.title = "Open source annotation";
  anchor.removeAttribute("href");
  anchor.removeAttribute("data-href");
  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void goto(target.file, target.cfi);
  });
}

function findTargetNear(container: HTMLElement, exportPath: string, app: App): { file: string; cfi: string } | null {
  const cfi = findCfiNear(container);
  if (!cfi) {
    return null;
  }

  const sourcePath = findSourcePathNear(container);
  if (sourcePath && app.vault.getAbstractFileByPath(sourcePath)) {
    return { file: sourcePath, cfi };
  }

  const inferredFile = findEpubFileFromExportPath(exportPath, app);
  return inferredFile ? { file: inferredFile, cfi } : null;
}

function findCfiNear(container: HTMLElement): string | null {
  const span = container.querySelector("[data-yh-cfi]") as HTMLElement | null;
  if (span?.dataset?.yhCfi) {
    return span.dataset.yhCfi;
  }

  const commentMatch = (container.textContent ?? "").match(CFI_COMMENT_RE);
  if (commentMatch) {
    return commentMatch[1];
  }

  const textMatch = (container.textContent ?? "").match(/yh-cfi[=:]\s*(epubcfi\([\s\S]*?\))/i);
  return textMatch ? textMatch[1] : null;
}

function findSourcePathNear(container: HTMLElement): string | null {
  const span = container.querySelector("[data-yh-source-path]") as HTMLElement | null;
  return span?.dataset?.yhSourcePath ?? null;
}

function findEpubFileFromExportPath(exportPath: string, app: App): string | null {
  const basename = exportPath.split("/").pop() ?? "";
  const candidates = [
    basename.replace(/-notes(?:-[^.]+)?\.md$/i, ""),
    basename.replace(/\.md$/i, "").replace(/^《/, "").replace(/》摘录$/, ""),
  ].filter(Boolean);

  for (const candidate of candidates) {
    for (const ext of SOURCE_EXTENSIONS) {
      const file = app.vault.getFiles().find((item) => item.extension.toLowerCase() === ext && item.basename === candidate);
      if (file) {
        return file.path;
      }
    }
  }

  return null;
}

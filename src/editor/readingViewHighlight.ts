/**
 * [INPUT]: 依赖 Reading View 渲染 DOM、TextAnchor 数据与 fuzzyMatch 的容错定位能力
 * [OUTPUT]: 对外提供 installReadingViewHighlights，在非 CodeMirror 阅读模式中注入视觉高亮
 * [POS]: editor 模块的 Reading View 投影层，与 highlightExtension 分别覆盖 HTML DOM 与 CM6
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { MarkdownPostProcessorContext, MarkdownRenderChild, Platform } from "obsidian";

import { findBestFuzzyMatch } from "../anchor/fuzzyMatch";
import { stripText, stripWithMap, strippedScore } from "../anchor/textStrip";
import { AnnotationColor, CommentAnnotation, HighlightAnnotation, TextAnchor } from "../storage/types";
import { highlightBackground } from "./highlightColors";

export type ReadingMark = Pick<HighlightAnnotation | CommentAnnotation, "id" | "color" | "anchor" | "orphaned">;

interface InstallReadingHighlightsOptions {
  root: HTMLElement;
  context: MarkdownPostProcessorContext;
  /** 实时读取最新 marks（不能用安装时的快照：新建高亮后 observer 重绘会用旧列表把新高亮抹掉） */
  getMarks: () => ReadingMark[];
}

interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

interface RenderedRange {
  start: number;
  end: number;
}

interface NormalizedIndex {
  text: string;
  map: number[];
}

const MARK_SELECTOR = ".yh-reading-highlight, mark.yh-highlight";
const MOBILE_RENDER_DELAYS = [0, 80, 220, 520, 900];
const DESKTOP_RENDER_DELAYS = [0, 40, 160];

export function installReadingViewHighlights(options: InstallReadingHighlightsOptions): void {
  const component = new MarkdownRenderChild(options.root);
  let frame: number | null = null;
  let disposed = false;

  const render = (): void => {
    if (disposed) {
      return;
    }

    if (frame !== null) {
      cancelAnimationFrame(frame);
    }

    frame = requestAnimationFrame(() => {
      frame = null;
      refreshReadingViewHighlights(options.root, options.getMarks());
    });
  };

  const delays = Platform.isMobile ? MOBILE_RENDER_DELAYS : DESKTOP_RENDER_DELAYS;
  for (const delay of delays) {
    const timer = window.setTimeout(render, delay);
    component.register(() => window.clearTimeout(timer));
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.every(isOwnHighlightMutation)) {
      return;
    }

    render();
  });
  observer.observe(options.root, { childList: true, subtree: true, characterData: true });

  component.register(() => {
    disposed = true;
    if (frame !== null) {
      cancelAnimationFrame(frame);
    }
    observer.disconnect();
  });
  options.context.addChild(component);
}

export function refreshReadingViewHighlights(root: HTMLElement, marks: ReadingMark[]): void {
  unwrapReadingHighlights(root);
  renderReadingHighlights(root, marks);
  renderCalloutReadingHighlights(root, marks);
}

function renderReadingHighlights(root: HTMLElement, marks: ReadingMark[]): void {
  const liveMarks = marks
    .filter((mark) => !mark.orphaned && mark.anchor.selectedText.trim())
    .sort((left, right) => right.anchor.selectedText.length - left.anchor.selectedText.length);

  for (const mark of liveMarks) {
    if (root.querySelector(highlightSelectorForId(mark.id))) {
      continue;
    }

    wrapRenderedAnchor(root, mark.anchor, mark.color, mark.id);
  }
}

function renderCalloutReadingHighlights(root: HTMLElement, marks: ReadingMark[]): void {
  const callouts = calloutRoots(root);
  if (!callouts.length) {
    return;
  }

  const liveMarks = marks
    .filter((mark) => !mark.orphaned && mark.anchor.selectedText.trim())
    .sort((left, right) => right.anchor.selectedText.length - left.anchor.selectedText.length);

  for (const callout of callouts) {
    for (const mark of liveMarks) {
      if (root.querySelector(highlightSelectorForId(mark.id))) {
        continue;
      }

      wrapRenderedAnchor(callout, mark.anchor, mark.color, mark.id);
    }
  }
}

function calloutRoots(root: HTMLElement): HTMLElement[] {
  const roots = new Set<HTMLElement>();

  if (root.matches(".callout")) {
    roots.add(root);
  }

  const parentCallout = root.closest<HTMLElement>(".callout");
  if (parentCallout) {
    roots.add(parentCallout);
  }

  for (const callout of Array.from(root.querySelectorAll<HTMLElement>(".callout"))) {
    roots.add(callout);
  }

  return Array.from(roots);
}

function unwrapReadingHighlights(root: HTMLElement): void {
  for (const mark of Array.from(root.querySelectorAll<HTMLElement>(MARK_SELECTOR))) {
    const parent = mark.parentNode;
    if (!parent) {
      continue;
    }

    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
    parent.normalize();
  }
}

function wrapRenderedAnchor(root: HTMLElement, anchor: TextAnchor, color: AnnotationColor, id: string): boolean {
  const snapshot = collectText(root);
  if (!snapshot.text.trim()) {
    return false;
  }

  const range = locateRenderedRange(snapshot.text, anchor);
  if (!range || range.start === range.end) {
    return false;
  }

  return wrapRange(snapshot.segments, range, color, id);
}

function locateRenderedRange(renderedText: string, anchor: TextAnchor): RenderedRange | null {
  const exact = locateBestTextRange(renderedText, anchor);
  if (exact) {
    return exact;
  }

  const normalized = locateNormalizedRange(renderedText, anchor);
  if (normalized) {
    return normalized;
  }

  // 编辑模式创建的锚点存的是 Markdown 源码原文（含换行与 ##、**、[[ 等语法字符），
  // 阅读模式渲染 DOM 里两者都不存在，精确/归一化均失配。此处剥掉空白与装饰字符后
  // 再搜，用位置映射还原偏移，并要求前后文评分 ≥ 0.5 防止误匹配到别处。
  const stripped = locateStrippedRange(renderedText, anchor);
  if (stripped) {
    return stripped;
  }

  const fuzzy = findBestFuzzyMatch(
    renderedText,
    anchor.selectedText,
    0,
  );
  if (!fuzzy || fuzzy.confidence < 0.55) {
    return null;
  }

  return {
    start: fuzzy.startOffset,
    end: fuzzy.endOffset,
  };
}

function locateBestTextRange(renderedText: string, anchor: TextAnchor): RenderedRange | null {
  if (!anchor.selectedText) {
    return null;
  }

  let cursor = renderedText.indexOf(anchor.selectedText);
  let best: { range: RenderedRange; score: number } | null = null;

  while (cursor >= 0) {
    const range = {
      start: cursor,
      end: cursor + anchor.selectedText.length,
    };
    const score = rangeScore(renderedText, anchor, range);
    if (!best || score > best.score) {
      best = { range, score };
    }
    cursor = renderedText.indexOf(anchor.selectedText, cursor + 1);
  }

  return best?.range ?? null;
}

function locateNormalizedRange(renderedText: string, anchor: TextAnchor): RenderedRange | null {
  const rendered = normalizeWithMap(renderedText);
  const selected = normalizeWithMap(anchor.selectedText);
  if (!rendered.text || !selected.text) {
    return null;
  }

  let normalizedStart = rendered.text.indexOf(selected.text);
  let best: { range: RenderedRange; score: number } | null = null;

  while (normalizedStart >= 0) {
    const normalizedEnd = normalizedStart + selected.text.length - 1;
    const start = rendered.map[normalizedStart];
    const end = rendered.map[normalizedEnd] + 1;
    if (start !== undefined && end !== undefined && start < end) {
      const range = { start, end };
      const score = rangeScore(renderedText, anchor, range);
      if (!best || score > best.score) {
        best = { range, score };
      }
    }
    normalizedStart = rendered.text.indexOf(selected.text, normalizedStart + 1);
  }

  return best?.range ?? null;
}

function locateStrippedRange(renderedText: string, anchor: TextAnchor): RenderedRange | null {
  if (!anchor.selectedText) {
    return null;
  }

  const rendered = stripWithMap(renderedText);
  const selected = stripWithMap(anchor.selectedText);
  if (rendered.text.length < 2 || !selected.text) {
    return null;
  }

  let strippedStart = rendered.text.indexOf(selected.text);
  let best: { range: RenderedRange; score: number } | null = null;

  while (strippedStart >= 0) {
    const strippedEnd = strippedStart + selected.text.length - 1;
    const start = rendered.map[strippedStart];
    const end = rendered.map[strippedEnd] + 1;
    if (start !== undefined && end !== undefined && start < end) {
      const range = { start, end };
      const score = rangeScore(renderedText, anchor, range);
      if (!best || score > best.score) {
        best = { range, score };
      }
    }
    strippedStart = rendered.text.indexOf(selected.text, strippedStart + 1);
  }

  // 短选区在文中多次出现时上下文评分天然偏弱，收紧阈值防 wrap 到错误实例；
  // 长文本维持 0.5，保证跨行/含语法的选区仍能显示。
  const threshold = stripText(anchor.selectedText).length < 8 ? 0.7 : 0.5;
  if (!best || best.score < threshold) {
    return null;
  }

  return best.range;
}

function rangeScore(renderedText: string, anchor: TextAnchor, range: RenderedRange): number {
  const before = renderedText.slice(Math.max(0, range.start - anchor.prefix.length), range.start);
  const after = renderedText.slice(range.end, Math.min(renderedText.length, range.end + anchor.suffix.length));
  // 锚点 prefix/suffix 是源码切片（含 ** [[ 等语法字符），渲染上下文没有；
  // 剥字符口径评分，两端才可比（阅读模式创建的锚点上下文来自渲染 DOM，同样成立）。
  const context = strippedScore(anchor.prefix, before, "suffix") * 0.45 + strippedScore(anchor.suffix, after, "prefix") * 0.45;
  const distance = 1 - Math.min(1, Math.abs(range.start - anchor.startOffset) / Math.max(renderedText.length, 1));
  return context + distance * 0.1;
}

function normalizeWithMap(value: string): NormalizedIndex {
  let text = "";
  const map: number[] = [];
  let pendingSpace = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (/\s/.test(char)) {
      pendingSpace = text.length > 0;
      continue;
    }

    if (pendingSpace) {
      text += " ";
      map.push(index);
      pendingSpace = false;
    }

    text += char.toLowerCase();
    map.push(index);
  }

  return { text: text.trim(), map };
}

function collectText(root: HTMLElement): { text: string; segments: TextSegment[] } {
  const segments: TextSegment[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) {
        return NodeFilter.FILTER_REJECT;
      }

      const tag = parent.tagName.toLowerCase();
      if (["script", "style"].includes(tag)) {
        return NodeFilter.FILTER_REJECT;
      }

      if (parent.closest(`${MARK_SELECTOR}, mark.yh-highlight, pre, textarea, input`)) {
        return NodeFilter.FILTER_REJECT;
      }

      if (!node.textContent) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node = walker.nextNode() as Text | null;
  while (node) {
    const start = text.length;
    text += node.textContent ?? "";
    segments.push({ node, start, end: text.length });
    node = walker.nextNode() as Text | null;
  }

  return { text, segments };
}

function wrapRange(segments: TextSegment[], range: RenderedRange, color: AnnotationColor, id: string): boolean {
  const touched = segments.filter((segment) => segment.end > range.start && segment.start < range.end);
  if (!touched.length) {
    return false;
  }

  for (const segment of touched) {
    const localStart = Math.max(0, range.start - segment.start);
    const localEnd = Math.min(segment.node.length, range.end - segment.start);
    if (localStart >= localEnd || !segment.node.parentNode) {
      continue;
    }

    const selected = splitTextRange(segment.node, localStart, localEnd);
    const mark = document.createElement("mark");
    mark.className = `yh-reading-highlight yh-highlight yh-highlight--${color}`;
    mark.dataset.yhColor = color;
    mark.dataset.yhId = id;
    mark.style.setProperty("background-color", highlightBackground(color), "important");
    mark.tabIndex = 0;
    selected.parentNode?.insertBefore(mark, selected);
    mark.appendChild(selected);
  }

  return true;
}

function splitTextRange(node: Text, start: number, end: number): Text {
  let selected = node;
  if (start > 0) {
    selected = selected.splitText(start);
  }

  const selectedLength = end - start;
  if (selectedLength < selected.length) {
    selected.splitText(selectedLength);
  }

  return selected;
}

function isOwnHighlightMutation(mutation: MutationRecord): boolean {
  const target = mutation.target;
  if (target instanceof HTMLElement && target.closest(MARK_SELECTOR)) {
    return true;
  }

  return Array.from(mutation.addedNodes).every((node) => {
    return node instanceof HTMLElement && Boolean(node.closest(MARK_SELECTOR));
  });
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return value.replace(/["\\]/g, "\\$&");
}

function highlightSelectorForId(id: string): string {
  const escaped = cssEscape(id);
  return `.yh-reading-highlight[data-yh-id="${escaped}"], mark.yh-highlight[data-yh-id="${escaped}"]`;
}

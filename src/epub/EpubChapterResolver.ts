/**
 * [INPUT]: 依赖 epubjs Book/NavItem/Spine API
 * [OUTPUT]: 提供 TOC→Spine 映射、章节名解析和 spine index 提取
 * [POS]: EPUB 阅读器的章节定位基础设施
 */

export interface TocSpineEntry {
  label: string;
  spineIndex: number;
}

/** 深度优先遍历 TOC，解析每项对应的 spine index */
export function buildTocSpineIndex(book: any, tocItems: any[]): TocSpineEntry[] {
  const entries: TocSpineEntry[] = [];

  function walk(items: any[]): void {
    for (const item of items) {
      const section = book.spine.get(item.href);
      if (section != null && Number.isFinite(section.index)) {
        entries.push({ label: (item.label ?? "").trim(), spineIndex: section.index });
      }
      if (item.subitems?.length) {
        walk(item.subitems);
      }
    }
  }

  walk(tocItems);

  return [...entries].sort((a, b) => a.spineIndex - b.spineIndex);
}

/** 取 spineIndex <= current 的最后一条（同 index 时后出现的子项优先） */
export function resolveChapterLabel(entries: TocSpineEntry[], spineIndex: number): string {
  if (!Number.isFinite(spineIndex) || entries.length === 0) {
    return "";
  }

  let best = "";
  for (const entry of entries) {
    if (entry.spineIndex <= spineIndex) {
      best = entry.label;
    } else {
      break;
    }
  }
  return best;
}

/** 从 epub.js location 或 CFI 提取 spine index */
export function spineIndexFromLocation(
  location: any,
  cfi?: string,
  book?: any,
): number | null {
  const index = location?.start?.index;
  if (typeof index === "number" && Number.isFinite(index)) {
    return index;
  }

  const cfiStr = cfi ?? location?.start?.cfi;
  if (cfiStr && book) {
    const section = book.spine.get(typeof cfiStr === "string" ? cfiStr : String(cfiStr));
    if (section != null && Number.isFinite(section.index)) {
      return section.index;
    }
  }

  return null;
}

/** CFI 规范化：将 epubjs 对象或历史 JSON 统一为 CFI 字符串 */
export function normalizeCfi(cfi: unknown): string {
  if (!cfi) {
    return "";
  }
  if (typeof cfi === "string") {
    return cfi;
  }
  if (typeof cfi === "object" && cfi !== null) {
    const obj = cfi as { str?: unknown; toString?: () => string };
    if (typeof obj.str === "string" && obj.str.startsWith("epubcfi(")) {
      return obj.str;
    }
    if (typeof obj.toString === "function") {
      const s = obj.toString();
      if (s.startsWith("epubcfi(")) {
        return s;
      }
    }
  }
  return "";
}

/** epub.js 使用 0–1；兼容历史误存为 0–100 的数据 */
export function normalizePercent(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0) {
    return 0;
  }
  if (percent > 1) {
    return Math.min(percent / 100, 1);
  }
  return percent;
}

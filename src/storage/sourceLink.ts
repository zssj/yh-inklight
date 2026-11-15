/**
 * [INPUT]: 无外部依赖（纯函数，可在 Node 下直接测试）
 * [OUTPUT]: 对外提供 buildSourceLinkUrl / parseSourceLinkParams / refineOffset / encodeLinkValue，
 *           统一「导出笔记里的 Back to source 链接」与「协议跳转参数」的编解码规则
 * [POS]: 导出层与 main 之间唯一的回链契约。写出去的链接与读回来的参数必须同源，
 *        否则改一处漏一处就会出现「点了没反应」这类只在手机上才发现的故障
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

export type SourceLinkMode = "md" | "pdf" | "epub";

/** 回链协议地址；main.ts 用 inklight 注册处理器，inklight-epub 作为老导出页的兼容入口保留 */
export const SOURCE_LINK_URL = "obsidian://inklight";

/** 协议里携带的原文片段上限：够定位，又不至于把链接撑成一行书 */
const QUOTE_MAX_LENGTH = 80;

/** 片段过短（单字）时匹配噪声太大，宁可不校正 */
const QUOTE_MIN_LENGTH = 4;

export interface SourceLinkInput {
  sourcePath: string;
  mode: SourceLinkMode;
  /** Markdown 字符偏移；pdf/epub 不传 */
  offset?: number;
  pageNumber?: number | null;
  cfiRange?: string;
  /** 被划中的原文，用于偏移漂移后的就近校正 */
  quote?: string;
}

export interface SourceLinkTarget {
  file: string;
  mode: SourceLinkMode;
  /** 无偏移时为 null，调用方应退回「只打开文件」 */
  offset: number | null;
  page: number | null;
  cfi: string | null;
  quote: string;
}

/**
 * Markdown 链接目标转义：`encodeURIComponent` 不会转义 `( ) ! ' *`，
 * 而 CFI 形如 `epubcfi(/6/28[...])`、中文书名常含 `(刘润)`，
 * 这些括号会让 `[text](url)` 在第一个 `)` 处提前结束，链接被截断成死链。
 */
export function encodeLinkValue(value: string): string {
  return encodeURIComponent(value).replace(/[()'!*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function buildSourceLinkUrl(input: SourceLinkInput): string {
  const params = [`file=${encodeLinkValue(input.sourcePath)}`, `mode=${input.mode}`];

  if (typeof input.offset === "number" && Number.isFinite(input.offset) && input.offset >= 0) {
    params.push(`offset=${Math.floor(input.offset)}`);
  }
  if (input.pageNumber && input.pageNumber > 0) {
    params.push(`page=${Math.floor(input.pageNumber)}`);
  }
  if (input.cfiRange) {
    params.push(`cfi=${encodeLinkValue(input.cfiRange)}`);
  }

  const quote = (input.quote ?? "").replace(/\s+/g, " ").trim();
  if (quote) {
    params.push(`text=${encodeLinkValue(quote.slice(0, QUOTE_MAX_LENGTH))}`);
  }

  return `${SOURCE_LINK_URL}?${params.join("&")}`;
}

/**
 * 解析协议参数。Obsidian 交来的值可能已被解码一次，再解一次遇到裸 `%` 会抛 URIError，故容错。
 * 只要拿到文件路径就返回结果：缺 offset/page/cfi 时由调用方降级为「只打开文件」，
 * 这比整条链接失效好得多（老库里的链接可能是旧版本写出来的）。
 */
export function parseSourceLinkParams(params: Record<string, unknown>): SourceLinkTarget | null {
  const file = decodeParam(params.file);
  if (!file) {
    return null;
  }

  const rawMode = decodeParam(params.mode).toLowerCase();
  const mode: SourceLinkMode = rawMode === "pdf" || rawMode === "epub" || rawMode === "md"
    ? rawMode
    : inferMode(file);

  return {
    file,
    mode,
    offset: toPosition(decodeParam(params.offset)),
    page: toPosition(decodeParam(params.page)),
    cfi: decodeParam(params.cfi) || null,
    quote: decodeParam(params.text),
  };
}

/**
 * 偏移漂移校正。`startOffset` 是裸字符下标，只要用户在原文上方增删过文字就会偏。
 * 策略：把正文与片段都去掉空白后做子串查找，取**离原偏移最近**的那一处；
 * 找不到（原文被改写、片段为空、片段过短）就原样返回，交给调用方按偏移硬跳。
 */
export function refineOffset(content: string, offset: number, quote: string): number {
  const limit = Math.max(content.length - 1, 0);
  const clamped = Math.min(Math.max(Math.floor(offset) || 0, 0), limit);
  const needle = normalizeFragment(quote);
  if (needle.length < QUOTE_MIN_LENGTH) {
    return clamped;
  }

  const { normalized, map } = normalizeWithMap(content);
  if (normalized.length < needle.length) {
    return clamped;
  }

  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let cursor = 0;

  while (cursor <= normalized.length - needle.length) {
    const hit = normalized.indexOf(needle, cursor);
    if (hit < 0) {
      break;
    }
    const originalIndex = map[hit];
    const distance = Math.abs(originalIndex - clamped);
    if (distance < bestDistance) {
      best = originalIndex;
      bestDistance = distance;
    }
    if (distance === 0) {
      break;
    }
    cursor = hit + 1;
  }

  return best >= 0 ? best : clamped;
}

function decodeParam(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function toPosition(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferMode(filePath: string): SourceLinkMode {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "pdf") {
    return "pdf";
  }
  if (extension === "epub" || extension === "mobi" || extension === "azw3" || extension === "fb2" || extension === "txt") {
    return "epub";
  }
  return "md";
}

function normalizeFragment(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

/** 去掉空白并记录每个字符在原文中的下标，用于把归一化命中位置映射回原始偏移 */
function normalizeWithMap(content: string): { normalized: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (/\s/.test(char)) {
      continue;
    }
    chars.push(char.toLowerCase());
    map.push(index);
  }
  return { normalized: chars.join(""), map };
}

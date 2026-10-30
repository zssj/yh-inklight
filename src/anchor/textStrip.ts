/**
 * [INPUT]: 依赖纯字符串处理，无外部依赖
 * [OUTPUT]: 对外提供剥除 Markdown 装饰字符/空白的 stripText、stripWithMap 及 strippedScore 上下文评分
 * [POS]: anchor 模块的文本归一化工具，被 main.ts 源码定位与 readingViewHighlight 渲染匹配共享，
 *        保证"渲染文本 ↔ 源码"两端使用同一套剥除规则与评分口径
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

/** Markdown 装饰字符：渲染后不显示、但存在于源码中的符号 */
const MARKDOWN_DECORATION_CHARS = new Set([
  "*",
  "_",
  "~",
  "=",
  "`",
  "[",
  "]",
  "(",
  ")",
  "#",
  ">",
  "|",
  "+",
  "-",
]);

export interface StrippedIndex {
  text: string;
  map: number[];
}

/**
 * 空白折叠归一化：连续空白折叠为单个空格、统一小写，保留原位置映射。
 * 用于解决"渲染选区段间一个 \n、源码段间空行 \n\n"这类换行形态差异
 * ——折叠后两端精确相等，偏移经 map 还原分毫不差。
 */
export function foldWhitespaceWithMap(value: string): StrippedIndex {
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

  return { text, map };
}

/** 剥掉空白与 Markdown 装饰字符，返回纯文本内容 */
export function stripText(text: string): string {
  return stripWithMap(text).text;
}

/**
 * 剥掉空白与 Markdown 装饰字符，保留原位置映射
 * （map[i] = 第 i 个保留字符在原文中的下标）。
 */
export function stripWithMap(text: string): StrippedIndex {
  const map: number[] = [];
  let stripped = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/\s/.test(char) || MARKDOWN_DECORATION_CHARS.has(char)) {
      continue;
    }
    stripped += char;
    map.push(index);
  }

  return { text: stripped, map };
}

/**
 * 上下文相似度评分（0~1）：剥除装饰字符后比较 expected 与 actual 的
 * 最长公共前缀/后缀占比。mode 指定比较方向：
 * - "suffix": 比较尾部对齐（用于选区【前】文，前文尾部应与选区衔接）
 * - "prefix": 比较头部对齐（用于选区【后】文，后文头部应与选区衔接）
 */
export function strippedScore(expected: string, actual: string, mode: "prefix" | "suffix"): number {
  const left = stripText(expected);
  const right = stripText(actual);

  if (!left && !right) {
    return 1;
  }
  if (!left || !right) {
    return 0;
  }

  if (mode === "suffix") {
    if (right.endsWith(left) || left.endsWith(right)) {
      return 1;
    }
    let shared = 0;
    const max = Math.min(left.length, right.length);
    for (let index = 1; index <= max; index += 1) {
      if (left.slice(-index) === right.slice(-index)) {
        shared = index;
      }
    }
    return shared / Math.max(left.length, right.length);
  }

  if (right.startsWith(left) || left.startsWith(right)) {
    return 1;
  }
  let shared = 0;
  const max = Math.min(left.length, right.length);
  for (let index = 1; index <= max; index += 1) {
    if (left.slice(0, index) === right.slice(0, index)) {
      shared = index;
    }
  }
  return shared / Math.max(left.length, right.length);
}

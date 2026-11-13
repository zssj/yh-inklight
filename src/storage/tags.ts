/**
 * [INPUT]: 无外部依赖，纯字符串处理
 * [OUTPUT]: 对外提供标签归一化（normalizeTag / normalizeTags）、比较键（tagKey）、并集（unionTags）、
 *           Obsidian 标签语法转换（toObsidianTag / toObsidianTags）、排序键（sortTagKeys）与容量常量
 * [POS]: storage 模块的标签规则单点，被 annotationStore、views/tagInput、views/sidebarView、views/tagBoardView 共享
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

/** 单个标签的最大字符数（按 Unicode 码点计，中文一字一码点） */
export const MAX_TAG_LENGTH = 32;
/** 单条批注最多挂多少个标签 */
export const MAX_TAGS_PER_ANNOTATION = 12;
/** 卡片上直接展示的 chip 数，超出折叠为 +N */
export const MAX_VISIBLE_TAG_CHIPS = 4;

/**
 * 标签内不允许出现的字符：
 * - `#` 已在前置步骤剥离，此处兜底清掉内部残留
 * - 路径分隔与 shell 通配符，避免将来导出为 md 标签时出问题
 * - `/` 特意保留：Obsidian 用它表示嵌套标签（`认知/偏差`）
 */
const ILLEGAL_CHARS = /[#[\]|\\:*?"<>]/g;
const WHITESPACE_RUN = /\s+/g;

/**
 * 归一化单个标签。返回 null 表示这不是一个有效标签。
 * 存储保留用户原本的大小写写法，比较统一走 tagKey。
 */
export function normalizeTag(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") {
    return null;
  }

  const stripped = raw.replace(/^#+/, "");
  const collapsed = stripped.replace(WHITESPACE_RUN, " ").replace(ILLEGAL_CHARS, "").trim();

  if (!collapsed) {
    return null;
  }

  const clipped = Array.from(collapsed).slice(0, MAX_TAG_LENGTH).join("").trim();
  return clipped || null;
}

/** 标签的比较键：小写。中文不受影响，英文做到 `Foo` 与 `foo` 视为同一标签 */
export function tagKey(tag: string): string {
  return normalizeTag(tag)?.toLowerCase() ?? "";
}

/**
 * 数组级归一化：逐个清洗 → 按 tagKey 去重（保留首次出现的写法）→ 截断数量。
 * 传入 undefined / 非数组时返回空数组，供老数据直接使用。
 */
export function normalizeTags(input: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const result: string[] = [];
  const seen = new Set<string>();

  for (const item of input) {
    const tag = normalizeTag(item);
    if (!tag) {
      continue;
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(tag);
    if (result.length >= MAX_TAGS_PER_ANNOTATION) {
      break;
    }
  }

  return result;
}

/** 多条来源（高亮与其笔记）的标签并集，保持先后顺序 */
export function unionTags(...lists: Array<readonly string[] | null | undefined>): string[] {
  const merged: string[] = [];
  for (const list of lists) {
    if (Array.isArray(list)) {
      merged.push(...list);
    }
  }
  return normalizeTags(merged);
}

/** 判断某条批注是否含指定标签（按比较键） */
export function hasTag(tags: readonly string[] | null | undefined, key: string): boolean {
  if (!key || !Array.isArray(tags)) {
    return false;
  }
  return tags.some((tag) => tagKey(tag) === key);
}

/** 排序键：用于索引里 tags 数组的稳定输出（小写升序） */
export function sortTagKeys(keys: readonly string[]): string[] {
  return Array.from(new Set(keys.filter((key) => !!key))).sort((left, right) => left.localeCompare(right));
}

/**
 * Obsidian 标签只接受 Unicode 字母/数字、`_`、`-` 与 `/`（嵌套）。
 * 空白折叠成一个 `-`（保住词边界），其余标点直接剔除，避免导出后被截断。
 * 与 normalizeTag 的差异：后者允许空格与更多标点，故写入 md 前必须再过这一层。
 */
const OB_WHITESPACE = /\s+/g;
const OB_PUNCTUATION = /[^\p{L}\p{N}/_-]+/gu;
/** 纯数字标签 Obsidian 不识别，统一加前缀 */
const OB_NUMERIC_PREFIX = "tag-";

/**
 * 把插件标签转换为可被 Obsidian metadataCache 索引的标签文本（不含 `#`）。
 * 输出统一小写，与 index.json 的 tagNames key / tagKey() 对齐。
 * 返回 null 表示转换后无有效内容。
 */
export function toObsidianTag(raw: string | null | undefined): string | null {
  const base = normalizeTag(raw);
  if (!base) {
    return null;
  }

  const segments = base
    .split("/")
    .map((part) =>
      part
        .replace(OB_WHITESPACE, "-")
        .replace(OB_PUNCTUATION, "")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase(),
    )
    .filter((part) => part.length > 0);

  const result = segments.join("/");
  if (!result) {
    return null;
  }

  // 去掉分隔符与连字符后仍全是数字 → OB 会当作无效标签
  return /^\d+$/.test(result.replace(/[/\-_]/g, "")) ? `${OB_NUMERIC_PREFIX}${result}` : result;
}

/** 数组版转换：逐项转换 → 按结果去重，顺序保持输入顺序 */
export function toObsidianTags(input: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const tag = toObsidianTag(item);
    if (!tag || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

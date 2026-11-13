/**
 * [INPUT]: 无外部依赖，纯字符串处理
 * [OUTPUT]: 对外提供 extractTerms（中文 2-gram + ASCII 词，词频取前 N）、termOverlap（Jaccard 与命中词）、
 *           isRelationEligible（短文本 / 代码选区过滤）与常量 MIN_RELATION_TEXT_CHARS
 * [POS]: utils 模块的字面抽词单点，供 views/relationModel 的标签推荐与相关批注共用；
 *        不引分词库、不联网、不做语义；换个说法认不出是已知且接受的限制
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

/** 短于这个长度的划线不参与关联：词太少必然乱配 */
export const MIN_RELATION_TEXT_CHARS = 8;
/** 长文本只取前 500 字抽词，避免大段引用拖慢侧栏 */
const MAX_TEXT_CHARS = 500;
/** 每条划线保留的词条数 */
const MAX_TERMS = 12;
/** 字面相关的 Jaccard 下限 */
export const RELATED_THRESHOLD = 0.25;

/**
 * 无区分度的双字词。2-gram 会把「目的」「的了」一起切出来，
 * 用整词黑名单滤掉噪音，比按单字过滤（会误伤实词）更稳。
 */
const STOP_GRAMS = new Set([
  "我们", "你们", "他们", "这个", "那个", "这些", "那些", "什么", "怎么", "为了",
  "因为", "所以", "但是", "如果", "可以", "一个", "没有", "就是", "不是", "时候",
  "这样", "那样", "以及", "并且", "而且", "还有", "自己", "已经", "可能", "应该",
  "需要", "通过", "关于", "对于", "其中", "之后", "之前", "一些", "一种", "一直",
  "非常", "更加", "主要", "方面", "问题", "的了", "是在", "是个", "这个", "这种",
]);

const CJK_RUN = /[\u3400-\u9fff]+/g;
const ASCII_WORD = /[a-z0-9][a-z0-9_-]*/g;

/** 去 Markdown / wiki / HTML 装饰，统一小写并截断。不改变词组顺序。 */
function normalize(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[\[[^\]]*\]\]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_`~|]/g, " ")
    .toLowerCase()
    .slice(0, MAX_TEXT_CHARS);
}

/**
 * 把一段文本切成词条：中文按连续汉字串做 2-gram，英文/数字按空格词。
 * 按词频降序取前 MAX_TERMS，同频按字典序保证输出稳定。
 */
export function extractTerms(text: string): string[] {
  const clean = normalize(text);
  if (clean.trim().length < MIN_RELATION_TEXT_CHARS) {
    return [];
  }

  const counts = new Map<string, number>();
  const add = (term: string): void => {
    if (term.length < 2) {
      return;
    }
    counts.set(term, (counts.get(term) ?? 0) + 1);
  };

  for (const word of clean.match(ASCII_WORD) ?? []) {
    if (!/^\d+$/.test(word)) {
      add(word);
    }
  }

  for (const run of clean.match(CJK_RUN) ?? []) {
    for (let i = 0; i + 1 < run.length; i += 1) {
      const gram = run.slice(i, i + 2);
      if (!STOP_GRAMS.has(gram)) {
        add(gram);
      }
    }
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_TERMS)
    .map(([term]) => term);
}

export interface TermOverlap {
  /** Jaccard：交集 / 并集 */
  score: number;
  /** 两边都出现的词，用于给用户解释「为什么相关」 */
  shared: string[];
}

/** 两组词条的字面重合度。任一组为空直接返回 0。 */
export function termOverlap(a: readonly string[], b: readonly string[]): TermOverlap {
  if (a.length === 0 || b.length === 0) {
    return { score: 0, shared: [] };
  }
  const setB = new Set(b);
  const shared = a.filter((term) => setB.has(term));
  const union = new Set([...a, ...b]).size;
  return { score: union > 0 ? shared.length / union : 0, shared };
}

/** 代码选区与过短划线一律不参与关联，避免符号噪音和乱配 */
export function isRelationEligible(text: string, isCode: boolean): boolean {
  return !isCode && text.trim().length >= MIN_RELATION_TEXT_CHARS;
}

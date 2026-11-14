/**
 * [INPUT]: 无外部依赖，纯字符串处理
 * [OUTPUT]: 对外提供 extractTerms（中文 2/3-gram + ASCII 词，全量去重）、rankTerms（按全库文档频率挑稀有词），
 *           以及常量 MIN_RELATION_TEXT_CHARS
 * [POS]: utils 模块的抽词单点，现仅供 views/relationModel 的标签推荐（getRecommendedTags）使用；
 *        相关批注的匹配已改走 utils/textPhrases 的短语级算法，本文件不再承担判定职责；
 *        不引分词库、不联网、不做语义；换个说法认不出是已知且接受的限制
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

/** 短于这个长度的划线不参与关联：词太少必然乱配 */
export const MIN_RELATION_TEXT_CHARS = 8;
/** 长文本只取前 600 字抽词；EPUB 选区常是整段，比 md 手写划线长得多 */
const MAX_TEXT_CHARS = 600;
/** 单条文本允许产生的词条上限，防止超长引用拖垮全库快照 */
const MAX_RAW_TERMS = 400;
/** 参与匹配的词条数（先按全库稀有度排序再截断） */
export const MAX_TERMS = 24;

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
  "也就是说", "事实上", "实际上", "一般来说", "换句话说",
]);

const CJK_RUN = /[\u3400-\u9fff]+/g;
const ASCII_WORD = /[a-z0-9][a-z0-9_-]*/g;

/**
 * 去 Markdown / wiki / HTML 装饰，剥 HTML 实体，折叠换行与连续空白后截断。
 * EPUB 选区常带 \n\n 与引号：折叠成空格可避免把上句末字和下句首字拼成假词，
 * 同时保留中文标点作为天然断句边界（CJK_RUN 不会跨标点连续匹配）。
 */
function normalize(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[\[[^\]]*\]\]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+|#x[0-9a-f]+);/gi, " ")
    .replace(/[#>*_`~|]/g, " ")
    .replace(/[\s\u00a0]+/g, " ")
    .toLowerCase()
    .slice(0, MAX_TEXT_CHARS);
}

/**
 * 把一段文本切成词条：中文按连续汉字串做 2-gram 与 3-gram，英文/数字按空格词。
 * 返回全量去重词（稳定字典序），由调用方用 rankTerms 按全库稀有度挑选——
 * 单条文本里词频几乎全为 1，直接按词频截断会把「确认偏误」这类术语挤掉，
 * 正是 EPUB 长段落同术语复现无法命中的主因之一。
 */
export function extractTerms(text: string): string[] {
  const clean = normalize(text);
  if (clean.trim().length < MIN_RELATION_TEXT_CHARS) {
    return [];
  }

  const terms = new Set<string>();
  const add = (term: string): void => {
    if (term.length >= 2) {
      terms.add(term);
    }
  };

  for (const word of clean.match(ASCII_WORD) ?? []) {
    if (!/^\d+$/.test(word)) {
      add(word);
    }
  }

  for (const run of clean.match(CJK_RUN) ?? []) {
    for (let i = 0; i + 1 < run.length; i += 1) {
      const gram2 = run.slice(i, i + 2);
      if (STOP_GRAMS.has(gram2)) {
        continue;
      }
      add(gram2);
      // 3-gram 更贴近术语，且能把「确认偏误」这类四字词的可解释片段留下来
      if (i + 2 < run.length) {
        const gram3 = run.slice(i, i + 3);
        if (!STOP_GRAMS.has(gram3) && !STOP_GRAMS.has(gram3.slice(1))) {
          add(gram3);
        }
      }
    }
  }

  return Array.from(terms).sort().slice(0, MAX_RAW_TERMS);
}

/**
 * 按全库文档频率（df）挑出最有区分度的词：df>=2 的稀有词优先，df<=1 的词
 * 不可能与其它卡片共享、一律垫底；同 df 下长词优先，最后按字典序保证稳定。
 */
export function rankTerms(
  terms: readonly string[],
  df: ReadonlyMap<string, number>,
  limit: number = MAX_TERMS,
): string[] {
  const priority = (term: string): number => {
    const count = df.get(term) ?? 0;
    return count >= 2 ? count : 1000 + count;
  };
  return Array.from(new Set(terms))
    .sort((left, right) =>
      priority(left) - priority(right)
      || right.length - left.length
      || left.localeCompare(right))
    .slice(0, limit);
}

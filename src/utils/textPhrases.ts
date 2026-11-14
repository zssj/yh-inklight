/**
 * [INPUT]: 无外部依赖，纯字符串处理
 * [OUTPUT]: 对外提供 cleanText（清洗归一）、splitSegments（切词段）、expandPhrase（从共同种子向两侧扩展成最长公共短语）、
 *           trimPhrase（修剪首尾虚词残段）、isNoisePhrase（套话/元话语/通用短语过滤）、
 *           hasTermSuffix（术语后缀判定）、startsWithWeakToken（数量词/否定词开头判定）、
 *           phraseSpecificity（短语区分度）、isRelationEligible（短文本 / 代码选区过滤），
 *           以及常量 MIN_PHRASE_LENGTH / SEED_LENGTH / MIN_LATIN_PHRASE_LENGTH / MIN_RELATION_TEXT_CHARS
 * [POS]: utils 模块的字面短语单点，供 views/relationModel 的相关批注共用；
 *        匹配单位是「完整词段里的具体短语」，不是词袋：不再用 2-gram 碎片凑命中，
 *        避免「都提到『的渴望』」这种没有信息量的推荐；
 *        不引分词库、不联网、不做语义
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

/** 短于这个长度的划线不参与关联：内容太少必然乱配 */
export const MIN_RELATION_TEXT_CHARS = 8;
/** 长文本只取前 600 字；EPUB 选区常是整段，比 md 手写划线长得多 */
export const MAX_TEXT_CHARS = 600;
/** 公共短语的最短长度：4 个汉字起步，低于此长度的说法没有区分度 */
export const MIN_PHRASE_LENGTH = 4;
/** 倒排种子长度：与 MIN_PHRASE_LENGTH 对齐，保证每个短语都能被种子索引找到 */
export const SEED_LENGTH = 4;
/** 纯拉丁短语的最短长度：单词太短没有区分度，多词短语另按词数判定 */
export const MIN_LATIN_PHRASE_LENGTH = 8;

/**
 * 功能字：虚词、代词、连词、介词、量词、助词。
 * 切词段时在这些字上断开，「工业革命的核心是能源转换」会变成
 * 「工业革命」「核心」「能源转换」——真正的术语才能作为整体参与匹配。
 */
const FUNCTION_CHARS = new Set(
  "的了着过是在和与也都就而但还更不很该此这那有以所其之于为把被让向从到对给比才又再只个种些并或如若则及吗呢吧啊呀哦嘛呗么你您我他她它们".split(""),
);

/**
 * 无区分度的通用字：短语基本由这些字拼成时，说明它只是行文套话，
 * 不代表两条划线在谈同一件事。
 */
const GENERIC_CHARS = new Set(
  "重要实际生活应该可能需要研究表结果问题方面工作方式方法感觉体验东西部分条件状态数量过程阶段一种时间社会人们事情情况地方世界进行出现具有成为使用作用影响变化发展".split(""),
);

/**
 * 整段是套话 / 序数 / 过渡语，不构成共同话题。
 * 只列不会被切词段规则打碎的完整短语。
 */
const PHRASE_STOP = new Set([
  "一方面", "另一方面", "一般来说", "一般而言", "换句话说", "换言之", "事实上", "实际上",
  "值得注意的是", "需要注意的是", "综上所述", "总而言之", "所谓", "以下", "如下", "上述",
  "不言而喻", "毋庸置疑", "众所周知",
]);

/**
 * 元话语：谈论「这句话」「这段原文」的词。
 * 两张划线都写「这句话出自《XX》」时字面完全重合，但说的不是同一件事，必须排除。
 */
const META_WORDS = [
  "原文", "出处", "出自", "来源", "背景", "作者", "读者", "划线", "批注", "备注", "笔记",
  "摘录", "引用", "参见", "补充说明", "展开说明", "这段", "这句", "那句", "本句", "下句", "上句",
];

/**
 * 代词：谈论对象相同不代表话题相同（「我」「我们」在每本书里都有）。
 */
const PRONOUN_WORDS = [
  "自己", "别人", "他人", "彼此", "人们", "大家", "有人", "咱们", "人家", "谁", "什么", "怎么", "怎样",
];

/** 纯拉丁短语里的常见词，长度虽够但没有信息量 */
const LATIN_STOP = new Set([
  "about", "there", "their", "which", "would", "could", "should", "other", "these", "those",
  "what", "when", "where", "while", "because", "however", "therefore", "whether", "everything",
  "something", "anything", "nothing", "really", "always", "never", "often", "sometimes",
  "indeed", "perhaps", "rather", "certain", "single", "another", "through", "before",
  "people", "system", "market", "effect", "theory", "value", "level", "issue", "change",
  "result", "process", "become", "business", "government", "important", "different",
]);

/**
 * 术语后缀：中文术语常见的收尾成分。
 * 「复利效应」「亲密关系」「增强回路」这类短语即使只有四个字，也能表明在谈同一个概念；
 * 「最佳方法」「综合起来」则不含任何术语成分，属于行文套话。
 */
const TERM_SUFFIXES = [
  "关系", "理论", "效应", "原则", "规律", "成本", "循环", "回路", "机制", "模型", "系统", "结构",
  "法则", "定律", "阶级", "主义", "趋势", "指数", "壁垒", "范式", "策略", "优势", "差异", "障碍",
  "因素", "心理", "生理", "反应", "需求", "供给", "市场", "商品", "波动", "增长", "阅读", "思维",
  "思考", "感情", "感受", "习惯", "能力", "学",
];

/**
 * 弱开头：数量词 / 序数词开头的基本不是术语。
 * 「一篇文章」「第一」「第二个」这类短语在任何书里都能对上，没有区分度。
 */
const WEAK_NUMBER_PREFIX = new Set(
  "一二三四五六七八九十百千两数每某该本次个点位名遍种件几第各另同每另".split(""),
);

/** 弱否定开头（仅对最短的短语生效）：「无忧无虑」「无法改变」不是术语 */
const WEAK_NEGATION_PREFIX = new Set("无不没未非莫勿毋".split(""));

/**
 * 首尾虚词残段：短语切在功能字边界上时容易带出这些字，
 * 「话出自」「人际关系中」这类尾巴没有信息量，应当修剪掉。
 */
const TRIM_CHARS = new Set("中上下里前时后内份点些个".split(""));

const CJK_PATTERN = /[\u3400-\u9fff]/;
const LATIN_PATTERN = /[a-z0-9]/;

/**
 * 去 Markdown / wiki / HTML 装饰，剥 HTML 实体，折叠空白并截断，
 * 最后把非「字母数字汉字」的字符统一换成空格。
 * 中文标点因此变成天然断句边界：短语不会跨过句号逗号去凑出假的长句。
 */
export function cleanText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[\[[^\]]*\]\]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+|#x[0-9a-f]+);/gi, " ")
    .replace(/[#>*_`~|]/g, " ")
    .replace(/[\s\u00a0]+/g, " ")
    .toLowerCase()
    .slice(0, MAX_TEXT_CHARS)
    .replace(/[^0-9a-z\u3400-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 把清洗后的文本切成词段。
 *
 * - 中文：在空白与功能字处断开，保留长度 ≥2 的段
 *   （「工业革命的核心是能源转换」→「工业革命」「核心」「能源转换」）
 * - 拉丁：连续的英文单词合并成一个词段（"coolidge effect"），
 *   这样「完整术语」不会被空格切碎，也不会退化成 "lation" 这种碎片
 * - 纯数字段丢弃
 */
export function splitSegments(dense: string): string[] {
  const segments: string[] = [];
  let latinRun: string[] = [];

  const flushLatin = (): void => {
    if (latinRun.length > 0) {
      segments.push(latinRun.join(" "));
      latinRun = [];
    }
  };

  for (const token of dense.split(" ")) {
    if (!token) {
      continue;
    }
    if (CJK_PATTERN.test(token)) {
      flushLatin();
      let current = "";
      const flushCjk = (): void => {
        if (current.length >= 2) {
          segments.push(current);
        }
        current = "";
      };
      for (const ch of token) {
        if (FUNCTION_CHARS.has(ch)) {
          flushCjk();
          continue;
        }
        current += ch;
      }
      flushCjk();
      continue;
    }
    if (/^\d+$/.test(token)) {
      flushLatin();
      continue;
    }
    latinRun.push(token);
  }
  flushLatin();

  return segments;
}

/**
 * 短语里的「有信息量」字数：汉字里去掉通用字后的个数，以及拉丁字母个数。
 * 用来判断一条短语是不是只有套话。
 */
export function phraseSpecificity(phrase: string): { cjk: number; latin: number } {
  let cjk = 0;
  let latin = 0;
  for (const ch of phrase) {
    if (CJK_PATTERN.test(ch)) {
      if (!GENERIC_CHARS.has(ch)) {
        cjk += 1;
      }
    } else if (LATIN_PATTERN.test(ch)) {
      latin += 1;
    }
  }
  return { cjk, latin };
}

/**
 * 判断一条公共短语是不是噪音：
 * 套话清单、元话语、代词、纯通用字拼成、汉字信息量不足 2、拉丁词太短或命中常见词。
 */
export function isNoisePhrase(phrase: string): boolean {
  if (phrase.length < MIN_PHRASE_LENGTH) {
    return true;
  }
  if (PHRASE_STOP.has(phrase)) {
    return true;
  }
  if (META_WORDS.some((word) => phrase.includes(word))) {
    return true;
  }
  if (PRONOUN_WORDS.some((word) => phrase.includes(word))) {
    return true;
  }
  const { cjk, latin } = phraseSpecificity(phrase);
  if (cjk > 0) {
    return cjk < 2;
  }
  const words = phrase.split(" ").filter(Boolean);
  if (words.length === 1) {
    return latin < MIN_LATIN_PHRASE_LENGTH || LATIN_STOP.has(phrase);
  }
  if (latin < MIN_LATIN_PHRASE_LENGTH) {
    return true;
  }
  if (words.some((word) => word.length < 3)) {
    return true;
  }
  return LATIN_STOP.has(phrase);
}

/**
 * 修剪短语首尾的虚词残段：切在功能字边界上时会带出这些字，
 * 「人际关系中」→「人际关系」。
 */
export function trimPhrase(phrase: string): string {
  let result = phrase;
  while (result.length > MIN_PHRASE_LENGTH && TRIM_CHARS.has(result[0])) {
    result = result.slice(1);
  }
  while (result.length > MIN_PHRASE_LENGTH && TRIM_CHARS.has(result[result.length - 1])) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * 短语是不是一个「术语」：以常见的术语成分收尾。
 * 「复利效应」「亲密关系」「增强回路」→ 是；「最佳方法」「综合起来」→ 不是。
 */
export function hasTermSuffix(phrase: string): boolean {
  return TERM_SUFFIXES.some((suffix) => phrase.endsWith(suffix));
}

/**
 * 短语是不是以数量词 / 序数词 / 否定词开头：
 * 「一篇文章」「第二个」「无忧无虑」这类短语在任何书里都能对上，没有区分度。
 */
export function startsWithWeakToken(phrase: string): boolean {
  const first = phrase[0];
  if (!first) {
    return true;
  }
  if (WEAK_NUMBER_PREFIX.has(first)) {
    return true;
  }
  if (phrase.length === MIN_PHRASE_LENGTH && WEAK_NEGATION_PREFIX.has(first)) {
    return true;
  }
  return false;
}

/**
 * 从一个共同种子向两侧扩展成最长公共短语。
 * leftOffset / rightOffset 是种子在两段里的起始位置；
 * 返回公共的最长子串（可能为空串，表示只有种子本身）。
 */
export function expandPhrase(
  left: string,
  leftOffset: number,
  right: string,
  rightOffset: number,
  maxLength: number,
): string {
  let start = 0;
  while (
    start < maxLength
    && leftOffset - start - 1 >= 0
    && rightOffset - start - 1 >= 0
    && left[leftOffset - start - 1] === right[rightOffset - start - 1]
  ) {
    start += 1;
  }
  let end = SEED_LENGTH;
  while (
    end < maxLength
    && leftOffset + end < left.length
    && rightOffset + end < right.length
    && left[leftOffset + end] === right[rightOffset + end]
  ) {
    end += 1;
  }
  return left.slice(leftOffset - start, leftOffset + end);
}

/** 代码选区与过短划线一律不参与关联，避免符号噪音和乱配 */
export function isRelationEligible(text: string, isCode: boolean): boolean {
  return !isCode && text.trim().length >= MIN_RELATION_TEXT_CHARS;
}

/**
 * [INPUT]: 依赖 AnnotationStore 的全库文档与 version、views/cardModel 的 SidebarCard、
 *          utils/textPhrases 的短语级匹配、utils/textTerms 的细粒度词条（仅标签推荐用）
 * [OUTPUT]: 对外提供 RelationModel：prepare（按需内存快照）、getRelated（短语级相关 + 命中理由）、
 *           getRecommendedTags（按内容推荐历史标签）、invalidate
 * [POS]: views 模块的派生数据层，与 cardModel 同层；纯内存、不落盘、不写 sidecar、不升 index 版本。
 *        删批注 / 改名 / 删源文件全部由 store.version 自动失效，无需单独迁移索引。
 *        匹配单位是「跨书罕见的具体短语」，不是词袋：2-gram 碎片共现不再算相关，
 *        避免整屏都是「都提到『的渴望』」这种没有信息量的推荐。
 *        同文档与跨文档用不同门槛：同文档只要求短语够长够罕见，
 *        跨文档还要求短语带术语特征（长度 ≥5 或含罕见字 / 术语后缀），
 *        因为跨书撞词的概率高得多，「最佳方法」这种行文套话在每本书里都有。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import type { AnnotationStore } from "../storage/annotationStore";
import type { FileAnnotationDocument } from "../storage/types";
import { tagKey } from "../storage/tags";
import { buildCards, SidebarCard } from "./cardModel";
import {
  cleanText,
  expandPhrase,
  hasTermSuffix,
  isNoisePhrase,
  isRelationEligible,
  MIN_PHRASE_LENGTH,
  MIN_RELATION_TEXT_CHARS,
  SEED_LENGTH,
  splitSegments,
  startsWithWeakToken,
  trimPhrase,
} from "../utils/textPhrases";
import { extractTerms, rankTerms } from "../utils/textTerms";

const RELATED_LIMIT = 5;
const RECOMMEND_LIMIT = 3;
/** 标签少于 3 个或卡片少于 10 条时不出推荐：冷启动没有可依据的分布 */
const COLD_START_MIN_TAGS = 3;
const COLD_START_MIN_CARDS = 10;
/** 同一 version 内的短缓存，避免搜索输入连续重绘时反复拍平全库 */
const CACHE_TTL_MS = 3000;
/** 超大库保护：参与关联的卡片上限，超出部分按文档顺序截断 */
const MAX_ENTRIES = 4000;
/**
 * 短语出现在多少个源文档里算「罕见」：超过此值说明这是通用说法而不是术语，
 * 命中它不代表两条划线在谈同一件事。
 */
const MAX_PHRASE_DOCUMENTS = 3;
/**
 * 跨文档时 5 字以上的短语直接放行：这么长的中文短语基本已经是术语。
 * 4 字短语要另加术语特征判定（罕见字 / 术语后缀），否则「最佳方法」这类套话会命中。
 */
const CROSS_MIN_PHRASE_LENGTH = 5;
/**
 * 跨文档 4 字短语里的「罕见字」门槛：短语中至少有一个汉字，
 * 出现在不超过这么多源文档里（含它的短语多半是专名或术语）。
 */
const RARE_CHAR_DOCUMENTS = 5;
/** 倒排种子命中的卡片数上限：超过说明这个种子太泛，命中也是噪音 */
const MAX_SEED_POSTINGS = 60;
/** 同文档命中的排序降权；只影响排序，不作为命中门槛 */
const SAME_DOCUMENT_ORDER_FACTOR = 0.9;
/** 短语向两侧扩展的最大长度：够显示完整术语，又不至于无限回溯 */
const MAX_EXTENSION = 40;

interface RelationEntry {
  card: SidebarCard;
  key: string;
  /** 该卡切出的词段，公共短语只在词段之间匹配（词段内不含功能字） */
  segments: string[];
  /** 全库拍平顺序，用于排除 EPUB 同章紧挨着的划线 */
  order: number;
}

export interface RelatedHit {
  card: SidebarCard;
  score: number;
  /** 两边共有的具体短语，展示为「都提到了 ××」 */
  reasons: string[];
}

/** 跨文档 id 可能撞车，统一用「路径 # 批注 id」做键 */
function cardKey(card: SidebarCard): string {
  return `${card.sourcePath}#${card.id}`;
}

const CJK_PATTERN = /[\u3400-\u9fff]/;

/**
 * 同一文档里紧挨着的划线不算「新发现」，否则相关区会被近邻刷满。
 * md 看字符偏移、pdf 看页码；epub 没有统一坐标，用同章节 + 拍平序号相邻近似。
 * 注意：跨文档永远不算近邻，同书命中不会再被硬门槛砍掉。
 */
function isAdjacent(self: SidebarCard, selfOrder: number, entry: RelationEntry): boolean {
  const other = entry.card;
  if (self.sourcePath !== other.sourcePath) {
    return false;
  }
  if (self.mode === "md" && other.mode === "md") {
    return Math.abs(self.startOffset - other.startOffset) < 150;
  }
  if (self.mode === "pdf" && other.mode === "pdf" && self.pageNumber !== null && other.pageNumber !== null) {
    return self.pageNumber === other.pageNumber;
  }
  if (self.mode === "epub" && other.mode === "epub") {
    if (self.chapter && other.chapter && self.chapter !== other.chapter) {
      return false;
    }
    return selfOrder >= 0 && Math.abs(selfOrder - entry.order) <= 1;
  }
  return false;
}

/**
 * 把一张卡切成词段。
 * 划线文本与笔记正文分开切：拼在一起会在拼接边界造出「句话出自」这种跨边界残段。
 * 代码选区与过短划线不参与关联。
 */
function buildEntry(card: SidebarCard, order: number): RelationEntry | null {
  const textOk = isRelationEligible(card.text, card.isCode);
  const contentOk = card.content.trim().length >= MIN_RELATION_TEXT_CHARS;
  if (!textOk && !contentOk) {
    return null;
  }
  const segments = [
    ...(textOk ? splitSegments(cleanText(card.text)) : []),
    ...splitSegments(cleanText(card.content)),
  ];
  if (segments.length === 0) {
    return null;
  }
  return { card, key: cardKey(card), segments, order };
}

/**
 * 从公共短语里挑出「互不包含」的几条：
 * 同一段话会同时产出 4 字、5 字、6 字……的短语，它们其实是同一件事，
 * 全都计入分数会让长句天然占优。只留最长的那条（以及与之并列的其它短语）。
 */
function selectDistinctPhrases(phrases: readonly string[]): string[] {
  const sorted = [...new Set(phrases)].sort((left, right) => right.length - left.length || left.localeCompare(right));
  const selected: string[] = [];
  for (const phrase of sorted) {
    if (selected.some((kept) => kept.includes(phrase))) {
      continue;
    }
    selected.push(phrase);
  }
  return selected;
}

export class RelationModel {
  private entries: RelationEntry[] = [];
  /** 卡片键 → 该卡的相关命中，快照时一次性算好 */
  private related = new Map<string, RelatedHit[]>();
  /** 汉字 → 出现在哪些源文档里，用于跨文档短语的罕见字判定 */
  private charDocuments = new Map<string, Set<string>>();
  /** 标签比较键 → 该标签下所有卡片的词频，用于按内容推荐（懒建） */
  private tagTerms: Map<string, Map<string, number>> | null = null;
  /** 标签推荐用的全库词频（与 tagTerms 同步懒建） */
  private tagFrequency = new Map<string, number>();
  private version = -1;
  private builtAt = 0;

  constructor(private readonly store: AnnotationStore) {}

  invalidate(): void {
    this.version = -1;
    this.tagTerms = null;
  }

  /**
   * 构建（或复用）快照。documents 是全库时直接复用，当前文件模式则补拉全库——
   * getIndexedDocuments 走 store 的文档缓存，冷启动后只付一次读盘代价。
   * 四步：切词段 → 4 字种子倒排找候选对 → 逐对扩展出最长公共短语 → 按跨文档稀有度筛选。
   */
  async prepare(documents: readonly FileAnnotationDocument[]): Promise<void> {
    const now = Date.now();
    if (this.version === this.store.version && now - this.builtAt < CACHE_TTL_MS) {
      return;
    }

    const all = documents.length > 1 ? documents : await this.store.getIndexedDocuments();
    const entries: RelationEntry[] = [];
    for (const document of all) {
      for (const card of buildCards(document)) {
        const entry = buildEntry(card, entries.length);
        if (!entry) {
          continue;
        }
        entries.push(entry);
        if (entries.length >= MAX_ENTRIES) {
          break;
        }
      }
      if (entries.length >= MAX_ENTRIES) {
        break;
      }
    }

    this.entries = entries;
    this.charDocuments = this.buildCharDocuments(entries);
    this.related = this.buildRelations(entries);
    this.tagTerms = null;
    this.version = this.store.version;
    this.builtAt = now;
  }

  /** 汉字 → 源文档集合：同一本书里的几十张卡不会把本稀有的字刷成常见字 */
  private buildCharDocuments(entries: RelationEntry[]): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    for (const entry of entries) {
      const seen = new Set<string>();
      for (const segment of entry.segments) {
        for (const ch of segment) {
          if (CJK_PATTERN.test(ch)) {
            seen.add(ch);
          }
        }
      }
      for (const ch of seen) {
        let sources = map.get(ch);
        if (!sources) {
          sources = new Set<string>();
          map.set(ch, sources);
        }
        sources.add(entry.card.sourcePath);
      }
    }
    return map;
  }

  /** 短语里是否含有罕见字（出现在不超过 RARE_CHAR_DOCUMENTS 个源文档里） */
  private hasRareCharacter(phrase: string): boolean {
    for (const ch of phrase) {
      if (!CJK_PATTERN.test(ch)) {
        continue;
      }
      const documents = this.charDocuments.get(ch)?.size ?? 0;
      if (documents <= RARE_CHAR_DOCUMENTS) {
        return true;
      }
    }
    return false;
  }

  /**
   * 找出共享「跨书罕见具体短语」的卡片对。
   * 先用 4 字种子倒排筛出候选对（避免全库两两比对），再逐对把种子扩展成最长公共短语，
   * 最后按短语出现的源文档数过滤：出现在很多书里的说法（『一般来说』『一般情况下』）
   * 不构成共同话题，直接丢弃。
   */
  private buildRelations(entries: RelationEntry[]): Map<string, RelatedHit[]> {
    const related = new Map<string, RelatedHit[]>();
    if (entries.length < 2) {
      return related;
    }

    // 种子倒排：4 字连续片段 → 出现在哪些卡片里
    const postings = new Map<string, number[]>();
    entries.forEach((entry, cardIndex) => {
      const seeds = new Set<string>();
      for (const segment of entry.segments) {
        for (let i = 0; i + SEED_LENGTH <= segment.length; i += 1) {
          seeds.add(segment.slice(i, i + SEED_LENGTH));
        }
      }
      for (const seed of seeds) {
        const list = postings.get(seed);
        if (list) {
          list.push(cardIndex);
        } else {
          postings.set(seed, [cardIndex]);
        }
      }
    });

    // 候选对：只认出现在 2 张以上、且不算泛滥的种子
    const pairs = new Map<string, [number, number]>();
    for (const list of postings.values()) {
      const cardIndexes = Array.from(new Set(list));
      if (cardIndexes.length < 2 || cardIndexes.length > MAX_SEED_POSTINGS) {
        continue;
      }
      for (let i = 0; i < cardIndexes.length; i += 1) {
        for (let j = i + 1; j < cardIndexes.length; j += 1) {
          const low = Math.min(cardIndexes[i], cardIndexes[j]);
          const high = Math.max(cardIndexes[i], cardIndexes[j]);
          pairs.set(`${low}:${high}`, [low, high]);
        }
      }
    }

    // 逐对扩展出最长公共短语
    const pairPhrases = new Map<string, string[]>();
    const allPhrases = new Set<string>();
    for (const [pair, [low, high]] of pairs) {
      const shared = selectDistinctPhrases(
        this.expandCommonPhrases(entries[low].segments, entries[high].segments),
      );
      if (shared.length === 0) {
        continue;
      }
      pairPhrases.set(pair, shared);
      for (const phrase of shared) {
        allPhrases.add(phrase);
      }
    }

    // 短语出现在哪些源文档里：按短语里的 4 字种子反查候选卡片，
    // 再确认是否真的包含整条短语——这样得到的才是「文档级」频次，
    // 同一本书里的几十张卡不会把本稀有的词刷成常见词。
    const phraseDocuments = new Map<string, Set<string>>();
    for (const phrase of allPhrases) {
      const candidates = new Set<number>();
      for (let i = 0; i + SEED_LENGTH <= phrase.length; i += 1) {
        for (const item of postings.get(phrase.slice(i, i + SEED_LENGTH)) ?? []) {
          candidates.add(item);
        }
      }
      const sources = new Set<string>();
      for (const index of candidates) {
        if (entries[index].segments.some((segment) => segment.includes(phrase))) {
          sources.add(entries[index].card.sourcePath);
        }
      }
      phraseDocuments.set(phrase, sources);
    }

    for (const [pair, phrases] of pairPhrases) {
      const [low, high] = pairs.get(pair) ?? [0, 0];
      const cross = entries[low].card.sourcePath !== entries[high].card.sourcePath;
      const usable = phrases.filter((phrase) => {
        const documents = phraseDocuments.get(phrase)?.size ?? 0;
        if (documents > MAX_PHRASE_DOCUMENTS) {
          return false;
        }
        if (!cross) {
          return true;
        }
        return this.isCrossPhraseUsable(phrase);
      });
      if (usable.length === 0) {
        continue;
      }
      // 越长、越罕见，分数越高
      const score = usable.reduce((sum, phrase) => {
        const documents = phraseDocuments.get(phrase)?.size ?? 1;
        return sum + phrase.length * (MAX_PHRASE_DOCUMENTS + 1 - documents);
      }, 0);
      // 命中理由优先给更具体（更长）的短语
      const reasons = usable.slice(0, 2);

      pushHit(related, entries[low], entries[high], score, reasons);
      pushHit(related, entries[high], entries[low], score, reasons);
    }

    for (const hits of related.values()) {
      hits.sort((left, right) => right.score - left.score);
    }
    return related;
  }

  /**
   * 跨文档短语是否可用：跨书撞词的概率高得多，光靠长度和稀有度不够，
   * 还得看短语本身是不是术语。
   * 5 字以上直接放行；4 字短语必须带术语特征（罕见字 / 术语后缀），
   * 并且不能是「一篇文章」「无忧无虑」这类数量词或否定词开头的通用说法。
   */
  private isCrossPhraseUsable(phrase: string): boolean {
    if (phrase.length >= CROSS_MIN_PHRASE_LENGTH) {
      return true;
    }
    if (startsWithWeakToken(phrase)) {
      return false;
    }
    return this.hasRareCharacter(phrase) || hasTermSuffix(phrase);
  }

  /** 两组词段之间的公共短语：在共同种子上向两侧扩展，取最长的那些 */
  private expandCommonPhrases(left: readonly string[], right: readonly string[]): string[] {
    const found = new Set<string>();
    const seeds = new Map<string, number[]>();
    right.forEach((segment, segmentIndex) => {
      for (let i = 0; i + SEED_LENGTH <= segment.length; i += 1) {
        const seed = segment.slice(i, i + SEED_LENGTH);
        const list = seeds.get(seed);
        if (list) {
          list.push(segmentIndex, i);
        } else {
          seeds.set(seed, [segmentIndex, i]);
        }
      }
    });

    for (const segment of left) {
      if (segment.length < MIN_PHRASE_LENGTH) {
        continue;
      }
      for (let i = 0; i + SEED_LENGTH <= segment.length; i += 1) {
        const positions = seeds.get(segment.slice(i, i + SEED_LENGTH));
        if (!positions) {
          continue;
        }
        for (let p = 0; p < positions.length; p += 2) {
          const other = right[positions[p]];
          const expanded = expandPhrase(segment, i, other, positions[p + 1], MAX_EXTENSION);
          const phrase = trimPhrase(expanded);
          if (phrase.length >= MIN_PHRASE_LENGTH && !isNoisePhrase(phrase)) {
            found.add(phrase);
          }
        }
      }
    }

    return Array.from(found);
  }

  /**
   * 与当前卡片字面相关的其他批注，按共享短语的区分度排序，带命中理由。
   * 只有「跨书罕见的具体短语」才算相关：出现在很多书里的说法会被稀有度过滤掉，
   * 避免推荐出一堆不相干的划线。
   */
  getRelated(card: SidebarCard, limit: number = RELATED_LIMIT): RelatedHit[] {
    const hits = this.related.get(cardKey(card));
    if (!hits || hits.length === 0) {
      return [];
    }
    return hits.slice(0, limit);
  }

  /**
   * 按当前划线内容推荐历史标签。只从用户已经用过的标签里挑，
   * 不发明新词；冷启动或命中词不足 2 个时静默返回空。
   * 词频索引按需构建：只有打开标签编辑态才会用到，不拖慢常规渲染。
   */
  getRecommendedTags(card: SidebarCard, limit: number = RECOMMEND_LIMIT): string[] {
    const tagTerms = this.ensureTagIndex();
    if (tagTerms.size < COLD_START_MIN_TAGS || this.entries.length < COLD_START_MIN_CARDS) {
      return [];
    }
    const terms = rankTerms(extractTerms(`${card.text} ${card.content}`), this.tagFrequency);
    if (terms.length === 0) {
      return [];
    }

    const existing = new Set(card.tags.map((tag) => tagKey(tag)));
    const ranked: Array<{ key: string; score: number }> = [];
    for (const [key, counts] of tagTerms) {
      if (existing.has(key)) {
        continue;
      }
      let hits = 0;
      for (const term of terms) {
        if ((counts.get(term) ?? 0) > 0) {
          hits += 1;
        }
      }
      if (hits < 2) {
        continue;
      }
      ranked.push({ key, score: hits / terms.length });
    }

    return ranked
      .sort((left, right) => right.score - left.score || left.key.localeCompare(right.key))
      .slice(0, limit)
      .map((item) => this.store.getTagDisplayName(item.key));
  }

  /** 标签推荐用的词频索引：标签 → 该标签下卡片出现的词条及次数 */
  private ensureTagIndex(): Map<string, Map<string, number>> {
    if (this.tagTerms) {
      return this.tagTerms;
    }
    const frequency = new Map<string, number>();
    const cardTerms: string[][] = [];
    for (const entry of this.entries) {
      const terms = extractTerms(`${entry.card.text} ${entry.card.content}`);
      cardTerms.push(terms);
      for (const term of terms) {
        frequency.set(term, (frequency.get(term) ?? 0) + 1);
      }
    }
    const tagTerms = new Map<string, Map<string, number>>();
    this.entries.forEach((entry, index) => {
      const terms = rankTerms(cardTerms[index], frequency);
      for (const tag of entry.card.tags) {
        const key = tagKey(tag);
        if (!key) {
          continue;
        }
        let counts = tagTerms.get(key);
        if (!counts) {
          counts = new Map<string, number>();
          tagTerms.set(key, counts);
        }
        for (const term of terms) {
          counts.set(term, (counts.get(term) ?? 0) + 1);
        }
      }
    });
    this.tagFrequency = frequency;
    this.tagTerms = tagTerms;
    return tagTerms;
  }
}

/** 记一次命中，同时排除同文档紧挨着的划线 */
function pushHit(
  related: Map<string, RelatedHit[]>,
  owner: RelationEntry,
  target: RelationEntry,
  score: number,
  reasons: string[],
): void {
  if (isAdjacent(owner.card, owner.order, target)) {
    return;
  }
  const adjusted = owner.card.sourcePath === target.card.sourcePath
    ? score * SAME_DOCUMENT_ORDER_FACTOR
    : score;
  let list = related.get(owner.key);
  if (!list) {
    list = [];
    related.set(owner.key, list);
  }
  list.push({ card: target.card, score: adjusted, reasons });
}

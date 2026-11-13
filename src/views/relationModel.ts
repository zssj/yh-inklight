/**
 * [INPUT]: 依赖 AnnotationStore 的全库文档与 version、views/cardModel 的 SidebarCard、utils/textTerms 的字面抽词
 * [OUTPUT]: 对外提供 RelationModel：prepare（按需内存快照）、getRelated（字面相关 + 命中理由）、
 *           getRecommendedTags（按内容推荐历史标签）、invalidate
 * [POS]: views 模块的派生数据层，与 cardModel 同层；纯内存、不落盘、不写 sidecar、不升 index 版本。
 *        删批注 / 改名 / 删源文件全部由 store.version 自动失效，无需单独迁移索引
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import type { AnnotationStore } from "../storage/annotationStore";
import type { FileAnnotationDocument } from "../storage/types";
import { tagKey } from "../storage/tags";
import { buildCards, SidebarCard } from "./cardModel";
import { extractTerms, isRelationEligible, RELATED_THRESHOLD, termOverlap } from "../utils/textTerms";

const RELATED_LIMIT = 5;
const RECOMMEND_LIMIT = 3;
/** 标签少于 3 个或卡片少于 10 条时不出推荐：冷启动没有可依据的分布 */
const COLD_START_MIN_TAGS = 3;
const COLD_START_MIN_CARDS = 10;
/** 同一 version 内的短缓存，避免搜索输入连续重绘时反复拍平全库 */
const CACHE_TTL_MS = 3000;
/** 超大库保护：参与关联的上限，超出部分按文档顺序截断 */
const MAX_ENTRIES = 800;

interface RelationEntry {
  card: SidebarCard;
  key: string;
  terms: string[];
}

export interface RelatedHit {
  card: SidebarCard;
  score: number;
  /** 两边共有的词，展示为「都提到了 ××」 */
  reasons: string[];
}

/** 跨文档 id 可能撞车，统一用「路径 # 批注 id」做键 */
function cardKey(card: SidebarCard): string {
  return `${card.sourcePath}#${card.id}`;
}

/** 同一文档里紧挨着的划线不算「新发现」，否则相关区会被近邻刷满 */
function isAdjacent(a: SidebarCard, b: SidebarCard): boolean {
  if (a.sourcePath !== b.sourcePath) {
    return false;
  }
  if (a.mode === "md" && b.mode === "md") {
    return Math.abs(a.startOffset - b.startOffset) < 150;
  }
  if (a.mode === "pdf" && b.mode === "pdf" && a.pageNumber !== null && b.pageNumber !== null) {
    return a.pageNumber === b.pageNumber;
  }
  return false;
}

export class RelationModel {
  private entries: RelationEntry[] = [];
  /** 标签比较键 → 该标签下所有卡片的词频，用于按内容推荐 */
  private tagTerms = new Map<string, Map<string, number>>();
  private version = -1;
  private builtAt = 0;

  constructor(private readonly store: AnnotationStore) {}

  invalidate(): void {
    this.version = -1;
  }

  /**
   * 构建（或复用）快照。documents 是全库时直接复用，当前文件模式则补拉全库——
   * getIndexedDocuments 走 store 的文档缓存，冷启动后只付一次读盘代价。
   */
  async prepare(documents: readonly FileAnnotationDocument[]): Promise<void> {
    const now = Date.now();
    if (this.version === this.store.version && now - this.builtAt < CACHE_TTL_MS) {
      return;
    }

    const all = documents.length > 1 ? documents : await this.store.getIndexedDocuments();
    const entries: RelationEntry[] = [];
    const tagTerms = new Map<string, Map<string, number>>();

    for (const document of all) {
      for (const card of buildCards(document)) {
        if (!isRelationEligible(card.text, card.isCode)) {
          continue;
        }
        const terms = extractTerms(`${card.text} ${card.content}`);
        if (terms.length === 0) {
          continue;
        }
        entries.push({ card, key: cardKey(card), terms });

        for (const tag of card.tags) {
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
        if (entries.length >= MAX_ENTRIES) {
          break;
        }
      }
      if (entries.length >= MAX_ENTRIES) {
        break;
      }
    }

    this.entries = entries;
    this.tagTerms = tagTerms;
    this.version = this.store.version;
    this.builtAt = now;
  }

  /** 与当前卡片字面相关的其他批注，按重合度降序，带命中理由 */
  getRelated(card: SidebarCard, limit: number = RELATED_LIMIT): RelatedHit[] {
    const selfTerms = extractTerms(`${card.text} ${card.content}`);
    if (selfTerms.length === 0) {
      return [];
    }
    const self = cardKey(card);
    const hits: RelatedHit[] = [];

    for (const entry of this.entries) {
      if (entry.key === self || isAdjacent(card, entry.card)) {
        continue;
      }
      const overlap = termOverlap(selfTerms, entry.terms);
      if (overlap.shared.length === 0) {
        continue;
      }
      // 同文档的命中降权，优先把别的文档拉进来
      const score = overlap.score * (entry.card.sourcePath === card.sourcePath ? 0.6 : 1);
      if (score < RELATED_THRESHOLD) {
        continue;
      }
      hits.push({ card: entry.card, score, reasons: overlap.shared.slice(0, 2) });
    }

    return hits.sort((left, right) => right.score - left.score).slice(0, limit);
  }

  /**
   * 按当前划线内容推荐历史标签。只从用户已经用过的标签里挑，
   * 不发明新词；冷启动或命中词不足 2 个时静默返回空。
   */
  getRecommendedTags(card: SidebarCard, limit: number = RECOMMEND_LIMIT): string[] {
    if (this.tagTerms.size < COLD_START_MIN_TAGS || this.entries.length < COLD_START_MIN_CARDS) {
      return [];
    }
    const terms = extractTerms(`${card.text} ${card.content}`);
    if (terms.length === 0) {
      return [];
    }

    const existing = new Set(card.tags.map((tag) => tagKey(tag)));
    const ranked: Array<{ key: string; score: number }> = [];
    for (const [key, counts] of this.tagTerms) {
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
}

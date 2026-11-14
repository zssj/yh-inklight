/**
 * [INPUT]: views/annotationCard 的三端共用卡片与文案工具、EPUB 自己的批注字段（章节/时间/noteType）
 * [OUTPUT]: EpubAnnotationCard —— 把 EPUB 批注模型映射到共用 AnnotationCard 的薄适配层
 * [POS]: EPUB 标注详情 UI 的入口；样式与交互由 views/annotationCard 统一，本文件只做字段翻译
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { AnnotationColor } from "../storage/types";
import {
  AnnotationCard,
  AnnotationCardAnchor,
  AnnotationCardOptions,
  annotationBadge,
  formatAnnotationTime,
} from "../views/annotationCard";

export type EpubAnnotationCardAnchor = AnnotationCardAnchor;
export type EpubAnnotationCardOptions = AnnotationCardOptions;

export interface EpubAnnotationCardData {
  quote: string;
  note?: string;
  noteType?: "insight" | "question" | "reminder";
  /** 已落盘的标签；卡片内编辑后由 onTagsChange 回写 */
  tags: readonly string[];
  color: AnnotationColor;
  chapter?: string;
  createdAt?: string;
  hasNote: boolean;
}

/** 章节 · 时间，空字段自动跳过，不留多余分隔符 */
function buildMeta(data: EpubAnnotationCardData): string {
  return [data.chapter, formatAnnotationTime(data.createdAt)].filter((part) => Boolean(part)).join(" · ");
}

/**
 * 点击 EPUB 高亮后弹出的标注详情卡片。
 * 自 0.18.14 起与 Markdown / PDF 共用同一套样式与交互（views/annotationCard）。
 */
export class EpubAnnotationCard extends AnnotationCard {
  constructor(data: EpubAnnotationCardData, options: EpubAnnotationCardOptions = {}) {
    super(
      {
        quote: data.quote,
        note: data.note,
        tags: data.tags,
        color: data.color,
        badge: annotationBadge(data.noteType),
        meta: buildMeta(data),
        hasNote: data.hasNote,
      },
      options,
    );
  }
}

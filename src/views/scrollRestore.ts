/**
 * [INPUT]: 只依赖调用方注入的量测/写入回调，不直接碰 DOM API
 * [OUTPUT]: 对外提供 applyScrollRestore 与 RESTORE_MAX_CARDS，供侧栏列表重建后回到原位置
 * [POS]: views 模块的纯逻辑层（与 cardModel 同层），不读写存储、不持状态；
 *        量测与写入由 sidebarView 注入，因此可以在 jsdom 里直接测。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

/**
 * 恢复位置的输入。
 * 同时记像素位置和锚点卡：卡片高度会随笔记内容变化（新增一行笔记、展开相关区），
 * 只按像素恢复会漂，按「锚点卡在视口里的偏移」对齐才落回同一处内容。
 */
export interface ScrollRestore {
  /** 重建前的 list.scrollTop */
  top: number;
  /** 重建前列表顶端第一张可见卡片的 data-id；空串表示没有可用的锚点 */
  anchorId: string;
  /** 该卡片重建前相对列表顶部的偏移（可能是负数：卡片只露出下半部分） */
  anchorOffset: number;
}

export interface ScrollRestoreTarget {
  /** 当前内容高度（list.scrollHeight） */
  contentHeight(): number;
  /** 当前可视高度（list.clientHeight） */
  viewportHeight(): number;
  /** 锚点卡现在相对列表顶部的偏移；卡片不在 DOM 里（还没渲染到）返回 null */
  anchorOffsetIn(anchorId: string): number | null;
  /** 直接设置滚动位置 */
  setTop(top: number): void;
  /** 在当前滚动位置上微调（锚点校正用） */
  adjust(delta: number): void;
}

/** 恢复时最多同步补渲染多少张卡：再深就退回像素落位，剩余高度交给滚动追加 */
export const RESTORE_MAX_CARDS = 400;

/**
 * 把列表滚动位置放回重建前的位置。
 *
 * 列表是「滚到才建」的，重建后一开始只有首屏那么高，直接写 scrollTop 会被浏览器夹到
 * 当前 scrollHeight；所以先让调用方把高度补够（fill），再落位，最后按锚点卡校正。
 *
 * fill 返回 true 表示卡片已全部渲染完——此时调用方可以把底部哨兵移除。
 */
export function applyScrollRestore(
  target: ScrollRestoreTarget,
  restore: ScrollRestore,
  fill: (atLeastHeight: number) => boolean,
): boolean {
  const finished = fill(restore.top + target.viewportHeight());

  target.setTop(restore.top);
  const offset = restore.anchorId ? target.anchorOffsetIn(restore.anchorId) : null;
  if (offset !== null) {
    // 内容高度变化后锚点会偏：按差值补偿，让同一张卡落在重建前的位置
    const delta = offset - restore.anchorOffset;
    if (Math.abs(delta) > 0.5) {
      target.adjust(delta);
    }
  }
  return finished;
}

/**
 * 取列表顶端第一张可见卡片，作为恢复时的锚点。
 * cards 必须是列表内的卡片元素（不含哨兵），顺序即渲染顺序。
 */
export function pickScrollAnchor(
  cards: readonly { id: string; top: number; bottom: number }[],
  listTop: number,
): { anchorId: string; anchorOffset: number } {
  for (const card of cards) {
    if (card.bottom > listTop + 1) {
      return { anchorId: card.id, anchorOffset: card.top - listTop };
    }
  }
  return { anchorId: "", anchorOffset: 0 };
}

/**
 * [INPUT]: 只依赖调用方注入的量测/写入回调，不直接碰 DOM API
 * [OUTPUT]: 对外提供 applyScrollRestore / placeScrollRestore / restorePending 与 RESTORE_MAX_CARDS，
 *           供侧栏列表重建后回到原位置；深列表恢复由「先像素落位、后续批次补落位」两段完成
 * [POS]: views 模块的纯逻辑层（与 cardModel 同层），不读写存储、不持状态；
 *        量测与写入由 sidebarView 注入，因此可以在 jsdom 里直接测。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

/**
 * 恢复位置的输入。
 * 记「锚点卡」而不是像素位置：卡片高度会随笔记内容变化，且重建后视口上方的
 * 未绘制卡片按 contain-intrinsic-size 估算报高，像素坐标在重建前后不是同一坐标系；
 * 按「锚点卡在视口里的偏移」对齐才落回同一处内容。
 */
export interface ScrollRestore {
  /** 重建前的 list.scrollTop（锚点不可用时退回像素落位） */
  top: number;
  /** 重建前列表顶端第一张可见卡片的 data-id；空串表示没有可用的锚点 */
  anchorId: string;
  /** 该卡片重建前相对视口顶部的偏移（可能是负数：卡片只露出下半部分） */
  anchorOffset: number;
}

export interface ScrollRestoreTarget {
  /** 当前内容高度（list.scrollHeight） */
  contentHeight(): number;
  /** 当前可视高度（list.clientHeight） */
  viewportHeight(): number;
  /**
   * 锚点卡此刻在**内容坐标系**里相对列表顶部的偏移（含滚动量，即 rect 差 + scrollTop）。
   * 这是现量出来的真实布局值，与「上方卡片按估算高度报」无关。
   * 卡片不在 DOM 里（还没渲染到）返回 null。
   */
  anchorContentOffset(anchorId: string): number | null;
  /** 直接设置滚动位置 */
  setTop(top: number): void;
}

/** 恢复时最多同步补渲染多少张卡：再深就退回像素落位，剩余高度交给滚动追加 */
export const RESTORE_MAX_CARDS = 400;

/**
 * 把列表滚动位置放回重建前的位置。
 *
 * 列表是「滚到才建」的，重建后一开始只有首屏那么高，直接写 scrollTop 会被浏览器夹到
 * 当前 scrollHeight；所以先让调用方把高度补够（fill），再落位。
 *
 * 落位认卡不认像素：锚点卡已渲染时，量它在当前布局里的内容偏移，把视口顶对到
 * 「锚点偏移 - 重建前它在视口里的偏移」。上方卡片即使是 160px 估算高度也不影响
 * 落点——scrollTop 定位的是真实布局，锚点的偏移是现量的。（上方卡片随后绘制时
 * 涨回真实高度造成的位移，由浏览器滚动锚定补偿。）
 * 锚点不在 DOM（超补卡上限）或没有锚点时，退回按像素落位。
 *
 * fill 返回 true 表示卡片已全部渲染完——此时调用方可以把底部哨兵移除。
 */
export function applyScrollRestore(
  target: ScrollRestoreTarget,
  restore: ScrollRestore,
  fill: (atLeastHeight: number) => boolean,
): boolean {
  const finished = fill(restore.top + target.viewportHeight());

  placeScrollRestore(target, restore);
  return finished;
}

/**
 * 按锚点落位；锚点不可用时退回像素落位。
 * 从 applyScrollRestore 里拆出来供「深列表补落位」复用：补卡预算用尽时第一次落位
 * 会被当时的 scrollHeight 夹住，后续追加批次把内容补够后要再按锚点落一次。
 */
export function placeScrollRestore(target: ScrollRestoreTarget, restore: ScrollRestore): void {
  const contentOffset = restore.anchorId ? target.anchorContentOffset(restore.anchorId) : null;
  if (contentOffset !== null) {
    target.setTop(Math.max(0, contentOffset - restore.anchorOffset));
  } else {
    target.setTop(restore.top);
  }
}

/**
 * 深列表补落位判断：内容高度还容不下 restore.top + 视口时，第一次像素落位
 * 会被 scrollHeight 夹住（滑过补卡上限的典型症状）——返回 true，调用方在
 * 后续追加批次里量一次，够高了就调 placeScrollRestore 补落位。
 */
export function restorePending(target: ScrollRestoreTarget, restore: ScrollRestore): boolean {
  return target.contentHeight() < restore.top + target.viewportHeight();
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

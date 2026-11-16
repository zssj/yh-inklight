/**
 * [INPUT]: 视口坐标下的选区矩形（划线并集）、浮层实测尺寸、可用区域（视口 ∩ 阅读区 − 安全区）
 * [OUTPUT]: computePopoverPlacement 返回 left/top/width/maxHeight/side，保证浮层完整可见且不越界；
 *           空间不足时允许压住选区（不再把「不遮挡」当硬约束）
 * [POS]: views 模块浮层定位单点，被 AnnotationCard（md/pdf/epub 三端共用）使用；纯函数，不碰 DOM
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

export interface PopoverRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PopoverSize {
  width: number;
  height: number;
}

export type PopoverSide = "below" | "above" | "end" | "start" | "overlay";

export interface PopoverPlacement {
  left: number;
  top: number;
  width: number;
  /** 浮层允许的最大高度；超出时由卡片内部滚动消化 */
  maxHeight: number;
  side: PopoverSide;
}

/** 浮层与划线之间的留白 */
const GAP = 10;
/** 与可用区域边缘的最小留白 */
const EDGE = 8;
const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;

/**
 * 移动端浮层的四边留白。手机屏小，卡片要尽量占满屏幕：
 * 左右各 20、上下各 40（上下留得多是因为顶部有标题栏、底部有手势条/导航栏）。
 * 键盘弹起时可视区已经很矮，边距收紧到 12，把空间让给内容。
 */
export const MOBILE_SHEET_GUTTERS = {
  side: 20,
  top: 40,
  bottom: 40,
  /** 键盘弹起（可视区被压矮）时的紧凑边距 */
  compact: 12,
} as const;

export interface MobileSheetInput {
  viewportHeight: number;
  /** visualViewport.offsetTop：键盘顶起时页面被平移的距离 */
  visualOffsetTop: number;
  /** 键盘 + 底部固定栏在视口底部占用的高度 */
  bottomInset: number;
  /** 键盘是否弹起（弹起时用紧凑边距） */
  compact: boolean;
}

/**
 * 移动端浮层的落位：**固定占满「四边留白」之间的区域**，不再按内容高度测量。
 *
 * 为什么要改成固定高度（v0.19.10）：按 `min(自然高度, 可用高度)` 依赖一次 DOM 测量，
 * 而卡片里的想法是 Markdown 异步渲染的——show() 里立刻测量时内容还没落地，量出来的
 * 高度偏小，maxHeight 跟着偏小，卡片就只剩一小条，看起来「弹出来太小」。
 * 现在高度只由视口决定：内容少时卡片仍然大（像一张 sheet），内容多时内部滚动，
 * 既不会因为测量时序变小，也不会溢出屏幕。
 */
export function computeMobileSheet(input: MobileSheetInput): { top: number; height: number } {
  const { viewportHeight, visualOffsetTop, bottomInset, compact } = input;
  const gutter = MOBILE_SHEET_GUTTERS;
  const topGutter = compact ? gutter.compact : gutter.top;
  const bottomGutter = compact ? gutter.compact : gutter.bottom;

  const top = Math.max(0, visualOffsetTop) + topGutter;
  const bottomLimit = viewportHeight - Math.max(0, bottomInset) - bottomGutter;
  // 可用高度优先：宁可矮到极限，也不让浮层底部溢出屏幕
  const height = Math.max(0, bottomLimit - top);
  return { top, height };
}

function clamp(value: number, min: number, max: number): number {
  const hi = Math.max(min, max);
  return Math.max(min, Math.min(value, hi));
}

/** 视口安全区（8px 留白），没有更精确的区域时用它 */
export function viewportRect(): PopoverRect {
  return { left: 8, top: 8, right: window.innerWidth - 8, bottom: window.innerHeight - 8 };
}

/** DOMRect / Rect 转成定位用的普通矩形 */
export function toPopoverRect(rect: { left: number; top: number; right: number; bottom: number }): PopoverRect {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

/**
 * 计算浮层位置：**完整可见优先，「不遮挡选区」降级为偏好而非硬约束。**
 *
 * 为什么改（v0.19.9）：原先上下两侧以「零重叠」为硬约束，单侧空间不足时只能压缩 maxHeight，
 * 卡片被压成一条缝、内容全塞进内部滚动，手机上根本点不到。现在改为：
 *
 * 1. 目标高度取「自然高度」，只在超过可用区时才降为可用区高度（此时才内部滚动）。
 * 2. 先找完整可见且完全不遮挡的位置：下方 → 上方 → 右侧 → 左侧（顺序即优先级）。
 * 3. 四侧都不行时，在「贴选区下方」与「贴选区上方」两个方向里选**偏移最小**的一个，
 *    允许浮层压住选区——换取完整高度，不再为了躲原文把卡片压扁。
 * 4. 可用区本身比最小高度还矮（极端）时才退为 overlay：贴顶、内部滚动，仍不出界。
 */
export function computePopoverPlacement(
  avoid: PopoverRect,
  size: PopoverSize,
  bounds: PopoverRect,
): PopoverPlacement {
  const boundsWidth = Math.max(MIN_WIDTH + 2 * EDGE, bounds.right - bounds.left);
  const width = clamp(size.width, MIN_WIDTH, boundsWidth - 2 * EDGE);
  const availableHeight = Math.max(MIN_HEIGHT, bounds.bottom - bounds.top - 2 * EDGE);
  // 完整可见优先：目标高度只受可用区限制，不再被单侧剩余空间压缩
  const height = Math.min(Math.max(MIN_HEIGHT, size.height), availableHeight);

  const minLeft = bounds.left + EDGE;
  const maxLeft = Math.max(minLeft, bounds.right - EDGE - width);
  const minTop = bounds.top + EDGE;
  const maxTop = Math.max(minTop, bounds.bottom - EDGE - height);

  // 选区可能部分在阅读区外（跨页/滚动），先裁到可用区域再算空间
  const a: PopoverRect = {
    left: clamp(avoid.left, bounds.left, bounds.right),
    top: clamp(avoid.top, bounds.top, bounds.bottom),
    right: clamp(avoid.right, bounds.left, bounds.right),
    bottom: clamp(avoid.bottom, bounds.top, bounds.bottom),
  };
  if (a.right <= a.left) a.right = a.left + 1;
  if (a.bottom <= a.top) a.bottom = a.top + 1;

  const centerLeft = clamp((a.left + a.right) / 2 - width / 2, minLeft, maxLeft);

  const belowIdeal = a.bottom + GAP;
  const aboveIdeal = a.top - GAP - height;

  /** 完整可见 + 与选区零重叠，按偏好顺序取第一个 */
  const clean: Array<{ side: PopoverSide; left: number; top: number }> = [];
  if (belowIdeal >= minTop && belowIdeal + height <= bounds.bottom - EDGE) {
    clean.push({ side: "below", left: centerLeft, top: belowIdeal });
  }
  if (aboveIdeal >= minTop && aboveIdeal + height <= bounds.bottom - EDGE) {
    clean.push({ side: "above", left: centerLeft, top: aboveIdeal });
  }
  // 左右只有在整块浮层能水平避开选区时才考虑：同样是「不遮挡 + 完整可见」
  const sideTop = clamp(a.top, minTop, maxTop);
  if (a.right + GAP + width <= bounds.right - EDGE) {
    clean.push({ side: "end", left: a.right + GAP, top: sideTop });
  }
  if (a.left - GAP - width >= minLeft) {
    clean.push({ side: "start", left: a.left - GAP - width, top: sideTop });
  }

  const chosen = clean[0];
  if (chosen) {
    return { left: chosen.left, top: chosen.top, width, maxHeight: height, side: chosen.side };
  }

  // 无零重叠位置：贴选区上/下，取偏移更小的一侧，允许覆盖选区
  const belowTop = clamp(belowIdeal, minTop, maxTop);
  const aboveTop = clamp(aboveIdeal, minTop, maxTop);
  const belowShift = Math.abs(belowTop - belowIdeal);
  const aboveShift = Math.abs(aboveTop - aboveIdeal);
  const useBelow = belowShift <= aboveShift;
  const top = useBelow ? belowTop : aboveTop;

  // 上下都没有腾挪空间：可用区本身就比一张卡矮，只能贴顶并内部滚动
  if (minTop === maxTop) {
    return { left: centerLeft, top: minTop, width, maxHeight: availableHeight, side: "overlay" };
  }

  return {
    left: centerLeft,
    top,
    width,
    maxHeight: height,
    side: useBelow ? "below" : "above",
  };
}

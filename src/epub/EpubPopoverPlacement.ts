/**
 * [INPUT]: 视口坐标下的选区矩形（划线并集）、浮层实测尺寸、可用区域（视口 ∩ 阅读区 − 安全区）
 * [OUTPUT]: computePopoverPlacement 返回 left/top/width/maxHeight/side，保证浮层避开选区、不越界
 * [POS]: epub 模块浮层定位单点，被 EpubAnnotationCard 使用；纯函数，不碰 DOM
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

export interface EpubRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface EpubPopoverSize {
  width: number;
  height: number;
}

export type EpubPopoverSide = "below" | "above" | "end" | "start" | "overlay";

export interface EpubPopoverPlacement {
  left: number;
  top: number;
  width: number;
  /** 浮层允许的最大高度；超出时由卡片内部滚动消化 */
  maxHeight: number;
  side: EpubPopoverSide;
}

/** 浮层与划线之间的留白 */
const GAP = 10;
/** 与可用区域边缘的最小留白 */
const EDGE = 8;
const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;
/** 极端兜底：宁可把卡片压到很矮、内容内部滚动，也不压住划线 */
const MIN_TIGHT_HEIGHT = 56;

function clamp(value: number, min: number, max: number): number {
  const hi = Math.max(min, max);
  return Math.max(min, Math.min(value, hi));
}

function intersectionArea(a: EpubRect, b: EpubRect): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

interface Candidate {
  side: EpubPopoverSide;
  left: number;
  top: number;
  height: number;
  overlap: number;
}

/**
 * 计算浮层位置，优先级：划线下方 → 上方 → 右侧 → 左侧。
 *
 * - 上下两侧以「不遮挡选区」为硬约束：top 从 avoid.bottom/top 之外起算，天然零重叠。
 * - 左右两侧靠水平分离保证零重叠，top 只做边界钳制。
 * - 四侧都放不下完整高度时，选剩余空间最大的一侧并压缩 maxHeight（卡片内部滚动），
 *   而不是把浮层压到选区上。
 * - 选区几乎占满阅读区（极端情况）才退化为贴边 overlay，此时允许重叠但保证不全屏外溢。
 */
export function computePopoverPlacement(
  avoid: EpubRect,
  size: EpubPopoverSize,
  bounds: EpubRect,
): EpubPopoverPlacement {
  const boundsWidth = Math.max(MIN_WIDTH + 2 * EDGE, bounds.right - bounds.left);
  const width = clamp(size.width, MIN_WIDTH, boundsWidth - 2 * EDGE);
  const height = Math.max(MIN_HEIGHT, size.height);
  const boundsHeight = Math.max(MIN_HEIGHT, bounds.bottom - bounds.top - 2 * EDGE);

  const minLeft = bounds.left + EDGE;
  const maxLeft = Math.max(minLeft, bounds.right - EDGE - width);
  const minTop = bounds.top + EDGE;

  // 选区可能部分在阅读区外（跨页/滚动），先裁到可用区域再算空间
  const a: EpubRect = {
    left: clamp(avoid.left, bounds.left, bounds.right),
    top: clamp(avoid.top, bounds.top, bounds.bottom),
    right: clamp(avoid.right, bounds.left, bounds.right),
    bottom: clamp(avoid.bottom, bounds.top, bounds.bottom),
  };
  if (a.right <= a.left) a.right = a.left + 1;
  if (a.bottom <= a.top) a.bottom = a.top + 1;

  const centerLeft = clamp((a.left + a.right) / 2 - width / 2, minLeft, maxLeft);
  const candidates: Candidate[] = [];
  const push = (side: EpubPopoverSide, left: number, top: number, h: number): void => {
    candidates.push({
      side,
      left,
      top,
      height: h,
      overlap: intersectionArea({ left, top, right: left + width, bottom: top + h }, a),
    });
  };

  // 下方
  const belowTop = a.bottom + GAP;
  const belowSpace = bounds.bottom - EDGE - belowTop;
  if (belowSpace >= MIN_HEIGHT) {
    push("below", centerLeft, belowTop, Math.min(height, belowSpace));
  }

  // 上方
  const aboveBottom = a.top - GAP;
  const aboveSpace = aboveBottom - minTop;
  if (aboveSpace >= MIN_HEIGHT) {
    const h = Math.min(height, aboveSpace);
    push("above", centerLeft, aboveBottom - h, h);
  }

  // 左右：仅在整块浮层能水平避开选区时才采纳
  const sideHeight = Math.min(height, boundsHeight);
  const sideTop = clamp(a.top, minTop, Math.max(minTop, bounds.bottom - EDGE - sideHeight));
  const endLeft = a.right + GAP;
  if (endLeft + width <= bounds.right - EDGE) {
    push("end", endLeft, sideTop, sideHeight);
  }
  const startLeft = a.left - GAP - width;
  if (startLeft >= minLeft) {
    push("start", startLeft, sideTop, sideHeight);
  }

  // 四侧都低于常规阈值时（整页划线），降低阈值再占一条窄带：
  // 卡片变矮并内部滚动，仍然零重叠，比覆盖原文好
  if (candidates.length === 0) {
    const belowAny = Math.max(0, bounds.bottom - EDGE - belowTop);
    const aboveAny = Math.max(0, aboveBottom - minTop);
    const tight = Math.max(belowAny, aboveAny);
    if (tight >= MIN_TIGHT_HEIGHT) {
      const useBelow = belowAny >= aboveAny;
      const h = useBelow ? belowAny : aboveAny;
      return {
        left: centerLeft,
        top: useBelow ? belowTop : aboveBottom - h,
        width,
        maxHeight: Math.min(boundsHeight, h),
        side: useBelow ? "below" : "above",
      };
    }
  }

  const free = candidates.filter((c) => c.overlap === 0);
  // 完整高度优先；按 push 顺序（下/上/右/左）取第一个不压缩的
  const full = free.find((c) => c.height >= height - 1);
  if (full) {
    return { left: full.left, top: full.top, width, maxHeight: boundsHeight, side: full.side };
  }
  const shrunk = free.slice().sort((x, y) => y.height - x.height)[0];
  if (shrunk) {
    return {
      left: shrunk.left,
      top: shrunk.top,
      width,
      maxHeight: Math.max(MIN_HEIGHT, Math.min(boundsHeight, shrunk.height)),
      side: shrunk.side,
    };
  }

  const overlayTop = clamp(belowTop, minTop, Math.max(minTop, bounds.bottom - EDGE - MIN_HEIGHT));
  return {
    left: centerLeft,
    top: overlayTop,
    width,
    maxHeight: clamp(bounds.bottom - EDGE - overlayTop, MIN_HEIGHT, boundsHeight),
    side: "overlay",
  };
}

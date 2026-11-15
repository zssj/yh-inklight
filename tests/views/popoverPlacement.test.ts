/**
 * [INPUT]: 被测 src/views/popoverPlacement.ts
 * [OUTPUT]: 覆盖四侧优先级、「完整可见优先于不遮挡」的覆盖策略、以及极端情况下的贴顶滚动
 * [POS]: L1 纯逻辑测试——浮层压住划线/溢出屏幕在真机上只能靠肉眼发现，这里用几何断言锁死
 */

import { describe, expect, it } from "vitest";

import { computePopoverPlacement, PopoverRect } from "../../src/views/popoverPlacement";

const BOUNDS: PopoverRect = { left: 0, top: 0, right: 1000, bottom: 800 };

function overlap(a: { left: number; top: number; width: number; maxHeight: number }, avoid: PopoverRect): number {
  const w = Math.min(a.left + a.width, avoid.right) - Math.max(a.left, avoid.left);
  const h = Math.min(a.top + a.maxHeight, avoid.bottom) - Math.max(a.top, avoid.top);
  return w > 0 && h > 0 ? w * h : 0;
}

describe("computePopoverPlacement", () => {
  it("空间充足时放在划线下方，水平居中且不遮挡", () => {
    const avoid: PopoverRect = { left: 100, top: 100, right: 300, bottom: 140 };
    const placement = computePopoverPlacement(avoid, { width: 320, height: 240 }, BOUNDS);

    expect(placement.side).toBe("below");
    expect(placement.top).toBe(avoid.bottom + 10);
    expect(placement.left).toBe(40);
    expect(placement.width).toBe(320);
    expect(overlap(placement, avoid)).toBe(0);
  });

  it("下方放不下时翻到上方，底边贴住划线上沿", () => {
    const avoid: PopoverRect = { left: 100, top: 700, right: 300, bottom: 740 };
    const placement = computePopoverPlacement(avoid, { width: 320, height: 240 }, BOUNDS);

    expect(placement.side).toBe("above");
    expect(placement.top).toBe(avoid.top - 10 - 240);
    expect(overlap(placement, avoid)).toBe(0);
  });

  it("上下都被占满时退到右侧", () => {
    const avoid: PopoverRect = { left: 100, top: 8, right: 300, bottom: 792 };
    const placement = computePopoverPlacement(avoid, { width: 320, height: 240 }, BOUNDS);

    expect(placement.side).toBe("end");
    expect(placement.left).toBe(avoid.right + 10);
    expect(overlap(placement, avoid)).toBe(0);
  });

  it("单侧空间不足时优先保完整高度，允许压住划线", () => {
    const bounds: PopoverRect = { left: 0, top: 0, right: 1000, bottom: 400 };
    const avoid: PopoverRect = { left: 0, top: 100, right: 1000, bottom: 300 };
    const placement = computePopoverPlacement(avoid, { width: 320, height: 240 }, bounds);

    // 高度不再被单侧剩余空间（82px）压缩，而是取满 240
    expect(placement.side).toBe("below");
    expect(placement.maxHeight).toBe(240);
    // 下方放不下完整高度 → 上移到贴住可用区底边，压住划线是允许的
    expect(placement.top).toBe(bounds.bottom - 8 - 240);
    expect(overlap(placement, avoid)).toBeGreaterThan(0);
    // 但绝不出界：底边与可用区底部留 8px
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(bounds.bottom - 8);
    expect(placement.top).toBeGreaterThanOrEqual(bounds.top + 8);
  });

  it("上下都放不下时，选偏移更小的一侧覆盖", () => {
    const bounds: PopoverRect = { left: 0, top: 0, right: 1000, bottom: 400 };
    // 划线偏下：从上方贴合需要的位移更小
    const avoid: PopoverRect = { left: 0, top: 100, right: 1000, bottom: 350 };
    const placement = computePopoverPlacement(avoid, { width: 320, height: 240 }, bounds);

    expect(placement.side).toBe("above");
    expect(placement.top).toBe(bounds.top + 8);
    expect(placement.maxHeight).toBe(240);
  });

  it("选区几乎占满可用区域时退化为 overlay，仍限制在边界内", () => {
    const bounds: PopoverRect = { left: 0, top: 0, right: 400, bottom: 200 };
    const avoid: PopoverRect = { left: 0, top: 0, right: 400, bottom: 200 };
    const placement = computePopoverPlacement(avoid, { width: 320, height: 240 }, bounds);

    expect(placement.side).toBe("overlay");
    expect(placement.top).toBeGreaterThanOrEqual(8);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(bounds.bottom - 8);
  });

  it("超宽尺寸被钳到可用宽度内，不会横向溢出", () => {
    const avoid: PopoverRect = { left: 400, top: 100, right: 600, bottom: 140 };
    const placement = computePopoverPlacement(avoid, { width: 5000, height: 240 }, BOUNDS);

    expect(placement.width).toBe(984);
    expect(placement.left).toBeGreaterThanOrEqual(8);
    expect(placement.left + placement.width).toBeLessThanOrEqual(BOUNDS.right - 8);
  });

  it("过小尺寸被抬到最小宽高，避免卡片压成一条缝", () => {
    const avoid: PopoverRect = { left: 400, top: 100, right: 600, bottom: 140 };
    const placement = computePopoverPlacement(avoid, { width: 10, height: 10 }, BOUNDS);

    expect(placement.width).toBe(200);
    expect(placement.side).toBe("below");
  });

  it("选区部分在可用区域外时先裁剪再计算，不产生负坐标", () => {
    const avoid: PopoverRect = { left: -100, top: -50, right: 200, bottom: 60 };
    const placement = computePopoverPlacement(avoid, { width: 320, height: 240 }, BOUNDS);

    expect(placement.left).toBeGreaterThanOrEqual(8);
    expect(placement.top).toBeGreaterThanOrEqual(8);
  });
});

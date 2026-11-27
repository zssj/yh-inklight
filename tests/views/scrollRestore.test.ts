/**
 * [INPUT]: 被测 src/views/scrollRestore.ts 的纯函数（量测/写入通过 target 注入）
 * [OUTPUT]: 覆盖「重建后回到原滚动位置」的判定：先补高度再落位、按锚点内容偏移对齐（认卡不认像素）、无锚点退像素
 * [POS]: L1 纯逻辑测试——DOM 量测在真机验证，这里只锁住恢复顺序与落位算法
 */

import { describe, expect, it } from "vitest";

import { applyScrollRestore, pickScrollAnchor, RESTORE_MAX_CARDS } from "../../src/views/scrollRestore";

interface Harness {
  target: {
    contentHeight: () => number;
    viewportHeight: () => number;
    anchorContentOffset: (anchorId: string) => number | null;
    setTop: (top: number) => void;
  };
  state: { height: number; top: number };
}

function makeHarness(
  options: { height: number; viewport?: number; anchorContentOffset?: number | null } = { height: 0 },
): Harness {
  const state = {
    height: options.height,
    top: 0,
  };
  return {
    state,
    target: {
      contentHeight: () => state.height,
      viewportHeight: () => options.viewport ?? 600,
      anchorContentOffset: () =>
        options.anchorContentOffset === undefined ? null : options.anchorContentOffset,
      setTop: (top) => {
        state.top = top;
      },
    },
  };
}

describe("applyScrollRestore", () => {
  it("先补到「原位置 + 一屏」的高度再落位：不补高度 scrollTop 会被夹住", () => {
    const { target, state } = makeHarness({ height: 1200 });
    const asked: number[] = [];

    const finished = applyScrollRestore(target, { top: 5000, anchorId: "", anchorOffset: 0 }, (atLeast) => {
      asked.push(atLeast);
      state.height = 9000;
      return false;
    });

    expect(asked).toEqual([5600]);
    expect(state.top).toBe(5000);
    expect(finished).toBe(false);
  });

  it("按锚点内容偏移落位：像素坐标错位（估算高度噪声）也落回同一张卡", () => {
    // 保存的 top=12000 是真实高度坐标系；重建后锚点在当前布局的内容偏移只有 8200
    // （上方未绘制卡按 160px 估算）。按锚点对齐 = 8200 - 10，而不是拉回 12000。
    const { target, state } = makeHarness({ height: 20_000, anchorContentOffset: 8200 });
    applyScrollRestore(target, { top: 12_000, anchorId: "card-40", anchorOffset: 10 }, () => false);

    expect(state.top).toBe(8190);
  });

  it("锚点露出下半部分（负偏移）同样对齐：视口顶停在锚点上方 anchorOffset 处", () => {
    const { target, state } = makeHarness({ height: 9000, anchorContentOffset: 3000 });
    applyScrollRestore(target, { top: 3000, anchorId: "card-7", anchorOffset: -30 }, () => false);

    expect(state.top).toBe(3030);
  });

  it("锚点落位结果为负时夹到 0：内容被删短后锚点已近列表顶", () => {
    const { target, state } = makeHarness({ height: 9000, anchorContentOffset: 5 });
    applyScrollRestore(target, { top: 3000, anchorId: "card-7", anchorOffset: 40 }, () => false);

    expect(state.top).toBe(0);
  });

  it("锚点没渲染出来（在补卡上限之外）时退化成像素落位", () => {
    // anchorContentOffset 返回 null 就是「这张卡还不在 DOM 里」
    const { target, state } = makeHarness({ height: 20_000, anchorContentOffset: null });
    applyScrollRestore(target, { top: 12_000, anchorId: "card-999", anchorOffset: 5 }, () => false);

    expect(state.top).toBe(12_000);
  });

  it("空锚点（captureScroll 时 top≤1 等）直接按像素落位", () => {
    const { target, state } = makeHarness({ height: 9000 });
    applyScrollRestore(target, { top: 3000, anchorId: "", anchorOffset: 0 }, () => false);

    expect(state.top).toBe(3000);
  });

  it("卡片已全部渲染完时返回 true，调用方据此移除底部哨兵", () => {
    const { target } = makeHarness({ height: 4000 });
    expect(applyScrollRestore(target, { top: 100, anchorId: "", anchorOffset: 0 }, () => true)).toBe(true);
  });

  it("补高度按批推进且有上限：滚到极深时不会一次同步铺完全库", () => {
    const { target, state } = makeHarness({ height: 1200 });
    let appended = 0;

    const finished = applyScrollRestore(target, { top: 100_000, anchorId: "", anchorOffset: 0 }, (atLeast) => {
      let done = false;
      let budget = RESTORE_MAX_CARDS;
      while (!done && budget > 0 && state.height < atLeast) {
        appended += 40;
        state.height += 1000;
        budget -= 40;
        done = appended >= 2000;
      }
      return done;
    });

    expect(appended).toBe(RESTORE_MAX_CARDS);
    expect(finished).toBe(false);
  });
});

describe("pickScrollAnchor", () => {
  it("取列表顶端第一张有交集的卡，而不是第一张卡", () => {
    const cards = [
      { id: "above", top: 0, bottom: 80 },
      { id: "edges", top: 90, bottom: 200 },
      { id: "below", top: 210, bottom: 300 },
    ];
    // 列表顶端在 100：第一张卡已经整个滚过去了，锚点应是刚露出一点的那张
    expect(pickScrollAnchor(cards, 100)).toEqual({ anchorId: "edges", anchorOffset: -10 });
  });

  it("所有卡都在上方（例如只剩尾部空白）时返回空锚点，交给像素兜底", () => {
    const cards = [{ id: "a", top: 0, bottom: 50 }];
    expect(pickScrollAnchor(cards, 500)).toEqual({ anchorId: "", anchorOffset: 0 });
  });
});

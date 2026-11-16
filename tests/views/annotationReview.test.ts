/**
 * [INPUT]: 被测 src/views/markdownStatsView 的 buildAnnotationBuckets（纯函数）
 * [OUTPUT]: 覆盖批注回顾的日历窗口判定、孤岛优先排序与 Top 5 截断
 * [POS]: L1 纯逻辑测试——「换数据源」最容易错的是窗口条件照搬了 openCount
 */

import { describe, expect, it } from "vitest";

import { AnnotationReviewEntry, buildAnnotationBuckets } from "../../src/views/markdownStatsView";

const NOW = new Date(2026, 10, 15, 12, 0, 0);
const DAY_MS = 86_400_000;

function entry(id: string, daysAgo: number, linkCount = 0): AnnotationReviewEntry {
  return {
    id,
    filePath: "读书笔记/复利.md",
    mode: "md",
    quote: "复利效应",
    content: `想法 ${id}`,
    createdAt: NOW.getTime() - daysAgo * DAY_MS - 3_600_000,
    linkCount,
  };
}

describe("buildAnnotationBuckets", () => {
  it("按自然日窗口分到 1 天 / 7 天两张卡", () => {
    const buckets = buildAnnotationBuckets([entry("a", 1), entry("b", 7)], NOW);
    expect(buckets.map((bucket) => bucket.kind)).toEqual(["day1", "day7"]);
    expect(buckets[0].entries[0].id).toBe("a");
    expect(buckets[1].entries[0].id).toBe("b");
  });

  it("上月今日与去年今日按日历同号命中", () => {
    const lastMonth = new Date(2026, 9, 15, 9, 0, 0).getTime();
    const lastYear = new Date(2025, 10, 15, 9, 0, 0).getTime();
    const buckets = buildAnnotationBuckets(
      [
        { ...entry("m", 0), createdAt: lastMonth },
        { ...entry("y", 0), createdAt: lastYear },
      ],
      NOW,
    );
    expect(buckets.map((bucket) => bucket.kind)).toEqual(["lastMonth", "lastYear"]);
  });

  it("不在任何窗口内的条目不出现", () => {
    expect(buildAnnotationBuckets([entry("x", 3)], NOW)).toEqual([]);
  });

  it("孤岛优先：关联少的排在前面，同关联数按时间新到旧", () => {
    const buckets = buildAnnotationBuckets(
      [entry("linked", 1, 4), entry("island", 1, 0), entry("half", 1, 1)],
      NOW,
    );
    expect(buckets[0].entries.map((item) => item.id)).toEqual(["island", "half", "linked"]);
  });

  it("每张卡最多 5 条", () => {
    const many = Array.from({ length: 8 }, (_, index) => entry(`e${index}`, 1, index));
    expect(buildAnnotationBuckets(many, NOW)[0].entries).toHaveLength(5);
  });

  it("非法或未来时间不参与回顾", () => {
    const buckets = buildAnnotationBuckets(
      [{ ...entry("bad", 0), createdAt: Number.NaN }, { ...entry("future", 0), createdAt: NOW.getTime() + DAY_MS }],
      NOW,
    );
    expect(buckets).toEqual([]);
  });

  it("今天已回看过的条目不再出现，昨天回看过的仍出现", () => {
    const reviewedToday = NOW.getTime() - 60_000;
    const reviewedYesterday = NOW.getTime() - DAY_MS;
    const buckets = buildAnnotationBuckets(
      [
        { ...entry("done", 1), reviewedAt: reviewedToday },
        { ...entry("again", 1), reviewedAt: reviewedYesterday },
      ],
      NOW,
    );
    expect(buckets[0].entries.map((item) => item.id)).toEqual(["again"]);
  });

  it("全部条目今天都回看过 → 空卡消失（不留空壳标题）", () => {
    const buckets = buildAnnotationBuckets(
      [{ ...entry("only", 1), reviewedAt: NOW.getTime() - 1_000 }],
      NOW,
    );
    expect(buckets).toEqual([]);
  });
});

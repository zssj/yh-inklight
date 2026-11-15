/**
 * [INPUT]: views/cardBody 的动作归属表
 * [OUTPUT]: 动作在两个容器里的可见性契约：浮层与侧栏必须共用同一张表，不允许只加一边
 * [POS]: views 层的第一道防漂移护栏。历史问题是两套渲染各自长，noteType 在浮层里丢过一次
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { describe, expect, it } from "vitest";
import { CARD_ACTIONS } from "../../src/views/cardBody";

const ids = (inList: boolean) =>
  CARD_ACTIONS.filter((spec) => (inList ? spec.inList : spec.inPopover)).map((spec) => spec.id);

describe("CARD_ACTIONS", () => {
  it("动作 id 唯一，避免同一动作被两条规则重复渲染", () => {
    const all = CARD_ACTIONS.map((spec) => spec.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it("两个容器都有编辑/添加笔记、删除、导出笔记、提炼成卡片", () => {
    const shared = ["edit-note", "add-note", "delete", "open-export", "atom-card"];
    expect(ids(true)).toEqual(expect.arrayContaining(shared));
    expect(ids(false)).toEqual(expect.arrayContaining(shared));
  });

  it("只有「跳转」是列表专有：浮层点它等于原地跳原地", () => {
    const listOnly = ids(true).filter((id) => !ids(false).includes(id));
    expect(listOnly).toEqual(["jump"]);
  });

  it("浮层没有列表专有之外的动作，两侧差异只有一处", () => {
    const popoverOnly = ids(false).filter((id) => !ids(true).includes(id));
    expect(popoverOnly).toEqual([]);
  });
});

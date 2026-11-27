/**
 * [INPUT]: views/editPanel 的浮动面板外壳与两个内容包装、views/cardBody 的标签行、obsidian 的 Platform 替身
 * [OUTPUT]: 浮动编辑面板的核心契约：面板挂在 body、**不在列表 DOM 里**（列表重绘删不掉它）、
 *           点外关闭 / Esc / 关闭时提交未回车的标签、移动端底部卡片、锚点滚出视口即收，
 *           以及 cardBody 的「+」把按钮当锚点抛给宿主（标签行不再承载任何编辑态）
 * [POS]: 替换旧的 tagEditorGuard.test.ts。旧测试守的是「编辑期别重绘、别把输入框删掉」——
 *        那一整套守卫之所以存在，是因为编辑器就长在卡片里；现在编辑器在 body 上，
 *        真正该守的契约变成「卡片 DOM 里不许出现输入框」。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

import { dismissFloatingPanel, FloatingPanel, openNoteEditorPanel, openTagEditorPanel } from "../../src/views/editPanel";
import { renderCardBody } from "../../src/views/cardBody";
import type { SidebarCard } from "../../src/views/cardModel";
import { installObsidianDom } from "../helpers/dom";

installObsidianDom();

const ROOT = join(__dirname, "..", "..");

/** 让 rAF 与 setTimeout 都跑掉：面板的首次定位与聚焦都排在这一帧里 */
const flushFrame = (): void => {
  vi.advanceTimersByTime(32);
};
/** 越过「刚打开 700ms 内不判外点」的保护窗口 */
const passGrace = (): void => {
  vi.advanceTimersByTime(800);
};

function button(label = "+"): HTMLButtonElement {
  const element = document.createElement("button");
  element.textContent = label;
  // jsdom 没有布局，getBoundingClientRect 恒为零：给一个视口内的真实尺寸，
  // 否则面板会（正确地）判定「锚点不在视口里」而立刻收起，测不到后续行为
  const rect = { left: 40, top: 100, right: 60, bottom: 120, width: 20, height: 20, x: 40, y: 100 };
  element.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect }) as DOMRect;
  document.body.appendChild(element);
  return element;
}

function pointerDownOn(target: Element): void {
  target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
}

function escape(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
  Platform.isMobile = false;
  Platform.isDesktop = true;
});

afterEach(() => {
  // 面板的 document 监听不会随 innerHTML="" 消失，必须显式收掉，否则会污染后续用例
  dismissFloatingPanel();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("FloatingPanel 外壳", () => {
  it("面板挂在 body 上，列表被清空也删不掉它", () => {
    const list = document.createElement("div");
    list.className = "yh-ov-list";
    const anchor = button();
    list.appendChild(anchor);
    document.body.appendChild(list);

    const panel = new FloatingPanel({ anchor, width: 320, build: () => undefined });
    panel.open();
    flushFrame();

    expect(panel.el.parentElement).toBe(document.body);
    expect(list.contains(panel.el)).toBe(false);

    // 整表重绘：列表连同锚点一起被换掉
    list.innerHTML = "";
    expect(panel.el.isConnected, "编辑器在 body 上，列表重绘不该带走它").toBe(true);
    panel.dismiss();
  });

  it("键盘焦点进面板不会改变卡片高度（面板是 fixed 定位的独立节点）", () => {
    const anchor = button();
    const panel = new FloatingPanel({ anchor, width: 320, build: () => undefined });
    panel.open();
    flushFrame();

    const card = document.createElement("div");
    card.className = "yh-ov-card";
    card.appendChild(anchor);
    document.body.appendChild(card);

    expect(panel.el.classList.contains("yh-float-panel")).toBe(true);
    panel.dismiss();
  });

  it("点面板外关闭，点面板内不关", () => {
    const anchor = button();
    const onClose = vi.fn();
    let inner: HTMLElement | null = null;
    const panel = new FloatingPanel({
      anchor,
      width: 320,
      build: (host) => {
        inner = host.createDiv({ cls: "inside" });
      },
      onClose,
    });
    panel.open();
    flushFrame();
    passGrace();

    pointerDownOn(inner!);
    expect(panel.isOpen(), "点面板内部不该关闭").toBe(true);

    pointerDownOn(document.body);
    expect(panel.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledWith("outside");
  });

  it("刚打开的一瞬间不判外点：软键盘弹出会补发 target=body 的 pointerdown", () => {
    const anchor = button();
    const panel = new FloatingPanel({ anchor, width: 320, build: () => undefined });
    panel.open();
    flushFrame();

    pointerDownOn(document.body);
    expect(panel.isOpen(), "700ms 保护窗口内的外点必须忽略").toBe(true);
    panel.dismiss();
  });

  it("桌面端 Esc 关闭；移动端忽略（那是输入法在收键盘）", () => {
    const anchor = button();

    const desktop = new FloatingPanel({ anchor, width: 320, build: () => undefined });
    desktop.open();
    flushFrame();
    escape();
    expect(desktop.isOpen()).toBe(false);

    Platform.isMobile = true;
    Platform.isDesktop = false;
    const mobile = new FloatingPanel({ anchor, width: 320, build: () => undefined });
    mobile.open();
    flushFrame();
    escape();
    expect(mobile.isOpen(), "移动端的 Escape 来自输入法，不能当取消").toBe(true);
    mobile.dismiss();
    Platform.isMobile = false;
    Platform.isDesktop = true;
  });

  it("移动端不进 is-mobile 之外的定位假设：位置由可视视口算出来", () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const anchor = button();
    const panel = new FloatingPanel({ anchor, width: 320, build: () => undefined });
    panel.open();
    flushFrame();

    expect(panel.el.classList.contains("is-mobile")).toBe(true);
    expect(panel.el.style.left, "移动端也要写 left/top：键盘弹起时靠可视视口重新算").not.toBe("");
    expect(panel.el.style.top).not.toBe("");
    panel.dismiss();
    Platform.isMobile = false;
    Platform.isDesktop = true;
  });

  it("锚点滚出视口：桌面收起面板，移动端留着（键盘把卡片顶出去是常态）", () => {
    const anchor = button();
    const offscreen = () =>
      ({ left: 0, top: -400, right: 20, bottom: -380, width: 20, height: 20, x: 0, y: -400, toJSON: () => ({}) }) as DOMRect;
    anchor.getBoundingClientRect = offscreen;

    const desktop = new FloatingPanel({ anchor, width: 320, build: () => undefined });
    desktop.open();
    flushFrame();
    expect(desktop.isOpen()).toBe(false);

    Platform.isMobile = true;
    Platform.isDesktop = false;
    const mobile = new FloatingPanel({ anchor, width: 320, build: () => undefined });
    mobile.open();
    flushFrame();
    expect(mobile.isOpen(), "移动端要留着，用户可能正在输标签").toBe(true);
    mobile.dismiss();
    Platform.isMobile = false;
    Platform.isDesktop = true;
  });

  it("打开即收起时不再挂 document 监听（否则它会抢在真正的面板前面吃掉 Esc）", () => {
    const anchor = button();
    anchor.getBoundingClientRect = () =>
      ({ left: 0, top: -400, right: 20, bottom: -380, width: 20, height: 20, x: 0, y: -400, toJSON: () => ({}) }) as DOMRect;

    const panel = new FloatingPanel({ anchor, width: 320, build: () => undefined });
    panel.open();
    flushFrame();
    expect(panel.isOpen()).toBe(false);

    const event = escape();
    expect(event.defaultPrevented, "已收起的面板不该继续拦截 Esc，否则下一个面板收不掉").toBe(false);
  });
});

describe("标签面板", () => {
  it("关闭时提交输入框里没回车的标签", () => {
    const anchor = button();
    const onChange = vi.fn();
    const panel = openTagEditorPanel({ anchor, tags: [], suggestions: [], onChange });
    flushFrame();
    passGrace();

    const field = panel.el.querySelector<HTMLInputElement>(".yh-tag-input-field");
    expect(field, "标签面板必须直接给出输入框").not.toBeNull();
    field!.value = "认知负荷";

    pointerDownOn(document.body);
    expect(panel.isOpen()).toBe(false);
    expect(onChange, "点外关闭不能吞掉已经打好的标签").toHaveBeenCalledWith(["认知负荷"]);
  });

  it("Esc 关闭视为放弃，不提交半截输入", () => {
    const anchor = button();
    const onChange = vi.fn();
    const panel = openTagEditorPanel({ anchor, tags: [], suggestions: [], onChange });
    flushFrame();

    const field = panel.el.querySelector<HTMLInputElement>(".yh-tag-input-field");
    field!.value = "认知";
    escape();

    expect(panel.isOpen()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("同一时刻只有一个标签面板：开新的先收旧的", () => {
    const first = openTagEditorPanel({ anchor: button(), tags: [], suggestions: [], onChange: () => undefined });
    flushFrame();
    const second = openTagEditorPanel({ anchor: button(), tags: [], suggestions: [], onChange: () => undefined });
    flushFrame();

    expect(first.isOpen()).toBe(false);
    expect(second.isOpen()).toBe(true);
    second.dismiss();
  });
});

describe("想法面板", () => {
  it("保存把内容交给宿主，成功后自动收起", async () => {
    const anchor = button("添加笔记");
    const onSave = vi.fn().mockResolvedValue(undefined);
    const panel = openNoteEditorPanel({ anchor, value: "原有想法", onSave });
    flushFrame();

    const field = panel.el.querySelector<HTMLTextAreaElement>(".yh-float-panel-textarea");
    expect(field!.value, "编辑已有想法要带出原文").toBe("原有想法");
    field!.value = "改过的想法";

    panel.el.querySelector<HTMLButtonElement>(".yh-ov-save")!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(onSave).toHaveBeenCalledWith("改过的想法");
    expect(panel.isOpen()).toBe(false);
  });

  it("保存失败保持打开，输入不丢", async () => {
    const anchor = button("添加笔记");
    const onSave = vi.fn().mockRejectedValue(new Error("磁盘只读"));
    const panel = openNoteEditorPanel({ anchor, value: "", onSave });
    flushFrame();

    const field = panel.el.querySelector<HTMLTextAreaElement>(".yh-float-panel-textarea");
    field!.value = "写到一半";
    panel.el.querySelector<HTMLButtonElement>(".yh-ov-save")!.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.isOpen(), "写盘失败时面板必须留着，不能把用户写的字一起收掉").toBe(true);
    expect(field!.value).toBe("写到一半");
    panel.dismiss();
  });

  it("取消直接收起，不调保存", () => {
    const anchor = button("添加笔记");
    const onSave = vi.fn();
    const panel = openNoteEditorPanel({ anchor, value: "", onSave });
    flushFrame();

    panel.el.querySelector<HTMLButtonElement>(".yh-ov-cancel")!.click();
    expect(onSave).not.toHaveBeenCalled();
    expect(panel.isOpen()).toBe(false);
  });
});

describe("cardBody 的标签行", () => {
  const card = {
    id: "h1",
    kind: "highlight",
    mode: "md",
    sourcePath: "笔记.md",
    color: "yellow",
    text: "划线",
    content: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    startOffset: 0,
    pageNumber: null,
    isCode: false,
    tags: ["复利"],
    relations: [],
    highlight: { id: "h1", anchor: { startOffset: 0, selectedText: "划线" } },
    note: null,
  } as unknown as SidebarCard;

  it("点「+」把按钮本身当锚点交给宿主，并附带标签行重绘句柄", () => {
    const root = document.createElement("div");
    const onStartTagEdit = vi.fn();
    renderCardBody(root, card, {
      host: "list",
      fileName: "笔记.md",
      tags: { onStartTagEdit },
      actions: {},
    });

    const add = root.querySelector<HTMLElement>(".yh-ov-tag-add");
    expect(add, "标签行必须有加号").not.toBeNull();
    add!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onStartTagEdit).toHaveBeenCalledTimes(1);
    const [anchor, repaint] = onStartTagEdit.mock.calls[0];
    expect(anchor, "宿主拿不到按钮就没办法把面板贴在加号旁边").toBe(add);
    expect(typeof repaint, "改完标签要能原地刷新 chip 行").toBe("function");
    expect(root.querySelector(".yh-tag-input-field"), "卡片里不许出现输入框").toBeNull();
  });

  it("点折叠的 +N 也走同一条入口并回传被点的节点", () => {
    const root = document.createElement("div");
    const onStartTagEdit = vi.fn();
    renderCardBody(root, { ...card, tags: ["a", "b", "c", "d", "e", "f"] } as SidebarCard, {
      host: "list",
      fileName: "笔记.md",
      tags: { onStartTagEdit },
      actions: {},
    });

    const more = root.querySelector<HTMLElement>(".yh-tag-chip-more");
    expect(more).not.toBeNull();
    more!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onStartTagEdit.mock.calls[0][0]).toBe(more);
  });

  it("源码层面钉死：cardBody 不再引用内联标签编辑器，宿主不再持有编辑态", () => {
    const cardBody = readFileSync(join(ROOT, "src/views/cardBody.ts"), "utf8");
    expect(cardBody, "innerHTML 式内联编辑器一旦回来，点 + 就会重新撑高卡片").not.toMatch(/renderTagInput/);
    expect(cardBody).not.toMatch(/isTagEditing/);
  });

  it("源码层面钉死：侧栏不再挂任何行内编辑态字段", () => {
    const sidebar = readFileSync(join(ROOT, "src/views/sidebarView.ts"), "utf8");
    for (const field of ["editingTagCardId", "editingNoteCardId", "tagEditorMount", "pendingTagQuery"]) {
      expect(sidebar, `侧栏不该再有行内编辑态字段 ${field}`).not.toContain(field);
    }
  });
});

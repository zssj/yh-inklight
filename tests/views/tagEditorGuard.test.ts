/**
 * [INPUT]: 读 src/views/sidebarView.ts 源码文本（本仓库自有文件，不做跨平台路径假设）
 * [OUTPUT]: 守住「侧栏标签编辑态不被重绘吞掉」契约
 * [POS]: L1 静态守卫——编辑框一闪即逝的根因有两类：
 *        一是 requestRender 排队中的 setTimeout(0) 在编辑开始后才执行 render()，
 *        container.empty() 直接删掉输入框；二是切到另一张卡的「+」时旧编辑器监听
 *        没收口，两次 document pointerdown 一起把新旧框都关掉。
 *        两处都靠视图字段与守卫维持，改名字/删守卫会让 bug 无声回归，这里钉死。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const source = readFileSync(join(ROOT, "src/views/sidebarView.ts"), "utf8");

/** 从方法签名截到下一个方法，避免无关代码里的同名字符串误命中 */
function methodBody(signature: string, nextSignature: string): string {
  const start = source.indexOf(signature);
  expect(start, `找不到 ${signature}`).toBeGreaterThan(-1);
  const end = source.indexOf(nextSignature, start + signature.length);
  expect(end, `找不到 ${nextSignature}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("侧栏标签编辑态守卫", () => {
  it("render() 在 container.empty() 之前先挡编辑态", () => {
    const body = methodBody("async render(): Promise<void> {", "private async refreshList");
    const guard = body.indexOf("this.editingTagCardId !== null");
    // 只看真正的调用语句（带分号），别被守卫注释里提到的名字带偏
    const empty = body.search(/\n\s*container\.empty\(\);/);
    expect(guard, "render() 缺少编辑态守卫").toBeGreaterThan(-1);
    expect(empty, "render() 不再清空容器？检查实现是否已改").toBeGreaterThan(-1);
    expect(guard, "守卫必须在 container.empty() 之前，否则输入框已被删").toBeLessThan(empty);
  });

  it("refreshList() 在 await 之后再挡一次编辑态", () => {
    const body = methodBody("private async refreshList(): Promise<void> {", "private renderCardList");
    // 入口已有一处守卫；这里要的是 await loadScope / prepareRelations 之后的第二处
    const guards = body.match(/this\.editingTagCardId !== null/g) ?? [];
    expect(guards.length, "refreshList() 必须入口与 await 后各挡一次").toBeGreaterThanOrEqual(2);
    expect(body.indexOf("this.pendingRender = true")).toBeLessThan(body.indexOf("list.empty()"));
  });

  it("挂载新编辑器前先收口旧编辑器，close 后清自身句柄", () => {
    const body = methodBody("private wireTagEditor(", "private tagRefs(");
    const guard = body.indexOf("this.tagEditorCleanup?.()");
    expect(guard, "wireTagEditor 必须先收掉旧编辑器").toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf("document.addEventListener("));
    expect(body, "close 后必须清 tagEditorCleanup，否则同卡重开时旧 close 会删掉新输入框")
      .toMatch(/this\.tagEditorCleanup === close\)\s*\{\s*this\.tagEditorCleanup = null/);
  });

  it("onClose 清掉编辑态字段，避免重开视图时被守卫永久挡住", () => {
    const body = methodBody("async onClose(): Promise<void> {", "requestRender(force = false): void");
    expect(body).toContain("this.tagEditorCleanup?.()");
    expect(body).toMatch(/this\.editingTagCardId = null/);
  });
});

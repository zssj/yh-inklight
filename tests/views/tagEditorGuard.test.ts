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
    const guard = body.indexOf("this.isEditing()");
    // 只看真正的调用语句（带分号），别被守卫注释里提到的名字带偏
    const empty = body.search(/\n\s*container\.empty\(\);/);
    expect(guard, "render() 缺少编辑态守卫").toBeGreaterThan(-1);
    expect(empty, "render() 不再清空容器？检查实现是否已改").toBeGreaterThan(-1);
    expect(guard, "守卫必须在 container.empty() 之前，否则输入框已被删").toBeLessThan(empty);
    // 但视角变了必须放行：否则换范围/筛选时列表被永久冻在旧内容上
    expect(body, "编辑态守卫必须带视角例外").toMatch(
      /this\.renderedIdentity === this\.listIdentity\(\)[\s\S]{0,80}this\.abandonEditing\(\)/,
    );
  });

  it("refreshList() 在 await 之后再挡一次编辑态", () => {
    const body = methodBody("private async refreshList(): Promise<void> {", "private renderCardList");
    // 入口已有一处守卫；这里要的是 await loadScope / prepareRelations 之后的第二处
    const guards = body.match(/this\.isEditing\(\)/g) ?? [];
    expect(guards.length, "refreshList() 必须入口与 await 后各挡一次").toBeGreaterThanOrEqual(2);
    expect(body.indexOf("this.pendingRender = true")).toBeLessThan(body.indexOf("list.empty()"));
  });

  it("挂载新编辑器前先收口旧编辑器，close 后清自身句柄", () => {
    const body = methodBody("private wireTagEditor(", "private tagRefs(");
    const guard = body.indexOf("previous?.()");
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

  it("挂载新编辑器先自增代次再收口旧编辑器，旧 close 不再 repaint 新输入框", () => {
    const body = methodBody("private wireTagEditor(", "private tagRefs(");
    const bump = body.indexOf("++this.tagEditorMount");
    const previous = body.indexOf("previous?.()");
    expect(bump, "wireTagEditor 缺少挂载代次").toBeGreaterThan(-1);
    expect(previous, "wireTagEditor 必须先收口旧编辑器").toBeGreaterThan(-1);
    expect(bump, "代次必须在收口旧编辑器之前自增，否则旧 close 判不出已被接管").toBeLessThan(previous);
    // 旧 close：代次不一致时只解绑监听，不碰共享状态
    expect(body).toMatch(/mount !== this\.tagEditorMount\)\s*\{\s*return;/);
  });
});

/**
 * 行内「想法」编辑框：编辑态同样必须记在视图上。
 * 早先它只活在 DOM 里，任何一次刷新（切回前台、数据变化、后台自愈）都会把输入框
 * 连同没保存的内容一起删掉——用户看到的就是「点添加想法，一闪就没了」。
 */
describe("行内想法编辑态守卫", () => {
  it("重建卡片时按 editingNoteCardId 把输入框连同草稿挂回来", () => {
    const body = methodBody("private buildCardElement(", "private buildCardHost(");
    expect(body).toMatch(/this\.editingNoteCardId === cardData\.id/);
    expect(body, "重建后必须重挂编辑器，否则一次刷新就丢内容").toContain("this.openInlineEditor(");
    // 重建不抢焦点：否则输入法自己弹起来
    expect(body).toMatch(/focus:\s*false/);
  });

  it("openInlineEditor 登记编辑态、记草稿、退出时清干净", () => {
    const body = methodBody("private openInlineEditor(", "private async saveCardContent(");
    expect(body).toMatch(/this\.editingNoteCardId = cardData\.id/);
    expect(body).toMatch(/this\.noteDraft = initialValue/);
    expect(body, "输入必须实时记草稿，否则重建会回填旧的空串").toMatch(/textarea\.oninput/);
    expect(body).toMatch(/this\.editingNoteCardId = null/);
    expect(body).toMatch(/this\.noteDraft = ""/);
  });

  it("保存前先退编辑态，别把随后的刷新挡在守卫外", () => {
    const body = methodBody("private openInlineEditor(", "private async saveCardContent(");
    const exit = body.indexOf("exitEditor();");
    const save = body.indexOf("await this.saveCardContent(");
    expect(exit).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(-1);
    expect(exit, "必须先退编辑态再保存：保存会触发 refreshAnnotations").toBeLessThan(save);
  });

  it("视图不可见时不重建（隐藏状态下量不到滚动位置）", () => {
    const body = methodBody("async render(): Promise<void> {", "private async refreshList");
    const guard = body.indexOf("!this.isVisible()");
    const capture = body.indexOf("this.captureScroll()");
    expect(guard, "render() 缺少不可见守卫").toBeGreaterThan(-1);
    expect(capture).toBeGreaterThan(-1);
    expect(guard, "守卫必须在 captureScroll 之前").toBeLessThan(capture);
    expect(body).toMatch(/this\.pendingVisibleRender = true/);
  });
});

/**
 * 滚动后追加的卡片：正文 Markdown 是「进视口才绘制」的。
 * 这串绘制会清空正文重新渲染，卡片高度随之变化——点开编辑器的同一时刻发生，
 * 用户看到的就是「一闪而过」。首屏卡片不走延迟绘制，所以从来不闪。
 */
describe("延迟正文绘制与编辑态", () => {
  it("编辑期间不执行延迟绘制，退出后按视口补绘", () => {
    const body = methodBody("private deferCardContent(", "private resetDeferredContent(): void");
    expect(body, "IO 回调里必须先挡编辑态").toMatch(
      /if \(this\.isEditing\(\)\) \{\s*continue;/,
    );
    // 挡住的 job 留在队列里，必须有主动补绘的出口，否则滚过来的卡片正文永远是原文
    expect(source, "缺少 flushDeferredContent 出口").toContain("private flushDeferredContent(): void");
    const exit = methodBody("private openInlineEditor(", "private async saveCardContent(");
    expect(exit, "想法编辑退出后必须补绘").toContain("this.flushDeferredContent()");
    const tagEditor = methodBody("private wireTagEditor(", "private tagRefs(");
    expect(tagEditor, "标签编辑退出后必须补绘").toContain("this.flushDeferredContent()");
  });

  it("正在编辑的卡片退出 content-visibility 按需绘制", () => {
    const css = readFileSync(join(ROOT, "styles.css"), "utf8");
    expect(css).toMatch(
      /\.yh-ov-list > \.yh-ov-card\.is-tag-editing,\s*\n\.yh-ov-list > \.yh-ov-card\.is-note-editing \{\s*content-visibility: visible;/,
    );
    const body = methodBody("private wireTagEditor(", "private tagRefs(");
    expect(body).toContain('addClass("is-tag-editing")');
    expect(body).toContain('removeClass("is-tag-editing")');
    const note = methodBody("private openInlineEditor(", "private async saveCardContent(");
    expect(note).toContain('addClass("is-note-editing")');
    expect(note).toContain('removeClass("is-note-editing")');
  });

  it("已经完整可见的卡片不在点开时滚动列表", () => {
    const body = methodBody("private wireTagEditor(", "private tagRefs(");
    const guard = body.indexOf("rowRect.top >= listRect.top");
    const scroll = body.indexOf("field.scrollIntoView(");
    expect(guard, "revealField 必须先判断是否已完整可见").toBeGreaterThan(-1);
    expect(scroll).toBeGreaterThan(-1);
    expect(guard, "判断必须在 scrollIntoView 之前，否则白滚一次触发连锁重排").toBeLessThan(scroll);
  });
});

/**
 * [INPUT]: 读 src/views 与 main.ts 源码文本（本仓库自有文件，不做跨平台路径假设）
 * [OUTPUT]: 守住「跳转接线」契约：视图里的 EPUB 跳转回调必须是 openEpubAtCfi
 * [POS]: L1 静态守卫——openAnnotationTarget 的第三参决定书没打开时会不会开书；
 *        侧栏与标签总览曾误传 navigateEpubToCfi（只定位已开视图），
 *        表现为点击跳转「完全没反应、也不报错」，且 972 条 EPUB 批注几乎每次命中。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

describe("EPUB 跳转接线", () => {
  it("视图层不得直接调用 navigateEpubToCfi（它只定位已打开的视图，不会开书）", () => {
    for (const file of ["src/views/sidebarView.ts", "src/views/tagBoardView.ts", "src/views/annotationCard.ts"]) {
      // 只看「调用」（.navigateEpubToCfi(），注释里解释这个方法名是允许的
      expect(read(file), `${file} 应改用 plugin.openEpubAtCfi`).not.toMatch(/\.\s*navigateEpubToCfi\s*\(/);
    }
  });

  it("navigateEpubToCfi 保持 private：视图直接调它在编译期就失败", () => {
    expect(read("main.ts")).toMatch(/private navigateEpubToCfi\(/);
  });

  it("凡是调用 openAnnotationTarget 的视图，第三个参数都指向 openEpubAtCfi", () => {
    for (const file of ["src/views/sidebarView.ts", "src/views/tagBoardView.ts"]) {
      const source = read(file);
      const calls = source.split("openAnnotationTarget(").slice(1);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        // 第三参就在同一次调用的前 600 字符内
        expect(call.slice(0, 600)).toContain("openEpubAtCfi");
      }
    }
  });
});

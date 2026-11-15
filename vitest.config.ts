import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * 测试配置：把 `obsidian` 解析到测试替身，源码本身不做任何改动。
 * 环境默认 node；需要 DOM 的用例在文件头加 `// @vitest-environment jsdom`。
 */
export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    reporters: ["dot"],
    clearMocks: true,
  },
});

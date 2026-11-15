# 测试指南

自动化测试覆盖「算法与存储契约」，真机手测覆盖「渲染与手势」。两者不重叠，别用自动化去补渲染，也别用真机去验算法。

## 命令

```bash
npm test          # 跑一遍（约 5s），提交前必跑
npm run test:watch  # 写用例时开
npm run check     # 类型检查 + 生产构建（与测试互不替代）
```

CI：`Build Check` 在 mac/win/linux 三平台跑 `npm run build`，linux 额外跑 `npm test`。测试红则 Release 不会创建（同属 Build Check 判定）。

## 分层

| 层 | 位置 | 依赖 | 适合放什么 |
|---|---|---|---|
| L1 纯逻辑 | `tests/anchor`、`tests/storage/tags.test.ts`、`tests/views`、`tests/utils`、`tests/epub` | 无 | 坐标换算、锚点降级、标签规则、卡片配对、浮层几何、CFI 规范化 |
| L2 存储契约 | `tests/storage/annotationStore.test.ts` | `tests/helpers/fakeVault.ts` | sidecar 读写、index 迁移、失败保护、孤儿清理、改名迁移、导出 |
| 手工冒烟 | 真机 | — | 渲染、手势、真实 API 时序 |

## 目录

```
vitest.config.ts               # alias: obsidian → tests/mocks/obsidian.ts
tests/
  mocks/obsidian.ts            # TFile/TFolder/Notice/normalizePath 等替身
  helpers/fakeVault.ts         # 内存 Vault + 可注入写入失败
  anchor/  storage/  views/  utils/  epub/
```

## 加一个用例

纯逻辑模块直接 import：

```ts
import { createTextAnchor } from "../../src/anchor/textAnchor";

it("前插内容后 offset 跟随", () => {
  // 断言「对外契约」：offset 落在正确文字上，而不是内部某个中间变量
});
```

需要存储时用内存 Vault：

```ts
import { createApp } from "../helpers/fakeVault";
import { AnnotationStore } from "../../src/storage/annotationStore";

const { app, vault } = createApp({ files: { "note.md": "正文" } });
const store = new AnnotationStore(app);
await store.initialize();
await store.addHighlight(vault.fileAt("note.md"), highlight);
```

## mock 原则

- 只补被测代码实际调用的 API。缺符号时按**真实 Obsidian 行为**实现，例如 `adapter.write` 在父目录不存在时必须抛错——放宽 mock 会让「目录没建好」这类 bug 在测试里消失。
- 不 mock 被测模块本身。`RelationModel` 这类只依赖 `store.version` / `getIndexedDocuments` 的，传一个最小鸭子类型对象即可。
- 时间相关断言不要依赖真实时钟：需要「文件比 sidecar 新」时用 `vault.setMtime`。

## 已知取舍

- `files[].tags` 与标签字典的排序用 `localeCompare`，中英文先后随运行环境 locale 变化。用例里按同一规则生成期望值，不要硬编码顺序。
- `reconcileDocumentHash` 只在 `fileHash` 非空且文件 mtime 晚于 sidecar 时触发。新建批注时 `fileHash` 为空（由编辑器事件链路在首次修改后补写），测试里需要显式 seed 这个状态。
- 运行中的编辑由 vault 事件即时迁移；冷启动才走 hash 校验。验证 hash 自愈要用**新的 store 实例**。

## 真机冒烟清单（发版前）

Markdown
- [ ] 新建高亮与笔记 → 重启 Obsidian → 位置与内容不变
- [ ] 在批注前插入整段内容 → 划线仍指向原文
- [ ] 删掉被划线文字 → 侧栏置灰但不丢数据，阅读视图不渲染
- [ ] 代码块内划线不参与「相关批注」
- [ ] 导出单篇/全库/按标签 MOC，frontmatter 标签块可被 Obsidian 索引

PDF
- [ ] 跨页选区高亮位置正确
- [ ] 缩放窗口后高亮跟随
- [ ] 阅读进度重启后恢复

EPUB
- [ ] 跨章节跳转后标注立即重绘（约 160ms 补绘），不需手动重开
- [ ] 换一版书（spine 变化）后旧批注靠文字兜底定位，不指错章节
- [ ] 进度恢复与跳转不互相覆盖

移动端
- [ ] 侧栏打开后点笔记，右侧栏正确折叠
- [ ] 浮层不遮挡选中文字，键盘弹起时不被挡住
- [ ] 标签输入卡编辑态在重绘后不丢失

数据安全
- [ ] 删除源文件后不自动清批注，设置页可查看孤儿数量再手动清理
- [ ] 只读/同步冲突时写入失败有明确提示，sidecar 未被半截覆盖

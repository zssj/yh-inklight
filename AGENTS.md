# yh-inklight — 墨光批注

Obsidian 非侵入式阅读批注插件，支持 Markdown / PDF / EPUB。

## Commands

```bash
npm run dev          # esbuild watch mode, outputs main.js
npm run build        # esbuild production bundle
npm run check        # tsc --noEmit + build 一条命令（改动收敛后跑一次，勿边改边反复构建）
npm run verify       # tsc --noEmit + vitest run + build：改完代码的默认收尾命令，退出码 0 才算完成
npm test             # vitest run：L1 纯逻辑 + L2 storage 契约（约 5s，改动后必跑）
npm run test:watch   # vitest 监听模式，写用例时用
npx tsc --noEmit     # 只做类型检查（build 本身不做类型检查）
npm run release-check [vX.Y.Z]   # 发版验收，见下方 Release Workflow
```

No lint, no formatter config. CI 跑 `npm run build`（三平台）与 `npm test`（linux）。

## Release Workflow (发版流程)

Version lives in 3 files: `manifest.json`, `package.json`, `versions.json`.
`manifest.json` 与 `package.json` 每次发版必须同步；`versions.json` 是「插件版本 → 最低 app 版本」映射，历史上停在 `0.16.3`（0.17.x–0.18.2 未续写，自用/手动安装不受影响），自 0.18.3 起恢复追加 `"X.Y.Z": "1.0.0"`。

Steps (run from repo root `E:\OB插件\yh-inklight-src`):

```bash
npm run check                     # tsc --noEmit + 重建 main.js（一条命令，替代分别跑两次）
# 本地手动验证主路径，然后：
git add manifest.json package.json versions.json main.js src/<改动的源文件>   # 选择性 add，勿用 git add -A（工作区常有无关改动，如 README.md）
git commit -m "v0.17.XX: type: 中文描述"   # 历史格式: v开头版本号 + 中文提交说明；正文用「现象/原因/修复」三段
git push origin
git tag v0.17.XX                  # 轻量标签，带 v 前缀
git push origin v0.17.XX
# 注意：若 tag 已存在报 already exists，不要 tag -f 重打：先 git rev-list -n1 <tag>
# 核对指向当前提交，再 git push origin refs/tags/<tag> 补推。
```

- Tag MUST be lightweight and WITH `v` prefix（`v0.17.70`–`v0.17.74` 实际惯例）。历史备注：`0.17.20`–`0.17.69` 期间曾有一段不带 `v` 的 tag（如 `0.17.69`），但近期已回归 `v` 前缀，以 `v` 为准。
- After pushing the tag, GitHub Actions (`.github/workflows/release.yml`) auto-creates the GitHub Release with `main.js` + `manifest.json` + `styles.css` and auto-generated changelog. No web/`gh` CLI steps needed.
- Verify — 一条命令，不要手打 curl：

```bash
npm run release-check              # 默认取 package.json 版本；也可 npm run release-check -- v0.18.3
```

  它校验：HEAD == origin/main == tag 指向同一提交；`Build Check`(main) 与 `Release Obsidian Plugin`(该 tag) 均 success；Release 三资产 `uploaded` 且大小与本地产物一致（按 LF 归一化，CRLF 工作区不会误报）。输出 4 行结论，退出码 0 即就绪。未登录 GitHub 时 API 配额 60 次/小时，可用 `GITHUB_TOKEN` 环境变量提高。

- Deploy target for manual testing: `E:\知识库\.obsidian\plugins\yh-inklight\`（只覆盖 main.js / manifest.json / styles.css，不动 data.json）。

## Key Architecture

- **main.ts** — plugin entry, wires modules together. Exports `OverlayAnnotationsPlugin`.
- **src/storage/annotationStore.ts** — sole persistence layer. Annotations go to `<vault>/.obsidian-annotations/` sidecar JSON. Never touches original files.
- **src/storage/types.ts** — single source of truth for all annotation/settings types.
- **src/anchor/textAnchor.ts** — offset + context (prefix/suffix) anchor system with fuzzy matching fallback.
- **src/editor/** — CM6 highlight extension + reading view DOM highlight layer (separate paths).
- **src/pdf/** — PDF overlay highlights using page number + rect % coordinates.
- **src/epub/** — foliate-js based EPUB reader view, registered as `inklight-epub-reader`.
- **src/views/sidebarView.ts** — unified annotation sidebar (`yh-inklight-sidebar`), shared across all 3 formats.
- **Build output `main.js` is in `.gitignore` but IS git-tracked** — always rebuild before release and include it in the release commit.

## Conventions

- Non-invasive first: all annotation data in sidecar, document zero-modification.
- **原子卡目录是资产区**：`settings.atomCardFolder`（默认 `原子笔记/`，v0.19.15 前为 `卡片/`）下的文件由用户书写。提炼（抽卡）是一次性分叉，之后卡片与批注互不同步；任何清理/迁移/导出逻辑不得删除或覆盖其中文件。卡片去重只认 frontmatter 的 `inklightId`（= `${mode}-${annotationId}`），文件名仅作人类可读标题，可自由改。改目录名不影响已有卡片：ID 在 frontmatter 里，改完在设置里指到新路径即可。
- Three disjoint annotation coordinate systems: CM6 offset (MD), page+rect (PDF), CFI (EPUB).
- UI strings are Chinese (zh-CN). Comments and notices in Chinese.
- Module header convention: `[INPUT]` / `[OUTPUT]` / `[POS]` / `[PROTOCOL]` doc comments.
- `SUPPORTED_BOOK_EXTENSIONS` in types.ts lists all foliate-compatible formats registered as view handlers.
- Rename/move migration is debounced at 100ms (`main.ts:377`).

## Testing

**硬约定**：任何 `main.ts` / `src/**` 改动，收尾必须跑 `npm run verify`（类型检查 + 全部用例 + 生产构建）并拿到退出码 0。测试红时不得 commit、不得打 tag、不得部署到测试库；先定位失败用例是「测试预期错」还是「代码缺陷」，分别处理，禁止用 `.skip` / 放宽断言绕过去。

测试分两层，全部在 Node 下跑，不需要 Obsidian（`obsidian` 由 `vitest.config.mts` 的 alias 指到 `tests/mocks/obsidian.ts`）：

- **L1 纯逻辑**（`tests/anchor`、`tests/storage/tags`、`tests/views`、`tests/utils`、`tests/epub`）：零 mock，直接 import 源文件。覆盖锚点三级降级、模糊匹配、标签归一与 Obsidian 语法转换、卡片配对、浮层几何、CFI 规范化。
- **L2 存储契约**（`tests/storage/annotationStore.test.ts`）：`tests/helpers/fakeVault.ts` 提供内存 Vault + 可注入写入失败。覆盖 sidecar 读写、索引 v2/tagNames、写入失败保护、损坏 JSON 不覆盖、孤儿清理、改名迁移、导出。

**新增用例的约定**：只用源码实际调用的 obsidian API；`tests/mocks/obsidian.ts` 缺符号时按真实行为补齐，不要为了让测试变绿放宽 mock（例如让不存在的目录也能写）。断言写「对外契约」而不是内部实现细节。

**自动化盲区**（仍需手工验证）：foliate 真实渲染与跨章节 overlay、触摸手势与移动端侧栏、真实 Obsidian API 的时序（vault 事件、metadataCache）。发版前按 `docs/TESTING.md` 的冒烟清单在真机过一遍。

Manual deploy for verification: copy `main.js` + `manifest.json` + `styles.css` to `<vault>/.obsidian/plugins/yh-inklight/` and reload Obsidian.

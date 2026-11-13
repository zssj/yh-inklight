# yh-inklight — 墨光批注

Obsidian 非侵入式阅读批注插件，支持 Markdown / PDF / EPUB。

## Commands

```bash
npm run dev          # esbuild watch mode, outputs main.js
npm run build        # esbuild production bundle
npm run check        # tsc --noEmit + build 一条命令（改动收敛后跑一次，勿边改边反复构建）
npx tsc --noEmit     # 只做类型检查（build 本身不做类型检查）
npm run release-check [vX.Y.Z]   # 发版验收，见下方 Release Workflow
```

No lint, no test, no formatter config. CI only verifies `npm run build`.

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
- Three disjoint annotation coordinate systems: CM6 offset (MD), page+rect (PDF), CFI (EPUB).
- UI strings are Chinese (zh-CN). Comments and notices in Chinese.
- Module header convention: `[INPUT]` / `[OUTPUT]` / `[POS]` / `[PROTOCOL]` doc comments.
- `SUPPORTED_BOOK_EXTENSIONS` in types.ts lists all foliate-compatible formats registered as view handlers.
- Rename/move migration is debounced at 100ms (`main.ts:377`).

## Testing

No test framework. Manual testing: copy `main.js` + `manifest.json` + `styles.css` to `<vault>/.obsidian/plugins/yh-inklight/` and reload Obsidian.

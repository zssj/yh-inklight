# yh-inklight — 墨光批注

Obsidian 非侵入式阅读批注插件，支持 Markdown / PDF / EPUB。

## Commands

```bash
npm run dev       # esbuild watch mode, outputs main.js
npm run build     # esbuild production bundle
npx tsc --noEmit  # type check (separate from build)
```

No lint, no test, no formatter config. CI only verifies `npm run build`.

## Release Workflow (发版流程)

Version lives in 3 files — bump ALL of them in sync: `manifest.json`, `package.json`, `versions.json` (add `"X.Y.Z": "1.0.0"` entry).

Steps (run from repo root `E:\OB插件\yh-inklight-src`):

```bash
npx tsc --noEmit                  # 类型检查（build 不做类型检查，须单独跑）
npm run build                     # 重建 main.js（main.js 虽在 .gitignore，但历史上已被 git 跟踪，每次发版提交必须包含重建产物）
# 本地手动验证主路径，然后：
git add manifest.json package.json versions.json main.js src/<改动的源文件>   # 选择性 add，勿用 git add -A（工作区常有无关改动，如 README.md）
git commit -m "v0.17.XX: type: 中文描述"   # 历史格式: v开头版本号 + 中文提交说明；正文用「现象/原因/修复」三段
git push origin
git tag v0.17.XX                  # 轻量标签，带 v 前缀
git push origin v0.17.XX
```

- Tag MUST be lightweight and WITH `v` prefix（`v0.17.70`–`v0.17.74` 实际惯例）。历史备注：`0.17.20`–`0.17.69` 期间曾有一段不带 `v` 的 tag（如 `0.17.69`），但近期已回归 `v` 前缀，以 `v` 为准。
- After pushing the tag, GitHub Actions (`.github/workflows/release.yml`) auto-creates the GitHub Release with `main.js` + `manifest.json` + `styles.css` and auto-generated changelog. No web/`gh` CLI steps needed.
- Verify（`gh` CLI 未登录时用 GitHub API）:
  - Workflow run: `https://api.github.com/repos/zssj/yh-inklight/actions/runs?event=push&per_page=3` 看 status 变 success
  - Release: `https://api.github.com/repos/zssj/yh-inklight/releases/latest` 确认 3 个资产齐全，或浏览器打开 https://github.com/zssj/yh-inklight/releases/tag/v0.17.XX
- Deploy target for manual testing: `E:\知识库\.obsidian\plugins\yh-inklight\`.

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

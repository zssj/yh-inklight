# yh-inklight — 墨光批注

Obsidian 非侵入式阅读批注插件，支持 Markdown / PDF / EPUB。

## Commands

```bash
npm run dev       # esbuild watch mode, outputs main.js
npm run build     # esbuild production bundle
npx tsc --noEmit  # type check (separate from build)
```

No lint, no test, no formatter config. CI only verifies `npm run build`. Release via tagged push — GitHub Actions creates release with `main.js` + `manifest.json` + `styles.css`.

## Key Architecture

- **main.ts** — plugin entry, wires modules together. Exports `OverlayAnnotationsPlugin`.
- **src/storage/annotationStore.ts** — sole persistence layer. Annotations go to `<vault>/.obsidian-annotations/` sidecar JSON. Never touches original files.
- **src/storage/types.ts** — single source of truth for all annotation/settings types.
- **src/anchor/textAnchor.ts** — offset + context (prefix/suffix) anchor system with fuzzy matching fallback.
- **src/editor/** — CM6 highlight extension + reading view DOM highlight layer (separate paths).
- **src/pdf/** — PDF overlay highlights using page number + rect % coordinates.
- **src/epub/** — foliate-js based EPUB reader view, registered as `inklight-epub-reader`.
- **src/views/sidebarView.ts** — unified annotation sidebar (`yh-inklight-sidebar`), shared across all 3 formats.
- **Build output `main.js` is gitignored** — always rebuild before testing.

## Conventions

- Non-invasive first: all annotation data in sidecar, document zero-modification.
- Three disjoint annotation coordinate systems: CM6 offset (MD), page+rect (PDF), CFI (EPUB).
- UI strings are Chinese (zh-CN). Comments and notices in Chinese.
- Module header convention: `[INPUT]` / `[OUTPUT]` / `[POS]` / `[PROTOCOL]` doc comments.
- `SUPPORTED_BOOK_EXTENSIONS` in types.ts lists all foliate-compatible formats registered as view handlers.
- Rename/move migration is debounced at 100ms (`main.ts:377`).

## Testing

No test framework. Manual testing: copy `main.js` + `manifest.json` + `styles.css` to `<vault>/.obsidian/plugins/yh-inklight/` and reload Obsidian.

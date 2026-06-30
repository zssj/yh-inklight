# .github/
> L2 | 父级: /Users/epiphanyxiao/Documents/Playground/obsidian-annotation-plugin/AGENTS.md

成员清单
workflows/build.yml: GitHub Actions 三平台构建检查流水线，在 main push/PR 上验证 macOS、Windows、Linux 都能产出 main.js。
workflows/release.yml: GitHub Actions 发布流水线，按语义化版本 tag 构建并上传 Obsidian release assets。

法则: tag 等于 manifest 版本·release 附带 main.js/manifest.json/styles.css

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

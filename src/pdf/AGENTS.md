# pdf/
> L2 | 父级: /Users/epiphanyxiao/Documents/Playground/obsidian-annotation-plugin/src/AGENTS.md

成员清单
pdfAnnotationLayer.ts: PDF 注释控制器，捕获 PDF 文本选区、保存页内矩形锚点并渲染 overlay 高亮与右侧便签栏；点击高亮的详情浮层不自绘：用 views/cardModel 的 buildCards 取卡片（与侧栏同源），交给 views/annotationCard 外壳，内容由 views/cardBody 统一渲染；本文件只给回调，并把插件级动作（导出笔记/原子卡/关系）经 options.cardActions 由 main.ts 注入。
pdfViewerAdapter.ts: Obsidian 原生 PDF viewer 适配层，封装当前文件、当前页、页面跳转、pdf.js eventBus 与页面生命周期。

法则: PDF 坐标独立·文件不写入·矩形投影·DOM 适配保守

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

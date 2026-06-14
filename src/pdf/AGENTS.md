# pdf/
> L2 | 父级: /Users/epiphanyxiao/Documents/Playground/obsidian-annotation-plugin/src/AGENTS.md

成员清单
pdfAnnotationLayer.ts: PDF 注释控制器，捕获 PDF 文本选区、保存页内矩形锚点并渲染 overlay 高亮与右侧便签栏。
pdfViewerAdapter.ts: Obsidian 原生 PDF viewer 适配层，封装当前文件、当前页、页面跳转、pdf.js eventBus 与页面生命周期。

法则: PDF 坐标独立·文件不写入·矩形投影·DOM 适配保守

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

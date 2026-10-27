# src/
> L2 | 父级: /Users/epiphanyxiao/Documents/Playground/obsidian-annotation-plugin/AGENTS.md

成员清单
anchor/textAnchor.ts: 文本锚点生成与恢复，维护 offset、selectedText、prefix、suffix 与 isCode 的定位语义。
anchor/fuzzyMatch.ts: 模糊匹配恢复器，处理文件轻微改动后的锚点迁移。
editor/highlightColors.ts: 高亮背景色共享常量，CM6 编辑器层与 Reading 视图高亮层共用同一份 rgba 颜色。
editor/highlightExtension.ts: CodeMirror 6 高亮装饰层，使用 Decoration.mark 非侵入式绘制。
editor/readingViewHighlight.ts: Reading View DOM 高亮层，使用延迟渲染、MutationObserver 与 fuzzy matching 兼容移动端。
editor/selectionToolbar.ts: 选中文本后的浮动工具栏，提供颜色、便签、复制和总览入口。
pdf/pdfAnnotationLayer.ts: PDF 注释控制器，使用页码与矩形百分比坐标绘制非侵入式高亮和右侧便签栏。
pdf/pdfViewerAdapter.ts: Obsidian 原生 PDF viewer 适配层，封装当前页、跳转、pdf.js eventBus 与页面生命周期。
storage/types.ts: sidecar JSON、设置、锚点、高亮、便签、代码选区标记、索引的类型真相源。
storage/annotationStore.ts: .obsidian-annotations 持久化后端，读写文件 JSON 与全局 index。
views/annotationPopover.ts: 窄屏与阅读模式弹层，点击高亮后展示 sidecar 中的高亮和便签内容。
views/markdownStatsView.ts: Markdown 便签使用统计视图，列出全库 md 便签并支持跳转/定位/删除。
views/sidebarView.ts: 右侧总览面板，使用彩色卡片合并 highlight 与关联 note，并承载搜索、过滤、排序、导出、跳转与内联编辑。
views/stickyNoteLane.ts: 编辑/阅读模式的便签泳道，基于 positioning 布局算法渲染可编辑便签条，支持窄屏自适应。
views/stickyNoteView.ts: 兼容型便利贴卡片组件，保留 Markdown 渲染、折叠与编辑。
settings/settingsTab.ts: 插件设置页，管理默认颜色、便签栏、窄屏折叠、连接线、作者和迁移策略。
utils/format.ts: 通用格式化工具（时间等），供 sidebarView / stickyNoteView 等共用。
utils/positioning.ts: 便签避让布局纯函数，保留给后续便签栏实验复用。
ai/EpubAiClient.ts: OpenAI 兼容聊天客户端，用 requestUrl 绕过安卓 CORS，内置服务商/动作预设与中文错误映射；推理模型固定关闭 thinking。
epub/: 见 epub/AGENTS.md（19 个文件的完整清单与法则在该目录下维护）。

法则: 类型单一真相·业务不懂存储·渲染只做投影·UI 只做交互·总览优先于常驻叠层

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

# utils/
> L2 | 父级: /Users/epiphanyxiao/Documents/Playground/obsidian-annotation-plugin/src/AGENTS.md

成员清单
format.ts: 通用格式化工具（formatTime 等），供 sidebarView / stickyNoteView 等共用。
positioning.ts: 便签避让布局纯函数，保留给后续便签栏实验复用。
textTerms.ts: 字面抽词纯函数（中文 2-gram + ASCII 词 + 词频取前 N + 停用 gram 表）、termOverlap（Jaccard 与命中词）、短文本/代码选区过滤；无依赖、不联网、不做语义，供 views/relationModel 的标签推荐与相关批注共用。

法则: 算法纯粹·DOM 外置·布局可替换

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

# views/
> L2 | 父级: /Users/epiphanyxiao/Documents/Playground/obsidian-annotation-plugin/src/AGENTS.md

成员清单
annotationPopover.ts: 点击高亮后的弹层视图，在窄屏或阅读模式显示高亮原文与 Markdown 便签。
markdownStatsView.ts: Markdown 便签使用统计视图，列出全库 md 便签并支持跳转/定位/删除。
sidebarView.ts: 右侧 Leaf 总览面板，将 highlight 与关联 note 合并为同一卡片并支持搜索、筛选、排序、跳转、删除与导出。
stickyNoteLane.ts: 编辑/阅读模式的便签泳道，基于 positioning 布局算法渲染可编辑便签条，支持窄屏自适应。
stickyNoteView.ts: 兼容型便签卡片组件，保留 Markdown 渲染、折叠、删除、编辑动作。

法则: 视图轻量·操作回调外置·数据来自 store

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

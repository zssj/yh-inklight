# views/
> L2 | 父级: /Users/epiphanyxiao/Documents/Playground/obsidian-annotation-plugin/src/AGENTS.md

成员清单
annotationPopover.ts: 点击高亮后的弹层视图，在窄屏或阅读模式显示高亮原文与 Markdown 便签。
cardModel.ts: 卡片模型纯函数，把一份 sidecar 文档拍平成 SidebarCard（高亮挂笔记、孤儿笔记单独成卡、标签取并集），无 IO。
markdownStatsView.ts: 笔记使用统计视图，列出全库 md 笔记并支持跳转/删除；顶部提供 1 天复习（openCount==1）/ 7 天复习（openCount>=2）/ 上月今日 / 去年今日 四张卡片（各 Top 5，日差精确匹配，空卡隐藏）。
navigation.ts: 三端跳转单点（md 偏移 / pdf 页码 / epub CFI），侧栏与标签总览共用。
sidebarView.ts: 右侧 Leaf 总览面板，将 highlight 与关联 note 合并为同一卡片并支持搜索、标签筛选、排序、跳转、删除与导出；卡片标签行可原地编辑，编辑态存在视图字段 editingTagCardId（重绘不丢），仅由点卡片外或 Esc 显式关闭；标签编辑并入按内容推荐项，卡片底部折叠展示字面相关批注（带命中词、可跳转），受 contentRelations 设置控制；移动端编辑态用 utils/keyboardInset 补列表底部留白并把输入框滚入可视区，onClose 与 close() 都清理监听。
relationModel.ts: 字面关联派生层（与 cardModel 同层），按需内存快照随 store.version 失效；两遍构建（全量抽词统计文档频率 → rankTerms 按稀有度裁剪），getRelated 走 isRelatedOverlap 双通道判定 + 命中理由 + 近邻排除（含 EPUB 同章相邻），同文档降权只影响排序不做门槛；getRecommendedTags 基于「标签→词频」只推荐用过的标签且冷启动静默；不落盘、不写 sidecar、不升 index 版本。
tagBoardView.ts: 标签总览视图，按「标签 → 文档 → 批注」三栏主从跨文档聚合，窄屏降级为单栏 + 面包屑。
tagInput.ts: 标签 UI 组件，renderTagChips（只读 chip 行）与 renderTagInput（chip + 自定义补全下拉），三端共用；renderTagInput 返回 flush()/focus() 句柄，供弹窗点保存时兜住未回车的标签文本，并处理中文输入法组合态（compositionstart/end + isComposing + keyCode 229，拼音选词不提交、blur 不误提交）。补全候选为带来源的 TagSuggestion（当前文档 OB 标签置顶 / 已用 / OB 全库 / 概念页 / 按内容推荐），buildTagSuggestions 为纯函数；推荐项独立配额最多 3 个，不挤占常规 8 个候选；quickApply 支持一键沿用当前文档标签。
stickyNoteLane.ts: 编辑/阅读模式的便签泳道，基于 positioning 布局算法渲染可编辑便签条，支持窄屏自适应。
stickyNoteView.ts: 兼容型便签卡片组件，保留 Markdown 渲染、折叠、删除、编辑动作。

法则: 视图轻量·操作回调外置·数据来自 store

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

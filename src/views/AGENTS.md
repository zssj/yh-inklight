# views/
> L2 | 父级: /Users/epiphanyxiao/Documents/Playground/obsidian-annotation-plugin/src/AGENTS.md

成员清单
annotationCard.ts: 标注详情浮层，md/pdf/epub 三端共用（点击高亮弹出）：类型徽章 + 颜色 + 原文 + 笔记 + 标签行 + 元信息 + 编辑/添加笔记/添加标签/删除，移动端为底部卡片并跟随软键盘；样式类名沿用 .yh-epub-*（历史命名，改名会破坏用户自定义 CSS）；导出 annotationBadge / formatAnnotationTime 供三端统一文案。
popoverPlacement.ts: 浮层定位纯函数（无 DOM），输入划线矩形 + 浮层实测尺寸 + 可用区域，输出 left/top/width/maxHeight/side；四侧都放不下时压缩 maxHeight 由卡片内部滚动，绝不压到选区上；三端共用。
cardModel.ts: 卡片模型纯函数，把一份 sidecar 文档拍平成 SidebarCard（高亮挂笔记、孤儿笔记单独成卡、标签取并集），无 IO。
markdownStatsView.ts: 笔记使用统计视图，列出全库 md 笔记并支持跳转/删除；顶部提供 1 天复习（openCount==1）/ 7 天复习（openCount>=2）/ 上月今日 / 去年今日 四张卡片（各 Top 5，日差精确匹配，空卡隐藏）。
navigation.ts: 三端跳转单点（md 偏移 / pdf 页码 / epub CFI），侧栏与标签总览共用；epub 分支先复用已打开该书的 leaf（view.file 或 viewState.state.file 匹配，含 deferred），避免重复 openFile 二次触发 onLoadFile 造成进度恢复与批注跳转互相覆盖；视图类型常量在本文件内定义，**不要 import EpubReaderView**（会让 esbuild 模块图整体重排，main.js diff 从几百行涨到八千行）。
sidebarView.ts: 右侧 Leaf 总览面板，将 highlight 与关联 note 合并为同一卡片并支持搜索、标签筛选、排序、跳转、删除与导出；顶部搜索/范围（当前文件·全库）/颜色/类型/排序/标签/导出统一收进单一折叠菜单（默认收起，展开态存视图字段 menuOpen，跨重绘保留；开合以 panel.hidden 为唯一硬状态、class 仅作样式，经视图根节点的 click 委托 + menuPanel/menuButton 直连引用切换，不再 querySelector 查找，故按钮被重绘重建或点击相位变化都不会丢收起动作；收起态不占列表高度），有生效筛选时菜单按钮点亮小圆点；卡片标签行可原地编辑，编辑态存在视图字段 editingTagCardId（重绘不丢），仅由点卡片外或 Esc 显式关闭；标签编辑并入按内容推荐项，卡片底部折叠展示字面相关批注（带命中词、可跳转），受 contentRelations 设置控制；相关行可「确认关联」：行内选择条（候选第一位=命中最长短语，其后已用标签，支持自定义，IME 守卫）把一个共享标签经 store.setTags 写入两侧批注（活读最新 tags 取并集再覆盖，绝不静默写入），已确认的关联显示「已关联 xx」chip，点 chip 从两侧移除该标签断开；确认结果落在 tags 字段（无 schema 变更），随标签总览/筛选/obTagBridge 全链路生效；两侧源文件缺失时关联按钮禁用；相关区 details 展开态存视图字段 openRelated，确认后的重绘不折回；移动端编辑态用 utils/keyboardInset 补列表底部留白并把输入框滚入可视区，onClose 与 close() 都清理监听；编辑态期间 requestRender / refreshList 只置 pendingRender 不重绘（退出后补一次），重绘重建仅在用户主动点 + 时聚焦（tagEditorAutoFocus），未提交输入经 pendingTagQuery 回填。
relationModel.ts: 字面关联派生层（与 cardModel 同层），按需内存快照随 store.version 失效；相关批注走短语级匹配（utils/textPhrases）：4 字种子倒排找候选对 → 逐对扩展出最长公共短语 → 按「短语出现在几个源文档里」做文档级稀有度过滤（超过 3 个文档视为通用说法丢弃）→ 同文档只要短语够长够罕见即算相关，跨文档另加术语特征门槛（5 字以上直接放行；4 字短语须含罕见字或术语后缀，且不能是数量词/否定词开头），命中理由取最具体的短语，近邻排除沿用旧规则（md 偏移差<150 / pdf 同页 / epub 同章相邻），同文档降权只影响排序不做门槛；getRecommendedTags 仍基于 textTerms 的「标签→词频」，只推荐用过的标签且冷启动静默；不落盘、不写 sidecar、不升 index 版本。
tagBoardView.ts: 标签总览视图，按「标签 → 文档 → 批注」三栏主从跨文档聚合，窄屏降级为单栏 + 面包屑。
tagInput.ts: 标签 UI 组件，renderTagChips（只读 chip 行）与 renderTagInput（chip + 自定义补全下拉），三端共用；renderTagInput 返回 flush()/focus() 句柄，供弹窗点保存时兜住未回车的标签文本，并处理中文输入法组合态（compositionstart/end + isComposing + keyCode 229，拼音选词不提交、blur 不误提交）。补全候选为带来源的 TagSuggestion（当前文档 OB 标签置顶 / 已用 / OB 全库 / 概念页 / 按内容推荐），buildTagSuggestions 为纯函数；推荐项独立配额最多 3 个，不挤占常规 8 个候选；quickApply 支持一键沿用当前文档标签；`showSuggestionsOnOpen`（侧栏传 true）让空内容打开即显示候选并在 focus 时兜底重绘，弹窗不传、维持输入后才弹；`initialQuery` / `onQueryChange` 供侧栏重绘后回填未提交文本；空内容折叠为「推荐 3 + 常用 5」（已用标签按使用文件数降序，不再按字典序），其余收进可展开的「还有 N 个候选」，有输入时不做折叠。
stickyNoteLane.ts: 编辑/阅读模式的便签泳道，基于 positioning 布局算法渲染可编辑便签条，支持窄屏自适应。
stickyNoteView.ts: 兼容型便签卡片组件，保留 Markdown 渲染、折叠、删除、编辑动作。

法则: 视图轻量·操作回调外置·数据来自 store

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

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
storage/annotationStore.ts: .obsidian-annotations 持久化后端，读写文件 JSON 与全局 index，维护标签索引与标签字典。
storage/tags.ts: 标签归一化纯函数（去 #、折叠空白、剥离非法字符、大小写无关去重、并集）与 OB 标签语法转换 toObsidianTag/toObsidianTags，无 IO。
views/annotationPopover.ts: 窄屏与阅读模式弹层，点击高亮后展示 sidecar 中的高亮和便签内容。
views/cardModel.ts: 卡片模型纯函数，把 sidecar 文档拍平成 SidebarCard（高亮挂笔记、孤儿笔记独立成卡、标签取并集）。
views/markdownStatsView.ts: 笔记使用统计视图，列出全库 md 笔记并支持跳转/删除；顶部提供 1 天复习（openCount==1）/ 7 天复习（openCount>=2）/ 上月今日 / 去年今日 四张卡片，日差精确匹配、各 Top 5。
views/navigation.ts: 三端跳转单点（md 偏移 / pdf 页码 / epub CFI），侧栏与标签总览共用。
views/sidebarView.ts: 右侧总览面板，使用彩色卡片合并 highlight 与关联 note，并承载搜索、标签筛选、过滤、排序、导出、跳转与内联编辑；移动端标签编辑态处理软键盘遮挡，不改阅读区。
views/tagBoardView.ts: 标签总览视图，按「标签 → 文档 → 批注」三栏主从跨文档聚合批注，窄屏降级为单栏 + 面包屑。
views/tagInput.ts: 标签 UI 组件（只读 chip 行 + chip 编辑器与补全下拉），侧栏、标签总览与两个弹窗共用；候选为 TagSuggestion[]（可含 OB 标签与按内容推荐项，推荐独立配额最多 3 个），支持 quickApply 一键沿用当前文档标签与 showSuggestionsOnOpen（侧栏空内容即显示候选）；处理中文输入法组合态，拼音选词不会误建标签。
views/relationModel.ts: 字面关联派生层（与 cardModel 同层），按需内存快照随 store.version 失效；两遍构建（全量抽词统计文档频率 → 按稀有度裁剪），提供 getRelated（稀有连续片段双通道判定 + 命中理由 + 近邻排除含 EPUB、同文档只降序不设门槛）与 getRecommendedTags（标签→词频、冷启动静默、只推荐用过的标签）；不落盘、不写 sidecar、不升 index 版本。
views/stickyNoteLane.ts: 编辑/阅读模式的便签泳道，基于 positioning 布局算法渲染可编辑便签条，支持窄屏自适应。
views/stickyNoteView.ts: 兼容型便利贴卡片组件，保留 Markdown 渲染、折叠与编辑。
settings/settingsTab.ts: 插件设置页，管理默认颜色、便签栏、窄屏折叠、连接线、作者、迁移策略、Markdown 统计与「与 Obsidian 标签互通」开关（默认关）。
utils/format.ts: 通用格式化工具（时间等），供 sidebarView / stickyNoteView 等共用。
utils/textTerms.ts: 字面抽词与判定纯函数（中文 2/3-gram + ASCII 词 + 停用 gram 表 + EPUB 文本清洗）、rankTerms（按全库文档频率挑稀有词）、termOverlap（共享词与覆盖率）、isRelatedOverlap（稀有连续片段双通道判定）、短文本/代码选区过滤；无依赖、不联网、不做语义。
utils/keyboardInset.ts: 软键盘可见区域探测（visualViewport + virtualKeyboard + focusin 重测，带 isAlive 自动卸载），只回调遮挡高度、不碰 DOM。
utils/positioning.ts: 便签避让布局纯函数，保留给后续便签栏实验复用。
ai/EpubAiClient.ts: OpenAI 兼容聊天客户端，用 requestUrl 绕过安卓 CORS，内置服务商/动作预设与中文错误映射；推理模型固定关闭 thinking。
epub/: 见 epub/AGENTS.md（19 个文件的完整清单与法则在该目录下维护）。

法则: 类型单一真相·业务不懂存储·渲染只做投影·UI 只做交互·总览优先于常驻叠层

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

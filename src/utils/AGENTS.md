# utils/
> L2 | 父级: /Users/epiphanyxiao/Documents/Playground/obsidian-annotation-plugin/src/AGENTS.md

成员清单
format.ts: 通用格式化工具（formatTime 等），供 sidebarView / stickyNoteView 等共用。
positioning.ts: 便签避让布局纯函数，保留给后续便签栏实验复用。
textTerms.ts: 字面抽词与判定纯函数（中文 2/3-gram + ASCII 词 + 停用 gram 表 + EPUB 文本清洗）、rankTerms（按全库文档频率挑稀有词）、termOverlap（共享词与覆盖率）、isRelatedOverlap（稀有连续片段双通道判定）、短文本/代码选区过滤；无依赖、不联网、不做语义，供 views/relationModel 共用。
keyboardInset.ts: 软键盘可见区域探测（visualViewport + virtualKeyboard + focusin 重测，带 isAlive 自动卸载），只回调被遮挡高度、不碰 DOM；供侧栏原地标签输入复用。

法则: 算法纯粹·DOM 外置·布局可替换

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

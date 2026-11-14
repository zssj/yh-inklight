# utils/
> L2 | 父级: /Users/epiphanyxiao/Documents/Playground/obsidian-annotation-plugin/src/AGENTS.md

成员清单
format.ts: 通用格式化工具（formatTime 等），供 sidebarView / stickyNoteView 等共用。
positioning.ts: 便签避让布局纯函数，保留给后续便签栏实验复用。
textTerms.ts: 字面抽词纯函数（中文 2/3-gram + ASCII 词 + 停用 gram 表 + EPUB 文本清洗）、rankTerms（按全库文档频率挑稀有词）、termOverlap、isRelatedOverlap、短文本/代码选区过滤；无依赖、不联网、不做语义；现仅供 views/relationModel 的标签推荐（getRecommendedTags）使用，相关批注匹配已改走 textPhrases 的短语级算法。
textPhrases.ts: 短语级匹配纯函数（相关批注的唯一判定基础）：cleanText（去 Markdown/wiki/HTML 装饰、剥实体、截 600 字、非字母数字汉字换空格）、splitSegments（中文按功能字切词段、拉丁按空白合并成多词段）、expandPhrase（从共同种子向两侧扩展成最长公共短语）、trimPhrase（修剪首尾虚词残段）、isNoisePhrase（套话/元话语/代词/纯通用字/拉丁常见词过滤）、hasTermSuffix（术语后缀判定）、startsWithWeakToken（数量词或否定词开头判定）、phraseSpecificity、短文本/代码选区过滤；不引分词库、不联网、不做语义。
keyboardInset.ts: 软键盘可见区域探测（visualViewport + virtualKeyboard + focusin 重测，带 isAlive 自动卸载），只回调被遮挡高度、不碰 DOM；供侧栏原地标签输入复用。

法则: 算法纯粹·DOM 外置·布局可替换

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

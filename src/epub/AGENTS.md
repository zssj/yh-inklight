# epub/
> L2 | 父级: ../AGENTS.md

成员清单
EpubReaderView.ts: EPUB 阅读器主视图（ItemView，注册为 inklight-epub-reader），编排 foliate-view 生命周期、工具栏、侧栏、进度/阅读时长、选区菜单、标注卡片、AI 入口、书签、点击/滑动翻页、手机端沉浸式导航栏；文件顶部含 CFI 跳转统一入口常量。只打标签不写想法时保持划线形态（updateEpubHighlight），不生成 note 为空的 comment。进度保存（saveCurrentProgress，relocate 后 2s 防抖）只写 sidecar，**不得调 refreshAnnotations**：位置/时长未变时直接跳过写盘，否则移动端会形成「每 2 秒全量重绘侧栏 + 输入法自动弹起」的自激循环。外部批注跳转统一走 navigateToCfi：书未完成 open + 进度恢复时用 pendingCfi 暂存（bookReady 后执行），防止 goTo 被 restoreProgress 覆盖；就绪后 performAnnotationJump 执行 goTo 并显式重绘高亮层（立即 + 160ms 补绘），补上「foliate addAnnotation 只作用于已渲染 section」导致的跨章节标注丢失，且不恢复周期性全量刷新。内嵌侧栏 navigateToAnnotation 复用同一入口。历史 CFI 因书换版而指向错误章节时，goTo 后用批注原文归一化前缀校验落点，未命中则遍历 book.sections 的 createDocument、构造 Range 并交给 getCFI 生成修正 CFI，存 cfiOverrides（annotationId → 新 CFI，仅内存、不写 sidecar）；高亮绘制与详情卡片回查都走该覆盖表。
EpubFoliateLoader.ts: foliate-js 加载器，从 npm 包构造 foliate-view、从二进制打开书籍，并安装自定义元素与 iframe patch。
EpubFoliateGuard.ts: customElements 注册守卫，防止 foliate 自定义元素与其他插件（obsidian-weave-reader）重复注册冲突。
EpubFoliatePatches.ts: foliate iframe 运行时 patch，覆盖 sandbox 检测、选区与内部行为以适配 Obsidian 移动端。
EpubBookshelfView.ts: 书架视图（ItemView），扫描 vault 内电子书文件，按书名搜索过滤并打开到阅读器。
EpubTocView.ts: 目录侧栏，构建 TOC 树、随阅读位置高亮当前章节、点击跳转 CFI。
EpubChapterResolver.ts: TOC/spine 章节解析，把 TOC 链接解析为 spine index，规范化 CFI 与进度百分比（0–1）。
EpubProgressManager.ts: 死代码——全仓无引用，勿改动勿依赖（进度恢复逻辑已在 EpubReaderView 内实现）。
EpubAnnotationCard.ts: 点击高亮弹出的标注详情浮层；按选区外接矩形四侧择优定位（避开划线、工具栏、屏幕边界与安全区），展示原文/想法/标签，提供「添加笔记或编辑 + 添加标签 + 删除」，标签内联编辑态存类字段（savedTags/draftTags/tagEditing），提交走 onTagsChange。移动端为底部卡片，bottom 由 visualViewport 键盘 inset + `.mobile-navbar/.mobile-toolbar` 实测占用高度共同决定（隐藏态滑出屏外则计 0），不得只扣键盘 inset，否则按钮与 Obsidian 底部导航栏重合。
EpubPopoverPlacement.ts: 纯函数定位器，输入选区矩形 + 浮层实测尺寸 + 可用区域，输出 left/top/width/maxHeight/side；四侧都放不下时压缩 maxHeight 由卡片内部滚动，绝不压到选区上。
EpubNoteModal.ts: 便签/想法输入弹窗，移动端用 visualViewport 定位避开键盘；提交前 flush 标签输入框里未回车的文本；补全候选为 TagSuggestion[]（带来源）。
EpubAiModal.ts: AI 解释/翻译/改写弹窗，内置动作预设与自定义提问，回复可存为便签。
EpubImageViewer.ts: EPUB 内图片全屏放大查看器，点击放大、再点/Esc 关闭。
EpubGotoHandler.ts: 导出批注 Markdown 的回链处理器，点击「回到原文」callout 链接跳回 EPUB 对应 CFI。
EpubStylesheetInliner.ts: 书籍 CSS 内联器，把 epub 内嵌样式表注入 iframe 保证渲染一致。
EpubThemeManager.ts: 主题管理，6 种阅读主题与系统深浅色跟随，通过 --theme-bg-color 等 foliate 官方钩子应用。
EpubFontCatalog.ts: 本机可用字体探测与目录管理，中英/新旧 family 名变体匹配，手填字体校验后实时预览。
polyfills.ts: 移动端 polyfill 集合，弥补安卓 WebView 与 foliate-js 的能力差异。
foliate-js.d.ts: foliate-js 类型声明（npm 包无官方类型）。
EpubFoliateLoader.ts.bak / EpubReaderView.ts.bak2: 历史备份文件（*.bak2 未被 .gitignore 匹配但已被跟踪），仅供对照，勿引用。

法则
·foliate 全局唯一: <foliate-view>/<foliate-paginator> 等自定义元素全库只允许注册一次，任何新 foliate 相关功能必须先过 EpubFoliateGuard。
·CFI 是唯一坐标: EPUB 批注/书签/进度一律用 CFI（或 spine+百分比），禁止用 DOM 路径。
·沉浸式导航栏（隐藏 Obsidian .mobile-navbar）由滚动方向迟滞累加器驱动: 上滑净累计 ≥30px 显示、下滑净累计 ≥45px 隐藏（NAV_SHOW/HIDE_SCROLL_THRESHOLD），方向反转立即清零反向累计——这是消除"回滑时导航栏闪现又消失"的关键，勿改回单向判定；200ms 事件门限防翻页回弹闪烁；恢复进度等程序化滚动后必须调用 baselineReaderScroll 基线化；视图卸载必须 setNavHidden(false) 恢复全局 body 类。
·不可改 .yh-epub-reader 的 padding: 会改变阅读区高度触发 foliate ResizeObserver 重新分页，导致阅读位置错乱/进度不准。
·标注卡片定位禁止用估算高度与单点 anchor: 必须用选区全部行矩形的并集（createSelectionAvoidRect）+ 浮层实测尺寸，可用区域取「视口 ∩ 阅读区 − --yh-safe-* 安全区」。卡片标签按 annotationId 走 store.setTags 关联并重建 index.json 的 tags/tagNames，只调 refreshAnnotations 同步全局侧栏，卡片内不得再主动触发 refreshRenditionAnnotations（标签不影响 foliate 绘制）。浮层类名固定 .yh-epub-annotation-popover，勿复用历史同名 .yh-epub-annotation-card 规则。
·翻页竞态: 点击翻页需吞掉 foliate snap 的双重翻页与动画竞态（v0.17.72 修复），改动翻页逻辑后必须真机回归。
·foliate 版本升级: 升级 foliate-js 前先确认 EpubFoliatePatches 与 Guard 的补丁点未失效。

[PROTOCOL]: 变更时更新此头部，然后检查 ../AGENTS.md

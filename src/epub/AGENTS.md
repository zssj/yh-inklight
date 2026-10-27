# epub/
> L2 | 父级: ../AGENTS.md

成员清单
EpubReaderView.ts: EPUB 阅读器主视图（ItemView，注册为 inklight-epub-reader），编排 foliate-view 生命周期、工具栏、侧栏、进度/阅读时长、选区菜单、标注卡片、AI 入口、书签、点击/滑动翻页、手机端沉浸式导航栏；文件顶部含 CFI 跳转统一入口常量。
EpubFoliateLoader.ts: foliate-js 加载器，从 npm 包构造 foliate-view、从二进制打开书籍，并安装自定义元素与 iframe patch。
EpubFoliateGuard.ts: customElements 注册守卫，防止 foliate 自定义元素与其他插件（obsidian-weave-reader）重复注册冲突。
EpubFoliatePatches.ts: foliate iframe 运行时 patch，覆盖 sandbox 检测、选区与内部行为以适配 Obsidian 移动端。
EpubBookshelfView.ts: 书架视图（ItemView），扫描 vault 内电子书文件，按书名搜索过滤并打开到阅读器。
EpubTocView.ts: 目录侧栏，构建 TOC 树、随阅读位置高亮当前章节、点击跳转 CFI。
EpubChapterResolver.ts: TOC/spine 章节解析，把 TOC 链接解析为 spine index，规范化 CFI 与进度百分比（0–1）。
EpubProgressManager.ts: 死代码——全仓无引用，勿改动勿依赖（进度恢复逻辑已在 EpubReaderView 内实现）。
EpubAnnotationCard.ts: 点击高亮/便签后弹出的标注卡片，展示原文、想法与删除动作。
EpubNoteModal.ts: 便签/想法输入弹窗，移动端用 visualViewport 定位避开键盘。
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
·翻页竞态: 点击翻页需吞掉 foliate snap 的双重翻页与动画竞态（v0.17.72 修复），改动翻页逻辑后必须真机回归。
·foliate 版本升级: 升级 foliate-js 前先确认 EpubFoliatePatches 与 Guard 的补丁点未失效。

[PROTOCOL]: 变更时更新此头部，然后检查 ../AGENTS.md

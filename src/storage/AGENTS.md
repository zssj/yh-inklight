# storage/
> L2 | 父级: /Users/epiphanyxiao/Documents/Playground/obsidian-annotation-plugin/src/AGENTS.md

成员清单
types.ts: sidecar JSON、注释、便签、代码选区标记、设置（含 contentRelations 字面关联开关）、索引的类型真相源。
annotationStore.ts: .obsidian-annotations 持久化入口，负责文件 JSON、index、标签字典、导出与迁移；导出笔记可选写入 OB 可索引的 frontmatter tags 与正文 #标签（受控标记保护用户 frontmatter）；正文按批注块增量合并——每块用 HTML 注释边界包住，重复导出只替换同 id 块，块外用户手写内容原样保留，老格式回退 callout+block-id 推断；回链统一走 `obsidian://inklight?file=&mode=&offset=|page=|cfi=&text=` 协议链接（生成见 sourceLink.buildSourceLinkUrl，解析见 main.openSourceLink；**不能**用 `#^<blockId>` 自引用锚点：它指向导出笔记自身，只靠 EpubGotoHandler 劫持才生效，MOC 页不在其路径白名单里就会点击无反应；也**不能**用 `[[源文件]]` 或 `[[源文件#page=N]]`：前者只能落到文件头，后者赌 Obsidian 私有锚点语法）；按标签导出 MOC 页 exportTagMoc——目标固定 vault 根 MOC/<标签>.md（文件夹无则新建），文件名由 tagKey 派生、标题固定为标签显示名（签名稳定，靠 `# <标签>` 行识别墨光生成页，非墨光生成的同名页拒绝覆盖返回 skipped-foreign）。
sourceLink.ts: 回链契约纯函数（buildSourceLinkUrl / parseSourceLinkParams / refineOffset / encodeLinkValue），导出层与协议解析端共用同一套编码规则，无 IO。协议值须额外转义 `( ) ! ' *`——encodeURIComponent 不转义它们，而 CFI 与含括号书名会让 Markdown 链接在第一个 `)` 处截断；refineOffset 用链接携带的原文片段给 drift 过的 startOffset 做就近校正，片段不足 4 字或找不到时保守返回原偏移。
结构化导出字段: 每条批注在 callout 之外、受控块之内追加 `noteType:: insight` 与关系行。关系目标三级落点：同文件 → `[[#^块id]]`；跨文件且目标已有导出笔记（索引 derivedNotePath）→ `[[目标导出笔记#^块id]]`（Graph 才有边）；其余 → `obsidian://inklight?...` 协议链接，靠关系自带的锚点快照（targetOffset/targetPage/targetCfi/targetQuote）定位。老关系没有锚点快照时退回纯文本 `"路径#id"`，宁可不点也不生成假链接。章节**不要**写成 inline field（callout 标题里已有）；块外手写内容不受影响。关系只存有向引用，对方被删不会级联失效。
反查指针（index v3）: 索引条目带 derivedNotePath / blockIds / mocPaths / exportedAt / atomCards，导出后由 recordExportTargets 回写，**只写索引不写 sidecar**；saveDocument 必须经 pickExportFields 把这些字段带到新条目，否则改一条批注就丢一次指针。findOrphanBlocks 用「当前批注」而非索引里的 blockIds 比对（删批注时指针会保留旧值，拿它比永远看不到孤儿块）。createAtomCard 只生成派生 md、不改 sidecar，靠 atomCards 去重；卡片删了指针仍在，再点会重新生成。
tags.ts: 标签归一化纯函数（去 #、折叠空白、剥离非法字符、大小写无关去重、并集）与 toObsidianTag/toObsidianTags（空格转连字符、剔 OB 非法字符、纯数字加前缀、保留 / 嵌套），无 IO。

法则: Markdown 只读·sidecar 持久·缓存加速·索引导航

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

# storage/
> L2 | 父级: /Users/epiphanyxiao/Documents/Playground/obsidian-annotation-plugin/src/AGENTS.md

成员清单
types.ts: sidecar JSON、注释、便签、代码选区标记、设置（含 contentRelations 字面关联开关）、索引的类型真相源。
annotationStore.ts: .obsidian-annotations 持久化入口，负责文件 JSON、index、标签字典、导出与迁移；导出笔记可选写入 OB 可索引的 frontmatter tags 与正文 #标签（受控标记保护用户 frontmatter）；正文按批注块增量合并——每块用 HTML 注释边界包住，重复导出只替换同 id 块，块外用户手写内容原样保留，老格式回退 callout+block-id 推断；回链按来源分三套：md 用 `[[源文件]]`、pdf 用 `[[源文件#page=N]]`、epub 用 `obsidian://inklight-epub?file=&cfi=` 协议链接（**不能**用 `#^<blockId>` 自引用锚点：它指向导出笔记自身，只靠 EpubGotoHandler 劫持才生效，MOC 页不在其路径白名单里就会点击无反应；协议值须经 encodeLinkValue 额外转义 `( ) ! ' *`，否则 CFI 与含括号的书名会让 Markdown 链接在第一个 `)` 处截断）；按标签导出 MOC 页 exportTagMoc——目标固定 vault 根 MOC/<标签>.md（文件夹无则新建），文件名由 tagKey 派生、标题固定为标签显示名（签名稳定，靠 `# <标签>` 行识别墨光生成页，非墨光生成的同名页拒绝覆盖返回 skipped-foreign）。
tags.ts: 标签归一化纯函数（去 #、折叠空白、剥离非法字符、大小写无关去重、并集）与 toObsidianTag/toObsidianTags（空格转连字符、剔 OB 非法字符、纯数字加前缀、保留 / 嵌套），无 IO。

法则: Markdown 只读·sidecar 持久·缓存加速·索引导航

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

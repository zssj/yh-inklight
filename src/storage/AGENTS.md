# storage/
> L2 | 父级: /Users/epiphanyxiao/Documents/Playground/obsidian-annotation-plugin/src/AGENTS.md

成员清单
types.ts: sidecar JSON、注释、便签、代码选区标记、设置（含 contentRelations 字面关联开关）、索引的类型真相源。
annotationStore.ts: .obsidian-annotations 持久化入口，负责文件 JSON、index、标签字典、导出与迁移；导出笔记可选写入 OB 可索引的 frontmatter tags 与正文 #标签（受控块保护用户 frontmatter）。
tags.ts: 标签归一化纯函数（去 #、折叠空白、剥离非法字符、大小写无关去重、并集）与 toObsidianTag/toObsidianTags（空格转连字符、剔 OB 非法字符、纯数字加前缀、保留 / 嵌套），无 IO。

法则: Markdown 只读·sidecar 持久·缓存加速·索引导航

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

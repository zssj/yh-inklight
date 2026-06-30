# anchor/
> L2 | 父级: /Users/epiphanyxiao/Documents/Playground/obsidian-annotation-plugin/src/AGENTS.md

成员清单
textAnchor.ts: 文本锚点核心，生成 offset+quote+context 并恢复轻微漂移后的定位。
fuzzyMatch.ts: 模糊匹配工具，使用近邻窗口与编辑距离恢复失效锚点。

法则: offset 优先·quote 兜底·context 判别·失败显式 orphaned

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

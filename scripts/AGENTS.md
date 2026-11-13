# scripts/
> L2 | 父级: /Users/epiphanyxiao/Documents/Playground/obsidian-annotation-plugin/AGENTS.md

成员清单
install.sh: 一条命令安装器，从 GitHub release 下载 main.js、manifest.json、styles.css 到指定 Obsidian vault。
release-check.mjs: 发版验收，一条命令校验 HEAD/origin/tag 三引用一致、两个 workflow 均 success、Release 三资产 uploaded 且大小与本地产物一致（按 LF 归一化，忽略 CRLF 差异），输出 4 行结论并以退出码表示结果。

法则: 安装脚本只搬运 release 产物·不修改 vault 内容·失败信息必须可执行
法则: 验收脚本只读不写·找不到运行记录 90 秒即失败退出·不空转到超时

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

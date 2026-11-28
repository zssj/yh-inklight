/**
 * [ROLE] 诊断日志双写工具（临时，问题定位后整体回收）
 * [INPUT] setDiagSink 注入的写入函数（main.ts 里接 vault.adapter.append，桌面/移动通吃，写库内相对路径）
 * [OUTPUT] console.log + 文件双写；文件通道让 agent 能自行读取真机/桌面复现日志
 * [POS] utils 纯工具层；不依赖 obsidian 类型与 node fs（manifest.dir 是相对路径，fs join 会解析到进程 CWD 导致 ENOENT，已弃用）
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

let sink: ((line: string) => void) | null = null;
let seq = 0;

/** 在插件 onload 时调用一次；传 null 关闭文件通道 */
export function setDiagSink(writer: ((line: string) => void) | null): void {
  sink = writer;
}

function fmt(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** console.log + 文件双写；文件通道任何失败都由注入方决定如何上报，诊断不能拖垮功能 */
export function diagLog(message: string, detail?: unknown): void {
  seq += 1;
  const ts = new Date().toISOString().slice(11, 23);
  const line = `${ts} #${seq} ${message}${detail !== undefined ? ` ${fmt(detail)}` : ""}`;
  // eslint-disable-next-line no-console
  console.log(line);
  if (!sink) {
    return;
  }
  try {
    sink(line);
  } catch {
    /* 忽略：文件通道不可用时不影响功能 */
  }
}

/** 带 Error 堆栈的诊断（调用方如 ver bump 需要抓是谁在搅动） */
export function diagLogStack(message: string): void {
  const stack = new Error("diag").stack ?? "";
  diagLog(message, stack.split("\n").slice(2, 8).join(" | "));
}

/**
 * [INPUT]: 依赖浏览器 window.visualViewport / navigator.virtualKeyboard，无 Obsidian 依赖
 * [OUTPUT]: 对外提供 observeKeyboardInset(onChange, isAlive)，回调软键盘（含中文候选栏）占据的底部高度，返回清理函数
 * [POS]: utils 模块的键盘可见区域探测单点，供侧栏标签编辑等原地输入场景复用；
 *        只测量并回调，不修改任何 DOM，调用方自行决定加 padding / 滚动
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

interface VirtualKeyboardLike {
  boundingRect?: { height: number };
  addEventListener?: (type: "geometrychange", listener: () => void) => void;
  removeEventListener?: (type: "geometrychange", listener: () => void) => void;
}

/** 小于这个高度的视口差当作浏览器 UI 抖动，不是软键盘 */
const MIN_INSET_PX = 60;
/** 键盘弹出有动画，focusin 后分两次重测兜底事件漏发 */
const FOCUS_REMEASURE_DELAYS = [120, 450];

/**
 * 测量底部被遮挡的高度。优先用 visualViewport 与布局视口的差值，
 * 安卓部分输入法不改 visualViewport 时用 virtualKeyboard.boundingRect 兜底。
 * isAlive 返回 false 时自动卸载全部监听，避免节点被重绘删除后留下孤儿监听。
 */
export function observeKeyboardInset(
  onChange: (inset: number) => void,
  isAlive: () => boolean = () => true,
): () => void {
  const vv = window.visualViewport;
  const vk = (navigator as unknown as { virtualKeyboard?: VirtualKeyboardLike }).virtualKeyboard;
  let lastInset = -1;
  let stopped = false;
  const timers: number[] = [];

  function cleanup(): void {
    if (stopped) {
      return;
    }
    stopped = true;
    vk?.removeEventListener?.("geometrychange", measure);
    vv?.removeEventListener("resize", measure);
    vv?.removeEventListener("scroll", measure);
    window.removeEventListener("resize", measure);
    document.removeEventListener("focusin", onFocus);
    for (const timer of timers) {
      window.clearTimeout(timer);
    }
  }

  function measure(): void {
    if (stopped) {
      return;
    }
    if (!isAlive()) {
      cleanup();
      return;
    }
    const innerH = window.innerHeight;
    const vvH = vv?.height ?? innerH;
    const vvInset = Math.max(0, innerH - vvH - (vv?.offsetTop ?? 0));
    const vkInset = vk?.boundingRect?.height ?? 0;
    const inset = Math.max(vvInset, vkInset) > MIN_INSET_PX
      ? Math.round(Math.max(vvInset, vkInset))
      : 0;
    if (inset === lastInset) {
      return;
    }
    lastInset = inset;
    onChange(inset);
  }

  function onFocus(): void {
    for (const delay of FOCUS_REMEASURE_DELAYS) {
      timers.push(window.setTimeout(measure, delay));
    }
  }

  vk?.addEventListener?.("geometrychange", measure);
  vv?.addEventListener("resize", measure);
  vv?.addEventListener("scroll", measure);
  window.addEventListener("resize", measure);
  document.addEventListener("focusin", onFocus);
  measure();

  return cleanup;
}

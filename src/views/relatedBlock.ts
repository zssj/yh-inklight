/**
 * [INPUT]: cardModel 的 SidebarCard、storage/tags 的标签键比较、storage/types 的关系类型
 * [OUTPUT]: renderRelatedBlock —— 卡片底部「相关的 N 条」折叠区与「确认关联」行内选择条；
 *           RelatedBlockHost —— 宿主注入的命中来源与写入回调
 * [POS]: views 模块相关区的 DOM 单点，侧栏列表与点击高亮浮层共用。
 *        命中计算来自 RelationModel（宿主负责 prepare），落库（共享标签 + 有向关系）也由宿主回调，
 *        本文件不做任何 IO，也不自己发明标签。
 *        明细行按需生成：收起态只留「相关的 N 条」摘要，首次展开才铺行，避免全库列表预先建满相关 DOM。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { hasTag, tagKey } from "../storage/tags";
import { RelationType } from "../storage/types";
import { SidebarCard } from "./cardModel";

export interface RelatedHitView {
  card: SidebarCard;
  /** 命中的公共短语，按长度降序；第一条即确认关联的默认候选 */
  reasons: string[];
}

export interface RelatedBlockHost {
  /** 命中列表；宿主没算出东西时返回空数组，整块不出现 */
  load: () => Promise<RelatedHitView[]>;
  /** 折叠态：侧栏存视图字段（重绘不折回），浮层存实例字段 */
  isOpen: (cardId: string) => boolean;
  setOpen: (cardId: string, open: boolean) => void;
  fileName: (card: SidebarCard) => string;
  /** 两侧源文件都在才允许建立关联 */
  canLink: (other: SidebarCard) => boolean;
  /** 关联候选：第一位应是命中最长短语，其后历史标签，最后一个输入框接受自定义 */
  candidates: (other: SidebarCard, reasons: readonly string[]) => string[];
  onJump: (target: SidebarCard) => void;
  onConfirm: (other: SidebarCard, tag: string, type: RelationType | null) => Promise<void> | void;
  onRemoveSharedTag: (other: SidebarCard, tag: string) => Promise<void> | void;
  /**
   * 写入完成后的重绘：浮层用它把「已关联」chip 刷出来（列表整表重绘，不需要）。
   */
  afterMutate?: () => void;
  relationTypes: readonly (readonly [RelationType, string])[];
}

/**
 * 字面相关的其他批注：默认折叠，每条标出命中的短语（说明为什么相关），点击跳到原文。
 * 行尾「关联」把确认动作物化为两侧共享标签（MOC 雏形），已确认的显示为「已关联 xx」chip，
 * 点 chip 从两侧断开。无命中时整个区块不出现。
 */
export function renderRelatedBlock(root: HTMLElement, self: SidebarCard, host: RelatedBlockHost): void {
  void host
    .load()
    .then((hits) => {
      if (hits.length === 0) {
        return;
      }
      paint(root, self, hits, host);
    })
    .catch(() => undefined);
}

/**
 * 原文摘录超过这个长度就在行内折叠（CSS 限 3 行 + 「展开」按钮）。
 * 用字符数而不是 DOM 测量：相关行常常在 <details> 收起状态下渲染，
 * 此时 clientHeight 为 0，量 scrollHeight 会误判「没有溢出」。
 */
export const RELATED_TEXT_COLLAPSE_LENGTH = 80;

/** 这条摘录是否需要「展开 / 收起」 */
export function shouldCollapseRelatedText(text: string): boolean {
  return text.trim().length > RELATED_TEXT_COLLAPSE_LENGTH;
}

/**
 * 折叠区：整块仍是 <details>（要不要看相关由用户决定），
 * 展开后**每一条的原文摘录各自可折叠**——长摘录默认限 3 行，点「展开」看全文，再点收起。
 * 行本身可点跳转，所以展开按钮必须 stopPropagation，否则一点就跳走。
 */
function paint(root: HTMLElement, self: SidebarCard, hits: RelatedHitView[], host: RelatedBlockHost): void {
  const box = root.createEl("details", { cls: "yh-ov-related" });
  box.createEl("summary", { text: `相关的 ${hits.length} 条` });
  const list = box.createDiv({ cls: "yh-ov-related-list" });

  // 明细行按需生成：全库列表里绝大多数相关区是收起的，
  // 为每张卡预先铺最多 5 行 DOM 纯属浪费。条数摘要始终保留，展开后内容与原来一致。
  let painted = false;
  const paintRows = (): void => {
    if (painted) {
      return;
    }
    painted = true;
    for (const hit of hits) {
      list.appendChild(renderHitRow(list, self, hit, host));
    }
  };

  // 先写初始展开态，再挂 toggle，避免把程序化赋值当成用户操作
  box.open = host.isOpen(self.id);
  if (box.open) {
    paintRows();
  }
  box.addEventListener("toggle", () => {
    host.setOpen(self.id, box.open);
    if (box.open) {
      paintRows();
    }
  });
}

/** 单条相关行：摘录 + 命中短语 + 文件名 + 已关联 chip + 「关联」入口 */
function renderHitRow(
  parent: HTMLElement,
  self: SidebarCard,
  hit: RelatedHitView,
  host: RelatedBlockHost,
): HTMLElement {
  const row = parent.createDiv({ cls: "yh-ov-related-row" });
  const excerpt = hit.card.text;
  const textEl = row.createDiv({ cls: "yh-ov-related-text", text: excerpt });
  if (shouldCollapseRelatedText(excerpt)) {
    textEl.addClass("is-collapsible");
    const toggle = row.createEl("span", {
      cls: "yh-ov-related-expand",
      text: "展开",
      attr: { role: "button", tabindex: "0", "aria-label": "展开这条相关摘录" },
    });
    const flip = (event: Event): void => {
      // 行本身点击是「跳到那一句」，展开必须拦住冒泡
      event.stopPropagation();
      const expanded = !textEl.hasClass("is-expanded");
      textEl.toggleClass("is-expanded", expanded);
      toggle.setText(expanded ? "收起" : "展开");
      toggle.setAttribute("aria-label", expanded ? "收起这条相关摘录" : "展开这条相关摘录");
    };
    toggle.addEventListener("click", flip);
    toggle.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      flip(event);
    });
  }

  const meta = row.createDiv({ cls: "yh-ov-related-meta" });
  meta.createSpan({ cls: "yh-ov-related-reason", text: `都提到「${hit.reasons.join("」「")}」` });
  meta.createSpan({ cls: "yh-ov-related-file", text: host.fileName(hit.card) });

  // 已确认的关联 = 两侧共享的标签（确认动作的持久结果）；点 chip 从两侧移除该标签
  for (const tag of sharedTags(self, hit.card)) {
    const chip = meta.createSpan({
      cls: "yh-ov-related-chip",
      text: `已关联 ${tag}`,
      attr: { title: "点击断开该关联标签（两侧同时移除）" },
    });
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
      runMutation(host.onRemoveSharedTag(hit.card, tag), host);
    });
  }

  const linkable = host.canLink(hit.card);
  const link = meta.createSpan({
    cls: "yh-ov-related-link",
    text: "关联",
    attr: linkable
      ? { role: "button", tabindex: "0", "aria-label": "确认关联", title: "确认关联：把一个共享标签写入两侧批注" }
      : { "aria-disabled": "true", title: "源文件缺失，无法建立关联" },
  });
  if (!linkable) {
    link.addClass("is-disabled");
  }
  const openPicker = (event: Event): void => {
    event.stopPropagation();
    if (linkable) {
      mountPicker(row, self, hit.card, hit.reasons, host);
    }
  };
  link.addEventListener("click", openPicker);
  link.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (linkable) {
      mountPicker(row, self, hit.card, hit.reasons, host);
    }
  });

  if (host.canLink(hit.card)) {
    row.addClass("is-clickable");
    row.setAttribute("role", "button");
    row.addEventListener("click", () => host.onJump(hit.card));
  }
  return row;
}

/** 写入是异步的：等它落地再重绘，否则 chip 会刷出旧状态 */
function runMutation(result: Promise<void> | void, host: RelatedBlockHost): void {
  void Promise.resolve(result)
    .then(() => host.afterMutate?.())
    .catch(() => undefined);
}

/** 两侧已共享的标签（按比较键判同、去重展示写法）：这就是「确认关联」落在数据上的样子 */
function sharedTags(a: SidebarCard, b: SidebarCard): string[] {
  const keys = new Set(b.tags.map(tagKey));
  const seen = new Set<string>();
  const shared: string[] = [];
  for (const tag of a.tags) {
    const key = tagKey(tag);
    if (!key || !keys.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    shared.push(tag);
  }
  return shared;
}

/**
 * 确认关联选择条：候选第一位是命中最长的公共短语（算法已保证术语性），
 * 其后是历史标签，最后一个输入框接受自定义。点候选或回车才写入，Esc / 点外收起。
 * 关系类型可先选：选了才落一条有向关系（支持/反驳/举例/延伸），不选只写共享标签。
 */
function mountPicker(
  row: HTMLElement,
  self: SidebarCard,
  other: SidebarCard,
  reasons: readonly string[],
  host: RelatedBlockHost,
): void {
  const picker = row.createDiv({ cls: "yh-ov-related-picker" });
  // 不让行级点击跳转吃掉选择条上的点击
  picker.addEventListener("click", (event) => event.stopPropagation());

  const listeners = new AbortController();
  const close = (): void => {
    listeners.abort();
    picker.remove();
  };

  const typeRow = picker.createDiv({ cls: "yh-ov-related-types" });
  let chosenType: RelationType | null = null;
  for (const [type, label] of host.relationTypes) {
    const button = typeRow.createSpan({
      cls: "yh-ov-related-type",
      text: label,
      attr: {
        role: "button",
        tabindex: "0",
        "aria-pressed": "false",
        title: `标记为「${label}」：再选一个标签建立有向关联`,
      },
    });
    const toggle = (): void => {
      chosenType = chosenType === type ? null : type;
      typeRow.querySelectorAll(".yh-ov-related-type").forEach((node) => node.removeClass("is-active"));
      button.setAttribute("aria-pressed", chosenType ? "true" : "false");
      if (chosenType) {
        button.addClass("is-active");
      }
    };
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggle();
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggle();
    });
  }

  const chips = picker.createDiv({ cls: "yh-ov-related-picker-chips" });
  for (const name of host.candidates(other, reasons)) {
    const phrase = reasons[0];
    const chip = chips.createSpan({
      cls: "yh-ov-related-picker-chip",
      text: name,
      attr: { title: name === phrase ? "用这个共同短语作为关联标签" : "用这个历史标签建立关联" },
    });
    chip.addEventListener("click", () => {
      close();
      runMutation(host.onConfirm(other, name, chosenType), host);
    });
  }

  const input = chips.createEl("input", {
    cls: "yh-ov-related-picker-input",
    attr: { type: "text", placeholder: "自定义标签", "aria-label": "自定义关联标签" },
  });
  let composing = false;
  input.addEventListener("compositionstart", () => {
    composing = true;
  });
  input.addEventListener("compositionend", () => {
    composing = false;
  });
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    // IME 选词阶段的 Enter 必须还给输入法；keyCode 229 是安卓 WebView 的兜底
    if (composing || event.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    const value = input.value.trim();
    if (!value) {
      return;
    }
    close();
    runMutation(host.onConfirm(other, value, chosenType), host);
  });

  // 点选择条外收起（capture 先于行跳转）；行被重绘销毁时顺手清监听
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!row.isConnected) {
        listeners.abort();
        return;
      }
      if (event.target instanceof Node && picker.contains(event.target)) {
        return;
      }
      close();
    },
    { capture: true, signal: listeners.signal },
  );
  picker.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        close();
      }
    },
    { signal: listeners.signal },
  );
}

/** 供宿主复用的候选过滤：去掉两侧已共享的标签（再点一次是空操作） */
export function filterSharedCandidates(
  names: readonly string[],
  self: SidebarCard,
  other: SidebarCard,
  limit = 6,
): string[] {
  const picked: string[] = [];
  for (const name of names) {
    if (picked.length >= limit) {
      break;
    }
    const key = tagKey(name);
    if (!key) {
      continue;
    }
    if (hasTag(self.tags, key) && hasTag(other.tags, key)) {
      continue;
    }
    if (!picked.some((item) => tagKey(item) === key)) {
      picked.push(name);
    }
  }
  return picked;
}

/**
 * [INPUT]: cardModel 的 SidebarCard、tagInput 的 chip 与输入组件、storage 的颜色与关系类型、
 *          obsidian 的 MarkdownRenderer / setIcon
 * [OUTPUT]: renderCardBody —— 侧栏列表与「点击高亮」浮层共用的唯一卡片渲染器，
 *           以及 CARD_ACTIONS 动作归属表（inList / inPopover）
 * [POS]: views 模块卡片 DOM 的唯一出口。两个宿主只提供数据与回调，
 *        字段顺序、排版、动作行都在这里产出——两处各写一遍必然漂移（noteType 就丢过一次）。
 *        宿主各自保留自己的状态与生命周期：侧栏是常驻列表 + 整表重绘，浮层是游离节点 + 点外关闭。
 *        展开按钮的尺寸测量按帧批量执行：先统一读 scrollHeight / lineHeight，再统一插入按钮，
 *        避免全库列表逐卡读写交替造成成百上千次强制布局。
 *        正文 Markdown 的渲染时机可由宿主通过 deferContent 接管：侧栏让未滚到的卡先显示原文，
 *        进入视口才解析（全库首屏因此只需解析真正可见的那几张）。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { App, Component, MarkdownRenderer, setIcon } from "obsidian";
import { AnnotationRelation, COLOR_LABELS } from "../storage/types";
import { SidebarCard } from "./cardModel";
import { renderTagChips, renderTagInput, TagSuggestion } from "./tagInput";
import { RelatedBlockHost, renderRelatedBlock } from "./relatedBlock";

export type CardHostKind = "list" | "popover";

export type CardActionId = "open-export" | "atom-card" | "edit-note" | "add-note" | "jump" | "delete";

export interface CardActionSpec {
  id: CardActionId;
  label: string;
  inList: boolean;
  inPopover: boolean;
}

/**
 * 动作归属表：每个动作显式声明两个容器是否出现。
 *
 * 新增动作必须在这里表态——只写进某一侧的渲染分支，另一侧就会慢慢漂移。
 * 「跳转」只给列表：浮层本身就是「点着这条划线」弹出来的，原地跳原地是空动作。
 */
export const CARD_ACTIONS: readonly CardActionSpec[] = [
  { id: "open-export", label: "打开导出笔记", inList: true, inPopover: true },
  { id: "atom-card", label: "提炼成卡片", inList: true, inPopover: true },
  { id: "edit-note", label: "编辑笔记", inList: true, inPopover: true },
  { id: "add-note", label: "添加笔记", inList: true, inPopover: true },
  // 只有列表需要：浮层里点了等于不做任何事
  { id: "jump", label: "跳转", inList: true, inPopover: false },
  { id: "delete", label: "删除", inList: true, inPopover: true },
];

/**
 * 需要图标而不是文字的动作；两侧一致，避免「同样一个动作两种长相」。
 * 图标名取自 Obsidian 内置 lucide 集，纯图标按钮必须给 title（见 actionTitle），
 * 否则新用户认不出「file-plus / message-square / trash-2」分别是干什么的。
 */
const ICON_ACTIONS: Partial<Record<CardActionId, string>> = {
  "open-export": "file-text",
  "atom-card": "file-plus",
  "edit-note": "pencil",
  "add-note": "message-square",
  "delete": "trash-2",
};

export interface CardExtraAction {
  label: string;
  onClick: () => void;
}

/** 标签编辑器由宿主持有的状态与依赖（侧栏的重绘不丢编辑态靠这个） */
export interface CardTagHost {
  /** 当前是否处于标签编辑态：宿主存类字段，body 只读 */
  isTagEditing: () => boolean;
  /** 用户点了标签行的「+」或已有 chip：宿主置状态，随后 body 重绘标签行 */
  onStartTagEdit: () => void;
  suggestions: () => readonly TagSuggestion[];
  onChange: (tags: string[]) => Promise<void> | void;
  /** 未提交输入的暂存与回填 */
  initialQuery?: () => string;
  onQueryChange?: (value: string) => void;
  /** 点已存在的 chip（列表用来按标签筛选；浮层不传） */
  onChipClick?: (tag: string) => void;
  /**
   * 编辑器挂载完成：宿主在此做聚焦、滚动、键盘避让与外点关闭。
   * repaint 把标签行原地换回只读 chip——宿主决定何时退出编辑态。
   */
  onEditorReady?: (row: HTMLElement, repaint: () => void) => void;
  quickApply?: () => { label: string; tags: readonly string[] } | undefined;
}

/**
 * 浮层专有的「插件级动作」：阅读器 / PDF 图层不掌握跨文件导航与索引写入，
 * 这些一律由 main.ts 注入；没注入就不渲染对应按钮，绝不造点了没反应的控件。
 */
export interface CardExternalActions {
  openDerivedNote?: (sourcePath: string) => Promise<void> | void;
  createAtomCard?: (card: SidebarCard) => Promise<void> | void;
  jumpToRelation?: (relation: AnnotationRelation) => void;
  /** 相关区宿主工厂：由 main.ts 提供，命中来自插件级关系模型 */
  relatedHost?: (card: SidebarCard) => RelatedBlockHost | undefined;
  removeRelation?: (
    sourcePath: string,
    annotationId: string,
    relation: AnnotationRelation,
  ) => Promise<void> | void;
}

export interface CardBodyHost {
  host: CardHostKind;
  /** 来源行左侧的文件名（宿主已解析 TFile；拿不到时回落文件名） */
  fileName: string;
  /** 只有列表需要：卡片根节点的 data-* 由宿主创建元素时给，body 不碰 */
  tags: CardTagHost;
  /** 动作回调：没给 = 该动作此刻不可用，不渲染按钮 */
  actions: Partial<Record<CardActionId, () => void>>;
  /** 容器专有按钮（Markdown 浮层的「同段另有 N 条批注」） */
  extraActions?: readonly CardExtraAction[];
  /** 关系行：不传回调则整行只读，绝不渲染「点了没反应」的控件 */
  onJumpRelation?: (relation: AnnotationRelation) => void;
  onRemoveRelation?: (relation: AnnotationRelation) => void;
  /** 浮层右上角关闭按钮 */
  onClose?: () => void;
  /** 字面相关区：宿主没给就整块不出现（PDF 之类拿不到全库快照的场景） */
  related?: RelatedBlockHost;
  /**
   * 接管正文 Markdown 的渲染时机：给了回调就由宿主决定何时调用 paint，
   * 没给则立即渲染（浮层只有一张卡，不延迟）。
   */
  deferContent?: (element: HTMLElement, paint: () => void) => void;
  app?: App;
  component?: Component;
}

/**
 * 渲染一张卡片。根节点由宿主创建并定位/加容器类，这里负责内容与配色。
 * 返回值是「标签行重绘」——宿主切换编辑态后调一次即可，不必重绘整卡。
 */
export function renderCardBody(root: HTMLElement, card: SidebarCard, host: CardBodyHost): void {
  root.empty();
  root.addClass("yh-ov-card");
  root.addClass(`yh-ov-card--${card.color}`);
  root.toggleClass("is-orphaned", Boolean(card.orphaned));

  renderHead(root, card, host);
  renderQuote(root, card);
  renderContent(root, card, host);
  renderTagRow(root, card, host);
  renderRelations(root, card, host);
  renderSource(root, card, host);
  renderActions(root, card, host);
  if (host.related) {
    renderRelatedBlock(root, card, host.related);
  }
}

/** 头行：颜色 / 载体 / 类型 / 想法类型 / 时间（浮层再加关闭） */
function renderHead(root: HTMLElement, card: SidebarCard, host: CardBodyHost): void {
  const head = root.createDiv({ cls: "yh-ov-card-head" });
  head.createSpan({ cls: `yh-ov-label yh-label--${card.color}`, text: COLOR_LABELS[card.color] });
  head.createSpan({ cls: "yh-ov-meta", text: modeLabel(card.mode) });
  head.createSpan({ cls: "yh-ov-dot", text: "·" });

  const title = card.note && "title" in card.note ? (card.note.title ?? "") : "";
  const kindLabel = card.kind === "highlight" ? "高亮" : "笔记";
  const type = head.createSpan({ cls: "yh-ov-type", text: title ? getTitleLabel(title) : kindLabel });
  if (title) {
    type.dataset.title = title;
  }

  if (card.noteType) {
    head.createSpan({ cls: "yh-ov-note-type", text: noteTypeLabel(card.noteType) });
  }

  head.createSpan({ cls: "yh-ov-time", text: formatTime(card.createdAt) });

  if (host.onClose) {
    const close = head.createEl("button", {
      cls: "yh-ov-card-close",
      attr: { type: "button", title: "关闭", "aria-label": "关闭" },
      text: "✕",
    });
    close.addEventListener("click", () => host.onClose?.());
  }
}

function renderQuote(root: HTMLElement, card: SidebarCard): void {
  const quote = root.createDiv({ cls: "yh-ov-quote" });
  quote.textContent = card.text;
  quote.toggleClass("is-code", card.isCode || isCodeLikeText(card.text));
  addExpandToggle(quote);
}

/**
 * 卡片正文：纯 Markdown 交由 Obsidian 渲染，三行以上给「展开」。
 * 宿主可以用 deferContent 接管渲染时机——全库列表里绝大多数卡片还没滚到，
 * 先把原文当占位文本放进去（高度由 CSS 的三行上限兜住），进入视口才付出解析成本。
 */
function renderContent(root: HTMLElement, card: SidebarCard, host: CardBodyHost): void {
  if (!card.content) {
    return;
  }
  const content = root.createDiv({ cls: "yh-ov-content" });

  const paint = (): void => {
    if (!host.app || !host.component) {
      content.setText(card.content);
      addExpandToggle(content);
      return;
    }
    content.empty();
    void MarkdownRenderer.render(host.app, card.content, content, card.sourcePath, host.component).then(() => {
      addExpandToggle(content);
    });
  };

  if (host.deferContent && host.app && host.component) {
    content.setText(card.content);
    host.deferContent(content, paint);
    return;
  }
  paint();
}

/** 标签行：只读 chip + 「+」；编辑态原地换成输入组件，两态都由宿主状态驱动 */
function renderTagRow(root: HTMLElement, card: SidebarCard, host: CardBodyHost): void {
  const row = root.createDiv({ cls: "yh-ov-tags" });
  const paint = (): void => renderTagRowContent(row, card, host, paint);
  paint();
}

function renderTagRowContent(
  row: HTMLElement,
  card: SidebarCard,
  host: CardBodyHost,
  repaint: () => void,
): void {
  const tags = host.tags;
  row.empty();

  if (tags.isTagEditing()) {
    row.addClass("is-editing");
    const quickApply = tags.quickApply?.();
    renderTagInput(row, {
      tags: card.tags,
      suggestions: [...(tags.suggestions() ?? [])],
      ...(quickApply ? { quickApply } : {}),
      // 侧栏点 + 即刻给出候选：空内容也显示，不必先输入一个字符
      showSuggestionsOnOpen: true,
      initialQuery: tags.initialQuery?.() ?? "",
      onQueryChange: (value) => tags.onQueryChange?.(value),
      onChange: (next) => {
        card.tags = next;
        // 宿主自己出 Notice；这里只兜住 reject，避免未处理的 Promise 警告
        void Promise.resolve(tags.onChange(next)).catch(() => undefined);
      },
    });
    tags.onEditorReady?.(row, repaint);
    return;
  }

  row.removeClass("is-editing");
  renderTagChips(row, card.tags, {
    ...(tags.onChipClick ? { onChipClick: tags.onChipClick } : {}),
    onOverflowClick: () => {
      tags.onStartTagEdit();
      repaint();
    },
  });

  const add = row.createSpan({
    cls: "yh-ov-tag-add",
    text: "+",
    attr: { role: "button", tabindex: "0", "aria-label": "添加标签", title: "添加标签" },
  });
  // 阻止 + 抢焦点：否则重绘删掉的是「正持有焦点的节点」，焦点退回 body，输入框立刻失焦
  add.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  const open = (event: Event): void => {
    event.stopPropagation();
    tags.onStartTagEdit();
    repaint();
  };
  add.addEventListener("click", open);
  add.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open(event);
    }
  });
}

/**
 * 关系区：有向关系直接可见。点一行跳到目标那句，点 × 双向解除——
 * 宿主没给对应回调时只渲染文本，不造「点了没反应」的假控件。
 */
function renderRelations(root: HTMLElement, card: SidebarCard, host: CardBodyHost): void {
  if (card.relations.length === 0) {
    return;
  }
  const box = root.createDiv({ cls: "yh-ov-relations" });

  for (const relation of card.relations) {
    const row = box.createDiv({ cls: `yh-ov-rel yh-ov-rel--${relation.type}` });
    const jump = host.onJumpRelation;
    if (jump) {
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
      row.addEventListener("click", () => jump(relation));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          jump(relation);
        }
      });
    }

    row.createSpan({ cls: "yh-ov-rel-type", text: relationTypeLabel(relation.type) });

    const fallback = relation.targetPath.split("/").pop() ?? relation.targetPath;
    const quote = (relation.targetQuote?.trim() || fallback).replace(/\s+/g, " ");
    row.createSpan({
      cls: "yh-ov-rel-quote",
      text: quote.length > 30 ? `${quote.slice(0, 30)}…` : quote,
      attr: { title: relation.targetPath },
    });

    const remove = host.onRemoveRelation;
    if (!remove) {
      continue;
    }
    const button = row.createSpan({
      cls: "yh-ov-rel-remove",
      text: "×",
      attr: { role: "button", tabindex: "0", "aria-label": "解除关系", title: "解除关系（两侧一起断开）" },
    });
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      remove(relation);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      remove(relation);
    });
  }
}

function renderSource(root: HTMLElement, card: SidebarCard, host: CardBodyHost): void {
  const source = root.createDiv({ cls: "yh-ov-source" });
  source.createSpan({ cls: "yh-ov-file", text: host.fileName || card.sourcePath });
  source.createSpan({
    cls: "yh-ov-mode",
    text:
      card.mode === "epub"
        ? (card.chapter ?? "EPUB")
        : card.pageNumber
          ? `p.${card.pageNumber}`
          : "Markdown",
  });
}

/** 动作行：按 CARD_ACTIONS 表过滤，两个容器因此不可能各长一套 */
function renderActions(root: HTMLElement, card: SidebarCard, host: CardBodyHost): void {
  const actions = root.createDiv({ cls: "yh-ov-actions" });
  const allowed = (spec: CardActionSpec): boolean => (host.host === "list" ? spec.inList : spec.inPopover);

  for (const spec of CARD_ACTIONS) {
    // 容器专有按钮排在「删除」之前：删除永远是最后一颗，手指不会误触
    if (spec.id === "delete") {
      renderExtraActions(actions, host);
    }
    const run = host.actions[spec.id];
    if (!run || !allowed(spec)) {
      continue;
    }
    const icon = ICON_ACTIONS[spec.id];
    const button = actions.createEl("button", {
      cls: icon ? "yh-ov-btn yh-ov-btn--icon" : "yh-ov-btn",
      attr: { type: "button", title: actionTitle(spec, card), "data-action": spec.id },
      ...(icon ? {} : { text: actionLabel(spec, card) }),
    });
    if (icon) {
      setIcon(button, icon);
    }
    if (spec.id === "delete") {
      button.addClass("yh-ov-btn--danger");
    }
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      run();
    });
  }

}

function renderExtraActions(actions: HTMLElement, host: CardBodyHost): void {
  for (const extra of host.extraActions ?? []) {
    const button = actions.createEl("button", {
      cls: "yh-ov-btn",
      attr: { type: "button" },
      text: extra.label,
    });
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      extra.onClick();
    });
  }
}

function actionLabel(spec: CardActionSpec, card: SidebarCard): string {
  if (spec.id === "edit-note" || spec.id === "add-note") {
    return card.note ? "编辑笔记" : "添加笔记";
  }
  return spec.label;
}

function actionTitle(spec: CardActionSpec, card: SidebarCard): string {
  switch (spec.id) {
    case "open-export":
      return "打开这条批注所在的导出笔记";
    case "atom-card":
      return "把这条批注的想法提炼成一张独立的原子卡";
    case "edit-note":
      return "编辑笔记";
    case "delete":
      return "删除这条批注";
    default:
      return actionLabel(spec, card);
  }
}

function modeLabel(mode: SidebarCard["mode"]): string {
  if (mode === "pdf") {
    return "PDF";
  }
  return mode === "epub" ? "EPUB" : "Markdown";
}

function noteTypeLabel(noteType: NonNullable<SidebarCard["noteType"]>): string {
  const labels: Record<string, string> = { insight: "💡洞见", question: "❓疑问", reminder: "🔔提醒" };
  return labels[noteType] ?? noteType;
}

function relationTypeLabel(type: AnnotationRelation["type"]): string {
  const labels: Record<string, string> = {
    supports: "支持",
    refutes: "反驳",
    example: "举例",
    extends: "延伸",
  };
  return labels[type] ?? type;
}

function getTitleLabel(title: string): string {
  const labels: Record<string, string> = {
    Insight: "洞察",
    Question: "疑问",
    Reminder: "提醒",
  };
  return labels[title] ?? title;
}

/** 待测量的内容元素：同一帧内的所有卡片合并成一批，避免读写交替触发反复布局 */
const pendingExpandChecks = new Set<HTMLElement>();
/** 已测量过的元素不再重复排队（Markdown 渲染回调可能重入） */
const expandChecked = new WeakSet<HTMLElement>();
let expandCheckScheduled = false;

/**
 * 三行以上才给「展开」：按钮插在内容元素之后，样式靠 `.yh-ov-quote + .yh-ov-expand-btn` 相邻选择器，
 * 因此不能用 appendChild 挂到别处，否则按钮会掉到卡片末尾。
 * 全库列表一次渲染很多卡时，逐卡测量会造成成百上千次强制布局；
 * 这里先收集、统一读尺寸，再统一写按钮，判定条件与按钮行为保持不变。
 */
function addExpandToggle(contentEl: HTMLElement): void {
  if (expandChecked.has(contentEl)) {
    return;
  }
  pendingExpandChecks.add(contentEl);
  if (expandCheckScheduled) {
    return;
  }
  expandCheckScheduled = true;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      expandCheckScheduled = false;
      const elements = Array.from(pendingExpandChecks);
      pendingExpandChecks.clear();

      // 先读：所有尺寸一次性量完
      const needing: HTMLElement[] = [];
      for (const element of elements) {
        if (!element.isConnected) {
          continue;
        }
        const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
        const threshold = lineHeight * 3 + 10;
        if (element.scrollHeight > threshold + 2) {
          needing.push(element);
        } else {
          expandChecked.add(element);
        }
      }

      // 再写：统一插入按钮，不穿插读取
      for (const element of needing) {
        expandChecked.add(element);
        const button = document.createElement("span");
        button.className = "yh-ov-expand-btn";
        button.textContent = "展开";
        button.tabIndex = 0;
        button.setAttribute("role", "button");
        element.insertAdjacentElement("afterend", button);
        const toggle = (): void => {
          const expanded = element.hasClass("expanded");
          element.toggleClass("expanded", !expanded);
          button.setText(expanded ? "展开" : "收起");
        };
        button.addEventListener("click", toggle);
        button.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        });
      }
    });
  });
}

function isCodeLikeText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 400) {
    return false;
  }
  const codeSignals = [
    /^[{}[\]]/,
    /=>/,
    /;\s*$/,
    /^(const|let|var|function|class|import|export|def|public|private)\b/,
    /[<>]=?|==={0,1}|!==?/,
    /\breturn\b/,
  ];
  return codeSignals.filter((pattern) => pattern.test(trimmed)).length >= 2;
}

/** 与卡片头行一致的时间写法（MM-DD HH:mm） */
function formatTime(iso: string): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * [INPUT]: 依赖 storage/tags 的归一化规则与 dom 辅助（Obsidian HTMLElement 扩展）
 * [OUTPUT]: 对外提供 renderTagChips（只读 chip 行）、renderTagInput（可编辑 chip + 补全下拉）、
 *           TagSuggestion（带来源的补全候选，含按内容推荐）与 buildTagSuggestions（候选聚合，含 Obsidian 标签）；
 *           推荐项独立配额（最多 3 个），不挤占常规候选；showSuggestionsOnOpen 供侧栏打开即显示候选；
 *           initialQuery / onQueryChange 供调用方在重绘后回填未提交输入；
 *           renderTagInput 处理中文输入法组合态，拼音选词不会误建标签
 * [POS]: views 模块的标签 UI 单点，被 sidebarView、tagBoardView、CommentModal、EpubNoteModal 共用
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { MAX_TAGS_PER_ANNOTATION, MAX_VISIBLE_TAG_CHIPS, normalizeTag, normalizeTags, tagKey } from "../storage/tags";

const MAX_SUGGESTIONS = 8;
/** 按内容推荐的标签独立配额，不挤占常规候选 */
const MAX_RECOMMENDATIONS = 3;

/** 补全候选的来源，决定下拉右侧的角标文案 */
export type TagSuggestionKind = "current" | "used" | "ob" | "page" | "recommended";

/** 带来源的补全候选：name 用于写入标签，kind 只用于展示 */
export interface TagSuggestion {
  name: string;
  kind: TagSuggestionKind;
}

const KIND_LABELS: Record<TagSuggestionKind, string> = {
  current: "本文档",
  used: "已用标签",
  ob: "OB 标签",
  page: "概念页",
  recommended: "按内容推荐",
};

export interface TagChipOptions {
  /** 最多展示几个 chip，默认 4；超出折叠为 +N */
  max?: number;
  onChipClick?: (tag: string) => void;
  onOverflowClick?: () => void;
}

/** 只读 chip 行。无标签时不渲染任何节点，调用方可据此判断是否占位 */
export function renderTagChips(parent: HTMLElement, tags: readonly string[], options: TagChipOptions = {}): void {
  const list = normalizeTags(tags);
  if (list.length === 0) {
    return;
  }

  const max = Math.max(1, options.max ?? MAX_VISIBLE_TAG_CHIPS);
  const wrap = parent.createDiv({ cls: "yh-tag-chips" });

  for (const tag of list.slice(0, max)) {
    const chip = wrap.createSpan({ cls: "yh-tag-chip", text: tag });
    if (options.onChipClick) {
      chip.addClass("is-clickable");
      chip.setAttribute("role", "button");
      chip.setAttribute("tabindex", "0");
      const activate = (event: Event): void => {
        event.stopPropagation();
        options.onChipClick?.(tag);
      };
      chip.addEventListener("click", activate);
      chip.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate(event);
        }
      });
    }
  }

  if (list.length > max) {
    const more = wrap.createSpan({ cls: "yh-tag-chip yh-tag-chip-more", text: `+${list.length - max}` });
    if (options.onOverflowClick) {
      more.addClass("is-clickable");
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        options.onOverflowClick?.();
      });
    }
  }
}

export interface TagInputOptions {
  tags: readonly string[];
  /** 补全候选：当前文档 OB 标签 + 已用标签 + OB 全库标签 + 全库 md 文件名 */
  suggestions: readonly TagSuggestion[];
  /** 可选的一键沿用：下拉空查询时首项，点击把整组标签并入当前卡片 */
  quickApply?: { label: string; tags: readonly string[] };
  /** 打开编辑态即展示候选（侧栏用）；默认 false，弹窗维持「输入后才弹」 */
  showSuggestionsOnOpen?: boolean;
  /** 重建时回填的未提交输入（侧栏重绘时用） */
  initialQuery?: string;
  /** 输入内容变化回调，供调用方暂存未提交文本，避免一次重绘吞掉正在打的标签 */
  onQueryChange?: (value: string) => void;
  onChange: (tags: string[]) => void;
  placeholder?: string;
}

/** renderTagInput 的句柄：弹窗点「保存」时用 flush() 兜住输入框里未回车的文本 */
export interface TagInputHandle {
  flush(): void;
  focus(): void;
}

/**
 * 可编辑的标签输入：chip + 输入框 + 自定义补全下拉。
 * 自管理状态，任何增删都会立刻回调 onChange 并重绘 chip。
 */
export function renderTagInput(parent: HTMLElement, options: TagInputOptions): TagInputHandle {
  const wrap = parent.createDiv({ cls: "yh-tag-input" });
  const chipWrap = wrap.createDiv({ cls: "yh-tag-input-chips" });
  const field = wrap.createEl("input", {
    cls: "yh-tag-input-field",
    attr: { type: "text", placeholder: options.placeholder ?? "添加标签…", spellcheck: "false" },
  });
  const dropdown = wrap.createDiv({ cls: "yh-tag-suggest" });
  dropdown.addClass("yh-hidden");
  if (options.initialQuery) {
    field.value = options.initialQuery;
  }

  let tags = normalizeTags(options.tags);
  let matches: TagSuggestion[] = [];
  let activeIndex = 0;
  /** 侧栏要求打开即显示；有按内容推荐项时其它调用方也保持打开即显示 */
  const showOnOpen = options.showSuggestionsOnOpen === true
    || options.suggestions.some((item) => item.kind === "recommended");
  /**
   * 中文输入法组合态：拼音串还在候选栏里时，Enter / 逗号是「选词」不是「提交标签」。
   * isComposing 在部分安卓输入法上不可靠，因此自己维护一份显式标志。
   */
  let composing = false;

  const emit = (next: string[]): void => {
    const normalized = normalizeTags(next);
    if (normalized.length === tags.length && normalized.every((tag, index) => tag === tags[index])) {
      return;
    }
    tags = normalized;
    renderChips();
    options.onChange([...tags]);
  };

  const renderChips = (): void => {
    chipWrap.empty();
    for (const tag of tags) {
      const chip = chipWrap.createSpan({ cls: "yh-tag-chip yh-tag-chip-editable", text: tag });
      const remove = chip.createSpan({ cls: "yh-tag-chip-x", text: "×" });
      remove.setAttribute("role", "button");
      remove.setAttribute("aria-label", `移除标签 ${tag}`);
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        emit(tags.filter((item) => tagKey(item) !== tagKey(tag)));
      });
    }
    field.toggleClass("yh-hidden", tags.length >= MAX_TAGS_PER_ANNOTATION);
  };

  const closeDropdown = (): void => {
    dropdown.addClass("yh-hidden");
    dropdown.empty();
    matches = [];
    activeIndex = 0;
  };

  const renderDropdown = (): void => {
    const raw = field.value;
    const suggestion = normalizeTag(raw);
    const existing = new Set(tags.map((tag) => tagKey(tag)));
    const seen = new Set<string>();
    const query = (suggestion ?? "").toLowerCase();

    // 推荐项与常规候选分开计数：推荐最多 3 个，常规仍保留 8 个，避免推荐把下拉占满
    const pool: TagSuggestion[] = [];
    let recommendedCount = 0;
    let otherCount = 0;
    for (const item of options.suggestions) {
      const key = tagKey(item.name);
      if (!key || existing.has(key) || seen.has(key)) {
        continue;
      }
      if (query && !item.name.toLowerCase().includes(query)) {
        continue;
      }
      const isRecommended = item.kind === "recommended";
      if (isRecommended) {
        if (recommendedCount >= MAX_RECOMMENDATIONS) {
          continue;
        }
        recommendedCount += 1;
      } else {
        if (otherCount >= MAX_SUGGESTIONS) {
          continue;
        }
        otherCount += 1;
      }
      seen.add(key);
      pool.push(item);
      if (recommendedCount >= MAX_RECOMMENDATIONS && otherCount >= MAX_SUGGESTIONS) {
        break;
      }
    }

    matches = pool;
    const canCreate = Boolean(suggestion) && !existing.has(tagKey(suggestion!)) && !pool.some((item) => tagKey(item.name) === tagKey(suggestion!));
    const showQuick = !query && Boolean(options.quickApply?.tags.length);

    if (matches.length === 0 && !canCreate && !showQuick) {
      closeDropdown();
      return;
    }

    dropdown.removeClass("yh-hidden");
    dropdown.empty();
    activeIndex = Math.min(activeIndex, Math.max(0, matches.length - 1));

    if (showQuick && options.quickApply) {
      const quick = dropdown.createDiv({ cls: "yh-tag-suggest-item yh-tag-suggest-quick" });
      quick.createSpan({ cls: "yh-tag-suggest-name", text: options.quickApply.label });
      quick.createSpan({ cls: "yh-tag-suggest-kind", text: "一键沿用" });
      quick.addEventListener("mousedown", (event) => {
        event.preventDefault();
        emit([...tags, ...options.quickApply!.tags]);
        field.value = "";
        options.onQueryChange?.("");
        closeDropdown();
      });
    }

    matches.forEach((item, index) => {
      const row = dropdown.createDiv({ cls: "yh-tag-suggest-item" });
      if (item.kind === "recommended") {
        row.addClass("is-recommended");
      }
      row.createSpan({ cls: "yh-tag-suggest-name", text: item.name });
      row.createSpan({ cls: "yh-tag-suggest-kind", text: KIND_LABELS[item.kind] });
      if (index === activeIndex) {
        row.addClass("is-active");
      }
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        commitTag(item.name);
      });
    });

    if (canCreate) {
      const item = dropdown.createDiv({ cls: "yh-tag-suggest-item yh-tag-suggest-create" });
      item.createSpan({ cls: "yh-tag-suggest-name", text: `新建标签「${suggestion}」` });
      item.createSpan({ cls: "yh-tag-suggest-kind", text: "回车" });
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        commitTag(suggestion!);
      });
    }
  };

  const commitTag = (raw: string): void => {
    const tag = normalizeTag(raw);
    field.value = "";
    options.onQueryChange?.("");
    if (!tag) {
      closeDropdown();
      return;
    }
    if (tags.length >= MAX_TAGS_PER_ANNOTATION) {
      closeDropdown();
      return;
    }
    if (!tags.some((item) => tagKey(item) === tagKey(tag))) {
      emit([...tags, tag]);
    }
    activeIndex = 0;
    renderDropdown();
  };

  field.addEventListener("compositionstart", () => {
    composing = true;
  });

  field.addEventListener("compositionend", () => {
    composing = false;
    activeIndex = 0;
    renderDropdown();
  });

  field.addEventListener("input", () => {
    options.onQueryChange?.(field.value);
    // 拼音未上屏时不要拿半截拼音去筛候选，等 compositionend 再渲染
    if (composing) {
      return;
    }
    activeIndex = 0;
    renderDropdown();
  });

  field.addEventListener("keydown", (event) => {
    // IME 选词阶段的 Enter / 逗号必须还给输入法；keyCode 229 是安卓 WebView 的兜底
    if (composing || event.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === "Enter" || event.key === "," || event.key === "，") {
      event.preventDefault();
      const picked = !dropdown.hasClass("yh-hidden") ? matches[activeIndex] : undefined;
      commitTag(picked?.name ?? field.value);
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (matches.length === 0) {
        return;
      }
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      activeIndex = (activeIndex + delta + matches.length) % matches.length;
      renderDropdown();
      return;
    }

    if (event.key === "Escape") {
      if (!dropdown.hasClass("yh-hidden")) {
        event.preventDefault();
        closeDropdown();
      }
      return;
    }

    if (event.key === "Backspace" && field.value === "" && tags.length > 0) {
      event.preventDefault();
      emit(tags.slice(0, -1));
    }
  });

  field.addEventListener("focus", () => {
    // 首次聚焦与之后每次重新聚焦都兜底渲染：内容为空也立即显示候选列表，
    // 不依赖「先输入一个字符」触发 input；未开启 showOnOpen 的调用方行为保持原样
    if (showOnOpen) {
      renderDropdown();
    }
  });

  field.addEventListener("blur", () => {
    // 组合态中失焦（切输入法、点候选栏）不能把拼音当成标签提交
    if (composing) {
      return;
    }
    if (field.value.trim()) {
      commitTag(field.value);
    } else {
      closeDropdown();
    }
  });

  wrap.addEventListener("click", (event) => {
    if (event.target === wrap || event.target === chipWrap) {
      field.focus();
    }
  });

  renderChips();

  // 常规弹窗仍等用户输入再弹；侧栏（或有推荐项时）打开输入框即刻展示
  if (showOnOpen) {
    renderDropdown();
  }

  return {
    flush: () => {
      if (!composing && field.value.trim()) {
        commitTag(field.value);
      }
    },
    focus: () => field.focus(),
  };
}

/**
 * 补全候选聚合：当前文档 OB 标签（置顶）→ 已用标签 → OB 全库标签 → 全库 md 文件名。
 * 按 tagKey 去重（保留首次出现），各组内部按名称排序，当前文档组始终排最前。
 * 纯函数，不读磁盘；调用方负责从 metadataCache 采集标签。
 */
export function buildTagSuggestions(
  existingTags: readonly string[],
  markdownBasenames: readonly string[],
  obsidianTags: readonly string[] = [],
  currentFileTags: readonly string[] = [],
): TagSuggestion[] {
  const seen = new Set<string>();
  const result: TagSuggestion[] = [];

  const pushGroup = (names: readonly string[], kind: TagSuggestionKind): TagSuggestion[] => {
    const group: TagSuggestion[] = [];
    for (const name of names) {
      const cleaned = normalizeTag(name);
      const key = tagKey(cleaned ?? "");
      if (!cleaned || !key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      group.push({ name: cleaned, kind });
    }
    return group.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
  };

  // 当前文档标签必须最先占用 seen，才能压过同名的其它来源并置顶
  result.push(...pushGroup(currentFileTags, "current"));
  result.push(...pushGroup(existingTags, "used"));
  result.push(...pushGroup(obsidianTags, "ob"));
  result.push(...pushGroup(markdownBasenames, "page"));
  return result;
}

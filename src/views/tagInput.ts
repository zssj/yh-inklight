/**
 * [INPUT]: 依赖 storage/tags 的归一化规则与 dom 辅助（Obsidian HTMLElement 扩展）
 * [OUTPUT]: 对外提供 renderTagChips（只读 chip 行）、renderTagInput（可编辑 chip + 补全下拉）、
 *           TagSuggestion（带来源的补全候选，含按内容推荐与按需 AI 推荐）与 buildTagSuggestions（候选聚合，含 Obsidian 标签）；
 *           推荐项独立配额（本地按内容推荐最多 3 个、AI 推荐最多 1 个），互不挤占常规候选；
 *           AI 推荐只有用户点下拉里的 AI 行才发请求，加载/失败/无结果都在组件内维护；
 *           showSuggestionsOnOpen 供侧栏打开即显示候选；
 *           空内容折叠为「推荐 3 + 常用 5」，其余收进可点开的「还有 N 个候选」，有输入则按输入过滤；
 *           initialQuery / onQueryChange 供调用方在重绘后回填未提交输入；
 *           renderTagInput 处理中文输入法组合态，拼音选词不会误建标签
 * [POS]: views 模块的标签 UI 单点，被 sidebarView、tagBoardView、CommentModal、EpubNoteModal 共用
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { MAX_TAGS_PER_ANNOTATION, MAX_VISIBLE_TAG_CHIPS, normalizeTag, normalizeTags, tagKey } from "../storage/tags";

const MAX_SUGGESTIONS = 8;
/** 空内容折叠态：推荐之外只先给这么多，其余收进「还有 N 个候选」 */
const MAX_COMPACT_OTHERS = 5;
/** 点「展开」后常规候选的上限 */
const MAX_EXPANDED_OTHERS = 20;
/** 按内容推荐的标签独立配额，不挤占常规候选 */
const MAX_RECOMMENDATIONS = 3;
/** AI 推荐独立配额：默认只加 1 条，不挤占本地 3 条推荐 */
const MAX_AI_RECOMMENDATIONS = 1;

/** 补全候选的来源，决定下拉右侧的角标文案 */
export type TagSuggestionKind = "current" | "used" | "ob" | "page" | "recommended" | "ai";

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
  ai: "AI 推荐",
};

export interface TagChipOptions {
  /** 最多展示几个 chip，默认 4；超出折叠为 +N */
  max?: number;
  onChipClick?: (tag: string) => void;
  /** 点「+N」展开：回传被点的节点，宿主要用它当浮动面板的锚点 */
  onOverflowClick?: (anchor: HTMLElement) => void;
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
        options.onOverflowClick?.(more);
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
  /**
   * 按需请求 AI 推荐标签。只有用户点下拉里的「AI 推荐」行才会调用：
   * force=false 表示可复用调用方缓存；force=true 表示用户明确要求重新获取。
   * 返回值必须是调用方已经校验过的、确实存在于标签库中的展示名。
   */
  onRequestAi?: (force: boolean) => Promise<readonly string[]>;
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
  /** 空内容折叠态是否已点开「还有 N 个候选」 */
  let showAll = false;
  /** 侧栏要求打开即显示；有按内容推荐项时其它调用方也保持打开即显示 */
  const showOnOpen = options.showSuggestionsOnOpen === true
    || options.suggestions.some((item) => item.kind === "recommended")
    || typeof options.onRequestAi === "function";
  const hasAi = typeof options.onRequestAi === "function";
  /** AI 推荐是组件内的按需状态：不进入宿主的 suggestions 数组，避免重绘时被当成普通候选 */
  let aiState: "idle" | "loading" | "empty" | "error" = "idle";
  let aiSuggestions: TagSuggestion[] = [];
  let aiRequestId = 0;
  let requestAi = async (_force: boolean): Promise<void> => {};
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
    // 关闭/提交后让在途 AI 请求失效，避免它晚到又把下拉重新弹开
    aiRequestId += 1;
    dropdown.addClass("yh-hidden");
    dropdown.empty();
    matches = [];
    activeIndex = 0;
    showAll = false;
  };

  const renderDropdown = (): void => {
    const raw = field.value;
    const suggestion = normalizeTag(raw);
    const existing = new Set(tags.map((tag) => tagKey(tag)));
    const seen = new Set<string>();
    const query = (suggestion ?? "").toLowerCase();

    // 空内容折叠态：推荐最多 3 个 + 其余最多 5 个，剩下的收进「还有 N 个候选」；
    // 一旦有输入就按输入过滤、不再折叠，搜索能力不受影响
    const compact = !query && !showAll;
    const othersLimit = compact
      ? MAX_COMPACT_OTHERS
      : (showAll ? MAX_EXPANDED_OTHERS : MAX_SUGGESTIONS);
    const pool: TagSuggestion[] = [];
    let recommendedCount = 0;
    let aiCount = 0;
    let otherCount = 0;
    let hiddenCount = 0;
    // 本地候选在前、AI 候选在后：同名的本地推荐优先，AI 不会重复占位
    for (const item of [...options.suggestions, ...aiSuggestions]) {
      const key = tagKey(item.name);
      if (!key || existing.has(key) || seen.has(key)) {
        continue;
      }
      if (query && !item.name.toLowerCase().includes(query)) {
        continue;
      }
      if (item.kind === "recommended") {
        if (recommendedCount >= MAX_RECOMMENDATIONS) {
          continue;
        }
        recommendedCount += 1;
      } else if (item.kind === "ai") {
        if (aiCount >= MAX_AI_RECOMMENDATIONS) {
          continue;
        }
        aiCount += 1;
      } else {
        if (otherCount >= othersLimit) {
          hiddenCount += 1;
          continue;
        }
        otherCount += 1;
      }
      seen.add(key);
      pool.push(item);
    }

    matches = pool;
    const canCreate = Boolean(suggestion) && !existing.has(tagKey(suggestion!)) && !pool.some((item) => tagKey(item.name) === tagKey(suggestion!));
    const showQuick = !query && Boolean(options.quickApply?.tags.length);
    const showAiTrigger = !query && hasAi;

    if (matches.length === 0 && !canCreate && !showQuick && !showAiTrigger) {
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
      } else if (item.kind === "ai") {
        row.addClass("is-ai");
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

    if (showAiTrigger) {
      const row = dropdown.createDiv({ cls: "yh-tag-suggest-item yh-tag-suggest-ai" });
      const label = aiState === "loading"
        ? "AI 推荐中…"
        : aiState === "error"
          ? "AI 推荐失败"
          : aiState === "empty"
            ? "AI 没找到合适的标签"
            : aiSuggestions.length > 0
              ? "重新获取 AI 推荐"
              : "✨ AI 推荐标签";
      const kind = aiState === "loading"
        ? "请稍候"
        : aiState === "error" || aiState === "empty"
          ? "点此重试"
          : aiSuggestions.length > 0
            ? "重新获取"
            : "点击获取";
      row.createSpan({ cls: "yh-tag-suggest-name", text: label });
      row.createSpan({ cls: "yh-tag-suggest-kind", text: kind });
      if (aiState === "loading") {
        row.addClass("is-loading");
      } else {
        row.addEventListener("mousedown", (event) => {
          event.preventDefault();
          // 失败/无结果/已有结果时都强制重算；首次点按可复用宿主缓存
          void requestAi(aiState !== "idle" || aiSuggestions.length > 0);
        });
      }
    }

    // 折叠态剩下多少条：点一下展开，固定排在候选末尾、新建项之前
    if (hiddenCount > 0) {
      const more = dropdown.createDiv({ cls: "yh-tag-suggest-item yh-tag-suggest-more" });
      more.createSpan({ cls: "yh-tag-suggest-name", text: `还有 ${hiddenCount} 个候选…` });
      more.createSpan({ cls: "yh-tag-suggest-kind", text: "展开" });
      more.addEventListener("mousedown", (event) => {
        event.preventDefault();
        showAll = true;
        renderDropdown();
      });
    }

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

  requestAi = async (force: boolean): Promise<void> => {
    if (!options.onRequestAi || aiState === "loading") {
      return;
    }
    const token = ++aiRequestId;
    aiState = "loading";
    aiSuggestions = [];
    renderDropdown();
    try {
      const names = await options.onRequestAi(force);
      if (token !== aiRequestId) {
        return;
      }
      const current = new Set(tags.map((tag) => tagKey(tag)));
      aiSuggestions = names
        .filter((name) => {
          const key = tagKey(name);
          return !!key && !current.has(key);
        })
        .map((name) => ({ name, kind: "ai" as const }));
      aiState = aiSuggestions.length > 0 ? "idle" : "empty";
    } catch {
      if (token !== aiRequestId) {
        return;
      }
      aiState = "error";
    }
    if (wrap.isConnected) {
      renderDropdown();
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

  /** sort=false 时保留调用方给的顺序：已用标签按使用文件数降序，比字典序更有用 */
  const pushGroup = (names: readonly string[], kind: TagSuggestionKind, sort = true): TagSuggestion[] => {
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
    return sort
      ? group.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"))
      : group;
  };

  // 当前文档标签必须最先占用 seen，才能压过同名的其它来源并置顶
  result.push(...pushGroup(currentFileTags, "current"));
  // 已用标签保持 getTagDictionary 的频率降序：折叠态先露出来的就是最常用的
  result.push(...pushGroup(existingTags, "used", false));
  result.push(...pushGroup(obsidianTags, "ob"));
  result.push(...pushGroup(markdownBasenames, "page"));
  return result;
}

/**
 * [INPUT]: 依赖 storage/tags 的归一化规则与 dom 辅助（Obsidian HTMLElement 扩展）
 * [OUTPUT]: 对外提供 renderTagChips（只读 chip 行）与 renderTagInput（可编辑 chip + 补全下拉）
 * [POS]: views 模块的标签 UI 单点，被 sidebarView、tagBoardView、CommentModal、EpubNoteModal 共用
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { MAX_TAGS_PER_ANNOTATION, MAX_VISIBLE_TAG_CHIPS, normalizeTag, normalizeTags, tagKey } from "../storage/tags";

const MAX_SUGGESTIONS = 8;

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
  /** 补全候选：已有标签 ∪ 全库 md 文件名 */
  suggestions: readonly string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}

/**
 * 可编辑的标签输入：chip + 输入框 + 自定义补全下拉。
 * 自管理状态，任何增删都会立刻回调 onChange 并重绘 chip。
 */
export function renderTagInput(parent: HTMLElement, options: TagInputOptions): void {
  const wrap = parent.createDiv({ cls: "yh-tag-input" });
  const chipWrap = wrap.createDiv({ cls: "yh-tag-input-chips" });
  const field = wrap.createEl("input", {
    cls: "yh-tag-input-field",
    attr: { type: "text", placeholder: options.placeholder ?? "添加标签…", spellcheck: "false" },
  });
  const dropdown = wrap.createDiv({ cls: "yh-tag-suggest" });
  dropdown.addClass("yh-hidden");

  let tags = normalizeTags(options.tags);
  let matches: string[] = [];
  let activeIndex = 0;

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

    const pool: string[] = [];
    for (const name of options.suggestions) {
      const key = tagKey(name);
      if (!key || existing.has(key) || seen.has(key)) {
        continue;
      }
      if (query && !name.toLowerCase().includes(query)) {
        continue;
      }
      seen.add(key);
      pool.push(name);
      if (pool.length >= MAX_SUGGESTIONS) {
        break;
      }
    }

    matches = pool;
    const canCreate = Boolean(suggestion) && !existing.has(tagKey(suggestion!)) && !pool.some((name) => tagKey(name) === tagKey(suggestion!));

    if (matches.length === 0 && !canCreate) {
      closeDropdown();
      return;
    }

    dropdown.removeClass("yh-hidden");
    dropdown.empty();
    activeIndex = Math.min(activeIndex, Math.max(0, matches.length - 1));

    matches.forEach((name, index) => {
      const item = dropdown.createDiv({ cls: "yh-tag-suggest-item" });
      item.createSpan({ cls: "yh-tag-suggest-name", text: name });
      item.createSpan({ cls: "yh-tag-suggest-kind", text: "概念页" });
      if (index === activeIndex) {
        item.addClass("is-active");
      }
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        commitTag(name);
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

  field.addEventListener("input", () => {
    activeIndex = 0;
    renderDropdown();
  });

  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === "," || event.key === "，") {
      event.preventDefault();
      const picked = !dropdown.hasClass("yh-hidden") ? matches[activeIndex] : undefined;
      commitTag(picked ?? field.value);
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

  field.addEventListener("blur", () => {
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
}

/** 补全候选：已有标签 + 全库 md 文件名（概念页名），去重后按长度升序便于短名优先 */
export function buildTagSuggestions(existingTags: readonly string[], markdownBasenames: readonly string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const name of [...existingTags, ...markdownBasenames]) {
    const key = tagKey(name);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(name);
  }
  return merged.sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
}

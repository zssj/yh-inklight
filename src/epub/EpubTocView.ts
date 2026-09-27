/**
 * [INPUT]: 依赖 Obsidian ItemView API 与 EpubReaderView 的目录访问器
 * [OUTPUT]: 提供 EpubTocView，EPUB 目录的 Obsidian 原生左侧栏视图
 * [POS]: 手机端左边缘滑入的目录侧栏，与右侧批注面板对称
 */

import { ItemView, WorkspaceLeaf } from "obsidian";
import { EpubReaderView, EPUB_READER_VIEW_TYPE } from "./EpubReaderView";

export const EPUB_TOC_VIEW_TYPE = "inklight-epub-toc";

const EMPTY_HINT_NO_READER = "请先打开电子书";
const EMPTY_HINT_NO_TOC = "未找到目录信息。";

export class EpubTocView extends ItemView {
	/** 上次渲染的指纹，避免 relocate/leaf 切换时无谓重建列表 */
	private lastFingerprint: string | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return EPUB_TOC_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "目录";
	}

	getIcon(): string {
		return "list";
	}

	async onOpen(): Promise<void> {
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => void this.renderToc()),
		);
		await this.renderToc();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	/** 供 main.ts 在目录/当前位置变化后刷新（内部按指纹去重）。 */
	refresh(): void {
		void this.renderToc();
	}

	/**
	 * 定位当前应显示的 EpubReaderView。
	 * 焦点可能落在左侧栏本身，故不能用 getActiveViewOfType，改用
	 * rootSplit 内最近活跃 leaf + 全量 reader leaf 兜底；延迟加载的 leaf 需先 load。
	 */
	private async reader(): Promise<EpubReaderView | null> {
		const workspace = this.app.workspace;
		const pool: WorkspaceLeaf[] = [];
		const recent = workspace.getMostRecentLeaf(workspace.rootSplit);
		if (recent) {
			pool.push(recent);
		}
		pool.push(...workspace.getLeavesOfType(EPUB_READER_VIEW_TYPE));

		for (const leaf of pool) {
			if (leaf.view instanceof EpubReaderView) {
				return leaf.view;
			}
			if (leaf.view?.getViewType() !== EPUB_READER_VIEW_TYPE) {
				continue;
			}
			try {
				await leaf.loadIfDeferred();
			} catch {
				continue;
			}
			if (leaf.view instanceof EpubReaderView) {
				return leaf.view;
			}
		}
		return null;
	}

	/** 渲染指纹：换书、目录重建、高亮条目变化时才重建 DOM。 */
	private fingerprint(reader: EpubReaderView | null): string {
		if (!reader) {
			return "no-reader";
		}
		return [
			reader.file?.path ?? "",
			reader.getTocEntries().length,
			reader.getActiveTocIndex(),
		].join("|");
	}

	private async renderToc(): Promise<void> {
		const container = this.contentEl;
		const reader = await this.reader();
		if (!container.isConnected) {
			return;
		}
		const fingerprint = this.fingerprint(reader);
		if (fingerprint === this.lastFingerprint) {
			return;
		}
		this.lastFingerprint = fingerprint;

		container.empty();
		container.addClass("yh-epub-toc-view");

		if (!reader) {
			container.createDiv({ cls: "yh-epub-empty", text: EMPTY_HINT_NO_READER });
			return;
		}
		const entries = reader.getTocEntries();
		if (entries.length === 0) {
			container.createDiv({ cls: "yh-epub-empty", text: EMPTY_HINT_NO_TOC });
			return;
		}

		const list = container.createDiv({ cls: "yh-epub-toc-list" });
		const activeIndex = reader.getActiveTocIndex();

		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			const item = list.createEl("button", {
				cls: `yh-epub-toc-item${i === activeIndex ? " is-current" : ""}`,
				text: entry.label,
				attr: { type: "button" },
			});
			item.addEventListener("click", () => {
				reader.navigateToSpineIndex(entry);
				this.app.workspace.leftSplit.collapse();
			});
		}

		if (activeIndex >= 0) {
			const activeEl = list.children[activeIndex] as HTMLElement;
			setTimeout(() => activeEl?.scrollIntoView({ block: "center" }), 50);
		}
	}
}

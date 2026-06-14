/**
 * [INPUT]: 依赖 Obsidian vault API、storage/types 的 EPUB 标注类型、AnnotationStore 读取 sidecar
 * [OUTPUT]: 对外提供 EpubExcerptExporter，将 EPUB 标注导出为 Markdown 摘录文件
 * [POS]: epub 模块的摘录导出入口，Phase 4-B P1「摘录导出」核心
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 *
 * 导出格式（与 EpubGotoHandler 约定一致，参考 ob-epub AnnotationVaultStore.buildBlock）：
 *   ---
 *   title: 《书名》摘录
 *   source: path/to/book.epub
 *   ---
 *
 *   > [!inklight-epub|yellow] 章节 · 2026-06-13 14:30 ^epub-<id>
 *   > 选中的原文
 *   >
 *   > 💡 想法内容（仅 comment 标注）
 *   >
 *   > [回到原文](#^epub-<id>)
 *
 *   <!-- yh-epub-cfi: epubcfi(...) -->
 *   ---
 *
 * 回链机制：EpubGotoHandler 拦截「回到原文」点击 → 找附近 CFI 注释 → 从文件名推断 epub → openAtCfi。
 */

import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";

import {
	AnnotationColor,
	COLOR_LABELS,
	EpubCommentAnnotation,
	EpubHighlightAnnotation,
	FileAnnotationDocument,
	PdfCommentAnnotation,
	PdfHighlightAnnotation,
} from "../storage/types";
import { AnnotationStore } from "../storage/annotationStore";

export interface EpubExcerptExporterOptions {
	app: App;
	store: AnnotationStore;
	/** 摘录导出目录（vault 相对路径），默认 epub-excerpts */
	excerptFolder: string;
	/** 是否生成回链（兑现 epubBacklinkRendering） */
	backlinkRendering: boolean;
	/** 默认作者 */
	defaultAuthor: string;
}

/** 高亮颜色 → Obsidian callout 元数据色名（1-6） */
const COLOR_TO_CALLOUT_META: Record<AnnotationColor, string> = {
	yellow: "yellow",
	green: "green",
	blue: "blue",
	pink: "pink",
	orange: "orange",
	purple: "purple",
};

export class EpubExcerptExporter {
	constructor(private readonly options: EpubExcerptExporterOptions) {}

	/**
	 * 导出指定 EPUB 文件的所有标注为 Markdown 摘录。
	 * 文件路径：`${excerptFolder}/《书名》摘录.md`。
	 *
	 * @param file - EPUB 源文件
	 * @returns 导出的文件路径，无标注时返回 null
	 */
	async exportToFile(file: TFile): Promise<TFile | null> {
		const document = await this.options.store.getDocument(file);
		const isPdf = file.extension.toLowerCase() === "pdf";
		const highlights = isPdf ? document.pdfHighlights : document.epubHighlights;
		const comments = isPdf ? document.pdfComments : document.epubComments;

		if (highlights.length === 0 && comments.length === 0) {
			new Notice("该书暂无标注，无需导出。");
			return null;
		}

		const markdown = this.buildMarkdown(file, document);
		const targetPath = await this.resolveExportPath(file);
		await this.ensureFolder(targetPath);

		const existing = this.options.app.vault.getAbstractFileByPath(targetPath);
		if (existing instanceof TFile) {
			await this.options.app.vault.modify(existing, markdown);
			new Notice(`摘录已更新：${targetPath}`);
			return existing;
		}
		const created = await this.options.app.vault.create(targetPath, markdown);
		new Notice(`摘录已导出：${targetPath}`);
		return created;
	}

	/**
	 * 书籍改名时迁移摘录文件的关联（Phase 7 改名支持）。
	 * ① 更新摘录 frontmatter 的 source 路径；② 重命名摘录文件（《旧名》摘录.md → 《新名》摘录.md）。
	 *
	 * @param oldPath - 旧文件路径
	 * @param newPath - 新文件路径
	 */
	async migrateExcerptSource(oldPath: string, newPath: string): Promise<void> {
		const folder = this.options.excerptFolder.trim() || "epub-excerpts";
		const folderFile = this.options.app.vault.getAbstractFileByPath(folder);
		if (!(folderFile instanceof TFolder)) {
			return;
		}

		const oldBasename = (oldPath.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
		const newBasename = (newPath.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
		const oldSourceLine = `source: ${oldPath}`;
		const newSourceLine = `source: ${newPath}`;
		const oldExcerptName = `《${oldBasename}》摘录.md`;
		const newExcerptName = `《${newBasename}》摘录.md`;

		for (const file of folderFile.children) {
			if (!(file instanceof TFile) || file.extension !== "md") {
				continue;
			}
			const content = await this.options.app.vault.read(file);
			if (!content.includes(oldSourceLine)) {
				continue;
			}
			// 更新 frontmatter source
			const updated = content.replace(oldSourceLine, newSourceLine);
			await this.options.app.vault.modify(file, updated);

			// 重命名摘录文件（如果文件名遵循 《书名》摘录.md 模式）
			if (file.name === oldExcerptName && oldExcerptName !== newExcerptName) {
				const newPath2 = `${folder}/${newExcerptName}`;
				await this.options.app.vault.rename(file, newPath2).catch(() => {
					/* 目标可能已存在或并发改名 */
				});
			}
		}
	}

	/** 构建完整的 Markdown 摘录文本。 */
	private buildMarkdown(file: TFile, document: FileAnnotationDocument): string {
		const isPdf = file.extension.toLowerCase() === "pdf";
		const title = file.basename;
		const now = new Date();
		const parts: string[] = [];

		parts.push("---");
		parts.push(`title: 《${title}》${isPdf ? "PDF" : ""}摘录`);
		parts.push(`source: ${file.path}`);
		parts.push(`exportedAt: ${now.toISOString()}`);
		parts.push(`highlights: ${isPdf ? document.pdfHighlights.length : document.epubHighlights.length}`);
		parts.push(`notes: ${isPdf ? document.pdfComments.length : document.epubComments.length}`);
		parts.push("---");
		parts.push("");
		parts.push(`# 《${title}》摘录`);
		parts.push("");

		// 合并并按创建时间倒序（最新的在前）
		const entries = this.collectEntries(document, isPdf);
		for (const entry of entries) {
			parts.push(this.buildEntryBlock(entry, isPdf, file));
			parts.push("");
		}

		if (entries.length === 0) {
			parts.push("（暂无标注）");
			parts.push("");
		}

		return parts.join("\n");
	}

	private collectEntries(document: FileAnnotationDocument, isPdf = false): ExcerptEntry[] {
		if (isPdf) {
			return [
				...document.pdfHighlights.map((highlight) => this.pdfHighlightToEntry(highlight)),
				...document.pdfComments.map((comment) => this.pdfCommentToEntry(comment)),
			].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		}

		const highlights: ExcerptEntry[] = document.epubHighlights.map((h) => ({
			id: h.id,
			kind: "highlight",
			color: h.color,
			selectedText: h.anchor.selectedText,
			chapter: h.anchor.chapter,
			cfiRange: h.anchor.cfiRange,
			pageNumber: null,
			note: "",
			createdAt: h.createdAt,
		}));
		const comments: ExcerptEntry[] = document.epubComments.map((c) => ({
			id: c.id,
			kind: "comment",
			color: c.color,
			selectedText: c.anchor.selectedText,
			chapter: c.anchor.chapter,
			cfiRange: c.anchor.cfiRange,
			pageNumber: null,
			note: c.note,
			createdAt: c.createdAt,
		}));
		return [...highlights, ...comments].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	private pdfHighlightToEntry(highlight: PdfHighlightAnnotation): ExcerptEntry {
		return {
			id: highlight.id,
			kind: "highlight",
			color: highlight.color,
			selectedText: highlight.anchor.selectedText,
			chapter: `Page ${highlight.anchor.pageNumber}`,
			cfiRange: "",
			pageNumber: highlight.anchor.pageNumber,
			note: "",
			createdAt: highlight.createdAt,
		};
	}

	private pdfCommentToEntry(comment: PdfCommentAnnotation): ExcerptEntry {
		return {
			id: comment.id,
			kind: "comment",
			color: comment.color,
			selectedText: comment.anchor.selectedText,
			chapter: `Page ${comment.anchor.pageNumber}`,
			cfiRange: "",
			pageNumber: comment.anchor.pageNumber,
			note: comment.content,
			createdAt: comment.createdAt,
		};
	}

	private buildEntryBlock(entry: ExcerptEntry, isPdf = false, file?: TFile): string {
		const blockId = `${isPdf ? "pdf" : "epub"}-${entry.id}`;
		const colorMeta = COLOR_TO_CALLOUT_META[entry.color] ?? "yellow";
		const dateLabel = this.formatDate(new Date(entry.createdAt));
		const chapterLabel = isPdf ? `Page ${entry.pageNumber ?? "?"}` : entry.chapter?.trim() || "Untitled section";
		const calloutType = isPdf ? "inklight-pdf" : "inklight-epub";
		const header = `> [!${calloutType}|${colorMeta}] ${chapterLabel} - ${dateLabel} ^${blockId}`;

		const lines: string[] = [header];
		for (const line of entry.selectedText.split(/\r?\n/)) {
			lines.push(`> ${line}`);
		}

		if (entry.kind === "comment" && entry.note.trim()) {
			lines.push(">");
			for (const line of entry.note.split(/\r?\n/)) {
				lines.push(`> Note: ${line}`);
			}
		}

		if (this.options.backlinkRendering) {
			lines.push(">");
			if (isPdf && file) {
				const link = this.options.app.fileManager.generateMarkdownLink(
					file,
					"",
					`#page=${entry.pageNumber ?? 1}`,
					"Back to source",
				);
				lines.push(`> ${link}`);
			} else {
				lines.push(`> [Back to source](#^${blockId})`);
			}
		}

		const anchorLine = isPdf
			? `> <span style="display:none" data-yh-pdf-page="${entry.pageNumber ?? ""}" data-yh-pdf-id="${entry.id}"></span>`
			: `> <span style="display:none" data-yh-cfi="${entry.cfiRange}"></span>`;

		return `${lines.join("\n")}\n${anchorLine}\n\n---`;
	}

	/** 解析导出目标路径：`${excerptFolder}/《书名》摘录.md`。 */
	private async resolveExportPath(file: TFile): Promise<string> {
		const isPdf = file.extension.toLowerCase() === "pdf";
		const folder = this.options.excerptFolder.trim() || "epub-excerpts";
		const safeTitle = file.basename.replace(/[\\/:*?"<>|]/g, "_");
		return normalizePath(`${folder}/《${safeTitle}》${isPdf ? "PDF" : ""}摘录.md`);
	}

	/** 确保导出目录存在。 */
	private async ensureFolder(filePath: string): Promise<void> {
		const folderPath = filePath.split("/").slice(0, -1).join("/");
		if (!folderPath) {
			return;
		}
		const existing = this.options.app.vault.getAbstractFileByPath(folderPath);
		if (existing instanceof TFolder) {
			return;
		}
		await this.options.app.vault.createFolder(folderPath).catch(() => {
			/* 目录可能已被并发创建 */
		});
	}

	private formatDate(date: Date): string {
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}
}

interface ExcerptEntry {
	pageNumber?: number | null;
	id: string;
	kind: "highlight" | "comment";
	color: AnnotationColor;
	selectedText: string;
	chapter: string;
	cfiRange: string;
	note: string;
	createdAt: string;
}

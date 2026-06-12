/**
 * [INPUT]: 依赖 epubjs Rendition.annotations API、storage/types 的 EPUB 标注类型、
 *          AnnotationStore 的 sidecar 持久化接口、AnnotationPluginSettings 的 EPUB 样式设置
 * [OUTPUT]: 对外提供 EpubAnnotationBridge，负责 epubjs annotations API <-> sidecar JSON 的双向同步
 * [POS]: epub 模块的标注渲染/移除/刷新真相源，被 EpubReaderView 消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import {
	AnnotationPluginSettings,
	EPUB_COLOR_MAP,
	EpubCommentAnnotation,
	EpubHighlightAnnotation,
} from "../storage/types";
import { AnnotationStore } from "../storage/annotationStore";

// ---- SVG highlight styles ----

/**
 * Build the epub.js annotations.add() styles object based on EpubHighlightStyle.
 *
 * - fill: translucent color overlay (EPUB_COLOR_MAP rgba value)
 * - underline: stroke only, no fill
 * - wavy: stroke with wavy pattern, no fill
 */
function buildHighlightStyles(
	color: AnnotationColor,
	style: AnnotationPluginSettings["epubHighlightStyle"],
): Record<string, string> {
	const rgba = EPUB_COLOR_MAP[color];

	if (style === "underline") {
		return {
			fill: "transparent",
			stroke: rgba,
			"stroke-width": "2",
			"stroke-linecap": "round",
		};
	}

	if (style === "wavy") {
		return {
			fill: "transparent",
			stroke: rgba,
			"stroke-width": "1.5",
			"stroke-linecap": "round",
			"stroke-dasharray": "2,2",
		};
	}

	// Default: fill
	return {
		fill: rgba,
		"fill-opacity": "1",
		"mix-blend-mode": "multiply",
	};
}

// ---- Note icon ----

const NOTE_TYPE_ICONS: Record<string, string> = {
	insight: "\u{1F4A1}",
	question: "\u{2753}",
	reminder: "\u{1F514}",
};

const DEFAULT_NOTE_ICON = "\u{1F4DD}";

function noteIconForAnnotation(annotation: EpubCommentAnnotation): string {
	return NOTE_TYPE_ICONS[annotation.noteType ?? ""] ?? DEFAULT_NOTE_ICON;
}

// ---- EpubAnnotationBridge ----

/**
 * Bridge between epubjs annotations rendering API and the sidecar JSON persistence layer.
 *
 * Responsibilities:
 * 1. Load annotations from sidecar and draw them onto a rendition
 * 2. Draw / remove individual highlights
 * 3. Refresh all highlights (e.g. after a file change)
 * 4. Position note icons at the right edge of highlights
 */
export class EpubAnnotationBridge {
	constructor(
		private readonly store: AnnotationStore,
		private readonly settings: AnnotationPluginSettings,
	) {}

	// ================================================================
	// Public API
	// ================================================================

	/**
	 * Load all annotations from sidecar for the given EPUB file and draw them
	 * onto the rendition. This is the primary entry point after a book is opened.
	 */
	async loadAnnotations(rendition: any, epubFilePath: string): Promise<void> {
		const document = this.store.getCachedDocument(epubFilePath);
		if (!document) {
			return;
		}

		for (const highlight of document.epubHighlights) {
			this.drawHighlight(highlight, rendition);
		}

		for (const comment of document.epubComments) {
			this.drawHighlight(comment, rendition);
		}
	}

	/**
	 * Draw a single annotation onto the rendition using rendition.annotations.add().
	 * The visual style (fill / underline / wavy) is determined by annotation.style,
	 * falling back to the plugin setting default.
	 */
	drawHighlight(
		annotation: EpubHighlightAnnotation | EpubCommentAnnotation,
		rendition: any,
	): void {
		if (!rendition?.annotations) {
			return;
		}

		const effectiveStyle = annotation.style ?? this.settings.epubHighlightStyle;
		const cfiRange = annotation.anchor.cfiRange;
		const styles = buildHighlightStyles(annotation.color, effectiveStyle);

		try {
			rendition.annotations.add(
				"highlight",
				cfiRange,
				{ id: annotation.id },
				undefined,
				"yh-epub-highlight",
				styles,
			);
		} catch (error) {
			console.error("yh-inklight: Failed to draw highlight", cfiRange, error);
		}
	}

	/**
	 * Remove a single highlight from the rendition by its CFI range.
	 * Used when an annotation is deleted or when refreshing (clear-then-redraw).
	 */
	removeHighlight(cfiRange: string, rendition: any): void {
		if (!rendition?.annotations) {
			return;
		}

		try {
			rendition.annotations.remove(cfiRange, "highlight");
		} catch (error) {
			// epubjs may throw if the annotation does not exist (e.g. already removed)
			console.warn("yh-inklight: Failed to remove highlight", cfiRange, error);
		}
	}

	/**
	 * Refresh all annotations on the rendition.
	 * Clears every existing highlight via annotations.reset() (when available) or
	 * iterates stored annotations and removes them individually, then redraws all.
	 */
	async refreshAnnotations(rendition: any, epubFilePath: string): Promise<void> {
		if (!rendition?.annotations) {
			return;
		}

		const annotations = rendition.annotations as any;
		if (typeof annotations.reset === "function") {
			annotations.reset();
		} else {
			this.removeAllRenderedHighlights(rendition, epubFilePath);
		}

		await this.loadAnnotations(rendition, epubFilePath);
	}

	/**
	 * Synchronize note icon elements (emoji circles) to the right edge of each
	 * comment annotation highlight inside the reader container.
	 *
	 * Icons are positioned absolutely within readerEl based on the highlight
	 * bounding rect from the epub iframe, offset by the plugin settings.
	 */
	syncNoteIcons(
		readerEl: HTMLElement,
		rendition: any,
		annotations: (EpubHighlightAnnotation | EpubCommentAnnotation)[],
	): void {
		// Remove any stale icons from previous sync
		const staleIcons = readerEl.querySelectorAll(".yh-epub-note-icon");
		for (const icon of Array.from(staleIcons)) {
			icon.remove();
		}

		const comments = annotations.filter(
			(item): item is EpubCommentAnnotation => item.type === "epub-comment",
		);

		if (comments.length === 0) {
			return;
		}

		const iframe = readerEl.querySelector("iframe");
		if (!iframe) {
			return;
		}

		const iframeRect = iframe.getBoundingClientRect();
		const readerRect = readerEl.getBoundingClientRect();
		const offsetX = iframeRect.left - readerRect.left;
		const offsetY = iframeRect.top - readerRect.top;

		const iconSize = this.settings.epubNoteIconSize;
		const iconOffsetX = this.settings.epubNoteIconOffsetX;
		const iconOffsetY = this.settings.epubNoteIconOffsetY;

		for (const comment of comments) {
			const marker = this.findHighlightMarker(readerEl, comment.anchor.cfiRange);
			if (!marker) {
				continue;
			}

			const markerRect = marker.getBoundingClientRect();

			const iconEl = readerEl.createDiv({ cls: "yh-epub-note-icon" });
			iconEl.setText(noteIconForAnnotation(comment));
			iconEl.setAttribute("data-yh-annotation-id", comment.id);
			iconEl.setAttribute("aria-label", comment.note.slice(0, 80));

			const left = offsetX + markerRect.right - readerRect.left + iconOffsetX;
			const top = offsetY + markerRect.top - readerRect.top + (markerRect.height - iconSize) / 2 + iconOffsetY;

			iconEl.style.position = "absolute";
			iconEl.style.left = `${Math.round(left)}px`;
			iconEl.style.top = `${Math.round(top)}px`;
			iconEl.style.width = `${iconSize}px`;
			iconEl.style.height = `${iconSize}px`;
			iconEl.style.fontSize = `${Math.round(iconSize * 0.6)}px`;
			iconEl.style.lineHeight = `${iconSize}px`;
			iconEl.style.textAlign = "center";
			iconEl.style.borderRadius = "50%";
			iconEl.style.pointerEvents = "auto";
			iconEl.style.cursor = "pointer";
			iconEl.style.zIndex = "10";
		}
	}

	// ================================================================
	// Private helpers
	// ================================================================

	/**
	 * Attempt to remove all rendered highlights for the given file by iterating
	 * the cached document and calling removeHighlight for each annotation's CFI.
	 * Used as a fallback when annotations.reset() is not available.
	 */
	private removeAllRenderedHighlights(rendition: any, epubFilePath: string): void {
		const document = this.store.getCachedDocument(epubFilePath);
		if (!document) {
			return;
		}

		const allCfiRanges = [
			...document.epubHighlights.map((h) => h.anchor.cfiRange),
			...document.epubComments.map((c) => c.anchor.cfiRange),
		];

		for (const cfiRange of allCfiRanges) {
			this.removeHighlight(cfiRange, rendition);
		}
	}

	/**
	 * Find the SVG highlight marker element inside the epub iframe that
	 * corresponds to the given CFI range. epubjs renders highlights as SVG
	 * rect elements inside the content document.
	 */
	private findHighlightMarker(readerEl: HTMLElement, cfiRange: string): Element | null {
		const iframe = readerEl.querySelector("iframe");
		if (!iframe?.contentDocument) {
			return null;
		}

		// epubjs stores annotation data on the SVG element via epubcfi attribute
		const markers = iframe.contentDocument.querySelectorAll(`[ref="${cfiRange}"]`);
		if (markers.length > 0) {
			return markers[0];
		}

		// Fallback: look for epubjs highlight elements by class
		const allHighlights = iframe.contentDocument.querySelectorAll(".yh-epub-highlight");
		for (const el of Array.from(allHighlights)) {
			const elCfi = el.getAttribute("ref") ?? el.getAttribute("data-cfi-range") ?? "";
			if (elCfi === cfiRange) {
				return el;
			}
		}

		return null;
	}
}

// ---- Type guard helper ----

type AnnotationColor = keyof typeof EPUB_COLOR_MAP;

/** Re-export for consumers that import AnnotationColor via this module */
export type { AnnotationColor };

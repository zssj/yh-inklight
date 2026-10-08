/**
 * [INPUT]: 无（纯工具模块，只依赖浏览器 canvas 文本测量与 Obsidian CSS 变量）
 * [OUTPUT]: 对外提供固定字体选项、本机可用字体探测、字体设置值到 CSS font-family 串的解析
 * [POS]: epub 模块的字体真相源，被 EpubReaderView 与设置页消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 *
 * 背景：安卓 WebView 不支持 Local Font Access API（queryLocalFonts，crbug.com/40840834），
 * 因此无法枚举系统已装字体清单。退而求其次用「宽度比对探测」：
 * 同一段文字分别以候选字体与通用回退族渲染，量 measureText 宽度，
 * 宽度不同即候选字体真实存在。故下拉只列出常见名单中本机命中的字体，
 * 名单之外的由设置页手填输入框兜底。
 */

/** 设置项里代表「跟随 Obsidian 正文字体」的特殊值 */
export const FONT_VALUE_OBSIDIAN = "obsidian";

export interface FontOption {
	/** 下拉显示名 */
	label: string;
	/** 实际写入 CSS 的 family 名（已探测命中且经过清洗） */
	name: string;
}

interface FontCandidate {
	label: string;
	/** 同一字体的中英/新旧 family 名变体，按顺序试，任一命中即算存在 */
	names: string[];
}

/** 永远可用、无需探测的通用族与特殊项 */
export const FIXED_FONT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: "", label: "跟随电子书" },
	{ value: FONT_VALUE_OBSIDIAN, label: "跟随 Obsidian" },
	{ value: "serif", label: "系统衬线 serif" },
	{ value: "sans-serif", label: "系统无衬线 sans-serif" },
	{ value: "monospace", label: "等宽 monospace" },
];

/** CSS 通用族关键字：本身即回退目标，不需要加回退链 */
const GENERIC_KEYWORDS = new Set([
	"serif",
	"sans-serif",
	"monospace",
	"cursive",
	"fantasy",
	"system-ui",
	"ui-serif",
	"ui-sans-serif",
	"ui-monospace",
]);

/**
 * 常见字体候选名单。覆盖安卓 ROM 常见中文字体、流行开源中文字体与常用西文字体。
 * 探测不通过的不会出现在下拉里。
 */
const FONT_CANDIDATES: ReadonlyArray<FontCandidate> = [
	// —— 开源中文字体（含霞鹜文楷各版本与名称变体）——
	{ label: "霞鹜文楷", names: ["LXGW WenKai", "霞鹜文楷", "LXGW WenKai TC", "霞鹜文楷繁"] },
	{ label: "霞鹜文楷 GB 屏幕版", names: ["LXGW WenKai GB Screen", "霞鹜文楷 GB 屏幕版", "LXGW WenKai GB"] },
	{ label: "霞鹜文楷 Bright", names: ["LXGW Bright", "霞鹜文楷 Bright"] },
	{ label: "霞鹜新晰黑", names: ["LXGW Neo XiHei", "霞鹜新晰黑"] },
	{ label: "思源宋体", names: ["Source Han Serif SC", "Noto Serif CJK SC", "Source Han Serif CN", "Noto Serif SC", "思源宋体"] },
	{ label: "思源黑体", names: ["Source Han Sans SC", "Noto Sans CJK SC", "Source Han Sans CN", "Noto Sans SC", "思源黑体"] },
	{ label: "更纱黑体", names: ["Sarasa Gothic SC", "Sarasa UI SC", "更纱黑体"] },
	{ label: "阿里巴巴普惠体", names: ["Alibaba PuHuiTi 3.0", "Alibaba PuHuiTi", "阿里巴巴普惠体"] },
	{ label: "站酷快乐体", names: ["ZCOOL KuaiLe", "站酷快乐体"] },

	// —— 系统 / 平台中文字体 ——
	{ label: "宋体", names: ["SimSun", "宋体", "NSimSun", "Songti SC", "Songti"] },
	{ label: "黑体", names: ["SimHei", "黑体", "Heiti SC", "STHeiti"] },
	{ label: "楷体", names: ["KaiTi", "楷体", "Kaiti SC", "STKaiti", "Kaiti_GB2312"] },
	{ label: "仿宋", names: ["FangSong", "仿宋", "FangSong_GB2312", "STFangsong"] },
	{ label: "微软雅黑", names: ["Microsoft YaHei", "微软雅黑", "Microsoft YaHei UI"] },
	{ label: "等线", names: ["DengXian", "等线"] },
	{ label: "苹方", names: ["PingFang SC", "苹方"] },
	{ label: "MiSans", names: ["MiSans", "小米字体"] },
	{ label: "HarmonyOS Sans", names: ["HarmonyOS Sans SC", "HarmonyOS Sans"] },
	{ label: "OPPO Sans", names: ["OPPO Sans"] },
	{ label: "vivo Sans", names: ["vivo Sans"] },
	{ label: "HONOR Sans", names: ["HONOR Sans"] },
	{ label: "方正书宋", names: ["FZShuSong-Z01", "方正书宋"] },
	{ label: "方正楷体", names: ["FZKai-Z03", "方正楷体"] },
	{ label: "方正仿宋", names: ["FZFangSong-Z02", "方正仿宋"] },

	// —— 西文 ——
	{ label: "Georgia", names: ["Georgia"] },
	{ label: "Times New Roman", names: ["Times New Roman"] },
	{ label: "Cambria", names: ["Cambria"] },
	{ label: "Garamond", names: ["EB Garamond", "Garamond", "Garamond Premier Pro"] },
	{ label: "Palatino", names: ["Palatino Linotype", "Palatino", "Book Antiqua"] },
	{ label: "Charter", names: ["Charter", "Bitstream Charter"] },
	{ label: "Constantia", names: ["Constantia"] },
	{ label: "Literata", names: ["Literata"] },
	{ label: "Merriweather", names: ["Merriweather"] },
	{ label: "Lora", names: ["Lora"] },
	{ label: "Inter", names: ["Inter"] },
	{ label: "Roboto", names: ["Roboto"] },
	{ label: "Open Sans", names: ["Open Sans"] },
	{ label: "Lato", names: ["Lato"] },
	{ label: "Segoe UI", names: ["Segoe UI"] },
	{ label: "Helvetica", names: ["Helvetica Neue", "Helvetica"] },
	{ label: "Verdana", names: ["Verdana"] },
	{ label: "Tahoma", names: ["Tahoma"] },
];

/** 探测用样本：中英数混合，任一字形缺省都会改变排版宽度 */
const PROBE_TEXT = "mmmmmmmmmmlli 永字体测试 0123456789";

/** 探测时的回退族：多备一个可避免「候选本身是等宽/衬线字体」导致的假阴性 */
const PROBE_BASELINES = ["monospace", "sans-serif", "serif"] as const;

/**
 * 去掉任何可能破坏 CSS 声明或注入的字符，只保留可打印文字。
 * 引号与反斜杠一并移除，之后由调用方统一加引号。
 */
function sanitizeFamily(raw: string): string {
	return raw.replace(/[\u0000-\u001f\u007f;{}"'\\]/g, "").trim();
}

/** 校验一段 CSS font-family 值串可安全注入（不含声明/块终结符） */
function isSafeStack(value: string): boolean {
	return !!value && !/[;{}]/.test(value);
}

/**
 * 探测单个字体名在当前设备是否真的可渲染。
 * 同一尺寸下，候选族叠加通用族的测量宽度与纯通用族基线不同 → 候选存在。
 */
export function probeFontFamily(name: string): boolean {
	const clean = sanitizeFamily(name);
	if (!clean || GENERIC_KEYWORDS.has(clean)) {
		return false;
	}
	try {
		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return false;
		}
		const measure = (stack: string): number => {
			ctx.font = `72px ${stack}`;
			return ctx.measureText(PROBE_TEXT).width;
		};
		for (const base of PROBE_BASELINES) {
			if (measure(`"${clean}", ${base}`) !== measure(base)) {
				return true;
			}
		}
		return false;
	} catch {
		return false;
	}
}

let detectedCache: FontOption[] | null = null;

/**
 * 列出本机可用的常见字体（只测一次并缓存；字体集合在进程生命周期内不变）。
 * @returns 探测命中的字体，label 供下拉显示，name 为命中的 family 名
 */
export function detectAvailableFonts(): FontOption[] {
	if (detectedCache) {
		return detectedCache;
	}
	const options: FontOption[] = [];
	for (const candidate of FONT_CANDIDATES) {
		const hit = candidate.names.find((n) => probeFontFamily(n));
		if (hit) {
			options.push({ label: candidate.label, name: sanitizeFamily(hit) });
		}
	}
	detectedCache = options;
	return options;
}

/**
 * 解析 Obsidian 的 --font-text 为可直接使用的 font-family 串。
 * 变量值可能是 var() 嵌套，故通过临时元素的计算值取最终结果。
 */
function resolveObsidianTextFontStack(): string {
	try {
		const rawVar = getComputedStyle(document.body).getPropertyValue("--font-text").trim();
		if (!rawVar) {
			return "";
		}
		const probe = document.createElement("span");
		probe.style.cssText =
			"position:absolute;left:-9999px;top:0;visibility:hidden;font-family:var(--font-text)";
		probe.textContent = "x";
		document.body.appendChild(probe);
		const stack = getComputedStyle(probe).fontFamily.trim();
		probe.remove();
		return stack;
	} catch {
		return "";
	}
}

/**
 * 把设置值解析成可注入的 font-family 值串；返回空串表示不干预（不注入规则）。
 *
 * 优先级：手填 > 下拉。通用族关键字原样返回；具体字体名附带 serif/sans-serif 回退链，
 * 设备未安装时自动回落而不是显示方块。
 *
 * @param fontFamily - 下拉存的值：`""` / `"obsidian"` / 通用族关键字 / 字体名
 * @param custom - 手填的字体名，非空时覆盖 fontFamily
 */
export function resolveFontFamily(fontFamily?: string, custom?: string): string {
	const raw = sanitizeFamily(custom ?? "") || sanitizeFamily(fontFamily ?? "");
	if (!raw) {
		return "";
	}
	if (raw === FONT_VALUE_OBSIDIAN) {
		const stack = resolveObsidianTextFontStack();
		return isSafeStack(stack) ? stack : "";
	}
	if (GENERIC_KEYWORDS.has(raw)) {
		return raw;
	}
	return `"${raw}", serif, sans-serif`;
}

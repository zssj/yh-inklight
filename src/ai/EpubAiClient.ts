/**
 * [INPUT]: 依赖 Obsidian 的 requestUrl（绕过安卓 WebView 的 CORS 限制）与 storage/types 的 AI 设置字段
 * [OUTPUT]: OpenAI 兼容聊天客户端、服务商预设、AI 动作预设与内置系统提示词、配置解析与完整性检查、连接测试
 * [POS]: ai 模块的唯一网络出口，被 EpubAiModal 与设置页消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 *
 * 实现要点：
 * - 必须走 requestUrl 而非 fetch：安卓 WebView 直连第三方 API 会被 CORS 拦下。
 * - requestUrl 不支持 SSE，故只做一次性请求，不提供流式输出。
 * - 小米 MiMo 这类推理模型默认先「思考」：思考 token 计入输出（单价是输入的 2 倍），
 *   且会吃光 max_tokens 导致 content 为空，因此请求体固定关闭 thinking。
 * - 返回体里的 reasoning_content 不是回复，只读 choices[0].message.content。
 */

import { requestUrl, type RequestUrlResponse } from "obsidian";

/** 一次请求的硬超时（毫秒）。requestUrl 不支持 AbortSignal，超时后只放弃等待。 */
const REQUEST_TIMEOUT_MS = 30_000;

/** 选中文字超过此长度即截断，避免输入侧烧掉过多 token */
const MAX_SELECTED_CHARS = 3000;

export interface AiProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
}

/** 服务商预设。自定义项放在最后，baseUrl/model 留空由用户填写。 */
export const AI_PROVIDER_PRESETS: readonly AiProviderPreset[] = [
  {
    id: "mimo",
    label: "小米 MiMo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.6-flash",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  {
    id: "tongyi",
    label: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  },
  {
    id: "kimi",
    label: "Moonshot Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
  { id: "custom", label: "自定义", baseUrl: "", model: "" },
];

export type AiActionId = "explain" | "translate" | "rewrite" | "ask";

export interface AiActionPreset {
  id: AiActionId;
  label: string;
  /** 内置系统提示词。内置动作写死篇幅上限以控制成本；「自定义」按字数区间而非硬上限组织 */
  systemPrompt: string;
  /** 组装 user 消息正文 */
  buildUserText: (selectedText: string, question?: string) => string;
}

/**
 * 内置动作预设。系统提示词刻意写得很短——它随每次请求发送，越短越省。
 * 省 token 三件套：关闭思考 + 内置动作卡死篇幅 + 不附带章节上下文。
 */
export const AI_ACTION_PRESETS: readonly AiActionPreset[] = [
  {
    id: "explain",
    label: "解释",
    systemPrompt:
      "你是中文读书助手。用简体中文，最多 3 句话说清这段话的核心含义。不要复述原文，不要客套，不要用“总的来说”这类总结词。",
    buildUserText: (text) => text,
  },
  {
    id: "translate",
    label: "翻译",
    systemPrompt:
      "把下面这段文字译成中文；若原文已是中文则译成英文。只输出译文，不要解释、不要加引号、不要加“翻译：”前缀。",
    buildUserText: (text) => text,
  },
  {
    id: "rewrite",
    label: "改写",
    systemPrompt:
      "把下面这段文字改写成通俗大白话，保留原意。用简体中文，篇幅不超过原文的 1.2 倍。只输出改写结果。",
    buildUserText: (text) => text,
  },
  {
    id: "ask",
    label: "自定义",
    systemPrompt:
      "你是中文读书助手。用简体中文，像耐心的朋友那样把问题讲清楚。先直接给出结论，再展开说明，控制在 200-300 字左右；内容多时用 1. 2. 3. 序号或短段落组织，不要使用 markdown 符号（如 #、-、**）。字词释义、读音、用法、常识或背景知识要讲透，问读音时多音字要一并列出。问题涉及所给原文时，结合原文字句具体分析；需要超出原文才能回答的部分，明确说明这是你的补充知识，不要编造。",
    buildUserText: (text, question) => `我的问题：${(question ?? "").trim()}\n\n---\n\n${text}`,
  },
];

const TEST_SYSTEM_PROMPT = "只按要求回复，不要输出任何其他内容。";

/** 发起 AI 请求所需的全部配置（由设置字段解析而来） */
export interface AiRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  /** 附加系统提示词，追加在内置动作提示词之后；留空则只用内置 */
  systemPrompt: string;
}

export interface AiChatResult {
  content: string;
  /** true 表示回复被 max_tokens 截断 */
  truncated: boolean;
}

/** AI 请求失败。message 已是可直接展示给用户的中文文案 */
export class AiRequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "AiRequestError";
    this.status = status;
  }
}

/** 把原始设置字段解析成运行时配置 */
export function resolveAiConfig(settings: {
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
  aiMaxTokens: number;
  aiTemperature: number;
  aiSystemPrompt: string;
}): AiRuntimeConfig {
  return {
    baseUrl: settings.aiBaseUrl,
    apiKey: settings.aiApiKey,
    model: settings.aiModel,
    maxTokens: settings.aiMaxTokens,
    temperature: settings.aiTemperature,
    systemPrompt: settings.aiSystemPrompt,
  };
}

/** 配置是否齐全到可以发起请求 */
export function isAiConfigured(cfg: AiRuntimeConfig): boolean {
  return !!(cfg.baseUrl.trim() && cfg.apiKey.trim() && cfg.model.trim());
}

/** 拼接 chat/completions 端点，兼容用户把完整地址粘进 Base URL 的情况 */
function buildEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) {
    throw new AiRequestError("接口地址为空，请先在设置里填写。");
  }
  if (/\/chat\/completions$/i.test(base)) {
    return base;
  }
  return `${base}/chat/completions`;
}

/** 截断过长的选中文字，避免输入侧烧掉过多 token */
export function truncateSelectedText(text: string): string {
  if (text.length <= MAX_SELECTED_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_SELECTED_CHARS)}\n…（原文过长，已截断）`;
}

/** 拼接内置动作提示词与用户附加提示词 */
export function composeSystemPrompt(action: AiActionPreset, extra?: string): string {
  const suffix = (extra ?? "").trim();
  return suffix ? `${action.systemPrompt}\n${suffix}` : action.systemPrompt;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

/** requestUrl 不支持 AbortSignal，用 Promise.race 实现等待超时 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new AiRequestError(`请求超时（${Math.round(ms / 1000)} 秒）`));
    }, ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 把 HTTP 状态码翻译成带排查建议的中文文案 */
function describeHttpError(response: RequestUrlResponse): string {
  const snippet = (response.text ?? "")
    .slice(0, 200)
    .replace(/\s+/g, " ")
    .trim();
  if (response.status === 401 || response.status === 403) {
    return `API Key 无效或无权限（HTTP ${response.status}）`;
  }
  if (response.status === 404) {
    return `接口地址不存在（HTTP 404），请检查 Base URL 是否完整，通常以 /v1 结尾`;
  }
  if (response.status === 429) {
    return `请求过于频繁或账户余额不足（HTTP 429）`;
  }
  if (response.status >= 500) {
    return `服务商服务器错误（HTTP ${response.status}）`;
  }
  return `请求失败（HTTP ${response.status}）${snippet ? `：${snippet}` : ""}`;
}

/** 安全地取出 JSON，避免非 JSON 响应体（如网关 HTML 报错页）直接抛异常 */
function readJson(response: RequestUrlResponse): unknown {
  try {
    const parsed: unknown = response.json;
    if (parsed !== null && parsed !== undefined) {
      return parsed;
    }
  } catch {
    /* falls through to text parsing */
  }
  try {
    return JSON.parse(response.text ?? "");
  } catch {
    return null;
  }
}

interface ChatMessagePayload {
  content?: string | null;
  reasoning_content?: string | null;
}

interface ChatResponsePayload {
  choices?: Array<{ message?: ChatMessagePayload; finish_reason?: string | null } | null> | null;
  usage?: { completion_tokens_details?: { reasoning_tokens?: number } | null } | null;
}

/** 解析响应；content 为空时给出可操作的中文错误 */
function parseChatResponse(data: unknown, model: string): AiChatResult {
  const payload = data as ChatResponsePayload | null;
  const message = payload?.choices?.[0]?.message;
  const raw = message?.content;
  const content = typeof raw === "string" ? raw.trim() : "";

  if (!content) {
    const reasoningTokens = payload?.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    if (reasoningTokens > 0 || (message?.reasoning_content ?? "").trim()) {
      throw new AiRequestError("思考过程消耗了全部 Token，回复为空。请调大「最大 Token」。");
    }
    if (!payload?.choices?.length) {
      throw new AiRequestError("接口没有返回任何内容，请检查 Base URL 与模型名。");
    }
    throw new AiRequestError(`接口返回内容为空，请检查「模型名」是否正确（当前：${model}）。`);
  }

  return { content, truncated: payload?.choices?.[0]?.finish_reason === "length" };
}

/**
 * 发起一次 OpenAI 兼容的 chat/completions 请求。
 *
 * @param cfg - 运行时配置
 * @param systemPrompt - 本次使用的系统提示词（已由调用方拼好内置与附加部分）
 * @param userText - 用户消息正文
 * @throws {AiRequestError} 网络失败、超时、非 2xx、或返回内容为空
 */
export async function chatWithAi(
  cfg: AiRuntimeConfig,
  systemPrompt: string,
  userText: string,
): Promise<AiChatResult> {
  const endpoint = buildEndpoint(cfg.baseUrl);
  if (!cfg.apiKey.trim()) {
    throw new AiRequestError("API Key 为空，请先在设置里填写。");
  }

  const body = JSON.stringify({
    model: cfg.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
    stream: false,
    // 关闭推理模型的思考过程：思考 token 计入输出（单价是输入的 2 倍），
    // 且会吃光 max_tokens 导致 content 为空。
    thinking: { type: "disabled" },
  });

  let response: RequestUrlResponse;
  try {
    response = await withTimeout(
      requestUrl({
        url: endpoint,
        method: "POST",
        contentType: "application/json",
        headers: { Authorization: `Bearer ${cfg.apiKey.trim()}` },
        body,
        throw: false,
      }),
      REQUEST_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof AiRequestError) {
      throw error;
    }
    throw new AiRequestError(`网络请求失败：${describeError(error)}`);
  }

  if (response.status < 200 || response.status >= 300) {
    throw new AiRequestError(describeHttpError(response), response.status);
  }

  return parseChatResponse(readJson(response), cfg.model);
}

/**
 * 用当前配置发一条极小请求验证连通性。
 * @returns 模型的原始回复内容
 * @throws {AiRequestError} 任何一步失败都会抛出带中文说明的错误
 */
export async function testAiConnection(cfg: AiRuntimeConfig): Promise<string> {
  const result = await chatWithAi(cfg, TEST_SYSTEM_PROMPT, "请只回复两个字：正常");
  return result.content;
}

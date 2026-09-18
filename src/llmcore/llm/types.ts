/**
 * LLM 模块类型定义（OpenAI 兼容聊天请求/响应/消息）。
 * 从 v1 llm/types.ts 迁移，供 P3 LLM Core 使用。
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** 多模态内容：纯文本块 */
export interface TextContent {
  type: "text";
  text: string;
}

/** 多模态内容：图片 URL 块 */
export interface ImageContent {
  type: "image_url";
  image_url: { url: string; detail?: string };
}

/** 多模态内容联合类型 */
export type MultimodalContentPart = TextContent | ImageContent;

export interface ChatMessage {
  role: ChatRole;
  /** 纯文本时为 string；多模态（vision）时为内容块数组 */
  content: string | null | MultimodalContentPart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatResponse {
  id: string;
  model?: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
      cache_miss_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

/** Token 用量详情（包含缓存命中、推理 token 等扩展字段）。 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  cacheWriteTokens?: number;
  cacheMissTokens?: number;
}

export interface LLMResponse {
  content: string | null;
  finishReason: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  /** 模型思维链（reasoning_content，deepseek 等 reasoner 模型返回） */
  reasoningContent?: string | null;
  provider?: string;
  model?: string;
  baseUrl?: string;
}

/**
 * LLM 相关类型定义。
 * 含 chat message、tool call、tool definition、IPC 消息类型。
 */

// ─── Chat Messages ─────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

// ─── Tool Calls ────────────────────────────────────────

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ─── LLM Response ──────────────────────────────────────

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens?: number;
    reasoningTokens?: number;
    cacheWriteTokens?: number;
    cacheMissTokens?: number;
  };
  model: string;
}

// ─── Tool Execution ────────────────────────────────────

export interface ToolMeta {
  definition: ToolDefinition;
  requiresFollowUp: boolean;
  execute: (args: Record<string, unknown>) => Promise<string> | string;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  result: string;
}

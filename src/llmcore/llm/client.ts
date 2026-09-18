/**
 * LLM HTTP client — OpenAI 兼容 API 调用，支持 tool-calling。
 * 从 v1 llm/client.ts 迁移。
 */

import type { ChatMessage, ChatResponse, LLMResponse, ToolDefinition } from "./types";
import { createLogger } from "../../common/logger";
import { retry } from "../../common/retry";

const log = createLogger("P3.llm");

export interface LLMClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  timeoutMs: number;
  reasoningEffort?: string;
  headers?: Record<string, string>;
}

export class LLMClient {
  constructor(private readonly config: LLMClientConfig) {}

  private async send(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    const toolCount = tools?.length ?? 0;
    log.info("request.start", { msgCount: messages.length, tools: toolCount });

    const result = await retry(() => this._sendOnce(messages, tools), {
      maxAttempts: 5,
      baseDelayMs: 1000,
      onRetry: (attempt, err) => {
        const status = (err as Error & { status?: number }).status;
        if (typeof status === "number" && status >= 400 && status < 500) {
          throw err;
        }
        log.warn("request.retry", { attempt, error: err.message });
      },
    });

    const u = result.usage;
    log.info("request.done", {
      model: result.model,
      finish_reason: result.choices?.[0]?.finish_reason,
      promptTokens: u?.prompt_tokens,
      completionTokens: u?.completion_tokens,
      totalTokens: u?.total_tokens,
      hasToolCalls: !!result.choices?.[0]?.message?.tool_calls,
    });
    return result;
  }

  private async _sendOnce(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
          ...(this.config.headers ?? {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          ...(this.config.maxTokens != null ? { max_tokens: this.config.maxTokens } : {}),
          ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
          ...(this.config.reasoningEffort ? { reasoning_effort: this.config.reasoningEffort } : {}),
        }),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        const err = Object.assign(
          new Error(`LLM request failed with ${response.status}: ${raw.slice(0, 500)}`),
          { status: response.status },
        );
        throw err;
      }
      return JSON.parse(raw) as ChatResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const data = await this.send(messages);
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("LLM response contains no content");
    }
    return content;
  }

  async chatRaw(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
    const data = await this.send(messages, tools);
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error("LLM response has no choices");
    }
    return {
      content: choice.message.content?.trim() ?? null,
      finishReason: choice.finish_reason ?? "stop",
      toolCalls: choice.message.tool_calls,
      reasoningContent: choice.message.reasoning_content?.trim() ?? null,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0,
            cachedTokens: data.usage.prompt_tokens_details?.cached_tokens,
            reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens,
            cacheWriteTokens: data.usage.prompt_tokens_details?.cache_write_tokens,
            cacheMissTokens: data.usage.prompt_tokens_details?.cache_miss_tokens,
          }
        : undefined,
    };
  }
}

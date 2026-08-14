/**
 * LLM 中转层：按模型别名路由到可用 provider，调用 LLMClient。
 * 从 v1 llm/relay.ts 迁移。
 */

import { LLMClient } from "./client";
import type { ChatMessage, LLMResponse, ToolDefinition } from "./types";
import type { LLMProviderConfig } from "../../common/config";
import { createLogger } from "../../common/logger";

const log = createLogger("P3.relay");

export class LLMRelay {
  constructor(
    private readonly providers: LLMProviderConfig[],
    private readonly defaultAlias = "LLM",
  ) {}

  async chat(messages: ChatMessage[], model = this.defaultAlias): Promise<string> {
    const response = await this.chatRaw(messages, undefined, model);
    return response.content ?? "";
  }

  async chatRaw(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    model = this.defaultAlias,
  ): Promise<LLMResponse> {
    const provider = this.resolveProvider(model);
    if (!provider) {
      throw new Error(`No enabled LLM provider available for alias "${model}"`);
    }
    log.info("route", { alias: model, provider: provider.id });
    const client = new LLMClient({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      maxTokens: provider.maxTokens,
      timeoutMs: provider.timeoutMs ?? 30000,
      ...(provider.reasoningEffort ? { reasoningEffort: provider.reasoningEffort } : {}),
    });
    const response = await client.chatRaw(messages, tools);
    response.provider = provider.id;
    response.model = provider.model;
    response.baseUrl = provider.baseUrl;
    return response;
  }

  private resolveProvider(alias: string): LLMProviderConfig | undefined {
    const enabled = this.providers.filter((p) => p.enabled);
    if (alias) {
      const matched = enabled.find(
        (p) => p.id === alias || p.aliases.includes(alias),
      );
      if (matched) return matched;
    }
    return enabled[0];
  }
}

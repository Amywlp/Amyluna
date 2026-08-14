/**
 * Vision 图片描述接口。
 * 复用 v1 describeImages() 逻辑，通过 IPC 接收 P1 的 vision 请求。
 */

import type { LLMRelay } from "./llm/relay";
import type { ChatMessage, MultimodalContentPart } from "./llm/types";
import { createLogger } from "../common/logger";

const log = createLogger("P3.vision");

export interface VisionConfig {
  alias: string;
  systemPrompt: string;
}

/**
 * 调用 vision 模型描述图片。
 * @param imageUrls 图片 URL 列表
 * @param relay LLM relay 实例
 * @param config vision 配置
 * @returns 图片描述字符串
 */
export async function describeImages(
  imageUrls: string[],
  relay: LLMRelay,
  config: VisionConfig,
): Promise<string> {
  if (imageUrls.length === 0) return "";

  log.info("describe.start", { imageCount: imageUrls.length });

  const contentParts: MultimodalContentPart[] = [
    { type: "text", text: "请描述以下图片。" },
    ...imageUrls.map((url) => ({
      type: "image_url" as const,
      image_url: { url, detail: "auto" as const },
    })),
  ];

  const messages: ChatMessage[] = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: contentParts },
  ];

  try {
    const response = await relay.chatRaw(messages, undefined, config.alias);
    const description = response.content ?? "";
    log.info("describe.done", { descriptionLen: description.length });
    return description;
  } catch (err) {
    log.error("describe.fail", { error: String(err) });
    return `[图片描述失败: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

/**
 * P3 Conversation Loop — 有限轮次 while 循环，驱动 LLM 对话+工具调用。
 *
 * 与 v1 ConversationLoop 的关键区别：
 * - 仅注册非静默工具。LLM 返回的不在 registry 中的 tool_call 视为「静默工具」，
 *   收集到 silentToolCalls[] 并推占位 tool result 回 messages，由 P2 执行。
 * - 每一轮有文本输出的工具调用轮次，通过 onIntermediateReply 回调即时发送给 P2，
 *   不等待所有工具执行完成。
 * - 不处理 meme 逻辑，静默工具结果由 P2 处理。
 *
 * 从 v1 chat/conversation-loop.ts 解耦迁移。
 */

import type { LLMRelay } from "./llm/relay";
import type { ChatMessage } from "./llm/types";
import { logLLMResponse } from "./llm/llm-logger";
import type { ToolRegistry } from "./tools/registry";
import { createLogger } from "../common/logger";
import { stripStdToolText } from "../common/tool-text-guard";

/** Safe JSON parse – returns parsed object or empty object on failure. */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * 检测文本内容是否主要为工具调用的格式化文本（而非面向用户的内容）。
 *
 * DeepSeek 等模型有时会在 content 中输出 XML 格式的工具调用描述
 * （如 <invoke name="filesystem_read_file">...</invoke>），
 * 这些不应被发送给用户。
 */
function isToolCallContent(text: string | null): boolean {
  if (!text || !text.trim()) return false;
  const trimmed = text.trim();
  // 检测 XML 工具调用模式
  if (/<\/?invoke\b/i.test(trimmed)) return true;
  // 纯 JSON 工具调用（罕见但防御）
  if (/^\s*\[\s*\{.*"name"\s*:/.test(trimmed)) return true;
  return false;
}

/**
 * 从可能包含工具调用文本的内容中提取用户可见的纯文本。
 * 如果整个内容都是工具调用描述，返回空字符串。
 */
function extractUserVisibleContent(text: string | null): string {
  if (!text || !text.trim()) return "";
  // 移除 XML invoke 块及其内容
  let cleaned = text.replace(/<invoke[^>]*>[\s\S]*?<\/invoke>/gi, "");
  // 移除可能残留的 XML 标签
  cleaned = cleaned.replace(/<\/?parameter[^>]*>/gi, "");
  // 移除标准工具被误写成文本标记的残留（如 search_song(...) / send_song_card(...) /
  // resolve_media(...) / temp_mute(...) 等），防止泄漏给用户。
  // 名单唯一来源：src/common/tool-text-guard.ts（此处曾另存一份，导致改一处漏一处）。
  cleaned = stripStdToolText(cleaned);
  // 清理多余空行
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}

const log = createLogger("P3.loop");

// ─── 类型 ──────────────────────────────────────────────

/** 静默工具调用（P3 识别，P2 执行） */
export interface SilentToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** 每次循环的完整结果 */
export interface LoopResult {
  content: string;
  silentToolCalls: SilentToolCall[];
}

/** Token 用量回调 */
export type TokenUsageCallback = (params: {
  usage: import("./llm/types").TokenUsage;
  provider?: string;
  model?: string;
  baseUrl?: string;
  success: boolean;
  turn: number;
  groupId?: number;
  triggerMessageId?: number;
}) => void | Promise<void>;

/** 中间回复回调：每轮工具调用前的 LLM 文本即时发送给 P2 */
export type IntermediateReplyCallback = (text: string) => Promise<void>;

// ─── ConversationLoop ──────────────────────────────────

export class ConversationLoop {
  /** Token 用量回调 */
  onTokenUsage?: TokenUsageCallback;

  /** 中间回复回调（P3 → P2 IPC intermediate_reply） */
  onIntermediateReply?: IntermediateReplyCallback;

  constructor(
    private relay: LLMRelay,
    private registry: ToolRegistry,
    private maxTurns = 6,
    /** LLM 模型别名（用于 relay 路由），默认走 relay 的 defaultAlias */
    private model?: string,
  ) {}

  /**
   * 运行对话循环。
   * 返回最终的 LLM 回复文本 + 所有需要 P2 执行的静默工具调用。
   */
  async run(messages: ChatMessage[]): Promise<LoopResult> {
    const tools = this.registry.getToolDefinitions();
    let reply = "";
    const silentToolCalls: SilentToolCall[] = [];

    log.info("loop.start", {
      msgCount: messages.length,
      maxTurns: this.maxTurns,
      toolCount: tools.length,
      toolNames: tools.map((t) => t.function.name),
    });

    for (let turn = 0; turn < this.maxTurns; turn++) {
      const response = await this.relay.chatRaw(messages, tools, this.model);
      // Token 用量回调
      if (this.onTokenUsage && response.usage) {
        void Promise.resolve(
          this.onTokenUsage({
            usage: response.usage,
            provider: response.provider,
            model: response.model,
            baseUrl: response.baseUrl,
            success: true,
            turn,
          }),
        ).catch(() => {});
      }

      log.info("loop.turn", {
        turn,
        finishReason: response.finishReason,
        contentLen: (response.content ?? "").length,
        toolCalls: response.toolCalls?.map((tc) => tc.function.name) ?? [],
      });

      // LLM 响应日志
      logLLMResponse(response, { turn, msgCount: messages.length });

      // ── finishReason "stop": 正常完成 ──
      if (response.finishReason === "stop") {
        // 检查内容是否实际是工具调用文本（DeepSeek XML 格式）
        if (isToolCallContent(response.content)) {
          log.warn("loop.toolCallInContent", {
            turn,
            contentPreview: (response.content ?? "").slice(0, 200),
          });
          // 不视为最终回复，如果还有剩余轮次则请求 LLM 给出真正的文本回复
          if (turn + 1 < this.maxTurns) {
            // 将当前内容作为 assistant 消息追加，明确要求下一轮输出纯文本
            messages.push({
              role: "assistant",
              content: "（工具调用已提交）",
            });
            messages.push({
              role: "user",
              content: "请继续。不要输出工具调用的 XML，只输出你对用户的自然语言回复。",
            });
            continue;
          }
          // 最后一轮，仍尝试提取用户可见内容
          const visible = extractUserVisibleContent(response.content);
          if (visible) {
            reply = visible;
            break;
          }
          // 完全没有可见内容 → 强制回复
        }
        reply = response.content ?? "";
        break;
      }

      // ── finishReason "length": token 截断 ──
      if (response.finishReason === "length") {
        if (response.content) {
          log.warn("loop.truncated", { turn, contentLen: response.content.length });
          reply = response.content;
        } else {
          log.error("loop.emptyTruncated", { turn });
        }
        break;
      }

      // ── 有 tool_calls ──
      if (response.toolCalls && response.toolCalls.length > 0) {
        // 分类：非静默（在 registry 中且非 block）vs 静默（未注册 或 block=true）
        const hasNonSilent = response.toolCalls.some((tc) => {
          if (tc.type !== "function") return false;
          const meta = this.registry.findByName(tc.function.name);
          return !!meta && !meta.block;
        });

        // 非静默工具存在时，把 assistant 消息（含 tool_calls）推入 messages
        // 供下一轮 LLM 查看工具结果
        if (hasNonSilent) {
          messages.push({
            role: "assistant",
            content: response.content,
            tool_calls: response.toolCalls,
          });
        }

        let allSilent = true;

        for (const tc of response.toolCalls) {
          if (tc.type !== "function") continue;

          const args = parseArgs(tc.function.arguments);

          const meta = this.registry.findByName(tc.function.name);
          const isRegistered = !!meta;
          // 静默工具 = 未注册，或已注册但 block=true（如 timer/tts/muri_agent/text2image）
          const isSilentTool = !isRegistered || !!meta.block;

          if (isSilentTool) {
            // ── 静默工具：P3 不执行，收集 + 占位 tool result ──
            log.info("loop.silentTool", {
              turn,
              tool: tc.function.name,
              args: tc.function.arguments,
            });

            silentToolCalls.push({
              name: tc.function.name,
              arguments: args,
            });

            // 推占位 tool result 回 messages，告知 LLM 工具已执行
            if (hasNonSilent) {
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: `(由 P2 执行: ${tc.function.name})`,
              });
            }
            // 静默工具不影响 allSilent 判断
            continue;
          }

          // ── 非静默工具：P3 内部执行 ──
          log.info("loop.execTool", {
            turn,
            tool: tc.function.name,
            args: tc.function.arguments,
          });

          const result = await this.registry.execute(tc.function.name, args);

          log.info("loop.toolResult", {
            turn,
            tool: tc.function.name,
            hasContent: !!result.content,
            hasError: !!result.error,
            contentPreview: (result.content ?? result.error ?? "").slice(0, 200),
          });

          if (meta?.requiresFollowUp) {
            allSilent = false;
          }

          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result.error
              ? `Error: ${result.error}`
              : (result.content ?? "Done."),
          });
        }

        // ── 中间回复：有文本内容且非全部静默时，即时发送给 P2 ──
        // 过滤掉纯工具调用文本（DeepSeek 的 XML invoke 等），不发送给用户
        if (!allSilent && response.content && this.onIntermediateReply) {
          const visible = extractUserVisibleContent(response.content);
          if (visible) {
            log.info("loop.intermediateReply", {
              turn,
              contentLen: visible.length,
            });
            try {
              await this.onIntermediateReply(visible);
              log.info("loop.intermediateSent", { turn });
            } catch (err) {
              log.error("loop.intermediateFailed", { turn, error: String(err) });
            }
          } else {
            log.info("loop.intermediateSkip", {
              turn,
              reason: "content is tool-call formatting",
              originalLen: response.content.length,
            });
          }
        }

        // 退出条件：全部静默且有内容 / 无非静默工具
        if ((allSilent && response.content) || !hasNonSilent) {
          const reason = !hasNonSilent ? "silentOnly" : "allSilentWithContent";
          log.info("loop.done", { turn, reason, contentLen: (response.content ?? "").length });
          reply = response.content ?? "";
          break;
        }
        continue;
      }

      // 其他 finish_reason（content_filter 等）
      reply = response.content ?? "";
      break;
    }

    // ── 强制回复：循环耗尽无最终答案 ──
    if (!reply || isToolCallContent(reply)) {
      if (isToolCallContent(reply)) {
        log.warn("loop.replyIsToolCall", { replyPreview: reply.slice(0, 200) });
      }
      log.warn("loop.exhausted", { maxTurns: this.maxTurns, msgCount: messages.length });
      try {
        // 追加指令：基于已收集的信息给出最终回复。
        // 仍提供 tools 以防关键信息缺失，但明确优先综合已有结果。
        messages.push({
          role: "user",
          content: "你已经完成了多轮查询。现在请基于已收集到的所有信息，整合出一份完整的自然语言回复给用户。优先使用已有的查询结果，只有在关键信息完全缺失时才调用工具。不要输出工具调用 XML 或 JSON，直接输出给用户看的文字。",
        });
        const forcedResponse = await this.relay.chatRaw(messages, tools, this.model);
        reply = forcedResponse.content ?? "";
        // 最后的安全过滤
        if (isToolCallContent(reply)) {
          const visible = extractUserVisibleContent(reply);
          reply = visible || "";
        }
        if (reply) {
          log.info("loop.forcedReply", { replyLen: reply.length });
        } else {
          log.error("loop.forcedReply.fail", { msg: "Forced reply also empty" });
        }
      } catch (err) {
        log.error("loop.forcedReply.fail", { error: String(err) });
      }
    }

    log.info("loop.final", {
      replyLen: reply.length,
      silentToolCount: silentToolCalls.length,
      silentToolNames: silentToolCalls.map((st) => st.name),
    });

    // 最终安全过滤：确保返回的内容不是工具调用文本
    if (isToolCallContent(reply)) {
      log.warn("loop.finalToolCallContent", { replyPreview: reply.slice(0, 200) });
      const visible = extractUserVisibleContent(reply);
      if (visible) {
        reply = visible;
      } else {
        reply = "";  // 无法提取有效内容
      }
    }

    return { content: reply, silentToolCalls };
  }
}

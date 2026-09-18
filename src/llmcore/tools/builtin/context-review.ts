/**
 * context_review 工具 — 检索并总结用户在群聊中的最近消息。
 *
 * 非静默工具，注册在主 agent (holo) 的 ToolRegistry 中。
 * LLM 通过 function calling 主动调用，P3 查询 DB 后返回消息记录。
 *
 * 权限：仅好感度 > 80 的触发用户可用。
 * 对话轮数：调用后 requiresFollowUp=true，LLM 在下一轮综合总结。
 */

import type { ToolMeta } from "../types";
import type { MessageRepository } from "../../../common/db/message-repository";
import { createLogger } from "../../../common/logger";

const log = createLogger("P3.tools");

/** 请求上下文（由 IPC server 在每次 chat 请求前设置） */
export interface ContextReviewRequestContext {
  group_id: number;
  /** 触发消息的发送者 QQ 号 */
  user_id: number;
  /** 触发用户的有效好感度 1-100 */
  affinity: number;
}

/** 当前请求上下文（每次 chat 前由 P3 IPC server 设置，loop 结束后清空） */
let currentRequestContext: ContextReviewRequestContext | null = null;

/** 设置当前请求上下文（由 P3 IPC server 在 chat handler 中调用） */
export function setRequestContext(ctx: ContextReviewRequestContext | null): void {
  currentRequestContext = ctx;
}

/** 获取当前请求上下文（供 context_review 工具 execute 时读取） */
export function getRequestContext(): ContextReviewRequestContext | null {
  return currentRequestContext;
}

/** 默认检索消息条数 */
const DEFAULT_LIMIT = 40;
/** 最大检索条数（防止滥用） */
const MAX_LIMIT = 200;

/**
 * 格式化时间戳为可读格式。
 * created_at 为 ISO 字符串（如 "2026-08-12T14:30:00.000Z"）→ "08-12 14:30"
 */
function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${mm}-${dd} ${hh}:${min}`;
  } catch {
    return iso.slice(0, 16);
  }
}

export function createContextReviewTool(repo: MessageRepository): ToolMeta {
  return {
    definition: {
      type: "function",
      function: {
        name: "context_review",
        description:
          "检索指定用户在群聊中的最近消息记录，用于回顾聊天内容、总结某人的发言或查找关键信息。" +
          "调用此工具后，你会在下一轮收到检索结果，请直接综合成自然语言总结回复用户。" +
          "收到结果后直接输出总结，不要再调用其他工具（除非用户明确提出了新的、不相关的请求）。" +
          "仅好感度 > 80 的用户可以使用此功能；若好感度不足，工具会返回错误。",
        parameters: {
          type: "object",
          properties: {
            user_id: {
              type: "integer",
              description:
                "要检索的目标用户 QQ 号，从对话上下文的消息前缀中获取（如 [MsgID:xxx] [name](user_id) 中的 user_id）。" +
                "如果要回顾的是触发用户本人，则填写触发用户的 user_id。",
            },
            limit: {
              type: "integer",
              description:
                `检索的消息条数上限，默认 ${DEFAULT_LIMIT} 条，最大 ${MAX_LIMIT} 条。` +
                "消息量较小时用默认值即可；需要更完整回顾时可增大。",
              default: DEFAULT_LIMIT,
            },
          },
          required: ["user_id"],
        },
      },
    },
    execute: async (args: Record<string, unknown>) => {
      const targetUserId = Number(args.user_id);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return { error: `无效的 user_id: ${args.user_id}` };
      }

      let rawLimit = Number(args.limit);
      if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
        rawLimit = DEFAULT_LIMIT;
      }
      const limit = Math.min(Math.floor(rawLimit), MAX_LIMIT);

      // 获取请求上下文，校验权限
      const ctx = getRequestContext();
      if (!ctx) {
        return { error: "请求上下文不可用，请稍后重试" };
      }

      if (ctx.affinity <= 80) {
        log.info("contextReview.permissionDenied", {
          requester: ctx.user_id,
          affinity: ctx.affinity,
          target: targetUserId,
        });
        return {
          error:
            `好感度不足（当前 ${ctx.affinity}，需要 > 80）。` +
            "聊天记录回顾功能仅对好感度较高的用户开放。",
        };
      }

      log.info("contextReview.start", {
        group_id: ctx.group_id,
        targetUserId,
        limit,
        requesterAffinity: ctx.affinity,
      });

      try {
        const messages = await repo.findRecentByGroupAndUser(
          ctx.group_id,
          targetUserId,
          limit,
        );

        if (messages.length === 0) {
          return {
            content: `未找到用户 ${targetUserId} 在本群的聊天记录。`,
          };
        }

        // 格式化为结构化文本（时间升序，方便 LLM 阅读）
        const lines: string[] = [
          `用户 ${targetUserId} 在群 ${ctx.group_id} 中最近 ${messages.length} 条消息：`,
          "",
        ];

        for (const msg of messages.reverse()) {
          const time = formatTime(msg.created_at);
          const role = msg.role === "assistant" ? "[bot]" : "";
          const sender = msg.sender_name ?? "unknown";
          const content = (msg.content ?? "").trim();
          if (!content) continue;

          lines.push(
            `[${time}] [MsgID:${msg.message_id ?? "?"}] ${role}[${sender}](${msg.user_id}): ${content}`,
          );
        }

        const result = lines.join("\n");
        log.info("contextReview.done", {
          targetUserId,
          messageCount: messages.length,
          resultLen: result.length,
        });

        return { content: result };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error("contextReview.dbError", { targetUserId, error: errMsg });
        return { error: `查询消息失败: ${errMsg}` };
      }
    },
    requiresFollowUp: true,
    timeout: 10000,
    resultMaxLength: 8000,
  };
}

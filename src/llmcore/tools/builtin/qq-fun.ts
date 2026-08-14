/**
 * QQ 互动工具 — 仅供 muri_agent 使用，不注册给主 agent (holo)。
 *
 * 这些工具通过 IPC 委托 P1 执行 OneBot QQ 互动 action。
 * 迁移自 snowluma_adapter src/tools/builtin/{poke,like,reaction}.ts。
 */

import type { ToolMeta } from "../types";
import type { IpcClient } from "../../../common/ipc/client";
import type { QqActionPayload, QqActionResultPayload } from "../../../common/types/ipc";

/** 通过 IPC 调用 P1 执行 QQ 操作 */
async function callQqAction(p1Client: IpcClient, action: QqActionPayload["action"], params: Record<string, unknown>): Promise<{ error?: string }> {
  const result = await p1Client.request("qq_action", { action, params }, 10000) as QqActionResultPayload;
  if (!result.success) {
    return { error: result.error ?? `${action} 失败` };
  }
  return {};
}

// ─── 表情代码表 ──────────────────────────────────────────

const REACTION_CODES: Record<string, string> = {
  "4": "得意", "5": "流泪", "8": "睡", "9": "大哭", "10": "尴尬",
  "12": "调皮", "14": "微笑", "16": "酷", "21": "可爱", "23": "傲慢",
  "24": "饥饿", "25": "困", "26": "惊恐", "27": "流汗", "28": "憨笑",
  "29": "悠闲", "30": "奋斗", "32": "疑问", "33": "嘘", "34": "晕",
  "38": "敲打", "39": "再见", "41": "发抖", "42": "爱情",
};

function describeReactionCodes(): string {
  return Object.entries(REACTION_CODES)
    .map(([code, meaning]) => `${code}(${meaning})`)
    .join("、");
}

// ─── 工具工厂 ────────────────────────────────────────────

/** group_poke — 群拍一拍 */
export function createGroupPokeTool(p1Client: IpcClient): ToolMeta {
  return {
    definition: {
      type: "function",
      function: {
        name: "group_poke",
        description:
          "群拍一拍用户。" +
          "根据好感度使用：好感度 ≥6 时可以拍一拍作为友好互动；" +
          "好感度 ≤2 时不应使用（会被视为骚扰）。" +
          "user_id 从任务上下文中获取，group_id 从任务上下文中获取。",
        parameters: {
          type: "object",
          properties: {
            group_id: {
              type: "integer",
              description: "群号",
            },
            user_id: {
              type: "integer",
              description: "目标用户 QQ 号",
            },
          },
          required: ["group_id", "user_id"],
        },
      },
    },
    execute: async (args: Record<string, unknown>) => {
      const groupId = Number(args.group_id);
      const userId = Number(args.user_id);
      if (!Number.isFinite(groupId) || groupId <= 0) {
        return { error: `无效的 group_id: ${args.group_id}` };
      }
      if (!Number.isFinite(userId) || userId <= 0) {
        return { error: `无效的 user_id: ${args.user_id}` };
      }
      const result = await callQqAction(p1Client, "group_poke", { group_id: groupId, user_id: userId });
      if (result.error) return result;
      return { content: `已在群 ${groupId} 中拍一拍用户 ${userId}` };
    },
    requiresFollowUp: false,
  };
}

/** send_like — 给用户 QQ 资料卡点赞 */
export function createSendLikeTool(p1Client: IpcClient): ToolMeta {
  return {
    definition: {
      type: "function",
      function: {
        name: "send_like",
        description:
          "给用户 QQ 资料卡点赞（名片赞）。" +
          "根据好感度使用：好感度 ≥7 时可以主动点赞以表达喜爱；好感度 ≤3 时不应点赞。" +
          "user_id 从任务上下文中获取。",
        parameters: {
          type: "object",
          properties: {
            user_id: {
              type: "integer",
              description: "目标用户 QQ 号",
            },
            times: {
              type: "integer",
              description: "点赞次数，默认 1，最多建议 10",
              default: 1,
            },
          },
          required: ["user_id"],
        },
      },
    },
    execute: async (args: Record<string, unknown>) => {
      const userId = Number(args.user_id);
      const times = args.times != null ? Number(args.times) : 1;
      if (!Number.isFinite(userId) || userId <= 0) {
        return { error: `无效的 user_id: ${args.user_id}` };
      }
      const result = await callQqAction(p1Client, "send_like", { user_id: userId, times: Math.max(1, Math.min(times, 20)) });
      if (result.error) return result;
      return { content: `已给用户 ${userId} 点赞 ${times} 次` };
    },
    requiresFollowUp: false,
  };
}

/** set_group_reaction — 对群聊消息做出表情回应 */
export function createReactionTool(p1Client: IpcClient): ToolMeta {
  const codeList = describeReactionCodes();

  return {
    definition: {
      type: "function",
      function: {
        name: "set_group_reaction",
        description:
          "对群聊中某条消息做出表情回应（QQ 表情反应）。" +
          "根据好感度和上下文选取合适的表情。message_id 从任务上下文中获取。" +
          `可用表情代码: ${codeList}`,
        parameters: {
          type: "object",
          properties: {
            message_id: {
              type: "integer",
              description: "要回应的消息 ID",
            },
            code: {
              type: "string",
              description: `表情代码。可选值: ${Object.keys(REACTION_CODES).join(", ")}`,
              enum: Object.keys(REACTION_CODES),
            },
            group_id: {
              type: "integer",
              description: "群号（可选，不传则使用当前群）",
            },
          },
          required: ["message_id", "code"],
        },
      },
    },
    execute: async (args: Record<string, unknown>) => {
      const messageId = Number(args.message_id);
      const code = String(args.code ?? "");
      const groupId = args.group_id != null ? Number(args.group_id) : undefined;

      if (!Number.isFinite(messageId) || messageId <= 0) {
        return { error: `无效的 message_id: ${args.message_id}` };
      }
      if (!REACTION_CODES[code]) {
        return { error: `不支持的表情代码: ${code}。可用: ${Object.keys(REACTION_CODES).join(", ")}` };
      }

      const result = await callQqAction(p1Client, "set_group_reaction", {
        message_id: messageId,
        code,
        ...(groupId ? { group_id: groupId } : {}),
      });
      if (result.error) return result;
      return { content: `已对消息 ${messageId} 做出 "${REACTION_CODES[code]}" 表情回应` };
    },
    requiresFollowUp: false,
  };
}

/** 注册所有 QQ fun tools 到指定 registry */
export function registerQqFunTools(registry: { register: (meta: ToolMeta) => void }, p1Client: IpcClient): void {
  registry.register(createGroupPokeTool(p1Client));
  registry.register(createSendLikeTool(p1Client));
  registry.register(createReactionTool(p1Client));
}

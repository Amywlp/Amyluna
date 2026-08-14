/**
 * temp_mute 工具 — 临时静音用户。
 *
 * 非静默工具，注册在主 agent (holo) 的 ToolRegistry 中。
 * LLM 通过 function calling 主动调用，P3 通过 IPC 委托 P1 加入静音列表。
 *
 * 实际静音时长 = mute_time × severe_level（120s ~ 3000s）。
 *
 * 静音决策应与预设中「面对挑逗与冒犯的应对」五级系统对齐：
 *   severe_level → 冒犯层级（1-5）
 *   mute_time   → 由好感度 + 历史表现综合决定
 *
 * 印象联动：
 *   用户印象通过上下文注入（affinity:N, 印象:[...]），由 LLM 自行判断是否需要
 *   将 severe_level 调高一档。当印象中含过往冒犯记录且当前再次冒犯时应升级。
 */

import type { ToolMeta } from "../types";
import type { IpcClient } from "../../../common/ipc/client";
import type { TempMuteResultPayload } from "../../../common/types/ipc";

export function createTempMuteTool(p1Client: IpcClient): ToolMeta {
  return {
    definition: {
      type: "function",
      function: {
        name: "temp_mute",
        description:
          "临时静音用户，在指定时长内 bot 不再响应其消息。" +
          "实际静音时长 = mute_time × severe_level。user_id 从对话上下文的消息前缀中获取。" +
          "静音决策应与「面对挑逗与冒犯的应对」五级系统对齐——" +
          "severe_level 直接对应冒犯层级，mute_time 综合好感度高低和历史表现决定。" +
          "注意：若上下文消息前缀中该用户的印象标签含有过往冒犯记录（如「多次调戏」「屡次越界」等），" +
          "表明此用户有持续冒犯倾向，应将 severe_level 在五级系统判断的基础上额外调高一档（上限 5）。",
        parameters: {
          type: "object",
          properties: {
            user_id: {
              type: "integer",
              description: "目标用户 QQ 号，从对话上下文的消息前缀中获取",
            },
            mute_time: {
              type: "integer",
              description:
                "基础静音时长（秒），范围 120-600。" +
                "选择依据：①冒犯层级越高，取值越大；" +
                "②好感度越低，取值越大（生人/厌恶者冒犯比老友冒犯更重）；" +
                "③对方在提醒后未收敛、反复挑衅，取值应比初犯更大。" +
                "参考：初犯 120-240，再犯 300-420，屡犯 480-600",
              minimum: 120,
              maximum: 600,
            },
            severe_level: {
              type: "integer",
              description:
                "严重程度 1-5，直接对应「面对挑逗与冒犯的应对」中的五级冒犯层级。" +
                "实际静音时长 = mute_time × severe_level。" +
                "若用户印象中含过往冒犯记录，应在五级判断基础上 +1（上限 5）。",
              minimum: 1,
              maximum: 5,
            },
          },
          required: ["user_id", "mute_time", "severe_level"],
        },
      },
    },
    execute: async (args: Record<string, unknown>) => {
      const userId = Number(args.user_id);
      const muteTime = Number(args.mute_time);
      const severeLevel = Number(args.severe_level);

      // 参数校验
      if (!Number.isFinite(userId) || userId <= 0) {
        return { error: `无效的 user_id: ${args.user_id}` };
      }
      if (!Number.isFinite(muteTime) || muteTime <= 0) {
        return { error: `无效的 mute_time: ${args.mute_time}（需 >= 120）` };
      }
      if (!Number.isFinite(severeLevel) || severeLevel < 1 || severeLevel > 5) {
        return { error: `无效的 severe_level: ${args.severe_level}（需 1-5）` };
      }

      try {
        const result = await p1Client.request("temp_mute", {
          user_id: userId,
          mute_time: muteTime,
          severe_level: severeLevel,
        }, 10000) as TempMuteResultPayload;

        if (!result.success) {
          return { error: result.error ?? "静音操作失败" };
        }

        const actualDuration = result.actual_duration ?? (muteTime * severeLevel);
        const mutedUntil = result.muted_until ?? 0;
        const remainingMin = mutedUntil > 0
          ? Math.max(0, Math.ceil((mutedUntil - Math.floor(Date.now() / 1000)) / 60))
          : 0;

        return {
          content:
            `用户 ${userId} 已被临时静音，实际时长 ${actualDuration} 秒` +
            `（= ${muteTime} × 等级 ${severeLevel}），约 ${remainingMin} 分钟后自动解除。`,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return { error: `静音请求失败: ${errMsg}` };
      }
    },
    requiresFollowUp: true,
  };
}

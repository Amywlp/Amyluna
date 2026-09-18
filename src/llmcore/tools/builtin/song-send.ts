/**
 * send_song_card 工具 — 把选定的网易云歌曲以 QQ 音乐卡片(type=163)发到群。
 *
 * 第二轮工具：LLM 看过 search_song 候选后，确定要哪首就调用本工具。
 * 入参：group_id（目标群，从上下文 group:xxx 读取）+ song_id（候选文本里的 id）。
 *
 * 发送原理：经 P3 → P1 的 qq_action.send_group_msg，透传 OneBot music 段：
 *   {type:"music", data:{type:"163", id: <songId>}}
 * SnowLuma 收到 music 段会自动拉取网易云信息并签发 token（实测可用），
 * 卡片显示"网易云音乐"角标，可点击跳转/播放。
 */

import type { ToolMeta } from "../types";
import type { IpcClient } from "../../../common/ipc/client";
import { createLogger } from "../../../common/logger";

const log = createLogger("P3.tools");

export interface SongSendDeps {
  p1Client: IpcClient;
}

export function createSongSendTool(deps: SongSendDeps): ToolMeta {
  return {
    definition: {
      type: "function",
      function: {
        name: "send_song_card",
        description:
          "把一首网易云歌曲以 QQ 音乐卡片发送到指定群。在 search_song 返回候选列表后，确定用户要哪首时调用。" +
          "传入目标群号（上下文里 group:xxx 的 xxx）和歌曲 id（候选列表每行末尾 id=xxx）。" +
          "发送后群里会出现可点击播放的音乐卡片。",
        parameters: {
          type: "object",
          properties: {
            group_id: {
              type: "integer",
              description: "要发送到的群号，从上下文 group:1000000001 这类前缀读取。",
            },
            song_id: {
              type: "integer",
              description: "网易云歌曲 id，从 search_song 候选列表的 'id=xxx' 中取。",
            },
          },
          required: ["group_id", "song_id"],
        },
      },
    },
    execute: async (args: Record<string, unknown>) => {
      const groupId = Number(args.group_id);
      const songId = Number(args.song_id);

      if (!Number.isFinite(groupId) || groupId <= 0) {
        return { error: `无效的 group_id: ${args.group_id}。应从上下文 group:xxx 读取群号。` };
      }
      if (!Number.isFinite(songId) || songId <= 0) {
        return { error: `无效的 song_id: ${args.song_id}。应从 search_song 候选的 id=xxx 读取。` };
      }

      const message = [{ type: "music", data: { type: "163", id: String(songId) } }];
      try {
        const raw = await deps.p1Client.request("qq_action", {
          action: "send_group_msg",
          params: { group_id: groupId, message },
        });
        const result = raw as { success?: boolean; result?: { message_id?: number }; error?: string } | null;
        if (result?.success) {
          log.info("songSend.done", { group_id: groupId, song_id: songId, message_id: result.result?.message_id });
          return {
            content:
              `歌曲卡片已发送到群 ${groupId}（网易云 id=${songId}）。` +
              `若用户对版本不满意，可再 search_song 换关键词重试。`,
          };
        }
        const errMsg = result?.error ?? "未知错误";
        log.warn("songSend.fail", { group_id: groupId, song_id: songId, error: errMsg });
        return { error: `发送失败: ${errMsg}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("songSend.error", { group_id: groupId, song_id: songId, error: msg });
        return { error: `发送失败: ${msg}` };
      }
    },
    requiresFollowUp: true,
    timeout: 30000,
    resultMaxLength: 2000,
  };
}

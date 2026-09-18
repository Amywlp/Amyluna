/**
 * P1 IPC Server — 接收 P2 的 send_message 委托和 P3 的 error_alert。
 */

import * as fs from "node:fs";
import { IpcServer } from "../common/ipc/server";
import { createLogger } from "../common/logger";
import type { WsClient } from "./ws-client";
import { sendGroupMessage, sendGroupForwardMessage, sendLike, sendPoke, groupPoke, setGroupReaction, getGroupFileUrl } from "./send-api";
import type { ForwardNode } from "./send-api";
import type { MessageSegment } from "../common/types/onebot";
import type { QqActionPayload, TempMutePayload } from "../common/types/ipc";
import type { TempMuteList } from "./temp-mute-list";

const log = createLogger("P1.ipc-srv");

/** memesluna 表情图片匹配模式 */
const MEME_URL_RE = /^https?:\/\/127\.0\.0\.1:5141\/memesluna\/[^\s]+$/;

/**
 * 下载 memesluna 图片并转为 base64。
 * 迁移自 v1 snowluma_adapter utils/text.ts downloadImageToBase64()。
 */
async function downloadMemeToBase64(url: string): Promise<string> {
  log.info("meme.download.start", { url });
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching meme: ${url}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    const bodyPreview = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`Meme response is not an image (${contentType}): ${bodyPreview}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const base64 = buffer.toString("base64");
  log.info("meme.download.done", { url, contentType, sizeBytes: buffer.length, base64Len: base64.length });
  return base64;
}

/**
 * 读取本地文件并转为 base64 字符串（带 base64:// 前缀）。
 * 用于将 SoVITS 生成的 WAV 文件发送到 QQ（SnowLuma 在 Docker 中，无法读宿主机路径）。
 */
async function fileToBase64(filePath: string): Promise<string> {
  log.info("fileToBase64.start", { path: filePath });
  const buffer = await fs.promises.readFile(filePath);
  const base64 = buffer.toString("base64");
  log.info("fileToBase64.done", { path: filePath, sizeBytes: buffer.length, base64Len: base64.length });
  return `base64://${base64}`;
}

export interface P1IpcServerDeps {
  wsClient: WsClient;
  errorAlertGroupId: number;
  botId: number;
  tempMuteList: TempMuteList;
  /** 记录 bot 发送的消息 ID（reply 触发判断用） */
  registerBotMessageId: (groupId: number, messageId: number) => void;
}

/** 类型守卫：判断是否为 MessageSegment */
function isMessageSegment(value: unknown): value is { type: string; data: Record<string, unknown> } {
  return typeof value === "object" && value !== null && "type" in value && "data" in value;
}

/**
 * 解析合并转发节点中的 record 段：将 file:// 路径替换为 base64://。
 * 因为 SnowLuma 在 Docker 中，无法读取宿主机文件系统。
 */
async function resolveForwardRecordSegments(nodes: ForwardNode[]): Promise<ForwardNode[]> {
  const resolved: ForwardNode[] = [];
  for (const node of nodes) {
    const resolvedNode: ForwardNode = { ...node };

    // 检查 message 字段（MessageSegment[] | ForwardNode[]）
    if (Array.isArray(resolvedNode.message)) {
      const segments: Array<{ type: string; data: Record<string, unknown> }> = [];
      for (const seg of resolvedNode.message) {
        if (!isMessageSegment(seg)) {
          // ForwardNode — 原样保留
          segments.push(seg as unknown as { type: string; data: Record<string, unknown> });
          continue;
        }
        if (seg.type === "record" && typeof seg.data?.file === "string" && seg.data.file.startsWith("file://")) {
          try {
            const filePath = seg.data.file.slice(7);
            const base64Data = await fileToBase64(filePath);
            segments.push({ type: "record", data: { file: base64Data } });
          } catch (err) {
            log.warn("forward.resolveRecord.fail", { path: seg.data.file, error: String(err) });
          }
        } else {
          segments.push(seg);
        }
      }
      resolvedNode.message = segments;
    }

    // 检查 content 字段
    if (Array.isArray(resolvedNode.content)) {
      const segments: Array<{ type: string; data: Record<string, unknown> }> = [];
      for (const seg of resolvedNode.content) {
        if (!isMessageSegment(seg)) {
          segments.push(seg as unknown as { type: string; data: Record<string, unknown> });
          continue;
        }
        if (seg.type === "record" && typeof seg.data?.file === "string" && seg.data.file.startsWith("file://")) {
          try {
            const filePath = seg.data.file.slice(7);
            const base64Data = await fileToBase64(filePath);
            segments.push({ type: "record", data: { file: base64Data } });
          } catch (err) {
            log.warn("forward.resolveRecord.fail", { path: seg.data.file, error: String(err) });
          }
        } else {
          segments.push(seg);
        }
      }
      resolvedNode.content = segments;
    }

    resolved.push(resolvedNode);
  }
  return resolved;
}

export function createP1IpcServer(port: number, deps: P1IpcServerDeps): IpcServer {
  const server = new IpcServer(port, "P1");

  // ── send_message (P2 → P1): 委托 P1 发送消息 ──
  server.on("send_message", async (rawPayload, reply) => {
    const payload = rawPayload as {
      group_id: number;
      message: string;
      method?: "normal" | "forward";
      meme_url?: string;
      forward_nodes?: ForwardNode[];
      tts_audio?: string;
      image_path?: string;
    };
    log.info("send_message.recv", {
      group_id: payload.group_id,
      method: payload.method ?? "normal",
      textLen: payload.message?.length ?? 0,
      hasMeme: !!payload.meme_url,
      hasTtsAudio: !!payload.tts_audio,
    });

    try {
      let messageId: number | null = null;

      // TTS 音频：读取本地 WAV → base64 → 发送独立 record 消息
      if (payload.tts_audio) {
        try {
          const base64Data = await fileToBase64(payload.tts_audio);
          const recordSegment: MessageSegment = {
            type: "record",
            data: { file: base64Data },
          };
          const result = await sendGroupMessage(deps.wsClient, payload.group_id, [recordSegment]);
          messageId = result.message_id;
          log.info("tts_audio.sent", { group_id: payload.group_id, message_id: messageId });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error("tts_audio.fail", { path: payload.tts_audio, error: errMsg });
          // 发送失败时发送文本提示
          await sendGroupMessage(deps.wsClient, payload.group_id, "[语音合成失败，请重试]");
        }
      }

      // text2image 图片：读取本地图片 → base64 → 发送独立 image 消息
      if (payload.image_path) {
        try {
          const base64Data = await fileToBase64(payload.image_path);
          const imageSegment: MessageSegment = {
            type: "image",
            data: { file: base64Data },
          };
          const result = await sendGroupMessage(deps.wsClient, payload.group_id, [imageSegment]);
          messageId = result.message_id;
          log.info("image_path.sent", { group_id: payload.group_id, message_id: messageId });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error("image_path.fail", { path: payload.image_path, error: errMsg });
          await sendGroupMessage(deps.wsClient, payload.group_id, "[图片发送失败，请重试]");
        }
      }

      if (payload.method === "forward" && payload.forward_nodes) {
        // 合并转发：先解析节点中的 file:// record → base64://（Docker 隔离兼容）
        const resolvedNodes = await resolveForwardRecordSegments(payload.forward_nodes);
        const result = await sendGroupForwardMessage(deps.wsClient, payload.group_id, resolvedNodes);
        messageId = result.message_id;

        // 如果有 meme 图片，转发之后再单独发一条图片消息
        if (payload.meme_url && MEME_URL_RE.test(payload.meme_url)) {
          try {
            const base64 = await downloadMemeToBase64(payload.meme_url);
            const memeSegments: MessageSegment[] = [
              { type: "image", data: { file: `base64://${base64}` } },
            ];
            await sendGroupMessage(deps.wsClient, payload.group_id, memeSegments);
            log.info("meme.forward.appended", { group_id: payload.group_id });
          } catch (err) {
            log.warn("meme.forward.skipped", { url: payload.meme_url, error: String(err) });
          }
        }
      } else if (payload.meme_url && MEME_URL_RE.test(payload.meme_url)) {
        // 文本 + meme 图片在同一消息中：下载 meme → 构建 segments
        const segments: MessageSegment[] = [];
        if (payload.message) {
          segments.push({ type: "text", data: { text: payload.message } });
        }
        try {
          const base64 = await downloadMemeToBase64(payload.meme_url);
          segments.push({ type: "image", data: { file: `base64://${base64}` } });
        } catch (err) {
          log.warn("meme.download.skipped", { url: payload.meme_url, error: String(err) });
          // 图片下载失败时，以文本链接形式附加，至少用户能看到内容
          if (payload.message) {
            segments.push({ type: "text", data: { text: `\n${payload.meme_url}` } });
          }
        }
        const result = await sendGroupMessage(deps.wsClient, payload.group_id, segments);
        messageId = result.message_id;
      } else if (payload.message) {
        const result = await sendGroupMessage(deps.wsClient, payload.group_id, payload.message);
        messageId = result.message_id;
      }

      if (messageId != null) {
        deps.registerBotMessageId(payload.group_id, messageId);
      }
      reply({ message_id: messageId });
      log.info("send_message.done", { message_id: messageId });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("send_message.fail", { group_id: payload.group_id, error: errMsg });
      reply({ message_id: null, error: errMsg });
    }
  });

  // ── error_alert (P3 → P1): 发送错误告警到监控群 ──
  server.on("error_alert", async (rawPayload, reply) => {
    const payload = rawPayload as { group_id: number; message: string };
    log.warn("error_alert.recv", { group_id: payload.group_id, textLen: payload.message.length });

    try {
      await sendGroupMessage(deps.wsClient, deps.errorAlertGroupId, payload.message);
      reply({ sent: true });
    } catch (err) {
      log.error("error_alert.fail", { error: String(err) });
      reply({ sent: false, error: String(err) });
    }
  });

  // ── qq_action (P3 → P1): QQ 互动操作（muri_agent tools）──
  server.on("qq_action", async (rawPayload, reply) => {
    const payload = rawPayload as QqActionPayload;
    log.info("qq_action.recv", { action: payload.action, params: payload.params });

    try {
      switch (payload.action) {
        case "send_like": {
          const userId = Number(payload.params.user_id);
          const times = Number(payload.params.times ?? 1);
          await sendLike(deps.wsClient, userId, times);
          break;
        }
        case "send_poke": {
          const userId = Number(payload.params.user_id);
          await sendPoke(deps.wsClient, userId);
          break;
        }
        case "group_poke": {
          const groupId = Number(payload.params.group_id);
          const userId = Number(payload.params.user_id);
          await groupPoke(deps.wsClient, groupId, userId);
          break;
        }
        case "set_group_reaction": {
          const messageId = Number(payload.params.message_id);
          const code = String(payload.params.code);
          const groupId = payload.params.group_id != null ? Number(payload.params.group_id) : undefined;
          await setGroupReaction(deps.wsClient, messageId, code, groupId);
          break;
        }
        case "get_group_file_url": {
          const groupId = Number(payload.params.group_id);
          const fileId = String(payload.params.file_id ?? "");
          const fileResult = await getGroupFileUrl(deps.wsClient, groupId, fileId);
          reply({ success: true, result: { url: fileResult.url } });
          log.info("qq_action.done", { action: payload.action, hasUrl: !!fileResult.url });
          return;
        }
        case "send_group_msg": {
          // 通用群消息发送：params.message 为 MessageSegment[]（text/image/music/json 等任意段）。
          // 供 P3 工具（如点歌 send_song_card 发 music 段）经 IPC 直接发送富媒体。
          const groupId = Number(payload.params.group_id);
          const message = payload.params.message;
          if (!Number.isFinite(groupId) || !Array.isArray(message) || message.length === 0) {
            throw new Error("send_group_msg requires params.group_id and params.message array");
          }
          const result = await sendGroupMessage(deps.wsClient, groupId, message as MessageSegment[]);
          reply({ success: true, result: { message_id: result.message_id } });
          log.info("qq_action.done", { action: payload.action, message_id: result.message_id });
          return;
        }
        default:
          throw new Error(`Unknown qq_action: ${payload.action}`);
      }
      reply({ success: true });
      log.info("qq_action.done", { action: payload.action });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("qq_action.fail", { action: payload.action, error: errMsg });
      reply({ success: false, error: errMsg });
    }
  });

  // ── temp_mute (P3 → P1): 临时禁言 ──
  server.on("temp_mute", async (rawPayload, reply) => {
    const payload = rawPayload as TempMutePayload;
    log.info("temp_mute.recv", {
      user_id: payload.user_id,
      mute_time: payload.mute_time,
      severe_level: payload.severe_level,
    });

    try {
      const userId = Number(payload.user_id);
      const muteTime = Number(payload.mute_time);
      const severeLevel = Number(payload.severe_level);

      if (!Number.isFinite(userId) || userId <= 0) {
        reply({ success: false, error: `无效的 user_id: ${payload.user_id}` });
        return;
      }
      if (!Number.isFinite(muteTime) || muteTime < 0) {
        reply({ success: false, error: `无效的 mute_time: ${payload.mute_time}` });
        return;
      }
      if (!Number.isFinite(severeLevel) || severeLevel < 0) {
        reply({ success: false, error: `无效的 severe_level: ${payload.severe_level}` });
        return;
      }

      const entry = deps.tempMuteList.mute(userId, muteTime, severeLevel);
      const actualDuration = entry.mute_time_sec * entry.severe_level;

      reply({
        success: true,
        muted_until: entry.mute_end_time,
        actual_duration: actualDuration,
      });

      log.info("temp_mute.done", {
        user_id: userId,
        actual_duration: actualDuration,
        muted_until: entry.mute_end_time,
        listSize: deps.tempMuteList.size,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("temp_mute.fail", { error: errMsg });
      reply({ success: false, error: errMsg });
    }
  });

  // ── ping (watchdog) ──
  server.on("ping", (_payload, reply) => {
    reply(null);
  });

  return server;
}

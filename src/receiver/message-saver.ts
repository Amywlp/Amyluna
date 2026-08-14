/**
 * P1 Message Saver — 消息入库 + 富媒体提取。
 *
 * 收到即存 DB（白名单群），解析 MessageSegment[] 提取:
 * - image → image_urls 列 + media_parsed bit0
 * - video → video_urls 列 + media_parsed bit1
 * - record → voice_urls 列 + media_parsed bit2
 * - forward → 调 get_forward_msg 解析 → merged_forward 列 + media_parsed bit3
 * - 其他 → other_media 列 + media_parsed bit4+
 */

import type { MessageRepository } from "../common/db/message-repository";
import type { GroupMessageEvent, MessageSegment } from "../common/types/onebot";
import { extractImageUrls } from "../common/text";
import { createLogger } from "../common/logger";
import type { WsClient } from "./ws-client";
import { getForwardMsg } from "./send-api";

const log = createLogger("P1.saver");

// ─── 位掩码 ────────────────────────────────────────────
const BIT_IMAGE = 1 << 0;   // bit0
const BIT_VIDEO = 1 << 1;   // bit1
const BIT_VOICE = 1 << 2;   // bit2
const BIT_FORWARD = 1 << 3; // bit3
const BIT_OTHER = 1 << 4;   // bit4+

export interface SaveResult {
  saved: boolean;
  messageId: number;
  hasImages: boolean;
  hasForward: boolean;
  imageUrls: string[];
}

export async function saveMessage(
  event: GroupMessageEvent,
  repo: MessageRepository,
  wsClient: WsClient,
): Promise<SaveResult> {
  const segments = Array.isArray(event.message) ? event.message : [];
  const rawMsg = typeof event.raw_message === "string" ? event.raw_message : "";
  const senderName = event.sender?.nickname ?? event.sender?.card ?? "unknown";
  const textContent = extractTextContent(segments, rawMsg);

  let mediaParsed = 0;
  let imageUrls: string[] = [];
  let videoUrls: string | null = null;
  let voiceUrls: string | null = null;
  let otherMedia: string[] = [];
  let mergedForward: string | null = null;
  let quotedMessageId: string | null = null;

  for (const seg of segments) {
    switch (seg.type) {
      case "image": {
        const urls = extractImageUrls([seg]);
        if (urls.length > 0) { imageUrls.push(...urls); mediaParsed |= BIT_IMAGE; }
        break;
      }
      case "video": {
        const url = String(seg.data.url ?? seg.data.file ?? "");
        if (url) { videoUrls = (videoUrls ? videoUrls + "," : "") + url; mediaParsed |= BIT_VIDEO; }
        break;
      }
      case "record": {
        const url = String(seg.data.url ?? seg.data.file ?? "");
        if (url) { voiceUrls = (voiceUrls ? voiceUrls + "," : "") + url; mediaParsed |= BIT_VOICE; }
        break;
      }
      case "forward": {
        mediaParsed |= BIT_FORWARD;
        const fwdId = String(seg.data.id ?? "");
        if (fwdId) {
          try {
            const nodes = await getForwardMsg(wsClient, fwdId);
            const lines = ["[合并转发消息]"];
            for (const node of nodes) {
              const name = node.sender?.nickname ?? node.sender?.card ?? "unknown";
              const nodeText = extractTextFromSegments(node.message);
              lines.push(`[${name}](${node.user_id}): ${nodeText || "[非文本消息]"}`);
            }
            mergedForward = lines.join("\n");
          } catch (err) {
            log.warn("forward.parse.fail", { id: fwdId, error: String(err) });
            mergedForward = "[合并转发消息（获取失败）]";
          }
        }
        break;
      }
      case "reply": {
        quotedMessageId = String(seg.data.message_id ?? seg.data.id ?? "");
        break;
      }
      default: {
        if (seg.type !== "text" && seg.type !== "at" && seg.type !== "json") {
          otherMedia.push(seg.type);
          mediaParsed |= BIT_OTHER;
        }
        break;
      }
    }
  }

  // 也检查 raw_message 中的 reply
  if (!quotedMessageId && rawMsg.includes("[CQ:reply")) {
    const m = rawMsg.match(/\[CQ:reply,[^\]]*\bid=(-?\d+)/);
    if (m) quotedMessageId = m[1];
  }

  const saved = await repo.insertOrReplace({
    message_id: event.message_id,
    group_id: event.group_id,
    user_id: event.user_id,
    sender_name: senderName,
    is_private: false,
    role: "user",
    content: textContent || rawMsg || "[non-text message]",
    image_urls: imageUrls.length > 0 ? JSON.stringify(imageUrls) : null,
    video_urls: videoUrls,
    voice_urls: voiceUrls,
    other_media: otherMedia.length > 0 ? otherMedia.join(",") : null,
    merged_forward: mergedForward,
    media_parsed: mediaParsed,
    quoted_message_id: quotedMessageId || null,
  });

  log.info("save.done", {
    message_id: event.message_id,
    group_id: event.group_id,
    user_id: event.user_id,
    mediaParsed,
    hasImages: imageUrls.length > 0,
    hasForward: !!mergedForward,
  });

  return {
    saved: true,
    messageId: saved.id,
    hasImages: imageUrls.length > 0,
    hasForward: !!mergedForward,
    imageUrls,
  };
}

// ─── 辅助函数 ──────────────────────────────────────────

function extractTextContent(segments: MessageSegment[], rawMsg: string): string {
  const text = segments
    .filter((s) => s.type === "text")
    .map((s) => String(s.data.text ?? ""))
    .join("");

  // 如果消息只有非文本段（图片/转发等），用 raw_message 回退
  if (!text.trim() && segments.length > 0) {
    const hasTextualContent = segments.some((s) =>
      s.type === "image" || s.type === "forward" || s.type === "record" || s.type === "video",
    );
    if (hasTextualContent && rawMsg) {
      // 清洗 CQ 码为占位符
      return rawMsg
        .replace(/\[CQ:image,[^\]]*\]/g, "[image]")
        .replace(/\[CQ:video,[^\]]*\]/g, "[视频]")
        .replace(/\[CQ:record,[^\]]*\]/g, "[语音]")
        .replace(/\[CQ:forward,[^\]]*\]/g, "[合并转发]");
    }
  }
  return text.trim();
}

function extractTextFromSegments(segments: MessageSegment[]): string {
  return segments
    .filter((s) => s.type === "text")
    .map((s) => String(s.data.text ?? ""))
    .join("");
}

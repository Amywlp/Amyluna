/**
 * 文本处理工具：CQ 码解析、引用拆分、回复构建。
 * 迁移自 v1 utils/text.ts。
 */

import type { MessageSegment } from "./types/onebot";

// ─── 文本提取 ──────────────────────────────────────────

/** 从 message segments 中提取纯文本拼接 */
export function extractText(segments: MessageSegment[]): string {
  return segments
    .filter((seg) => seg.type === "text")
    .map((seg) => String(seg.data.text ?? ""))
    .join("");
}

/** 从 message segments 中去除 AT 段并提取文本 */
export function extractTextWithoutAt(segments: MessageSegment[], selfId?: number): string {
  return segments
    .filter((seg) => {
      if (seg.type === "at") {
        if (selfId !== undefined && Number(seg.data.qq) === selfId) return false;
        return false; // 过滤所有 AT
      }
      return seg.type === "text";
    })
    .map((seg) => String(seg.data.text ?? ""))
    .join("");
}

// ─── CQ 码解析 ─────────────────────────────────────────

/** 检查消息中是否包含 AT 机器人的段 */
export function hasAtBot(segments: MessageSegment[], botId: number): boolean {
  return segments.some(
    (seg) => seg.type === "at" && Number(seg.data.qq) === botId,
  );
}

/** 提取消息中的所有图片 URL */
export function extractImageUrls(segments: MessageSegment[]): string[] {
  return segments
    .filter((seg) => seg.type === "image")
    .map((seg) => String(seg.data.url ?? seg.data.file ?? ""))
    .filter(Boolean);
}

/** 提取消息中的引用消息 ID */
export function extractQuotedMessageId(segments: MessageSegment[]): string | null {
  const replySeg = segments.find((seg) => seg.type === "reply");
  if (!replySeg) return null;
  const id = replySeg.data.message_id ?? replySeg.data.id;
  return id != null ? String(id) : null;
}

// ─── 回复拆分 ──────────────────────────────────────────

export interface SplitReplyResult {
  /** 被引用的消息 ID */
  quotedId: string | null;
  /** 除去引用段后的剩余 text segments */
  remaining: MessageSegment[];
}

/** 分离引用段和剩余段 */
export function splitReply(segments: MessageSegment[]): SplitReplyResult {
  const replyIdx = segments.findIndex((seg) => seg.type === "reply");
  if (replyIdx === -1) return { quotedId: null, remaining: segments };

  const replySeg = segments[replyIdx];
  const quotedId = String(replySeg.data.message_id ?? replySeg.data.id ?? "");
  const remaining = segments.filter((_, i) => i !== replyIdx);
  return { quotedId: quotedId || null, remaining };
}

// ─── 回复构建 ──────────────────────────────────────────

/** 构建带引用的回复段 */
export function buildReplySegments(
  quotedMessageId: number | string,
  text: string,
): Array<{ type: string; data: Record<string, unknown> }> {
  return [
    { type: "reply", data: { id: String(quotedMessageId) } },
    { type: "text", data: { text } },
  ];
}

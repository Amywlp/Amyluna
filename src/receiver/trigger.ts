/**
 * P1 Trigger 判断 — 检测消息是否应触发 Bot 回复。
 *
 * 优先级: AT > 引用(reply) > 关键词 > PRD 随机
 * 从 v1 ChatManager.isTriggered() 迁移。
 */

import type { GroupMessageEvent, MessageSegment } from "../common/types/onebot";
import { createLogger } from "../common/logger";

const log = createLogger("P1.trigger");

export interface TriggerConfig {
  botId: number;
  triggerKeywords: string[];
  prdC: number;
}

export interface GroupTriggerState {
  /** PRD 当前概率（从 prdC 起步，每次未触发累加，触发后重置） */
  prdP: number;
}

export interface TriggerResult {
  triggered: boolean;
  reason?: "at" | "reply" | "keyword" | "prd";
}

/**
 * 判断一条消息是否触发 Bot 回复。
 * @param event 群消息事件
 * @param cleanText 清洗后的纯文本（去除 AT、引用段标签等）
 * @param state 群触发状态（维护 prdP）
 * @param isReplyToBot 检查引用消息的发送者是否为 bot（由外部回调提供）
 */
export function isTriggered(
  event: GroupMessageEvent,
  cleanText: string,
  config: TriggerConfig,
  state: GroupTriggerState,
  isReplyToBot: (replyMsgId: number) => boolean,
): TriggerResult {
  const segments = Array.isArray(event.message) ? event.message : [];
  const raw = (typeof event.raw_message === "string" ? event.raw_message : "")
    || (typeof event.message === "string" ? event.message : "");
  const botIdStr = String(config.botId);

  // 纯转发/json 消息不触发
  const hasOnlyNonTriggerable = segments.length > 0
    && segments.every((s) => s.type === "forward" || s.type === "json");
  if (hasOnlyNonTriggerable) {
    return { triggered: false };
  }

  // ── 优先级 1: AT ──
  for (const seg of segments) {
    if (seg.type === "at") {
      const targetId = seg.data?.qq ?? seg.data?.user_id;
      if (targetId !== undefined && String(targetId) === botIdStr) {
        log.debug("trigger.at", { targetId });
        return { triggered: true, reason: "at" };
      }
    }
  }
  if (raw.includes("[CQ:at,qq=" + botIdStr) || raw.includes("@" + botIdStr)) {
    log.debug("trigger.at.raw");
    return { triggered: true, reason: "at" };
  }

  // ── 优先级 2: 引用(reply) — 检查被引用消息是否 bot 发送 ──
  for (const seg of segments) {
    if (seg.type === "reply") {
      const replyMsgId = Number(seg.data?.id);
      if (Number.isFinite(replyMsgId) && isReplyToBot(replyMsgId)) {
        log.debug("trigger.reply", { replyMsgId });
        return { triggered: true, reason: "reply" };
      }
    }
  }
  if (raw.includes("[CQ:reply")) {
    const idMatch = raw.match(/\[CQ:reply,[^\]]*\bid=(-?\d+)/);
    if (idMatch) {
      const replyMsgId = Number(idMatch[1]);
      if (Number.isFinite(replyMsgId) && isReplyToBot(replyMsgId)) {
        log.debug("trigger.reply.raw", { replyMsgId });
        return { triggered: true, reason: "reply" };
      }
    }
  }

  // ── 优先级 3: 关键词 ──
  // 归一化全角波浪号（～ U+FF5E）→ 半角（~ U+007E），兼容用户输入习惯
  const textForTrigger = cleanText
    .replace(/～/g, "~")
    .replace(/^\[image\]\s*/, "");
  for (const kw of config.triggerKeywords) {
    const normKw = kw.replace(/～/g, "~");
    if (textForTrigger.startsWith(normKw)) {
      log.debug("trigger.keyword", { keyword: kw });
      return { triggered: true, reason: "keyword" };
    }
  }

  // ── 优先级 4: PRD 随机触发 ──
  if (config.prdC > 0) {
    const roll = Math.random();
    if (roll < state.prdP) {
      log.info("trigger.prd", { prdP: state.prdP, roll, resetTo: config.prdC });
      state.prdP = config.prdC;
      return { triggered: true, reason: "prd" };
    } else {
      state.prdP += config.prdC;
      log.debug("trigger.prd.miss", { prdP: state.prdP, roll });
    }
  }

  return { triggered: false };
}

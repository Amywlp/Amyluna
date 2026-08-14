/**
 * LLM 回复后处理模块。
 *
 * 功能：拆解 LLM 原始回复文本，提取动作描述、匹配情感标签、
 *       判断发送方式（普通/合并转发）。
 *
 * 在 P2 收到 P3 的 chat_response 或 intermediate_reply 后调用。
 *
 * 迁移自 v1 chat/post-process.ts。
 */
import { createLogger } from "../common/logger";

const log = createLogger("P2.post");

/** memesluna 表情图片 URL 模式。 */
const MEME_URL_RE = /https?:\/\/127\.0\.0\.1:5141\/memesluna\/[^\s]+/;

/** 通用 URL 模式（用于纯文本字数统计时剔除）。 */
const ANY_URL_RE = /https?:\/\/[^\s]+/g;

/** CQ 码模式（[CQ:image,...]、[CQ:at,...] 等）。 */
const CQ_CODE_RE = /\[CQ:[^\]]+\]/g;

/** 发送方式。 */
export type SendMethod = "normal" | "forward";

/** LLM 回复拆解结果。 */
export interface PostProcessResult {
  /** 处理后的纯文本（去除动作描述等格式化内容）。当前阶段原样保留全文。 */
  text: string;
  /** 从 LLM 返回结构中提取的参数列表。 */
  params: Record<string, unknown>;
  /** 发送方式。 */
  sendMethod: SendMethod;
}

/** LLM 回复后处理函数签名。 */
export type PostProcessor = (text: string) => PostProcessResult;

/** 纯文本字数阈值：超过此值使用合并转发发送。 */
const FORWARD_TEXT_THRESHOLD = 80;

/**
 * 统计消息中纯文本的字数。
 * 剔除 URL、CQ 码、[image] 占位符后，返回剩余可见文本的字符数。
 */
function countPlainText(text: string): number {
  let cleaned = text.replace(ANY_URL_RE, "");
  cleaned = cleaned.replace(CQ_CODE_RE, "");
  cleaned = cleaned.replace(/\[image\]/g, "");
  // 仅保留可见字符（排除空白），模拟真实发送时用户看到的字数
  return cleaned.replace(/\s/g, "").length;
}

/** 从回复首行提取 （动作描述） 中的内容。 */
function extractActionText(reply: string): string {
  const firstLine = reply.split("\n")[0] ?? "";
  const match = firstLine.match(/（([^）]*)）/);
  return match?.[1] ?? "";
}

/** 从回复中提取 meme URL（若有）。 */
function extractMemeUrl(reply: string): string | null {
  const match = reply.match(MEME_URL_RE);
  return match?.[0] ?? null;
}

/** 从回复中移除首行动作描述行（如果有 （xxx） 格式）。 */
function stripActionLine(reply: string): string {
  const lines = reply.split("\n");
  let start = 0;
  if (lines.length > 0 && /^（[^）]*）/.test(lines[0]!.trim())) {
    start = 1;
  }
  // 同时移除末行 meme URL
  let end = lines.length;
  if (end > start && MEME_URL_RE.test(lines[end - 1]!.trim())) {
    end--;
  }
  return lines.slice(start, end).join("\n").trim();
}

/** 情感关键词到标签的映射表。Ordered — first match wins. */
const EMOTION_TO_TAG: Array<[keywords: string[], tag: string]> = [
  [["满足", "开心", "高兴", "快乐", "得意", "炫耀", "温暖", "幸福", "治愈", "笑", "翘起", "眯起", "心满意足"], "满足"],
  [["委屈", "难过", "伤心", "沮丧", "流泪", "大哭", "心疼", "低落", "叹气", "叹息", "垂", "耷拉"], "委屈"],
  [["生气", "愤怒", "炸毛", "不爽", "恼火", "气愤", "发怒", "瞪", "吼", "怒"], "生气"],
  [["害羞", "脸红", "羞涩", "不好意思", "尴尬", "扭捏", "别过脸"], "害羞"],
  [["赞", "好", "棒", "点赞", "强", "厉害", "牛逼", "给力", "赞赏", "认同", "佩服", "竖起拇指"], "赞"],
];

/** 根据动作描述文本匹配情感标签。 */
function matchEmotionTag(action: string): string {
  for (const [keywords, tag] of EMOTION_TO_TAG) {
    for (const kw of keywords) {
      if (action.includes(kw)) return tag;
    }
  }
  return "开心"; // 默认
}

/** 创建 LLM 回复拆解处理器。 */
export function createDecomposePostProcessor(): PostProcessor {
  return (text: string) => {
    const action = extractActionText(text);
    const memeUrl = extractMemeUrl(text);
    const bodyText = stripActionLine(text);
    const emotion = action ? matchEmotionTag(action) : "开心";

    const hasMeme = memeUrl !== null;
    const lineCount = text.split("\n").length;
    const totalLen = text.length;

    const params: Record<string, unknown> = {
      /** 动作描述文本（首行 （）中的内容）。 */
      action,
      /** 匹配到的情感标签。 */
      emotion,
      /** 是否有表情包 URL。 */
      hasMeme,
      /** 表情包 URL（若有）。 */
      memeUrl,
      /** 去除动作描述后的正文。 */
      bodyText,
      /** 回复总行数。 */
      lineCount,
      /** 回复总字符数。 */
      totalLen,
    };

    // 发送方式判断：纯文本字数 > 阈值 → 合并转发
    const plainLen = countPlainText(bodyText);
    const sendMethod: SendMethod = plainLen > FORWARD_TEXT_THRESHOLD ? "forward" : "normal";

    log.debug("decompose", { action, emotion, hasMeme, lineCount, totalLen, plainLen, sendMethod });

    if (hasMeme && plainLen === 0) {
      log.warn("emptyBody", { totalLen, lineCount, hasMeme, memeUrl: memeUrl?.slice(0, 120) });
    }

    return { text, params, sendMethod };
  };
}

/** 创建空后处理器（入参原样返回，参数列表为空）。 */
export function createNoopPostProcessor(): PostProcessor {
  return (text: string) => ({ text, params: {}, sendMethod: "normal" as SendMethod });
}

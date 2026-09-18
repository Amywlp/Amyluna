/**
 * 静默工具文本提取器 — 从 LLM 回复文本中提取 getmeme()、affinity() 和 timer() 标记。
 *
 * LLM 不通过标准 function calling 调用这些工具，而是在回复文本中
 * 按预设格式写入标记，由 P2 解析并执行：
 *
 *   getmeme(情绪标签)        — 表情图片，如 getmeme(开心)
 *   affinity(用户id, bool)    — 好感度变更，true=+1, false=-1
 *   timer(时间, "事件文本")   — 定时提醒，如 timer(5分钟, "喝水")
 *
 * 提取后从文本中移除所有标记，返回清洗后的文本和提取到的调用数据。
 */

import { createLogger } from "../common/logger";
import { stripStdToolText } from "../common/tool-text-guard";

const log = createLogger("P2.silent-extract");

/** get_meme 可用标签集合（与 silent-tools.ts 中的 VALID_MEME_TAGS 保持一致） */
const VALID_MEME_TAGS = new Set([
  "幸福", "开心", "高兴", "快乐", "治愈", "满足",
  "委屈", "难过", "伤心", "沮丧", "流泪", "大哭",
  "生气", "愤怒", "炸毛", "不爽", "恼火", "气愤",
  "害羞", "脸红", "羞涩", "不好意思",
  "赞", "好", "棒", "点赞", "强", "厉害", "牛逼", "给力",
]);

/** 提取到的单条好感度调用 */
export interface AffinityCall {
  userId: number;
  delta: "+1" | "-1";
  /** 用户印象（可选，≤10 字），LLM 合成 */
  impression?: string;
}

/** 提取到的定时器调用 */
export interface TimerCall {
  /** 时长（秒），已解析并应用最小值限制 */
  durationSec: number;
  /** 事件文本 */
  eventText: string;
}

/** 提取到的 TTS 调用 */
export interface TtsCall {
  /** TTS 文本内容 */
  text: string;
  /** 语言标签：zh | ja | en | ko | yue | auto，默认 zh */
  lang?: string;
  /** 中文翻译（非中文时 LLM 提供，可选） */
  translation?: string;
}

/** 提取到的 muri agent 调用 */
export interface MuriAgentCall {
  /** 子代理任务描述 */
  task: string;
  /** 触发用户 ID（由外部传入） */
  userId?: number;
  /** 触发消息 ID（由外部传入） */
  messageId?: number;
}

/** 提取到的 text2image 调用 */
export interface Text2ImageCall {
  /** 文生图主题描述 */
  topic: string;
}

/** 提取结果 */
export interface ExtractedSilentCalls {
  /** 清洗后的文本（所有 getmeme()、affinity() 和 timer() 标记已移除） */
  cleanedText: string;
  /** 提取到的 get_meme 标签（取最后一个有效标签，无则为 null） */
  memeTag: string | null;
  /** 提取到的 affinity 调用列表（同一 userId 只保留最后一条） */
  affinityCalls: AffinityCall[];
  /** 提取到的 timer 调用（取最后一条，无则为 null） */
  timerCall: TimerCall | null;
  /** 提取到的 TTS 调用（取最后一条有效调用，无则为 null） */
  ttsCall: TtsCall | null;
  /** 提取到的 muri agent 调用（取最后一条，无则为 null） */
  muriAgentCall: MuriAgentCall | null;
  /** 提取到的 text2image 调用（取最后一条，无则为 null） */
  text2imageCall: Text2ImageCall | null;
}

/** getmeme(标签) 匹配模式 */
const GETMEME_RE = /getmeme\(([^)]*)\)/g;

/** affinity(用户id, true/false, "印象?") 匹配模式。
 *  第三个参数可选：双引号包裹的印象文本，≤10 字。 */
const AFFINITY_RE = /affinity\((\d+),\s*(true|false)(?:,\s*"([^"]{1,10})")?\)/g;

/** timer(时间, "事件文本") 匹配模式。
 *  时间支持: 5分钟/5min/5m、30秒/30s、1小时/1h、纯数字。
 *  事件文本用双引号包裹。 */
const TIMER_RE = /timer\(([^,)]*),\s*"([^"]*)"\)/g;

/** tts("文本", "语言?", "中文翻译?") 匹配模式。
 *  组1: 待合成文本（必填）
 *  组2: 语言标签（可选，zh|ja|en|ko|yue|auto）
 *  组3: 中文翻译（可选，非中文时提供） */
const TTS_RE = /tts\(\s*"([^"]*)"\s*(?:,\s*"([^"]*)")?\s*(?:,\s*"([^"]*)")?\s*\)/g;

/** 合法的 TTS 语言标签集合 */
const VALID_TTS_LANGS = new Set(["zh", "ja", "en", "ko", "yue", "auto"]);

/** TTS 文本最大长度 */
const TTS_MAX_TEXT_LEN = 300;

/** muri_agent("任务描述") 匹配模式（占位，暂不实现提取） */
const MURI_AGENT_RE = /muri_agent\("([^"]*)"\)/g;

/** text2image("主题描述") 匹配模式 */
const T2I_RE = /text2image\(\s*"([^"]*)"\s*\)/g;

/** text2image 主题最大长度 */
const T2I_MAX_TOPIC_LEN = 200;

/** temp_mute(...) 残留剥离 — 非文本调用工具，模型误写为文本时剥离防泄漏 */
const TEMP_MUTE_RE = /temp_mute\s*\([^)]*\)/g;

// 标准工具文本标记剥离名单的唯一来源：src/common/tool-text-guard.ts

/** 最短定时时长（秒） */
const MIN_TIMER_SEC = 60;
/** 最长定时时长（秒）：超过此值视为无效，回退到默认 */
const MAX_TIMER_SEC = 24 * 60 * 60; // 24h
/** 默认定时时长（秒） */
const DEFAULT_TIMER_SEC = 60;

/**
 * 解析时间字符串为秒数。
 * 支持格式：5分钟 / 5min / 5m → 300, 30秒 / 30s → 30, 1小时 / 1h → 3600, 纯数字 → 分钟。
 * 未识别时返回默认值 60 秒，结果强制不小于 60 秒。
 */
function parseDurationSec(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_TIMER_SEC;

  let duration: number;

  // 中文单位
  const minMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*分钟$/);
  if (minMatch) {
    duration = Math.round(Number.parseFloat(minMatch[1]!) * 60);
    return clampDuration(duration, raw);
  }

  const secMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*秒$/);
  if (secMatch) {
    duration = Math.round(Number.parseFloat(secMatch[1]!));
    return clampDuration(duration, raw);
  }

  const hourMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*小时$/);
  if (hourMatch) {
    duration = Math.round(Number.parseFloat(hourMatch[1]!) * 3600);
    return clampDuration(duration, raw);
  }

  // 英文简写
  const hMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*h$/i);
  if (hMatch) {
    duration = Math.round(Number.parseFloat(hMatch[1]!) * 3600);
    return clampDuration(duration, raw);
  }

  const minEnMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*min$/i);
  if (minEnMatch) {
    duration = Math.round(Number.parseFloat(minEnMatch[1]!) * 60);
    return clampDuration(duration, raw);
  }

  const mEnMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*m$/i);
  if (mEnMatch) {
    duration = Math.round(Number.parseFloat(mEnMatch[1]!) * 60);
    return clampDuration(duration, raw);
  }

  const sMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*s$/i);
  if (sMatch) {
    duration = Math.round(Number.parseFloat(sMatch[1]!));
    return clampDuration(duration, raw);
  }

  // 纯数字 → 默认为分钟
  const numMatch = trimmed.match(/^(\d+(?:\.\d+)?)$/);
  if (numMatch) {
    duration = Math.round(Number.parseFloat(numMatch[1]!) * 60);
    return clampDuration(duration, raw);
  }

  // 无法识别 → 默认
  log.warn("timer.unparseableDuration", { raw: trimmed });
  return DEFAULT_TIMER_SEC;
}

/** 应用范围限制：最短 MIN_TIMER_SEC，超过 MAX_TIMER_SEC 回退到默认 */
function clampDuration(seconds: number, raw: string): number {
  if (seconds > MAX_TIMER_SEC) {
    log.warn("timer.durationExceedsMax", { raw, seconds, max: MAX_TIMER_SEC });
    return DEFAULT_TIMER_SEC;
  }
  return Math.max(MIN_TIMER_SEC, seconds);
}

/**
 * 从文本中提取静默工具调用标记。
 *
 * 规则：
 * - getmeme(tag)：取最后一个有效标签，无效标签记录警告后忽略
 * - affinity(userId, bool)：同一 userId 出现多次时只保留最后一条
 * - timer(时间, "文本")：取最后一条
 * - muri_agent("任务描述")：取最后一条
 * - 所有标记从文本中移除（包括无效的），空白行一并清理
 *
 * @param triggerUserId 触发用户 ID（传入 muri_agent 调用）
 * @param triggerMessageId 触发消息 ID（传入 muri_agent 调用）
 */
export function extractSilentCalls(
  text: string,
  triggerUserId?: number,
  triggerMessageId?: number,
): ExtractedSilentCalls {
  // ── 提取 getmeme() ──
  let memeTag: string | null = null;
  const memeMatches: Array<{ tag: string; index: number; length: number }> = [];

  GETMEME_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GETMEME_RE.exec(text)) !== null) {
    const rawTag = (match[1] ?? "").trim();
    memeMatches.push({ tag: rawTag, index: match.index, length: match[0].length });
  }

  if (memeMatches.length > 0) {
    // 取最后一个有效标签
    for (let i = memeMatches.length - 1; i >= 0; i--) {
      const t = memeMatches[i]!;
      if (VALID_MEME_TAGS.has(t.tag)) {
        memeTag = t.tag;
        break;
      }
    }
    if (memeTag) {
      log.info("meme.extracted", { tag: memeTag, totalCalls: memeMatches.length });
    }
    // 记录无效标签
    for (const t of memeMatches) {
      if (t.tag && !VALID_MEME_TAGS.has(t.tag)) {
        log.warn("meme.invalidTag", { tag: t.tag });
      }
    }
  }

  // ── 提取 affinity() ──
  const affinityMap = new Map<number, AffinityCall>();

  AFFINITY_RE.lastIndex = 0;
  while ((match = AFFINITY_RE.exec(text)) !== null) {
    const userId = Number(match[1]);
    const isPositive = match[2] === "true";
    const impressionRaw = (match[3] ?? "").trim();
    if (Number.isFinite(userId) && userId > 0) {
      const impression = impressionRaw
        ? impressionRaw.slice(0, 10) // 防御性截断
        : undefined;
      affinityMap.set(userId, {
        userId,
        delta: isPositive ? "+1" : "-1",
        impression,
      });
    }
  }

  const affinityCalls = [...affinityMap.values()];
  if (affinityCalls.length > 0) {
    log.info("affinity.extracted", {
      count: affinityCalls.length,
      users: affinityCalls.map((a) => `${a.userId}:${a.delta}` + (a.impression ? `[${a.impression}]` : "")),
    });
  }

  // ── 提取 timer() ──
  let timerCall: TimerCall | null = null;
  const timerMatches: Array<{ durationSec: number; eventText: string }> = [];

  TIMER_RE.lastIndex = 0;
  while ((match = TIMER_RE.exec(text)) !== null) {
    const rawDuration = (match[1] ?? "").trim();
    const eventText = (match[2] ?? "").trim();
    if (eventText) {
      const durationSec = parseDurationSec(rawDuration);
      timerMatches.push({ durationSec, eventText });
    } else {
      log.warn("timer.emptyEventText");
    }
  }

  if (timerMatches.length > 0) {
    // 取最后一条有效调用
    const last = timerMatches[timerMatches.length - 1]!;
    timerCall = { durationSec: last.durationSec, eventText: last.eventText };
    log.info("timer.extracted", {
      durationSec: timerCall.durationSec,
      eventText: timerCall.eventText,
      totalCalls: timerMatches.length,
    });
  }

  // ── 提取 tts() ──
  let ttsCall: TtsCall | null = null;
  const ttsMatches: Array<{ text: string; lang?: string; translation?: string }> = [];

  TTS_RE.lastIndex = 0;
  while ((match = TTS_RE.exec(text)) !== null) {
    const ttsText = (match[1] ?? "").trim();
    const ttsLang = (match[2] ?? "").trim() || undefined;
    const ttsTranslation = (match[3] ?? "").trim() || undefined;
    if (ttsText) {
      if (ttsText.length > TTS_MAX_TEXT_LEN) {
        log.warn("tts.textTooLong", { len: ttsText.length, max: TTS_MAX_TEXT_LEN });
      }
      if (ttsLang && !VALID_TTS_LANGS.has(ttsLang.toLowerCase())) {
        log.warn("tts.invalidLang", { lang: ttsLang });
      }
      ttsMatches.push({ text: ttsText, lang: ttsLang, translation: ttsTranslation });
    } else {
      log.warn("tts.emptyText");
    }
  }

  if (ttsMatches.length > 0) {
    const last = ttsMatches[ttsMatches.length - 1]!;
    ttsCall = {
      text: last.text.slice(0, TTS_MAX_TEXT_LEN),
      lang: last.lang,
      translation: last.translation,
    };
    log.info("tts.extracted", {
      textLen: ttsCall.text.length,
      lang: ttsCall.lang ?? "zh",
      hasTranslation: !!ttsCall.translation,
      totalCalls: ttsMatches.length,
    });
  }

  // ── 提取 muri_agent() ──
  let muriAgentCall: MuriAgentCall | null = null;
  const muriAgentMatches: Array<{ task: string }> = [];

  MURI_AGENT_RE.lastIndex = 0;
  while ((match = MURI_AGENT_RE.exec(text)) !== null) {
    const task = (match[1] ?? "").trim();
    if (task) {
      muriAgentMatches.push({ task });
    } else {
      log.warn("muriAgent.emptyTask");
    }
  }

  if (muriAgentMatches.length > 0) {
    const last = muriAgentMatches[muriAgentMatches.length - 1]!;
    muriAgentCall = {
      task: last.task,
      userId: triggerUserId,
      messageId: triggerMessageId,
    };
    log.info("muriAgent.extracted", {
      task: muriAgentCall.task,
      userId: muriAgentCall.userId,
      messageId: muriAgentCall.messageId,
      totalCalls: muriAgentMatches.length,
    });
  }

  // ── 提取 text2image() ──
  let text2imageCall: Text2ImageCall | null = null;
  const t2iMatches: Array<{ topic: string }> = [];

  T2I_RE.lastIndex = 0;
  while ((match = T2I_RE.exec(text)) !== null) {
    const topic = (match[1] ?? "").trim();
    if (topic) {
      if (topic.length > T2I_MAX_TOPIC_LEN) {
        log.warn("text2image.topicTooLong", { len: topic.length, max: T2I_MAX_TOPIC_LEN });
      }
      t2iMatches.push({ topic });
    } else {
      log.warn("text2image.emptyTopic");
    }
  }

  if (t2iMatches.length > 0) {
    const last = t2iMatches[t2iMatches.length - 1]!;
    text2imageCall = { topic: last.topic.slice(0, T2I_MAX_TOPIC_LEN) };
    log.info("text2image.extracted", { topicLen: text2imageCall.topic.length, totalCalls: t2iMatches.length });
  }

  // ── 清洗文本：移除所有标记 ──
  let cleaned = text;
  // 先移除 affinity 标记
  cleaned = cleaned.replace(AFFINITY_RE, "");
  // 再移除 getmeme 标记
  cleaned = cleaned.replace(GETMEME_RE, "");
  // 再移除 timer 标记
  cleaned = cleaned.replace(TIMER_RE, "");
  // 再移除 tts 标记
  cleaned = cleaned.replace(TTS_RE, "");
  // 再移除 muri_agent 标记
  cleaned = cleaned.replace(MURI_AGENT_RE, "");
  // 再移除 text2image 标记
  cleaned = cleaned.replace(T2I_RE, "");
  // 剥离 temp_mute 残留（标准工具误写成文本，系统不解析，剥离防泄漏）
  cleaned = cleaned.replace(TEMP_MUTE_RE, "");
  // 剥离其他标准工具误写的文本标记（search_song / send_song_card / web_search 等）
  cleaned = stripStdToolText(cleaned);

  // 清理残留：标记移除后可能留下多余空行
  cleaned = cleaned
    .split("\n")
    .filter((line) => line.trim() !== "")
    .join("\n")
    .trim();

  return { cleanedText: cleaned, memeTag, affinityCalls, timerCall, ttsCall, muriAgentCall, text2imageCall };
}

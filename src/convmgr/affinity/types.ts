/**
 * 好感度系统 — 共享类型定义。
 *
 * 缓存格式：每个用户一条字符串 "5+1+1" 或 "5+1-1"，
 * 第一个数字为长期好感度，后续为短期变更（"+1" 或 "-1"）。
 *
 * 规则：
 * - LLM 调用工具仅在末尾追加 +1 或 -1
 * - 相邻 +1-1 或 -1+1 抵消后被移除
 * - 连续三个相同符号并入长期好感度并触发 DB 写入
 * - 好感度范围 1-10，超出截断
 *
 * 迁移自 v1 affinity/types.ts。
 */

/** ContextEntry：上下文构建时的单条消息表示。
 *  P2 内部使用，不暴露给其他进程。 */
export interface ContextEntry {
  sender_name: string;
  user_id: number;
  message_id: number;
  text: string;
  time: number;
  role: "user" | "assistant";
}

/** ContextInjector：上下文构建时对每条消息注入外部参数。
 *  返回值放在消息前缀的 {} 块中；返回 null 表示不注入。 */
export interface ContextInjector {
  inject(entry: ContextEntry): string | null;
}

/** 解析后的好感度状态。 */
export interface AffinityParsed {
  longTerm: number;
  shortTerms: string[];
}

/** 好感度范围 1-10 截断。 */
export function clampAffinity(value: number): number {
  return Math.max(1, Math.min(10, Math.round(value)));
}

/** 解析状态字符串，返回长期好感度和短期变更数组。 */
export function parseAffinity(state: string): AffinityParsed {
  const match = state.match(/^(\d+)((?:[+-]1)*)$/);
  if (!match) return { longTerm: 5, shortTerms: [] };
  const longTerm = clampAffinity(Number.parseInt(match[1]!, 10) || 5);
  const shortPart = match[2] ?? "";
  const shortTerms: string[] = [];
  for (let i = 0; i < shortPart.length; i += 2) {
    const token = shortPart.slice(i, i + 2);
    if (token === "+1" || token === "-1") shortTerms.push(token);
  }
  return { longTerm, shortTerms };
}

/** 将解析结果序列化回状态字符串。 */
export function formatAffinity(longTerm: number, shortTerms: string[]): string {
  return String(clampAffinity(longTerm)) + shortTerms.join("");
}

// ─── 用户印象 ──────────────────────────────────────────

/** 印象数组最大长度（FIFO） */
export const MAX_IMPRESSIONS = 10;

/** 冒犯关键词列表（印象匹配用，子串匹配） */
export const OFFENSE_KEYWORDS: readonly string[] = [
  "调戏",
  "越界",
  "冒犯",
  "不敬",
  "挑衅",
  "骚扰",
  "试探",
  "无礼",
  "出言不逊",
];

/**
 * 检查印象数组中是否包含冒犯关键词（子串匹配）。
 * 用于 temp_mute 联动升级判断。
 */
export function hasOffenseKeywords(impressions: string[]): boolean {
  if (!impressions || impressions.length === 0) return false;
  return impressions.some((imp) =>
    OFFENSE_KEYWORDS.some((kw) => imp.includes(kw)),
  );
}

/** 计算当前有效好感度（长期 + 短期折算）。 */
export function effectiveAffinity(state: string): number {
  const { longTerm, shortTerms } = parseAffinity(state);
  let total = longTerm;
  for (const t of shortTerms) {
    total += t === "+1" ? 1 : -1;
  }
  return clampAffinity(total);
}

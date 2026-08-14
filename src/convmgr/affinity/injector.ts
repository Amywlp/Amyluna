/**
 * 好感度 ContextInjector —— 在构建 LLM 上下文时给每条消息注入好感度标记。
 *
 * 格式：affinity:N, 印象:[...]
 * 注入位置：消息前缀的 {} 块中 →
 *   "[MsgID:xxx] [name](id) {group:xxx, affinity:N, 印象:["...","..."]}: text"
 *
 * 静默跳过 assistant 消息（bot 自己没有好感度）。
 *
 * 迁移自 v1 affinity/injector.ts。
 */
import type { ContextInjector, ContextEntry } from "./types";
import type { AffinityCache } from "./cache";

export class AffinityInjector implements ContextInjector {
  constructor(private readonly cache: AffinityCache) {}

  inject(entry: ContextEntry): string | null {
    // bot 自己的消息不注入好感度
    if (entry.role === "assistant") return null;
    // 首次触发用户初始化（异步写 DB，若已存在则无操作）
    this.cache.ensureInitialized(entry.user_id);
    const val = this.cache.getEffective(entry.user_id);

    // 用户印象（仅当有记录时注入）
    const impressions = this.cache.getImpressions(entry.user_id);
    if (impressions.length > 0) {
      const impressionList = impressions.map((s) => `"${s}"`).join(",");
      return `affinity:${val}, 印象:[${impressionList}]`;
    }

    return `affinity:${val}`;
  }
}

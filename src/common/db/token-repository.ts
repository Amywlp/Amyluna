/**
 * token_usage 表记录模块。
 * P3 使用，记录每次 LLM 调用的 token 用量。
 */

import mysql from "mysql2/promise";
import type { Pool } from "./pool";
import { createLogger } from "../logger";

const log = createLogger("token-repo");

// ─── 类型 ──────────────────────────────────────────────

export interface TokenUsageRecord {
  triggerMessageId: number | null;
  replyMessageId: number | null;
  groupId: number;
  model: string;
  provider: string;
  baseUrl: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  cacheWriteTokens?: number;
  cacheMissTokens?: number;
  success: boolean;
  errorMessage?: string;
}

// ─── Repository ────────────────────────────────────────

export class TokenRepository {
  constructor(private readonly pool: Pool) {}

  async insert(record: TokenUsageRecord): Promise<number> {
    log.info("insert", {
      model: record.model,
      totalTokens: record.totalTokens,
      success: record.success,
    });
    const [result] = await this.pool.query(
      `INSERT INTO token_usage
       (trigger_message_id, reply_message_id, group_id, model, provider, base_url,
        prompt_tokens, completion_tokens, total_tokens,
        cached_tokens, reasoning_tokens, cache_write_tokens, cache_miss_tokens,
        success, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.triggerMessageId,
        record.replyMessageId,
        record.groupId,
        record.model,
        record.provider,
        record.baseUrl,
        record.promptTokens,
        record.completionTokens,
        record.totalTokens,
        record.cachedTokens ?? 0,
        record.reasoningTokens ?? 0,
        record.cacheWriteTokens ?? 0,
        record.cacheMissTokens ?? 0,
        record.success ? 1 : 0,
        record.errorMessage ?? null,
      ],
    ) as [mysql.ResultSetHeader, unknown];
    return result.insertId;
  }
}

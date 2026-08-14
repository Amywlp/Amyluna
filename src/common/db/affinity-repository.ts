/**
 * user_affinity 表持久化。
 * P2 使用，管理用户好感度的长期存储。
 */

import mysql from "mysql2/promise";
import type { Pool } from "./pool";
import { createLogger } from "../logger";

const log = createLogger("aff-repo");

// ─── 类型 ──────────────────────────────────────────────

export interface AffinityRow {
  user_id: number;
  long_term_affinity: number;
  short_term_changes: string;
  impressions: string[];
}

// ─── Repository ────────────────────────────────────────

export class AffinityRepository {
  constructor(private readonly pool: Pool) {}

  async get(userId: number): Promise<AffinityRow | null> {
    const [rows] = await this.pool.query(
      `SELECT * FROM user_affinity WHERE user_id = ? LIMIT 1`,
      [userId],
    );
    const list = rows as mysql.RowDataPacket[];
    if (list.length === 0) return null;
    return rowToAffinity(list[0]!);
  }

  async upsert(
    userId: number,
    longTerm: number,
    shortTermChanges: string,
    impressions: string[],
  ): Promise<void> {
    const impressionsJson = impressions.length > 0 ? JSON.stringify(impressions) : null;
    log.info("upsert", { userId, longTerm, impressionCount: impressions.length });
    await this.pool.query(
      `INSERT INTO user_affinity (user_id, long_term_affinity, short_term_changes, impressions)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         long_term_affinity = VALUES(long_term_affinity),
         short_term_changes = VALUES(short_term_changes),
         impressions = VALUES(impressions)`,
      [userId, longTerm, shortTermChanges, impressionsJson],
    );
  }

  async getAll(): Promise<AffinityRow[]> {
    const [rows] = await this.pool.query(`SELECT * FROM user_affinity`);
    return (rows as mysql.RowDataPacket[]).map((r) => rowToAffinity(r));
  }
}

/** 将 DB 行转为 AffinityRow，安全解析 JSON 列 */
function rowToAffinity(row: mysql.RowDataPacket): AffinityRow {
  let impressions: string[] = [];
  if (row.impressions) {
    try {
      const parsed = typeof row.impressions === "string"
        ? JSON.parse(row.impressions)
        : row.impressions;
      if (Array.isArray(parsed)) {
        impressions = parsed.filter((v: unknown) => typeof v === "string") as string[];
      }
    } catch {
      impressions = [];
    }
  }
  return {
    user_id: row.user_id,
    long_term_affinity: row.long_term_affinity,
    short_term_changes: row.short_term_changes ?? "",
    impressions,
  };
}

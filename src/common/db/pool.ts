/**
 * MySQL 连接池模块。
 * 连 amyluna 库，迁移自 v1 storage/pool.ts。
 */

import mysql from "mysql2/promise";
import type { AppConfig } from "../config";
import { createLogger } from "../logger";

const log = createLogger("db");

export type Pool = mysql.Pool;

export function createPool(config: AppConfig["db"]): Pool {
  log.info("pool.create", {
    host: config.host,
    port: config.port,
    database: config.database,
    poolMax: config.poolMax,
  });
  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: config.poolMax,
    idleTimeout: config.poolIdleTimeoutMs,
    charset: "utf8mb4",
    timezone: "+08:00",
  });
}

/**
 * 执行 DDL，在应用启动时调用。
 * 幂等：使用 IF NOT EXISTS。
 */
export async function ensureTables(pool: Pool): Promise<void> {
  const log2 = createLogger("db.ddl");

  // ─── chat_messages ───────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      message_id INT,
      group_id BIGINT NOT NULL,
      sender_name VARCHAR(255),
      user_id BIGINT NOT NULL,
      is_private TINYINT(1) NOT NULL DEFAULT 0,
      role ENUM('user','assistant','system','tool') NOT NULL,
      content TEXT,
      tool_calls JSON,
      image_urls TEXT,
      video_urls TEXT,
      voice_urls TEXT,
      other_media TEXT,
      merged_forward TEXT,
      card_json TEXT,
      media_parsed INT DEFAULT 0,
      quoted_message_id VARCHAR(64),
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE INDEX uq_message_id (message_id),
      INDEX idx_group_time (group_id, created_at DESC),
      INDEX idx_user_time (user_id, created_at DESC),
      INDEX idx_quoted_msg (quoted_message_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  log2.info("table.chat_messages", { status: "ready" });

  // 兼容存量表：补充 card_json 列（json 段卡片 payload 保真存储）
  try {
    await pool.query(`ALTER TABLE chat_messages ADD COLUMN card_json TEXT`);
    log2.info("table.chat_messages.addColumn", { column: "card_json", status: "added" });
  } catch {
    // 列已存在（Duplicate column name）→ 忽略
  }

  // ─── token_usage ─────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      trigger_message_id BIGINT,
      reply_message_id BIGINT,
      group_id BIGINT UNSIGNED,
      model VARCHAR(128),
      provider VARCHAR(64),
      base_url VARCHAR(512),
      prompt_tokens INT UNSIGNED,
      completion_tokens INT UNSIGNED,
      total_tokens INT UNSIGNED,
      cached_tokens INT UNSIGNED,
      reasoning_tokens INT UNSIGNED,
      cache_write_tokens INT UNSIGNED,
      cache_miss_tokens INT UNSIGNED,
      success TINYINT(1) NOT NULL DEFAULT 1,
      error_message TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_group_id (group_id),
      INDEX idx_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  log2.info("table.token_usage", { status: "ready" });

  // ─── user_affinity ───────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_affinity (
      user_id BIGINT NOT NULL PRIMARY KEY,
      long_term_affinity INT NOT NULL DEFAULT 30,
      short_term_changes VARCHAR(255) NOT NULL DEFAULT '',
      impressions JSON DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // 兼容存量表：补充 impressions 列
  try {
    await pool.query(`ALTER TABLE user_affinity ADD COLUMN impressions JSON DEFAULT NULL`);
    log2.info("table.user_affinity.addColumn", { column: "impressions", status: "added" });
  } catch {
    // 列已存在（Duplicate column name）→ 忽略
  }
  log2.info("table.user_affinity", { status: "ready" });

  // ─── group_files（群文件元数据；与 chat_messages 以 message_id 逻辑联查）───
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_files (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      message_id BIGINT NOT NULL UNIQUE,
      group_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      file_id VARCHAR(255) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_size BIGINT,
      url TEXT,
      file_hash VARCHAR(64),
      download_status ENUM('pending','downloaded','failed','expired') DEFAULT 'pending',
      download_error TEXT,
      local_path VARCHAR(512),
      analysis_status ENUM('none','queued','done','failed') DEFAULT 'none',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_group_id (group_id),
      INDEX idx_file_id (file_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  log2.info("table.group_files", { status: "ready" });
}

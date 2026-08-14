/**
 * chat_messages 表完整 CRUD。
 * 含新 7 列（image_urls, video_urls, voice_urls, other_media, merged_forward, media_parsed, quoted_message_id）。
 */

import mysql from "mysql2/promise";
import type { Pool } from "./pool";
import { createLogger } from "../logger";

const log = createLogger("msg-repo");

// ─── 类型 ──────────────────────────────────────────────

export interface StoredMessage {
  id: number;
  message_id: number | null;
  group_id: number;
  user_id: number;
  sender_name: string | null;
  is_private: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls: unknown;
  image_urls: string | null;
  video_urls: string | null;
  voice_urls: string | null;
  other_media: string | null;
  merged_forward: string | null;
  media_parsed: number;
  quoted_message_id: string | null;
  created_at: string;
}

export interface InsertMessage {
  message_id: number | null;
  group_id: number;
  user_id: number;
  sender_name: string | null;
  is_private: boolean;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: unknown;
  image_urls?: string | null;
  video_urls?: string | null;
  voice_urls?: string | null;
  other_media?: string | null;
  merged_forward?: string | null;
  media_parsed?: number;
  quoted_message_id?: string | null;
}

// ─── Repository ────────────────────────────────────────

export class MessageRepository {
  constructor(private readonly pool: Pool) {}

  async insert(msg: InsertMessage): Promise<StoredMessage> {
    return this.insertOrReplace(msg);
  }

  async insertOrReplace(msg: InsertMessage): Promise<StoredMessage> {
    log.info("insert.execute", {
      group_id: msg.group_id,
      user_id: msg.user_id,
      message_id: msg.message_id,
      role: msg.role,
    });
    const [result] = await this.pool.query(
      `REPLACE INTO chat_messages
       (message_id, group_id, user_id, sender_name, is_private, role, content, tool_calls,
        image_urls, video_urls, voice_urls, other_media, merged_forward, media_parsed, quoted_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msg.message_id,
        msg.group_id,
        msg.user_id,
        msg.sender_name,
        msg.is_private ? 1 : 0,
        msg.role,
        msg.content,
        msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
        msg.image_urls ?? null,
        msg.video_urls ?? null,
        msg.voice_urls ?? null,
        msg.other_media ?? null,
        msg.merged_forward ?? null,
        msg.media_parsed ?? 0,
        msg.quoted_message_id ?? null,
      ],
    ) as [mysql.ResultSetHeader, unknown];

    log.info("insert.done", { insertId: result.insertId });
    return {
      id: result.insertId,
      message_id: msg.message_id,
      group_id: msg.group_id,
      user_id: msg.user_id,
      sender_name: msg.sender_name,
      is_private: msg.is_private ? 1 : 0,
      role: msg.role,
      content: msg.content,
      tool_calls: msg.tool_calls ?? null,
      image_urls: msg.image_urls ?? null,
      video_urls: msg.video_urls ?? null,
      voice_urls: msg.voice_urls ?? null,
      other_media: msg.other_media ?? null,
      merged_forward: msg.merged_forward ?? null,
      media_parsed: msg.media_parsed ?? 0,
      quoted_message_id: msg.quoted_message_id ?? null,
      created_at: new Date().toISOString(),
    };
  }

  /** 按 message_id 查找单条消息，用于引用解析 */
  async findByMessageId(messageId: number): Promise<StoredMessage | null> {
    const [rows] = await this.pool.query(
      `SELECT * FROM chat_messages WHERE message_id = ? LIMIT 1`,
      [messageId],
    );
    const list = rows as mysql.RowDataPacket[];
    if (list.length === 0) return null;
    return list[0] as StoredMessage;
  }

  /** 按 group_id 查最近 N 条 */
  async findRecentByGroup(
    groupId: number,
    limit: number,
    isPrivate: boolean = false,
  ): Promise<StoredMessage[]> {
    log.info("query.start", { group_id: groupId, limit, isPrivate });
    const [rows] = await this.pool.query(
      `SELECT * FROM chat_messages
       WHERE group_id = ? AND is_private = ?
       ORDER BY created_at DESC
       LIMIT ${Number(limit)}`,
      [groupId, isPrivate ? 1 : 0],
    );
    const mapped = (rows as mysql.RowDataPacket[]).map((r) => r as StoredMessage);
    log.info("query.done", { rowCount: mapped.length });
    return mapped;
  }

  /** 按 group_id + user_id 查最近 N 条（context_review 工具使用） */
  async findRecentByGroupAndUser(
    groupId: number,
    userId: number,
    limit: number,
  ): Promise<StoredMessage[]> {
    log.info("query.byUser.start", { group_id: groupId, user_id: userId, limit });
    const [rows] = await this.pool.query(
      `SELECT * FROM chat_messages
       WHERE group_id = ? AND user_id = ? AND is_private = 0
       ORDER BY created_at DESC
       LIMIT ${Number(limit)}`,
      [groupId, userId],
    );
    const mapped = (rows as mysql.RowDataPacket[]).map((r) => r as StoredMessage);
    log.info("query.byUser.done", { rowCount: mapped.length });
    return mapped;
  }

  /** 更新消息的 vision 描述（回填） */
  async updateContent(messageId: number, content: string): Promise<void> {
    await this.pool.query(
      `UPDATE chat_messages SET content = ? WHERE message_id = ?`,
      [content, messageId],
    );
  }

  /** 更新 media_parsed 位掩码 */
  async updateMediaParsed(messageId: number, mediaParsed: number): Promise<void> {
    await this.pool.query(
      `UPDATE chat_messages SET media_parsed = ? WHERE message_id = ?`,
      [mediaParsed, messageId],
    );
  }
}

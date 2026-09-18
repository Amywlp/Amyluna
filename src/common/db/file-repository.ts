/**
 * group_files 表 CRUD（群文件元数据）。
 * 与 chat_messages 以 message_id 逻辑联查（非物理外键，因主表用 REPLACE）。
 */

import mysql from "mysql2/promise";
import type { Pool } from "./pool";
import { createLogger } from "../logger";

const log = createLogger("file-repo");

// ─── 类型 ──────────────────────────────────────────────

export type FileDownloadStatus = "pending" | "downloaded" | "failed" | "expired";
export type FileAnalysisStatus = "none" | "queued" | "done" | "failed";

export interface GroupFile {
  id: number;
  message_id: number;
  group_id: number;
  user_id: number;
  file_id: string;
  file_name: string;
  file_size: number | null;
  url: string | null;
  file_hash: string | null;
  download_status: FileDownloadStatus;
  download_error: string | null;
  local_path: string | null;
  analysis_status: FileAnalysisStatus;
  created_at: string;
}

export interface InsertGroupFile {
  message_id: number;
  group_id: number;
  user_id: number;
  file_id: string;
  file_name: string;
  file_size?: number | null;
  url?: string | null;
  file_hash?: string | null;
  download_status?: FileDownloadStatus;
  download_error?: string | null;
  local_path?: string | null;
  analysis_status?: FileAnalysisStatus;
}

// ─── Repository ────────────────────────────────────────

export class FileRepository {
  constructor(private readonly pool: Pool) {}

  /** 插入或覆盖（同 message_id 幂等，保留首次 created_at 语义由 REPLACE 决定） */
  async upsert(file: InsertGroupFile): Promise<GroupFile> {
    log.info("file.upsert", {
      message_id: file.message_id,
      group_id: file.group_id,
      file_name: file.file_name,
    });
    await this.pool.query(
      `REPLACE INTO group_files
       (message_id, group_id, user_id, file_id, file_name, file_size, url, file_hash,
        download_status, download_error, local_path, analysis_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        file.message_id,
        file.group_id,
        file.user_id,
        file.file_id,
        file.file_name,
        file.file_size ?? null,
        file.url ?? null,
        file.file_hash ?? null,
        file.download_status ?? "pending",
        file.download_error ?? null,
        file.local_path ?? null,
        file.analysis_status ?? "none",
      ],
    );
    return this.findByMessageId(file.message_id) as Promise<GroupFile>;
  }

  /** 按 message_id 查找（与 chat_messages 联查键） */
  async findByMessageId(messageId: number): Promise<GroupFile | null> {
    const [rows] = await this.pool.query(
      `SELECT * FROM group_files WHERE message_id = ? LIMIT 1`,
      [messageId],
    );
    const list = rows as mysql.RowDataPacket[];
    if (list.length === 0) return null;
    return list[0] as unknown as GroupFile;
  }

  /** 按 file_id 查找（QQ 文件 id） */
  async findByFileId(fileId: string): Promise<GroupFile | null> {
    const [rows] = await this.pool.query(
      `SELECT * FROM group_files WHERE file_id = ? ORDER BY id DESC LIMIT 1`,
      [fileId],
    );
    const list = rows as mysql.RowDataPacket[];
    if (list.length === 0) return null;
    return list[0] as unknown as GroupFile;
  }

  /** 按群查最近 N 条 */
  async findRecentByGroup(groupId: number, limit: number): Promise<GroupFile[]> {
    const [rows] = await this.pool.query(
      `SELECT * FROM group_files
       WHERE group_id = ?
       ORDER BY id DESC
       LIMIT ${Number(limit)}`,
      [groupId],
    );
    return (rows as mysql.RowDataPacket[]) as unknown as GroupFile[];
  }

  /** 更新下载状态 */
  async updateDownloadStatus(
    messageId: number,
    status: FileDownloadStatus,
    error?: string,
    localPath?: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE group_files
       SET download_status = ?, download_error = ?, local_path = ?
       WHERE message_id = ?`,
      [status, error ?? null, localPath ?? null, messageId],
    );
  }

  /** 更新分析状态 */
  async updateAnalysisStatus(messageId: number, status: FileAnalysisStatus): Promise<void> {
    await this.pool.query(
      `UPDATE group_files SET analysis_status = ? WHERE message_id = ?`,
      [status, messageId],
    );
  }
}

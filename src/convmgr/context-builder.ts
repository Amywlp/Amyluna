/**
 * 上下文构建器 — 从 DB 查询最近消息，解析引用，注入好感度，格式化为 LLM 上下文。
 *
 * P2 不再维护内存队列，每次触发时从 DB 查询构建。
 *
 * 格式:
 *   [常规上下文]
 *   [MsgID:xxx] [sender_name](user_id) {group:xxx, affinity:N}:
 *   (↳ MsgID:xxx [sender_name]「quoted_text」) actual_text
 *
 *   [触发消息]
 *   [MsgID:xxx] [sender_name](user_id) {group:xxx, affinity:N}: actual_text
 *
 * 触发消息段从上下文中单独拎出，方便 LLM 识别当前要回复哪条消息。
 * 随机插嘴时触发消息段为「（随机插嘴）」，LLM 可据此判断是否被点名。
 *
 * 迁移自 v1 ChatSession.buildContext() + ChatManager 上下文组装逻辑。
 */
import { createLogger } from "../common/logger";
import type { MessageRepository, StoredMessage } from "../common/db/message-repository";
import type { ContextInjector, ContextEntry } from "./affinity/types";

const log = createLogger("P2.ctx");

export interface ContextBuilderOptions {
  repo: MessageRepository;
  groupId: number;
  botId: number;
  contextLimit: number;
  /** 好感度等注入器列表 */
  injectors?: ContextInjector[];
}

export interface BuildResult {
  /** 格式化后的纯文本上下文字符串 */
  context: string;
  /** 上下文中的消息条数 */
  entryCount: number;
}

export class ContextBuilder {
  private readonly repo: MessageRepository;
  private readonly groupId: number;
  private readonly botId: number;
  private readonly contextLimit: number;
  private readonly injectors: ContextInjector[];

  constructor(options: ContextBuilderOptions) {
    this.repo = options.repo;
    this.groupId = options.groupId;
    this.botId = options.botId;
    this.contextLimit = options.contextLimit;
    this.injectors = options.injectors ?? [];
  }

  /**
   * 构建格式化的上下文。
   *
   * 触发消息从常规上下文中移除，放入底部独立的「[触发消息]」段。
   * 若无触发消息（随机插嘴），触发消息段显示「（随机插嘴）」。
   *
   * @param triggerMessageId 触发消息的 ID，用于识别触发消息并拎出到触发消息段
   * @param isPrivate 是否为私聊（默认 false）
   */
  async build(triggerMessageId?: number, isPrivate: boolean = false): Promise<BuildResult> {
    // 1. 从 DB 查询最近 N 条
    const rows = await this.repo.findRecentByGroup(this.groupId, this.contextLimit, isPrivate);

    // 2. 过滤掉空内容，转为 ContextEntry
    const entries: ContextEntry[] = [];
    for (const row of rows.reverse()) {  // 时间升序
      if (row.role !== "user" && row.role !== "assistant") continue;

      // 合并转发消息：merged_forward 列存储了从 QQ 获取的完整内容，
      // content 列只有占位符 "[合并转发]"，优先使用 merged_forward
      const mergedContent = (row.merged_forward ?? "").trim();
      const text = mergedContent
        ? mergedContent
        : (row.content ?? "").trim();
      if (!text) continue;

      entries.push({
        sender_name: row.sender_name ?? "unknown",
        user_id: row.user_id,
        message_id: row.message_id ?? 0,
        text,
        time: new Date(row.created_at).getTime() / 1000,
        role: row.role as "user" | "assistant",
      });
    }

    // 限制长度
    while (entries.length > this.contextLimit) {
      entries.shift();
    }

    log.info("build.start", {
      groupId: this.groupId,
      dbRows: rows.length,
      validEntries: entries.length,
      hasTrigger: triggerMessageId != null,
    });

    // 3. 规范化发送者名称（每个用户用最新的群名片）
    this.normalizeNames(entries);

    // 4. 为每条消息解析引用
    await this.resolveQuotes(entries, rows);

    // 5. 格式化为上下文字符串（触发消息单独拎出）
    const contextLines: string[] = [];
    let triggerLine: string | null = null;

    for (const entry of entries) {
      // 收集注入器返回的外部参数
      const injected = this.injectors
        .map((inj) => inj.inject(entry))
        .filter((v): v is string => v != null);
      // group_id 是会话级参数，始终注入
      injected.unshift(`group:${this.groupId}`);
      const injectionBlock = injected.length > 0 ? ` {${injected.join(", ")}}` : "";

      if (entry.role === "assistant") {
        contextLines.push(entry.text);
        continue;
      }

      // 被引用消息嵌入（在 resolveQuotes 中设置）
      const quotePrefix = (entry as ContextEntryWithQuote).quotePrefix ?? "";

      const prefix = entry.message_id
        ? `[MsgID:${entry.message_id}] [${entry.sender_name}](${entry.user_id})${injectionBlock}: `
        : `[${entry.sender_name}](${entry.user_id})${injectionBlock}: `;

      const formattedLine = prefix + quotePrefix + entry.text;

      // 触发消息：从常规上下文中移除，放入触发消息段
      const isTrigger = triggerMessageId != null && entry.message_id === triggerMessageId;
      if (isTrigger) {
        triggerLine = formattedLine;
      } else {
        contextLines.push(formattedLine);
      }
    }

    // 追加触发消息段
    contextLines.push("");
    contextLines.push("[触发消息]");
    if (triggerLine) {
      contextLines.push(triggerLine);
    } else {
      // 无触发消息 → 随机插嘴
      contextLines.push("（随机插嘴）");
    }

    const context = contextLines.join("\n");
    log.info("build.done", {
      entryCount: entries.length,
      contextLen: context.length,
      hasTrigger: triggerLine != null,
    });

    return { context, entryCount: entries.length };
  }

  /**
   * 规范化名称：每个用户使用其最新一条消息中的群名片。
   * 迁移自 v1 ChatSession.normalizeNames()。
   */
  private normalizeNames(entries: ContextEntry[]): void {
    if (entries.length === 0) return;

    const perUserLatest = new Map<number, { name: string; time: number }>();
    for (const e of entries) {
      const current = perUserLatest.get(e.user_id);
      if (!current || e.time > current.time) {
        perUserLatest.set(e.user_id, { name: e.sender_name, time: e.time });
      }
    }

    for (const e of entries) {
      const latest = perUserLatest.get(e.user_id);
      if (latest && e.sender_name !== latest.name) {
        e.sender_name = latest.name;
      }
    }
  }

  /**
   * 解析引用消息：对有 quoted_message_id 的消息，查 DB 获取被引用消息内容，
   * 嵌入到消息文本之前作为引用前缀。
   */
  private async resolveQuotes(entries: ContextEntry[], rows: StoredMessage[]): Promise<void> {
    // 构建 row 索引，快速查找
    const rowById = new Map<number, StoredMessage>();
    for (const row of rows) {
      if (row.message_id != null) {
        rowById.set(row.message_id, row);
      }
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const row = rows.find((r) => r.message_id === entry.message_id);
      if (!row?.quoted_message_id) continue;

      const quotedId = Number(row.quoted_message_id);
      if (!Number.isFinite(quotedId)) continue;

      // 先在 entries 中查找
      const quotedEntry = entries.find((e) => e.message_id === quotedId);
      if (quotedEntry) {
        (entry as ContextEntryWithQuote).quotePrefix =
          `(↳ MsgID:${quotedEntry.message_id} [${quotedEntry.sender_name}]「${quotedEntry.text.slice(0, 100)}」) `;
        continue;
      }

      // 再查 DB
      try {
        const stored = await this.repo.findByMessageId(quotedId);
        if (stored) {
          const cleaned = (stored.content ?? "").replace(/\[CQ:image,[^\]]*\]/g, "[image]");
          (entry as ContextEntryWithQuote).quotePrefix =
            `(↳ MsgID:${stored.message_id} [${stored.sender_name ?? "unknown"}]「${cleaned.slice(0, 100)}」) `;
        }
      } catch (err) {
        log.warn("resolveQuoted.dbError", { quotedId, error: String(err) });
      }
    }
  }
}

/** ContextEntry 扩展：携带引用前缀 */
interface ContextEntryWithQuote extends ContextEntry {
  quotePrefix?: string;
}

/**
 * P1 — Receiver 入口 (:3101)
 *
 * 启动顺序:
 *   加载 config → 连接 DB → 创建 IPC Clients + WS client
 *   → 启动 IPC Server → 连接 IPC peers → 启动 Watchdog → client.connect()
 */

import { loadConfig } from "../common/config";
import { createLogger } from "../common/logger";
import { createPool } from "../common/db/pool";
import { MessageRepository } from "../common/db/message-repository";
import { IpcClient } from "../common/ipc/client";
import { Watchdog } from "../common/watchdog";
import { WsClient } from "./ws-client";
import { saveMessage } from "./message-saver";
import { isTriggered, type GroupTriggerState } from "./trigger";
import { RateLimiter } from "./rate-limiter";
import { createP1IpcServer } from "./ipc-server";
import { TempMuteList } from "./temp-mute-list";
import type { GroupMessageEvent } from "../common/types/onebot";
import {
  extractTextWithoutAt,
  extractImageUrls,
  extractQuotedMessageId,
  hasAtBot,
} from "../common/text";

const log = createLogger("P1");

// ─── 后台连接 ──────────────────────────────────────────

/** 启动持久连接（后台无限重连，永不阻塞，不因对端未就绪而退出） */
function connectPeers(p2Client: IpcClient, p3Client: IpcClient): void {
  p2Client.connectPersistent("P2");
  p3Client.connectPersistent("P3");
}

// ─── 状态 ──────────────────────────────────────────────

interface GroupState {
  triggerState: GroupTriggerState;
  /** 最近的消息 ID 集合，用于 reply 判断（bot 最近回复的消息 ID） */
  recentBotMessageIds: Set<number>;
}

/** 去重窗口大小 */
const DEDUP_WINDOW = 1000;

/** 每群缓存的 bot 消息 ID 上限（reply 触发判断用，FIFO 淘汰最旧） */
const BOT_MESSAGE_ID_MAX = 200;

async function main(): Promise<void> {
  const config = loadConfig();
  log.info("startup", { port: config.p1Port });

  // 1. 连接 DB
  const pool = createPool(config.db);
  const repo = new MessageRepository(pool);
  log.info("db ready");

  // 2. 群状态管理
  const groupStates = new Map<number, GroupState>();
  const recentMessageIds = new Set<number>();

  function getGroupState(groupId: number): GroupState {
    let state = groupStates.get(groupId);
    if (!state) {
      state = {
        triggerState: { prdP: config.chat.prdC },
        recentBotMessageIds: new Set(),
      };
      groupStates.set(groupId, state);
    }
    return state;
  }

  /** 记录 bot 发送的消息 ID（reply 触发判断用，带 FIFO 上限） */
  function registerBotMessageId(groupId: number, messageId: number): void {
    if (messageId == null) return;
    const set = getGroupState(groupId).recentBotMessageIds;
    if (set.has(messageId)) return;
    set.add(messageId);
    while (set.size > BOT_MESSAGE_ID_MAX) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
  }

  // 3. 速率限制器（每用户每窗口 N 次触发）
  const rateLimiter = new RateLimiter(
    config.chat.rateLimitWindowMs,
    config.chat.rateLimitMaxRequests,
  );
  rateLimiter.start();

  // 3.5. 临时禁言列表
  const tempMuteList = new TempMuteList();
  log.info("tempMuteList ready");

  // 4. 创建 IPC Clients（未连接，先创建对象）
  const p2Client = new IpcClient(config.p2Port, "P1→P2");
  const p3Client = new IpcClient(config.p3Port, "P1→P3");

  // 4. 创建 WS client
  const wsClient = new WsClient({
    ...config.snowluma,
    onGroupMessage: async (event: GroupMessageEvent) => {
      // ── 白名单检查 ──
      if (!config.chat.whitelistGroupIds.includes(event.group_id)) {
        return;
      }

      // ── 去重 ──
      if (recentMessageIds.has(event.message_id)) {
        log.debug("msg.duplicate", { message_id: event.message_id });
        return;
      }
      recentMessageIds.add(event.message_id);
      if (recentMessageIds.size > DEDUP_WINDOW) {
        let count = 0;
        for (const id of recentMessageIds) {
          if (count++ >= 100) break;
          recentMessageIds.delete(id);
        }
      }

      const isOwnMessage = event.user_id === config.chat.botId;
      const segments = Array.isArray(event.message) ? event.message : [];

      log.info("msg.recv", {
        group_id: event.group_id,
        user_id: event.user_id,
        message_id: event.message_id,
        segTypes: segments.map((s) => s.type).join(","),
        isOwn: isOwnMessage,
      });

      // 1. 消息入库（所有白名单群消息，包括 bot 自身）
      const saveResult = await saveMessage(event, repo, wsClient);

      // 跳过 bot 自身消息
      if (isOwnMessage) {
        // 记录 bot 消息 ID 供 reply 判断
        const state = getGroupState(event.group_id);
        state.recentBotMessageIds.add(event.message_id);
        return;
      }

      // 2. 富媒体异步处理：图片 → P3 vision
      if (saveResult.hasImages && saveResult.imageUrls.length > 0 && config.chat.acceptImages) {
        try {
          p3Client.send("vision", {
            image_urls: saveResult.imageUrls,
            group_id: event.group_id,
            message_id: event.message_id,
          });
          log.info("vision.sent", { imageCount: saveResult.imageUrls.length });
        } catch (err) {
          log.warn("vision.send.fail", { error: String(err) });
        }
      }

      // 3. 触发判断
      const cleanText = extractTextWithoutAt(segments, config.chat.botId);
      const groupState = getGroupState(event.group_id);

      const triggerResult = isTriggered(
        event,
        cleanText,
        {
          botId: config.chat.botId,
          triggerKeywords: config.chat.triggerKeywords,
          prdC: config.chat.prdC,
        },
        groupState.triggerState,
        (replyMsgId: number) => groupState.recentBotMessageIds.has(replyMsgId),
      );

      if (!triggerResult.triggered) {
        log.debug("trigger.skip", {
          group_id: event.group_id,
          message_id: event.message_id,
        });
        return;
      }

      log.info("trigger.fire", {
        group_id: event.group_id,
        message_id: event.message_id,
        reason: triggerResult.reason,
      });

      // 3.5. 禁言检查（仅非 PRD 触发，随机插嘴不检查）
      if (triggerResult.reason !== "prd" && tempMuteList.checkAndClean(event.time, event.user_id)) {
        log.info("tempmute.blocked", {
          user_id: event.user_id,
          group_id: event.group_id,
          message_time: event.time,
        });
        return;
      }

      // 4. 速率限制检查（仅在用户主动触发时，随机插嘴跳过）
      if (triggerResult.reason !== "prd" && !rateLimiter.checkAndDecrement(event.user_id)) {
        log.info("rateLimit.blocked", {
          user_id: event.user_id,
          group_id: event.group_id,
          remaining: rateLimiter.getRemaining(event.user_id),
        });
        return;
      }

      // 5. IPC → P2: trigger
      try {
        p2Client.send("trigger", {
          group_id: event.group_id,
          message_id: event.message_id,
          reason: triggerResult.reason,
          time: event.time,
        });
      } catch (err) {
        log.error("trigger.send.fail", { error: String(err) });
      }
    },
  });

  // 5. 启动 IPC Server（P2 和 P3 可以向 P1 发送 send_message / error_alert）
  const ipcServer = createP1IpcServer(config.p1Port, {
    wsClient,
    errorAlertGroupId: config.chat.errorAlertGroupId,
    botId: config.chat.botId,
    tempMuteList,
    registerBotMessageId,
  });
  await ipcServer.start();
  log.info("ipc server ready");

  // 6. 持久连接 P2 和 P3（后台无限重连，不阻塞）
  connectPeers(p2Client, p3Client);

  // 7. 启动 Watchdog（监控 P2 和 P3）
  const watchdog = new Watchdog("P1", {
    pingTargets: [
      { label: "P2", port: config.p2Port },
      { label: "P3", port: config.p3Port },
    ],
    intervalMs: config.watchdog.intervalMs,
    maxFailures: config.watchdog.maxFailures,
  });
  await watchdog.start();

  // 8. 连接 SnowLuma WebSocket
  log.info("connecting to SnowLuma...");
  await wsClient.connect();
  log.info("ready", { port: config.p1Port });

  console.log(`[P1] Receiver ready on :${config.p1Port}`);
  console.log(`[P1] Whitelist groups: ${config.chat.whitelistGroupIds.join(", ")}`);
}

// 仅在直接运行时启动
const isMain = process.argv[1]?.includes("receiver/index");
if (isMain) {
  main().catch((error) => {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error("startup.fail", { error: errMsg });
    console.error("[P1] startup failed:", errMsg);
    process.exit(1);
  });
}

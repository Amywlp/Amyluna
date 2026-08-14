/**
 * P2 IPC Server — 接收 P1 的 trigger 和 P3 的 chat_response / intermediate_reply。
 *
 * 处理流程:
 *   P1 trigger  → 冷却判断 → 构建上下文 → 发给 P3 (chat)
 *   P3 chat_response → 静默工具执行 → 后处理 → 发给 P1 (send_message) → 存 DB
 *   P3 intermediate_reply → 后处理 → 发给 P1 (send_message) → 存 DB
 */
import { IpcServer } from "../common/ipc/server";
import { createLogger } from "../common/logger";
import type { IpcClient } from "../common/ipc/client";
import type { MessageRepository } from "../common/db/message-repository";
import type { CooldownManager } from "./cooldown";
import type { ContextBuilder } from "./context-builder";
import type { PostProcessor } from "./post-process";
import type { SilentToolExecutor } from "./silent-tools";
import { extractSilentCalls } from "./silent-text-extractor";
import type { TaskQueueManager } from "./task-queue-manager";
import type { AffinityCache } from "./affinity/cache";
import type { TriggerPayload, ChatResponsePayload, IntermediateReplyPayload, SilentToolCall } from "../common/types/ipc";

const log = createLogger("P2.ipc-srv");

/** 每次触发最多向 P1 发送的中间回复条数 */
const MAX_INTERMEDIATE_REPLIES = 3;

/** group_id → 当前触发已发送的中间回复计数 */
const intermediateCounts = new Map<number, number>();

export interface P2IpcServerDeps {
  /** 冷却管理器 */
  cooldown: CooldownManager;
  /** 上下文构建器工厂（每次 trigger 创建新实例，因为 groupId 可不同） */
  createContextBuilder: (groupId: number) => ContextBuilder;
  /** 后处理器 */
  postProcessor: PostProcessor;
  /** 静默工具执行器 */
  silentTools: SilentToolExecutor;
  /** 消息持久化 */
  repo: MessageRepository;
  /** → P3: 发送 chat 请求 */
  p3Client: IpcClient;
  /** → P1: 发送 send_message */
  p1Client: IpcClient;
  /** bot QQ 号 */
  botId: number;
  /** 预设名称 */
  preset: string;
  /** 回复最大长度（超长截断） */
  replyMaxLength: number;
  /** chat 请求超时（ms） */
  replyTimeoutMs: number;
  /** 任务队列管理器（用于静默工具生命周期追踪，可选） */
  taskQueue?: TaskQueueManager;
  /** 错误告警目标群 ID（超时时发送反馈） */
  errorAlertGroupId: number;
  /** 好感度缓存（用于向 P3 传递触发用户好感度） */
  affinityCache: AffinityCache;
}

export function createP2IpcServer(port: number, deps: P2IpcServerDeps): IpcServer {
  const server = new IpcServer(port, "P2");

  // ── trigger (P1 → P2): 触发对话 ──
  server.on("trigger", async (rawPayload, reply) => {
    const payload = rawPayload as TriggerPayload;
    log.info("trigger.recv", { group_id: payload.group_id, message_id: payload.message_id });

    // 回复 P1 确认收到
    reply({ ack: true });

    // 进入冷却判断
    await deps.cooldown.onTrigger(payload.group_id, payload.message_id, async (groupId, triggerMsgId) => {
      await handleTrigger(groupId, triggerMsgId, deps, payload.reason, payload.time);
    });
  });

  // ── chat_response (P3 → P2): 最终回复 ──
  server.on("chat_response", async (rawPayload, reply) => {
    const payload = rawPayload as ChatResponsePayload;
    log.info("chat_response.recv", {
      group_id: payload.group_id,
      contentLen: payload.content.length,
      silentTools: payload.silent_tool_calls?.length ?? 0,
    });

    try {
      // 1. 从文本中提取静默工具标记
      const extracted = extractSilentCalls(payload.content, undefined, payload.message_id);
      const silentResult = deps.silentTools.executeExtracted(extracted, payload.group_id);

      // 2. 后处理（基于清洗后的文本）
      const postResult = deps.postProcessor(extracted.cleanedText || payload.content);
      log.debug("chat_response.postProcess", {
        sendMethod: postResult.sendMethod,
        params: postResult.params,
      });

      // 3. 发送到 P1（委托 P1 发送到 QQ）
      const trimmed = postResult.text.trim();
      if (trimmed) {
        const sendResult = await deps.p1Client.request("send_message", {
          group_id: payload.group_id,
          message: trimmed,
          method: postResult.sendMethod,
          meme_url: silentResult.memeUrl,
          forward_nodes: postResult.sendMethod === "forward"
            ? [{ uin: deps.botId, content: trimmed }]
            : undefined,
        }, 30000);

        const sendPayload = sendResult as { message_id: number | null };
        const sentMessageId = sendPayload?.message_id ?? null;

        // 4. 持久化到 DB
        await deps.repo.insertOrReplace({
          message_id: sentMessageId,
          group_id: payload.group_id,
          user_id: deps.botId,
          sender_name: "bot",
          is_private: false,
          role: "assistant",
          content: payload.content,
        });

        log.info("chat_response.done", { message_id: sentMessageId });
      }

      // 更新冷却状态
      deps.cooldown.updateLastRepliedTime(payload.group_id, Math.floor(Date.now() / 1000));

      reply({ ack: true });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("chat_response.fail", { group_id: payload.group_id, error: errMsg });
      reply({ ack: false, error: errMsg });
    }
  });

  // ── intermediate_reply (P3 → P2): 中间回复 ──
  server.on("intermediate_reply", async (rawPayload, reply) => {
    const payload = rawPayload as IntermediateReplyPayload;
    log.info("intermediate.recv", {
      group_id: payload.group_id,
      contentLen: payload.content.length,
    });

    try {
      // 计数判断：同一轮触发中最多向 P1 发送前 N 条中间回复
      const count = (intermediateCounts.get(payload.group_id) ?? 0) + 1;
      intermediateCounts.set(payload.group_id, count);

      if (count > MAX_INTERMEDIATE_REPLIES) {
        log.info("intermediate.skipped", {
          group_id: payload.group_id,
          count,
          reason: `exceeded max ${MAX_INTERMEDIATE_REPLIES}`,
        });
        reply({ ack: true });
        return;
      }

      // 中间回复只做安全清洗（万一 LLM 违反规则写了标记，静默移除）
      // 不执行静默工具：不生成 meme URL，不调整好感度
      const extracted = extractSilentCalls(payload.content);

      // 后处理（基于清洗后的文本）
      const postResult = deps.postProcessor(extracted.cleanedText || payload.content);

      // 发送到 P1（中间回复不带 meme_url）
      const trimmed = postResult.text.trim();
      if (trimmed) {
        await deps.p1Client.request("send_message", {
          group_id: payload.group_id,
          message: trimmed,
          method: postResult.sendMethod,
          forward_nodes: postResult.sendMethod === "forward"
            ? [{ uin: deps.botId, content: trimmed }]
            : undefined,
        }, 30000);

        // 中间回复不入库 —— 它们是瞬时的状态告知（"稍等，咱查一下"），
        // 不是对话内容。入库会导致 LLM 在后续上下文中看到自己之前输出的
        // 中间消息，学会模仿这种短格式，提前以 finishReason:stop 退出。
        log.info("intermediate.done", { group_id: payload.group_id, len: trimmed.length });
      }

      reply({ ack: true });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("intermediate.fail", { group_id: payload.group_id, error: errMsg });
      reply({ ack: false, error: errMsg });
    }
  });

  // ── ping (watchdog) ──
  server.on("ping", (_payload, reply) => {
    reply(null);
  });

  return server;
}

/**
 * 触发处理：构建上下文 → 发送给 P3。
 */
async function handleTrigger(
  groupId: number,
  triggerMsgId: number,
  deps: P2IpcServerDeps,
  reason?: string,
  triggerTime?: number,
): Promise<void> {
  const ctxBuilder = deps.createContextBuilder(groupId);

  // 0. 查触发消息的 user_id（timer 需要）+ 好感度（P3 context_review 需要）
  let triggerUserId: number | undefined;
  let triggerAffinity: number | undefined;
  try {
    const triggerMsg = await deps.repo.findByMessageId(triggerMsgId);
    triggerUserId = triggerMsg?.user_id;
    if (triggerUserId) {
      triggerAffinity = deps.affinityCache.getEffective(triggerUserId);
    }
  } catch (err) {
    log.warn("trigger.userIdLookup.fail", { triggerMsgId, error: String(err) });
  }

  // 1. 构建上下文（传入触发消息 ID，随机插嘴时 triggerMsgId 仍存在但 reason="prd"）
  const isRandom = reason === "prd";
  const buildResult = await ctxBuilder.build(isRandom ? undefined : triggerMsgId);

  if (buildResult.entryCount === 0) {
    log.warn("trigger.noContext", { groupId });
    return;
  }

  // 2. 重置中间回复计数，发送给 P3（request-response，P3 处理完成后返回最终结果）
  intermediateCounts.set(groupId, 0);
  log.info("trigger.chat", { groupId, triggerMsgId, contextLen: buildResult.context.length });
  try {
    const rawResponse = await deps.p3Client.request("chat", {
      context: buildResult.context,
      preset: deps.preset,
      group_id: groupId,
      message_id: triggerMsgId,
      user_id: triggerUserId,
      time: triggerTime,
      affinity: triggerAffinity,
    }, deps.replyTimeoutMs);

    const chatResponse = rawResponse as ChatResponsePayload;
    log.info("trigger.response", {
      groupId,
      contentLen: chatResponse.content?.length ?? 0,
      silentTools: chatResponse.silent_tool_calls?.length ?? 0,
    });

    // 3. 从文本中提取静默工具标记，执行并清洗文本
    const rawContent = chatResponse.content ?? "";
    const extracted = extractSilentCalls(rawContent, triggerUserId, triggerMsgId);
    const silentResult = deps.silentTools.executeExtracted(extracted, groupId, triggerUserId);

    // 安全检查：跳过纯工具调用内容（DeepSeek XML invoke 等残留）
    const textToSend = extracted.cleanedText || rawContent;
    if (!textToSend || /^<\/?invoke\b/i.test(textToSend.trim())) {
      log.warn("trigger.emptyContent", { groupId, contentLen: rawContent.length, preview: rawContent.slice(0, 200) });
      deps.cooldown.updateLastRepliedTime(groupId, Math.floor(Date.now() / 1000));
      return;
    }

    // 4. 后处理（基于清洗后的文本）
    const postResult = deps.postProcessor(textToSend);

    // 5. 发送到 P1（委托 P1 发送到 QQ）
    const trimmed = postResult.text.trim();
    if (trimmed) {
      const sendResult = await deps.p1Client.request("send_message", {
        group_id: groupId,
        message: trimmed,
        method: postResult.sendMethod,
        meme_url: silentResult.memeUrl,  // P1 负责下载 + 转 base64 图片
        forward_nodes: postResult.sendMethod === "forward"
          ? [{ uin: deps.botId, content: trimmed }]
          : undefined,
      }, 30000);

      const sendPayload = sendResult as { message_id: number | null };
      const sentMessageId = sendPayload?.message_id ?? null;

      // 6. 持久化到 DB（存清洗前的原始内容，含标记以便回溯）
      await deps.repo.insertOrReplace({
        message_id: sentMessageId,
        group_id: groupId,
        user_id: deps.botId,
        sender_name: "bot",
        is_private: false,
        role: "assistant",
        content: rawContent,
      });

      log.info("trigger.done", { groupId, message_id: sentMessageId, hasMeme: !!silentResult.memeUrl });
    }

    // 更新冷却状态
    deps.cooldown.updateLastRepliedTime(groupId, Math.floor(Date.now() / 1000));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error("trigger.chat.fail", { groupId, error: errMsg });

    // 超时时发送反馈到测试群
    const isTimeout = errMsg.includes("timed out");
    if (isTimeout) {
      const timeoutMsg = `[P2 超时告警] 群 ${groupId} 的 chat 请求超时（${deps.replyTimeoutMs}ms），LLM 响应未及时返回。`;
      log.info("trigger.timeoutFeedback", { groupId, alertGroup: deps.errorAlertGroupId });
      try {
        deps.p1Client.send("send_message", {
          group_id: deps.errorAlertGroupId,
          message: timeoutMsg,
        });
      } catch (sendErr) {
        log.error("trigger.timeoutFeedback.fail", { error: String(sendErr) });
      }
    }
  }
}

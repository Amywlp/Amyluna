/**
 * P3 IPC Server — 接收 P2 的 chat 请求和 P1 的 vision 请求。
 */

import { IpcServer } from "../common/ipc/server";
import { createLogger } from "../common/logger";
import type { PresetLoader } from "./preset-loader";
import type { ConversationLoop } from "./conversation-loop";
import type { MuriAgentLoop } from "./muri-agent/loop";
import type { ChatMessage } from "./llm/types";
import type { LLMRelay } from "./llm/relay";
import type { IpcClient } from "../common/ipc/client";
import type { MessageRepository } from "../common/db/message-repository";
import type { TokenRepository } from "../common/db/token-repository";
import type { MuriAgentPayload } from "../common/types/ipc";
import { describeImages, type VisionConfig } from "./vision";
import { setRequestContext } from "./tools/builtin/context-review";

const log = createLogger("P3.ipc-srv");

export interface P3IpcServerDeps {
  presetLoader: PresetLoader;
  loop: ConversationLoop;
  /** Muri Agent 子代理循环 */
  muriAgentLoop: MuriAgentLoop;
  /** IPC client to P2 (for intermediate_reply and error_alert) */
  p2Client: IpcClient;
  /** IPC client to P1 (for error_alert) */
  p1Client: IpcClient;
  /** 好感度系统指南（追加到 system prompt 末尾） */
  affinityGuidelines: string;
  /** 回复格式约束 */
  replyFormatConstraint: string;
  /** 错误告警群 ID */
  errorAlertGroupId: number;
  /** LLM Relay（用于 vision 图片描述） */
  relay: LLMRelay;
  /** Vision 模型配置 */
  visionConfig: VisionConfig;
  /** 消息持久化（用于回填 vision 描述） */
  repo: MessageRepository;
  /** Token 用量持久化 */
  tokenRepo: TokenRepository;
}

export function createP3IpcServer(port: number, deps: P3IpcServerDeps): IpcServer {
  const server = new IpcServer(port, "P3");

  // ── chat (P2 → P3) ──
  server.on("chat", async (rawPayload, reply) => {
    const payload = rawPayload as {
      context: string;
      preset: string;
      group_id: number;
      message_id: number;
      user_id?: number;
      time?: number;
      affinity?: number;
    };
    log.info("chat.recv", { group_id: payload.group_id, preset: payload.preset });

    try {
      // 1. 获取 preset system prompt
      const preset = deps.presetLoader.getPreset(payload.preset);
      const systemPrompt = preset.systemPrompt + deps.affinityGuidelines + deps.replyFormatConstraint;

      // 2. 组装 messages
      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: payload.context },
      ];

      // 3. 设置中间回复回调：每轮 LLM 输出即时发送给 P2
      deps.loop.onIntermediateReply = async (text: string) => {
        log.info("chat.intermediateReply", {
          group_id: payload.group_id,
          message_id: payload.message_id,
          textLen: text.length,
        });
        try {
          deps.p2Client.send("intermediate_reply", {
            group_id: payload.group_id,
            message_id: payload.message_id,
            content: text,
          });
        } catch (err) {
          log.error("intermediateReply.send.fail", { error: String(err) });
        }
      };

      // 3.5. 设置 Token 用量回调
      deps.loop.onTokenUsage = (params) => {
        deps.tokenRepo.insert({
          triggerMessageId: payload.message_id,
          replyMessageId: null,
          groupId: payload.group_id,
          model: params.model ?? "",
          provider: params.provider ?? "",
          baseUrl: params.baseUrl ?? "",
          promptTokens: params.usage.promptTokens,
          completionTokens: params.usage.completionTokens,
          totalTokens: params.usage.totalTokens,
          cachedTokens: params.usage.cachedTokens,
          reasoningTokens: params.usage.reasoningTokens,
          success: params.success,
        }).catch((err) => {
          log.error("tokenUsage.insert.fail", { error: String(err) });
        });
      };

      // 4. 设置请求上下文（供 context_review 等工具校验权限）
      if (payload.user_id != null) {
        setRequestContext({
          group_id: payload.group_id,
          user_id: payload.user_id,
          affinity: payload.affinity ?? 5,
        });
      }

      // 5. 运行 ConversationLoop
      const result = await deps.loop.run(messages);

      // 5b. 清理请求上下文
      setRequestContext(null);

      // 6. 返回最终结果给 P2
      reply({
        group_id: payload.group_id,
        message_id: payload.message_id,
        content: result.content,
        silent_tool_calls: result.silentToolCalls.length > 0 ? result.silentToolCalls : undefined,
      });

      log.info("chat.done", {
        group_id: payload.group_id,
        replyLen: result.content.length,
        silentToolCount: result.silentToolCalls.length,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("chat.error", { group_id: payload.group_id, error: errMsg });

      // 超时/异常 → P1 发送 error_alert 到 ERROR_ALERT_GROUP_ID
      try {
        deps.p1Client.send("error_alert", {
          group_id: deps.errorAlertGroupId,
          message: `[P3 Error] group=${payload.group_id} msg=${payload.message_id}: ${errMsg}`,
        });
      } catch (err2) {
        log.error("errorAlert.send.fail", { error: String(err2) });
      }

      // 返回空回复
      reply({
        group_id: payload.group_id,
        message_id: payload.message_id,
        content: "",
        silent_tool_calls: undefined,
      });
    }
  });

  // ── vision (P1 → P3): 图片描述，异步回填 DB ──
  server.on("vision", async (rawPayload, reply) => {
    const payload = rawPayload as {
      image_urls: string[];
      group_id: number;
      message_id?: number;
    };
    log.info("vision.recv", {
      group_id: payload.group_id,
      message_id: payload.message_id,
      imageCount: payload.image_urls?.length ?? 0,
    });

    // 先回复确认，不阻塞 P1
    reply({ ack: true });

    if (!payload.image_urls || payload.image_urls.length === 0) {
      log.warn("vision.noUrls", { group_id: payload.group_id });
      return;
    }

    try {
      const description = await describeImages(payload.image_urls, deps.relay, deps.visionConfig);

      if (!description) {
        log.warn("vision.emptyDescription", { group_id: payload.group_id });
        return;
      }

      // 回填 DB：读取当前消息内容，决定是替换还是追加
      if (payload.message_id != null) {
        try {
          const stored = await deps.repo.findByMessageId(payload.message_id);
          if (stored) {
            const currentContent = (stored.content ?? "").trim();
            // 纯占位符消息（"[image]" 等）→ 直接用描述替换
            const isPlaceholder = /^\[(image|图片|视频|语音|合并转发)\]$/.test(currentContent) || currentContent === "";
            const newContent = isPlaceholder
              ? description
              : `${currentContent}\n[图片描述: ${description}]`;
            await deps.repo.updateContent(payload.message_id, newContent);
            log.info("vision.dbUpdated", {
              message_id: payload.message_id,
              isPlaceholder,
              descLen: description.length,
            });
          } else {
            log.warn("vision.messageNotFound", { message_id: payload.message_id });
          }
        } catch (dbErr) {
          log.error("vision.dbWriteFail", { message_id: payload.message_id, error: String(dbErr) });
        }
      } else {
        log.warn("vision.noMessageId", { group_id: payload.group_id });
      }
    } catch (err) {
      log.error("vision.fail", { group_id: payload.group_id, error: String(err) });
    }
  });

  // ── muri_agent (P2 → P3): 子代理 LLM 循环 ──
  server.on("muri_agent", async (rawPayload, reply) => {
    const payload = rawPayload as MuriAgentPayload;
    log.info("muriAgent.recv", {
      group_id: payload.group_id,
      user_id: payload.user_id,
      message_id: payload.message_id,
      taskLen: payload.task.length,
      hasTimestamp: !!payload.timestamp,
    });

    try {
      // 提取时间（HH:MM 格式，用于时段判断）
      const date = new Date(payload.timestamp);
      const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

      // 构造用户上下文（传递给 MuriAgentLoop Phase 1: tool call 循环）
      const userContext = [
        `群号: ${payload.group_id}`,
        `触发用户ID: ${payload.user_id}`,
        `触发消息ID: ${payload.message_id}`,
        `触发消息内容: ${payload.trigger_text || "(未获取到)"}`,
        `当前时间: ${hhmm}`,
        `任务概述: ${payload.task}`,
      ].join("\n");

      const result = await deps.muriAgentLoop.run(userContext, {
        timestamp: payload.timestamp,
        triggerText: payload.trigger_text,
        triggerUserId: payload.user_id,
        triggerMessageId: payload.message_id,
        groupId: payload.group_id,
        task: payload.task,
      } satisfies import("./muri-agent/types").MuriAgentContext);

      log.info("muriAgent.done", {
        group_id: payload.group_id,
        nodeCount: result.forwardNodes.length,
        hasError: !!result.error,
      });

      reply({
        group_id: payload.group_id,
        forward_nodes: result.forwardNodes,
        error: result.error,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("muriAgent.fail", { group_id: payload.group_id, error: errMsg });
      reply({
        group_id: payload.group_id,
        forward_nodes: [],
        error: errMsg,
      });
    }
  });

  // ── ping (watchdog) ──
  server.on("ping", (_payload, reply) => {
    reply(null);
  });

  return server;
}

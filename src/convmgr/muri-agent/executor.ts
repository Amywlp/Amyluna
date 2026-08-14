/**
 * MuriAgentExecutor — P2 侧 muri_agent 执行器。
 *
 * 职责:
 *   1. 从 DB 获取触发消息文本
 *   2. 构造子代理上下文
 *   3. 通过 IPC 调用 P3 MuriAgentLoop
 *   4. 任务队列状态更新
 *   5. 合并转发发送（含身份伪造）
 */

import type { IpcClient } from "../../common/ipc/client";
import type { MessageRepository } from "../../common/db/message-repository";
import type { TaskQueueManager } from "../task-queue-manager";
import type { MuriAgentCall } from "../silent-text-extractor";
import type { MuriAgentResponsePayload } from "../../common/types/ipc";
import { createLogger } from "../../common/logger";

const log = createLogger("P2.muriAgent");

/** muri_agent IPC 请求超时（ms），比普通 chat 长 */
const MURI_AGENT_IPC_TIMEOUT_MS = 120_000;

/** send_message IPC 请求超时（ms） */
const SEND_MESSAGE_TIMEOUT_MS = 30_000;

export class MuriAgentExecutor {
  constructor(
    private readonly p3Client: IpcClient,
    private readonly p1Client: IpcClient,
    private readonly repo: MessageRepository,
    private readonly taskQueue: TaskQueueManager | null,
  ) {}

  /**
   * 执行 muri_agent 任务。
   *
   * @param call 提取到的 muri_agent 调用
   * @param groupId 群 ID
   * @param taskId 任务队列 ID（仅排队路径传入，直接执行路径为 null）
   */
  async execute(call: MuriAgentCall, groupId: number, taskId?: string): Promise<void> {
    log.info("execute.start", { groupId, task: call.task, userId: call.userId, messageId: call.messageId, taskId });

    // 1. 获取触发消息文本
    let triggerText = "";
    if (call.messageId) {
      try {
        const msg = await this.repo.findByMessageId(call.messageId);
        triggerText = msg?.content ?? "";
      } catch (err) {
        log.warn("triggerText.lookupFail", { messageId: call.messageId, error: String(err) });
      }
    }

    // 2. 构造请求（传递完整触发信息给 P3）
    const timestamp = new Date().toISOString();

    // 3. 调用 P3 MuriAgentLoop
    let response: MuriAgentResponsePayload;
    try {
      const raw = await this.p3Client.request("muri_agent", {
        group_id: groupId,
        user_id: call.userId ?? 0,
        message_id: call.messageId ?? 0,
        trigger_text: triggerText,
        timestamp,
        task: call.task,
      }, MURI_AGENT_IPC_TIMEOUT_MS);

      response = raw as MuriAgentResponsePayload;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("execute.ipcFail", { groupId, taskId, error: errMsg });
      // IPC 失败 → 任务标记为 failed
      if (taskId && this.taskQueue) {
        this.taskQueue.transition(taskId, "failed", errMsg);
      }
      return;
    }

    // 4. 检查 P3 返回的错误
    if (response.error) {
      log.warn("execute.p3Error", { groupId, taskId, error: response.error });
      if (taskId && this.taskQueue) {
        this.taskQueue.transition(taskId, "failed", response.error);
      }
      return;
    }

    // 5. 发送合并转发
    if (response.forward_nodes && response.forward_nodes.length > 0) {
      try {
        await this.p1Client.request("send_message", {
          group_id: groupId,
          message: "", // forward 模式下可为空
          method: "forward",
          forward_nodes: response.forward_nodes,
        }, SEND_MESSAGE_TIMEOUT_MS);

        log.info("execute.sent", {
          groupId,
          taskId,
          nodeCount: response.forward_nodes.length,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error("execute.sendFail", { groupId, taskId, error: errMsg });
        if (taskId && this.taskQueue) {
          this.taskQueue.transition(taskId, "failed", errMsg);
        }
        return;
      }
    } else {
      log.warn("execute.emptyNodes", { groupId, taskId });
    }

    // 6. 任务完成
    if (taskId && this.taskQueue) {
      this.taskQueue.transition(taskId, "completed");
    }

    log.info("execute.done", { groupId, taskId });
  }
}

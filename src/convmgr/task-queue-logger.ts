/**
 * 任务队列专用日志模块。
 *
 * 只记录队列层面的事件：
 * - 入队（enqueue）：任务被提交到队列时
 * - 出队（dequeue）：任务完成或失败时
 *
 * 不记录工具内部执行细节（如 timer 的 setTimeout 过程、affinity 的状态机变化等）。
 */
import { createLogger } from "../common/logger";
import type { QueuedTask } from "./task-queue-types";

const log = createLogger("P2.taskqueue");

/** 入队日志 */
export function logEnqueue(task: QueuedTask, queueLength: number): void {
  log.info("enqueue", {
    taskId: task.id,
    type: task.type,
    groupId: task.groupId,
    userId: task.userId,
    queueLength,
    metadata: task.metadata,
  });
}

/** 出队日志（completed 或 failed） */
export function logDequeue(task: QueuedTask): void {
  const durationMs = task.completedAt && task.createdAt
    ? task.completedAt - task.createdAt
    : undefined;

  log.info("dequeue", {
    taskId: task.id,
    type: task.type,
    state: task.state,
    durationMs,
    error: task.error,
  });
}

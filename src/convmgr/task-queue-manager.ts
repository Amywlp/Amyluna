/**
 * 任务队列管理器 — 为需要异步/长时间运行的静默工具提供统一生命周期管理。
 *
 * 调度模型：
 * - 并行工具（parallel=true，如 timer、affinity）：入队后立即转为 running，无并发限制
 * - 串行工具（parallel=false，如 tts、muri_agent）：同一类型共享一个执行槽位，
 *   按入队顺序 FIFO 依次执行，前一个完成后才触发下一个
 *
 * 队列不干预工具内部执行逻辑，只管理生命周期和资源清理。
 */
import { createLogger } from "../common/logger";
import type {
  SilentToolType,
  ToolDefinition,
  QueuedTask,
  EnqueueOptions,
  TaskQueueStats,
  TaskState,
} from "./task-queue-types";
import { logEnqueue, logDequeue } from "./task-queue-logger";

const log = createLogger("P2.taskqueue");

/** 已完成任务缓冲区上限 */
const MAX_COMPLETED_BUFFER = 200;

/** 默认 purge 阈值（ms） */
const DEFAULT_PURGE_AGE_MS = 5 * 60 * 1000;

/** 合法状态转换表 */
const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  pending: ["running"],
  running: ["completed", "failed"],
  completed: [],
  failed: [],
};

export class TaskQueueManager {
  /** 所有任务 */
  private readonly tasks = new Map<string, QueuedTask>();
  /** 已完成/失败任务环形缓冲区 */
  private readonly completedBuffer: QueuedTask[] = [];
  /** 每种串行工具的等待队列（FIFO） */
  private readonly serialQueues = new Map<SilentToolType, string[]>();
  /** 每种串行工具的槽位占用状态 */
  private readonly serialLocks = new Map<SilentToolType, boolean>();
  /** 工具注册表 */
  private readonly toolDefs = new Map<SilentToolType, ToolDefinition>();
  /** 任务 ID 计数器 */
  private idCounter = 0;

  /* ------------------------------------------------------------------ */
  /*  工具注册                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * 注册工具定义（启动时调用）。
   * 一个工具类型只能注册一次。
   */
  registerTool(def: ToolDefinition): void {
    if (this.toolDefs.has(def.type)) {
      log.warn("register.duplicate", { type: def.type });
      return;
    }
    this.toolDefs.set(def.type, def);
    // 初始化串行锁（所有串行工具初始空闲）
    if (!def.parallel) {
      this.serialLocks.set(def.type, false);
      this.serialQueues.set(def.type, []);
    }
    log.info("register.tool", { type: def.type, parallel: def.parallel, description: def.description });
  }

  /** 查询工具是否并行 */
  isParallel(type: SilentToolType): boolean {
    return this.toolDefs.get(type)?.parallel ?? true; // 未知工具默认并行
  }

  /* ------------------------------------------------------------------ */
  /*  任务操作                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * 创建一个新任务并加入队列。
   *
   * - 并行工具：创建后立即自动 transition 到 running
   * - 串行工具：加入该类型的 FIFO 等待队列；若槽位空闲则立即 transition 到 running
   *
   * @returns 任务 ID
   */
  enqueue(type: SilentToolType, metadata: Record<string, unknown> = {}, opts: EnqueueOptions = {}): string {
    const id = `${type}-${Date.now()}-${++this.idCounter}`;

    const task: QueuedTask = {
      id,
      type,
      state: "pending",
      groupId: opts.groupId,
      userId: opts.userId,
      createdAt: Date.now(),
      metadata,
      onCancel: opts.onCancel,
    };

    this.tasks.set(id, task);

    // 记录入队日志
    logEnqueue(task, this.tasks.size);

    // 并行工具：立即开始
    if (this.isParallel(type)) {
      this.transition(task, "running");
    } else {
      // 串行工具：加入 FIFO 等待队列
      const queue = this.serialQueues.get(type);
      if (!queue) {
        // 未注册的串行工具 —— 回退到立即运行
        log.warn("enqueue.unregisteredSerial", { type, taskId: id });
        this.transition(task, "running");
        return id;
      }

      const locked = this.serialLocks.get(type) ?? false;
      if (!locked) {
        // 槽位空闲，直接运行
        this.transition(task, "running");
      } else {
        // 槽位被占用，加入等待队列
        queue.push(id);
        log.info("serial.queued", { type, taskId: id, position: queue.length });
      }
    }

    return id;
  }

  /**
   * 状态转换。带合法性验证。
   */
  transition(taskOrId: QueuedTask | string, state: TaskState, error?: string): void {
    const task = typeof taskOrId === "string" ? this.tasks.get(taskOrId) : taskOrId;
    if (!task) {
      log.warn("transition.notFound", { taskOrId });
      return;
    }

    const fromState = task.state;
    const allowed = VALID_TRANSITIONS[fromState];
    if (!allowed.includes(state)) {
      log.warn("transition.invalid", {
        taskId: task.id,
        type: task.type,
        from: fromState,
        to: state,
        expected: allowed,
      });
      return;
    }

    const now = Date.now();
    task.state = state;
    if (state === "running") task.startedAt = now;
    if (state === "completed" || state === "failed") {
      task.completedAt = now;
      if (error) task.error = error;
    }

    log.debug("transition", { taskId: task.id, type: task.type, from: fromState, to: state });

    // ── 完成/失败时：出队日志 + 清理 + 串行调度下一个 ──
    if (state === "completed" || state === "failed") {
      logDequeue(task);
      this.tasks.delete(task.id);
      this.addToCompletedBuffer(task);

      // 串行工具：释放槽位，触发下一个
      if (!this.isParallel(task.type)) {
        this.serialLocks.set(task.type, false);
        this.dispatchNextSerial(task.type);
      }
    }
  }

  /**
   * 等待任务进入 running 状态（用于串行工具在执行 API 调用前等待槽位）。
   *
   * 50ms 轮询，直到任务转为 running / 被移除 / 超时。
   *
   * @param taskId 任务 ID
   * @param timeoutMs 最大等待时间（ms）
   * @returns true=已获得运行槽位, false=超时/取消/失败
   */
  async waitForRunning(taskId: string, timeoutMs: number = 60000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = this.tasks.get(taskId);
      if (!task) {
        // 任务已被移除（取消/失败）
        log.debug("waitForRunning.removed", { taskId });
        return false;
      }
      if (task.state === "running") {
        return true;
      }
      if (task.state === "failed" || task.state === "completed") {
        log.debug("waitForRunning.terminalState", { taskId, state: task.state });
        return false;
      }
      await sleep(50);
    }
    log.warn("waitForRunning.timeout", { taskId, timeoutMs });
    return false;
  }

  /** 获取任务 */
  get(taskId: string): QueuedTask | undefined {
    return this.tasks.get(taskId) ?? this.completedBuffer.find((t) => t.id === taskId);
  }

  /* ------------------------------------------------------------------ */
  /*  查询                                                               */
  /* ------------------------------------------------------------------ */

  /** 获取队列统计 */
  stats(): TaskQueueStats {
    let pending = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;

    for (const t of this.tasks.values()) {
      switch (t.state) {
        case "pending": pending++; break;
        case "running": running++; break;
        case "completed": completed++; break;
        case "failed": failed++; break;
      }
    }

    // 也统计缓冲区中的
    for (const t of this.completedBuffer) {
      if (t.state === "completed") completed++;
      else if (t.state === "failed") failed++;
    }

    return {
      total: pending + running + completed + failed,
      pending,
      running,
      completed,
      failed,
    };
  }

  /** 获取所有活跃任务（pending + running） */
  listActive(): QueuedTask[] {
    return [...this.tasks.values()].filter((t) => t.state === "pending" || t.state === "running");
  }

  /** 按类型获取任务 */
  listByType(type: SilentToolType): QueuedTask[] {
    return [
      ...this.tasks.values(),
      ...this.completedBuffer,
    ].filter((t) => t.type === type);
  }

  /* ------------------------------------------------------------------ */
  /*  管理                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * 取消一个活跃任务。
   *
   * @returns 是否成功取消
   */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) {
      log.warn("cancel.notFound", { taskId });
      return false;
    }

    if (task.state === "completed" || task.state === "failed") {
      log.warn("cancel.alreadyDone", { taskId, state: task.state });
      return false;
    }

    // 调用取消回调（如 clearTimeout）
    task.onCancel?.();

    // 串行工具：如果还在 pending（等待队列中），从等待队列移除
    if (!this.isParallel(task.type) && task.state === "pending") {
      const queue = this.serialQueues.get(task.type);
      if (queue) {
        const idx = queue.indexOf(taskId);
        if (idx !== -1) queue.splice(idx, 1);
      }
    }

    this.transition(task, "failed", "cancelled");
    return true;
  }

  /**
   * 清理过期的已完成/失败任务。
   *
   * @param olderThanMs 早于此时间的记录将被清除
   * @returns 清理数量
   */
  purge(olderThanMs: number = DEFAULT_PURGE_AGE_MS): number {
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;

    for (let i = this.completedBuffer.length - 1; i >= 0; i--) {
      const t = this.completedBuffer[i]!;
      if ((t.completedAt ?? t.createdAt) < cutoff) {
        this.completedBuffer.splice(i, 1);
        removed++;
      }
    }

    if (removed > 0) {
      log.info("purge", { removed, remaining: this.completedBuffer.length });
    }
    return removed;
  }

  /**
   * 销毁管理器，取消所有活跃任务。
   */
  destroy(): void {
    const active = this.listActive();
    log.info("destroy", { activeCount: active.length, completedBuffer: this.completedBuffer.length });

    for (const task of active) {
      task.onCancel?.();
      this.transition(task, "failed", "shutdown");
    }

    this.tasks.clear();
    this.completedBuffer.length = 0;
    this.serialQueues.clear();
    this.serialLocks.clear();
    this.toolDefs.clear();
  }

  /* ------------------------------------------------------------------ */
  /*  内部方法                                                           */
  /* ------------------------------------------------------------------ */

  /** 将任务加入已完成缓冲区（环形） */
  private addToCompletedBuffer(task: QueuedTask): void {
    this.completedBuffer.push(task);
    if (this.completedBuffer.length > MAX_COMPLETED_BUFFER) {
      this.completedBuffer.shift();
    }
  }

  /** 为指定类型的串行工具调度下一个等待任务 */
  private dispatchNextSerial(type: SilentToolType): void {
    const queue = this.serialQueues.get(type);
    if (!queue || queue.length === 0) return;

    const nextId = queue.shift()!;
    const nextTask = this.tasks.get(nextId);
    if (!nextTask) {
      // 任务已被移除（如取消），继续尝试下一个
      log.warn("serial.nextNotFound", { type, taskId: nextId });
      this.dispatchNextSerial(type);
      return;
    }

    log.info("serial.dispatch", { type, taskId: nextId, remaining: queue.length });
    this.transition(nextTask, "running");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

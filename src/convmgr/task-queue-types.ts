/**
 * 任务队列类型定义 — 与管理器解耦，避免循环依赖。
 *
 * 静默工具任务队列为需要异步/长时间运行的静默工具提供统一的生命周期管理。
 * 支持并行/串行调度：串行工具（如 TTS）按 FIFO 依次执行，并行工具（如 timer）可同时运行。
 */

// ─── 工具类型 ────────────────────────────────────────────

/** 静默工具类型标识（字符串联合，可扩展） */
export type SilentToolType = "timer" | "affinity" | "tts" | "muri_agent" | "text2image";

/** 任务状态 */
export type TaskState = "pending" | "running" | "completed" | "failed";

// ─── 工具注册 ────────────────────────────────────────────

/** 工具定义（启动时注册到队列管理器） */
export interface ToolDefinition {
  /** 工具类型 */
  type: SilentToolType;
  /** 是否可并行执行。false = 串行（临界资源独占，FIFO），true = 可并行 */
  parallel: boolean;
  /** 工具描述 */
  description: string;
}

// ─── 任务条目 ────────────────────────────────────────────

/** 队列中的任务条目 */
export interface QueuedTask {
  /** 任务唯一 ID，格式: {type}-{timestamp}-{counter} */
  readonly id: string;
  /** 工具类型 */
  readonly type: SilentToolType;
  /** 当前状态 */
  state: TaskState;
  /** 群 ID */
  groupId?: number;
  /** 用户 ID */
  userId?: number;
  /** 入队时间戳 */
  createdAt: number;
  /** 开始执行时间戳 */
  startedAt?: number;
  /** 完成时间戳 */
  completedAt?: number;
  /** 工具相关元数据 */
  metadata: Record<string, unknown>;
  /** 错误信息（failed 时） */
  error?: string;
  /** 取消回调（由工具包装层提供，如 clearTimeout、abort 等） */
  onCancel?: () => void;
}

// ─── 新建任务参数 ────────────────────────────────────────

/** enqueue() 的可选参数 */
export interface EnqueueOptions {
  /** 群 ID */
  groupId?: number;
  /** 用户 ID */
  userId?: number;
  /** 取消回调 */
  onCancel?: () => void;
}

// ─── 统计 ────────────────────────────────────────────────

/** 队列统计信息 */
export interface TaskQueueStats {
  /** 总任务数 */
  total: number;
  /** 等待中的任务数 */
  pending: number;
  /** 运行中的任务数 */
  running: number;
  /** 已完成的任务数 */
  completed: number;
  /** 失败的任务数 */
  failed: number;
}

/**
 * 静默工具执行器 — P2 执行 get_meme、update_affinity 和 timer。
 *
 * P3 识别并标记这些工具为静默工具（不在 P3 ToolRegistry 中），
 * 通过 chat_response 的 silent_tool_calls[] 返回给 P2 执行。
 *
 * 执行结果：
 * - get_meme: 返回表情图片 URL（附加到回复末尾）
 * - update_affinity: 更新好感度缓存（无可见输出）
 * - timer: 设置定时提醒（后台 setTimeout，到期发送消息）
 *
 * 分流机制：
 * - getmeme 始终直接执行（不排队，无状态，瞬时完成）
 * - affinity / timer / tts / muri_agent 可通过 env 配置是否走任务队列管理生命周期
 *
 * 迁移自 v1 tools/builtin/meme.ts + tools/builtin/affinity.ts。
 */
import { createLogger } from "../common/logger";
import type { SilentToolCall } from "../common/types/ipc";
import type { AffinityCache } from "./affinity/cache";
import type { ExtractedSilentCalls, MuriAgentCall, AffinityCall, TimerCall, TtsCall, Text2ImageCall } from "./silent-text-extractor";
import type { TimerManager } from "./timer-manager";
import type { TaskQueueManager } from "./task-queue-manager";
import type { MuriAgentExecutor } from "./muri-agent/executor";
import type { TtsExecutor } from "./tts/executor";
import type { Text2ImageExecutor } from "./text2image/executor";

const log = createLogger("P2.silent");

/** memesluna 服务地址 */
const MEME_BASE_URL = "http://127.0.0.1:5141/memesluna/holo";

/** get_meme 可用标签集合 */
const VALID_MEME_TAGS = new Set([
  "幸福", "开心", "高兴", "快乐", "治愈", "满足",
  "委屈", "难过", "伤心", "沮丧", "流泪", "大哭",
  "生气", "愤怒", "炸毛", "不爽", "恼火", "气愤",
  "害羞", "脸红", "羞涩", "不好意思",
  "赞", "好", "棒", "点赞", "强", "厉害", "牛逼", "给力",
]);

export interface SilentToolResult {
  /** get_meme 返回的 meme URL（追加到回复末尾） */
  memeUrl?: string;
  /** 工具执行是否有错误 */
  error?: string;
}

/** 执行上下文（timer/muri_agent 等需要群与用户信息） */
export interface SilentExecContext {
  groupId?: number;
  userId?: number;
  messageId?: number;
}

/** SilentToolExecutor 构造选项 */
export interface SilentToolExecutorOptions {
  /** 任务队列管理器（用于生命周期管理的工具） */
  taskQueue?: TaskQueueManager;
  /** 需要通过队列管理的工具类型集合 */
  queuedTools?: Set<string>;
  /** Muri Agent 执行器 */
  muriAgentExecutor?: MuriAgentExecutor;
  /** TTS 执行器 */
  ttsExecutor?: TtsExecutor;
  /** Text2Image 执行器 */
  text2imageExecutor?: Text2ImageExecutor;
}

export class SilentToolExecutor {
  private readonly taskQueue: TaskQueueManager | null;
  private readonly queuedTools: Set<string>;
  private readonly muriAgentExecutor: MuriAgentExecutor | null;
  private readonly ttsExecutor: TtsExecutor | null;
  private readonly text2imageExecutor: Text2ImageExecutor | null;

  constructor(
    private readonly affinityCache: AffinityCache,
    private readonly timerManager: TimerManager | null = null,
    options?: SilentToolExecutorOptions,
  ) {
    this.taskQueue = options?.taskQueue ?? null;
    this.queuedTools = options?.queuedTools ?? new Set();
    this.muriAgentExecutor = options?.muriAgentExecutor ?? null;
    this.ttsExecutor = options?.ttsExecutor ?? null;
    this.text2imageExecutor = options?.text2imageExecutor ?? null;
  }

  /**
   * 执行从文本中提取的静默工具调用。
   *
   * 这是主要入口 —— LLM 通过文本标记（getmeme() / affinity() / timer()）
   * 而非标准 function calling 来调用静默工具。
   *
   * 分流逻辑：
   * - getmeme：始终直接执行（不排队）
   * - affinity / timer：根据 queuedTools 配置决定直接执行还是走任务队列
   *
   * @param extracted 提取到的静默工具调用
   * @param groupId 群 ID（timer 需要）
   * @param userId 触发用户 ID（timer 需要）
   * @returns memeUrl（若有 get_meme 调用）
   */
  executeExtracted(extracted: ExtractedSilentCalls, groupId?: number, userId?: number): SilentToolResult {
    const result: SilentToolResult = {};

    // 1. 生成 meme URL（始终直接执行，不排队 —— 瞬时完成，无状态）
    if (extracted.memeTag) {
      const url = `${MEME_BASE_URL}?q=${encodeURIComponent(extracted.memeTag)}`;
      result.memeUrl = url;
      log.info("meme.generated", { tag: extracted.memeTag, url });
    }

    // 2. 执行好感度变更（根据配置决定排队还是直接执行）
    for (const call of extracted.affinityCalls) {
      if (this.shouldQueue("affinity")) {
        this.executeAffinityQueued(call);
      } else {
        this.executeAffinityDirect(call, result);
      }
    }

    // 3. 设置定时器（根据配置决定排队还是直接执行）
    if (extracted.timerCall && this.timerManager && groupId != null && userId != null) {
      if (this.shouldQueue("timer")) {
        this.executeTimerQueued(extracted.timerCall, groupId, userId);
      } else {
        this.executeTimerDirect(extracted.timerCall, groupId, userId, result);
      }
    } else if (extracted.timerCall && (!groupId || !userId)) {
      log.warn("timer.missingContext", {
        hasGroupId: groupId != null,
        hasUserId: userId != null,
      });
    }

    // 4. TTS 调用
    if (extracted.ttsCall && this.ttsExecutor && groupId != null) {
      if (this.shouldQueue("tts")) {
        this.executeTtsQueued(extracted.ttsCall, groupId);
      } else {
        this.executeTtsDirect(extracted.ttsCall, groupId);
      }
    } else if (extracted.ttsCall && !this.ttsExecutor) {
      log.warn("tts.noExecutor", { text: extracted.ttsCall.text.slice(0, 50) });
    }

    // 5. muri agent 调用
    if (extracted.muriAgentCall && this.muriAgentExecutor && groupId != null) {
      if (this.shouldQueue("muri_agent")) {
        this.executeMuriAgentQueued(extracted.muriAgentCall, groupId);
      } else {
        this.executeMuriAgentDirect(extracted.muriAgentCall, groupId);
      }
    } else if (extracted.muriAgentCall && !this.muriAgentExecutor) {
      log.warn("muriAgent.noExecutor", { task: extracted.muriAgentCall.task });
    }

    // 6. text2image 调用
    if (extracted.text2imageCall && this.text2imageExecutor && groupId != null) {
      if (this.shouldQueue("text2image")) {
        this.executeText2ImageQueued(extracted.text2imageCall, groupId);
      } else {
        this.executeText2ImageDirect(extracted.text2imageCall, groupId);
      }
    } else if (extracted.text2imageCall && !this.text2imageExecutor) {
      log.warn("text2image.noExecutor", { topic: extracted.text2imageCall.topic });
    }

    return result;
  }

  /**
   * 执行静默工具调用列表（P3 function calling 通道的 SilentToolCall[]）。
   *
   * 同轮同工具去重：同一工具一轮只执行一次（保留最后一次出现的调用）；
   * update_affinity 按 userId 去重（不同用户各自一次，同用户取最后一次）。
   * 不同工具可同时执行。
   *
   * @returns memeUrl（若有 get_meme 调用）
   */
  executeAll(silentToolCalls: SilentToolCall[], ctx?: SilentExecContext): SilentToolResult {
    const result: SilentToolResult = {};

    // 同轮同工具去重（保留最后一次出现的）
    const latest = new Map<string, SilentToolCall>();
    for (const c of silentToolCalls) {
      const key = c.name === "update_affinity" ? `update_affinity:${(c.arguments ?? {}).user_id}` : c.name;
      latest.set(key, c);
    }

    for (const call of latest.values()) {
      try {
        const toolResult = this.executeOne(call, ctx);
        if (toolResult.memeUrl) result.memeUrl = toolResult.memeUrl;
        if (toolResult.error && !result.error) result.error = toolResult.error;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error("execute.fail", { name: call.name, error: errMsg });
        if (!result.error) result.error = errMsg;
      }
    }

    return result;
  }

  /**
   * 合并执行（推荐入口）：把 function calling 通道（silentToolCalls）与
   * 正文标记通道（extracted）合并为一次执行。
   *
   * 同轮同工具只执行一次，silentToolCalls（显式工具调用）优先于正文标记；
   * update_affinity 按 userId 合并（不同用户可各调一次）。
   */
  executeMerged(
    extracted: ExtractedSilentCalls,
    silentToolCalls: SilentToolCall[],
    ctx?: SilentExecContext,
  ): SilentToolResult {
    const merged: ExtractedSilentCalls = {
      cleanedText: extracted.cleanedText,
      memeTag: extracted.memeTag,
      affinityCalls: [...extracted.affinityCalls],
      timerCall: extracted.timerCall,
      ttsCall: extracted.ttsCall,
      muriAgentCall: extracted.muriAgentCall,
      text2imageCall: extracted.text2imageCall,
    };

    for (const call of silentToolCalls) {
      const args = call.arguments ?? {};
      switch (call.name) {
        case "get_meme": {
          const tag = String(args.tag ?? "").trim();
          if (tag && VALID_MEME_TAGS.has(tag)) {
            merged.memeTag = tag;
          } else if (tag) {
            log.warn("meme.invalidTag", { tag });
          }
          break;
        }
        case "update_affinity": {
          const userId = Number(args.user_id);
          const delta = Number(args.delta);
          if (!Number.isFinite(userId) || userId <= 0 || (delta !== 1 && delta !== -1)) {
            log.warn("affinity.invalidArgs", { userId: args.user_id, delta: args.delta });
            break;
          }
          const impressionRaw = typeof args.impression === "string" ? args.impression.trim() : "";
          const entry: AffinityCall = {
            userId,
            delta: delta === 1 ? "+1" : "-1",
            impression: impressionRaw ? impressionRaw.slice(0, 10) : undefined,
          };
          const idx = merged.affinityCalls.findIndex((a) => a.userId === userId);
          if (idx >= 0) merged.affinityCalls[idx] = entry;
          else merged.affinityCalls.push(entry);
          break;
        }
        case "timer": {
          const dur = Number(args.duration_sec ?? args.durationSec);
          const eventText = String(args.event_text ?? args.eventText ?? "").trim();
          if (!Number.isFinite(dur) || dur <= 0 || !eventText) {
            log.warn("timer.invalidArgs", { durationSec: args.duration_sec, eventText });
            break;
          }
          merged.timerCall = {
            durationSec: Math.min(24 * 3600, Math.max(60, Math.round(dur))),
            eventText,
          };
          break;
        }
        case "tts": {
          const text = String(args.text ?? "").trim();
          if (!text) {
            log.warn("tts.emptyText");
            break;
          }
          const lang = typeof args.lang === "string" ? args.lang.trim() : undefined;
          const translation = typeof args.translation === "string" ? args.translation.trim() : undefined;
          merged.ttsCall = {
            text: text.slice(0, 300),
            lang: lang || undefined,
            translation: translation || undefined,
          };
          break;
        }
        case "muri_agent": {
          const task = String(args.task ?? "").trim();
          if (!task) {
            log.warn("muriAgent.emptyTask");
            break;
          }
          merged.muriAgentCall = { task, userId: ctx?.userId, messageId: ctx?.messageId };
          break;
        }
        case "text2image": {
          const topic = String(args.topic ?? "").trim();
          if (!topic) {
            log.warn("text2image.emptyTopic");
            break;
          }
          merged.text2imageCall = { topic: topic.slice(0, 200) };
          break;
        }
        default:
          log.warn("unknownToolCall", { name: call.name });
      }
    }

    return this.executeExtracted(merged, ctx?.groupId, ctx?.userId);
  }

  // ─── 私有：分流判断 ────────────────────────────────────

  /** 判断指定工具类型是否应走任务队列 */
  private shouldQueue(toolType: string): boolean {
    return this.queuedTools.has(toolType) && this.taskQueue !== null;
  }

  // ─── 私有：好感度执行 ──────────────────────────────────

  /** 通过任务队列执行好感度变更（异步追踪 DB 写入） */
  private executeAffinityQueued(call: AffinityCall): void {
    const taskId = this.taskQueue!.enqueue("affinity", {
      userId: call.userId,
      delta: call.delta,
      impression: call.impression,
    }, {
      userId: call.userId,
    });
    // enqueue() 已自动 transition 到 running（并行工具立即，串行工具等待槽位释放后）
    // 此处不重复调用 transition

    this.affinityCache.addDelta(call.userId, call.delta, () => {
      // 印象存储在好感度变更之后
      if (call.impression) {
        this.affinityCache.addImpression(call.userId, call.impression);
      }
      this.taskQueue!.transition(taskId, "completed");
    });

    log.info("affinity.queued", { taskId, userId: call.userId, delta: call.delta, hasImpression: !!call.impression });
  }

  /** 直接执行好感度变更（不排队，现有行为） */
  private executeAffinityDirect(call: AffinityCall, result: SilentToolResult): void {
    try {
      const newAffinity = this.affinityCache.addDelta(call.userId, call.delta);
      // 印象存储
      if (call.impression) {
        this.affinityCache.addImpression(call.userId, call.impression);
      }
      log.info("affinity.updated", {
        userId: call.userId,
        delta: call.delta,
        newAffinity,
        hasImpression: !!call.impression,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("affinity.fail", { userId: call.userId, error: errMsg });
      if (!result.error) result.error = errMsg;
    }
  }

  // ─── 私有：定时器执行 ──────────────────────────────────

  /** 通过任务队列执行定时器（追踪生命周期和资源释放） */
  private executeTimerQueued(call: TimerCall, groupId: number, userId: number): void {
    let timerId: number | undefined;

    const taskId = this.taskQueue!.enqueue("timer", {
      durationSec: call.durationSec,
      eventText: call.eventText,
    }, {
      groupId,
      userId,
      onCancel: () => {
        if (timerId != null) {
          this.timerManager!.cancel(timerId);
        }
      },
    });

    // enqueue() 已自动 transition 到 running（并行工具立即，串行工具等待槽位释放后）
    // 此处不重复调用 transition

    timerId = this.timerManager!.set(
      userId,
      groupId,
      call.durationSec,
      call.eventText,
      () => {
        this.taskQueue!.transition(taskId, "completed");
      },
    );

    // 回存 timerId 到任务元数据
    const task = this.taskQueue!.get(taskId);
    if (task) {
      task.metadata.timerId = timerId;
    }

    log.info("timer.queued", {
      taskId,
      timerId,
      userId,
      groupId,
      durationSec: call.durationSec,
      eventText: call.eventText,
    });
  }

  /** 直接执行定时器（不排队，现有行为） */
  private executeTimerDirect(call: TimerCall, groupId: number, userId: number, result: SilentToolResult): void {
    try {
      const timerId = this.timerManager!.set(
        userId,
        groupId,
        call.durationSec,
        call.eventText,
      );
      log.info("timer.activated", {
        timerId,
        userId,
        groupId,
        durationSec: call.durationSec,
        eventText: call.eventText,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("timer.fail", { error: errMsg });
      if (!result.error) result.error = errMsg;
    }
  }

  // ─── 私有：muri_agent 执行 ─────────────────────────────

  /** 通过任务队列执行 muri_agent（串行 FIFO，追踪生命周期） */
  private executeMuriAgentQueued(call: MuriAgentCall, groupId: number): void {
    const taskId = this.taskQueue!.enqueue("muri_agent", {
      task: call.task,
    }, {
      groupId,
      userId: call.userId,
    });

    // 串行工具：enqueue 后可能处于 pending，等待槽位释放后 MuriAgentExecutor 执行
    // 执行在 executor 内部是异步的，此处不 await

    this.muriAgentExecutor!.execute(call, groupId, taskId).catch((err) => {
      log.error("muriAgent.queuedFail", { taskId, groupId, error: String(err) });
      this.taskQueue!.transition(taskId, "failed", String(err));
    });

    log.info("muriAgent.queued", { taskId, groupId, task: call.task });
  }

  /** 直接执行 muri_agent（不排队） */
  private executeMuriAgentDirect(call: MuriAgentCall, groupId: number): void {
    // 直接执行也 fire-and-forget，不阻塞主回复
    this.muriAgentExecutor!.execute(call, groupId).catch((err) => {
      log.error("muriAgent.directFail", { groupId, error: String(err) });
    });

    log.info("muriAgent.direct", { groupId, task: call.task });
  }

  // ─── 私有：TTS 执行 ────────────────────────────────────

  /** 通过任务队列执行 TTS（串行 FIFO，追踪生命周期） */
  private executeTtsQueued(call: TtsCall, groupId: number): void {
    const taskId = this.taskQueue!.enqueue("tts", {
      text: call.text,
      lang: call.lang,
      translation: call.translation,
    }, {
      groupId,
    });

    // 串行工具：enqueue 后可能处于 pending，等待槽位
    // executor 内部通过 waitForRunning 获取槽位后才实际调用 API
    this.ttsExecutor!.execute(call, groupId, taskId).catch((err) => {
      log.error("tts.queuedFail", { taskId, groupId, error: String(err) });
    });

    log.info("tts.queued", { taskId, groupId, textLen: call.text.length, lang: call.lang ?? "zh" });
  }

  /** 直接执行 TTS（不排队，fire-and-forget） */
  private executeTtsDirect(call: TtsCall, groupId: number): void {
    this.ttsExecutor!.execute(call, groupId).catch((err) => {
      log.error("tts.directFail", { groupId, error: String(err) });
    });

    log.info("tts.direct", { groupId, textLen: call.text.length, lang: call.lang ?? "zh" });
  }

  // ─── 私有：text2image 执行 ─────────────────────────────

  /** 通过任务队列执行 text2image（串行 FIFO，追踪生命周期） */
  private executeText2ImageQueued(call: Text2ImageCall, groupId: number): void {
    const taskId = this.taskQueue!.enqueue("text2image", {
      topic: call.topic,
    }, {
      groupId,
    });

    // 串行工具：enqueue 后可能处于 pending，等待槽位
    // executor 内部通过 waitForRunning 获取槽位后才实际调用 API
    this.text2imageExecutor!.execute(call, groupId, taskId).catch((err) => {
      log.error("text2image.queuedFail", { taskId, groupId, error: String(err) });
    });

    log.info("text2image.queued", { taskId, groupId, topic: call.topic });
  }

  /** 直接执行 text2image（不排队，fire-and-forget） */
  private executeText2ImageDirect(call: Text2ImageCall, groupId: number): void {
    this.text2imageExecutor!.execute(call, groupId).catch((err) => {
      log.error("text2image.directFail", { groupId, error: String(err) });
    });

    log.info("text2image.direct", { groupId, topic: call.topic });
  }

  // ─── 私有：兼容路径 ────────────────────────────────────

  private executeOne(call: SilentToolCall, ctx?: SilentExecContext): SilentToolResult {
    const args = call.arguments ?? {};

    switch (call.name) {
      case "get_meme": {
        const tag = String(args.tag ?? "").trim();
        if (!tag || !VALID_MEME_TAGS.has(tag)) {
          const errMsg = `无效的表情标签 "${tag}"。可用标签：${[...VALID_MEME_TAGS].join("、")}`;
          log.warn("meme.invalidTag", { tag });
          return { error: errMsg };
        }
        const url = `${MEME_BASE_URL}?q=${encodeURIComponent(tag)}`;
        log.info("meme.generated", { tag, url });
        return { memeUrl: url };
      }

      case "update_affinity": {
        const userId = Number(args.user_id);
        const delta = Number(args.delta);

        if (!Number.isFinite(userId) || userId <= 0) {
          return { error: `无效的 user_id: ${args.user_id}` };
        }
        if (delta !== 1 && delta !== -1) {
          return { error: `delta 必须为 1 或 -1，收到: ${args.delta}` };
        }

        const newAffinity = this.affinityCache.addDelta(userId, delta === 1 ? "+1" : "-1");
        log.info("affinity.updated", { userId, delta, newAffinity });
        return {};
      }

      case "timer": {
        const dur = Number(args.duration_sec ?? args.durationSec);
        const eventText = String(args.event_text ?? args.eventText ?? "").trim();
        if (!Number.isFinite(dur) || dur <= 0 || !eventText) {
          return { error: `timer 参数无效: duration_sec=${args.duration_sec}, event_text="${eventText}"` };
        }
        if (!this.timerManager) {
          return { error: "timerManager 未就绪" };
        }
        if (ctx?.groupId == null || ctx?.userId == null) {
          return { error: "timer 缺少群/用户上下文" };
        }
        const timerCall: TimerCall = {
          durationSec: Math.min(24 * 3600, Math.max(60, Math.round(dur))),
          eventText,
        };
        if (this.shouldQueue("timer")) {
          this.executeTimerQueued(timerCall, ctx.groupId, ctx.userId);
        } else {
          const r: SilentToolResult = {};
          this.executeTimerDirect(timerCall, ctx.groupId, ctx.userId, r);
          if (r.error) return { error: r.error };
        }
        return {};
      }

      case "tts": {
        const text = String(args.text ?? "").trim();
        if (!text) {
          return { error: "tts 文本为空" };
        }
        if (!this.ttsExecutor) {
          return { error: "ttsExecutor 未就绪" };
        }
        if (ctx?.groupId == null) {
          return { error: "tts 缺少群上下文" };
        }
        const lang = typeof args.lang === "string" ? args.lang.trim() : undefined;
        const translation = typeof args.translation === "string" ? args.translation.trim() : undefined;
        const ttsCall: TtsCall = {
          text: text.slice(0, 300),
          lang: lang || undefined,
          translation: translation || undefined,
        };
        if (this.shouldQueue("tts")) {
          this.executeTtsQueued(ttsCall, ctx.groupId);
        } else {
          this.executeTtsDirect(ttsCall, ctx.groupId);
        }
        return {};
      }

      case "muri_agent": {
        const task = String(args.task ?? "").trim();
        if (!task) {
          return { error: "muri_agent 任务为空" };
        }
        if (!this.muriAgentExecutor) {
          return { error: "muriAgentExecutor 未就绪" };
        }
        if (ctx?.groupId == null) {
          return { error: "muri_agent 缺少群上下文" };
        }
        const muriCall: MuriAgentCall = { task, userId: ctx.userId, messageId: ctx.messageId };
        if (this.shouldQueue("muri_agent")) {
          this.executeMuriAgentQueued(muriCall, ctx.groupId);
        } else {
          this.executeMuriAgentDirect(muriCall, ctx.groupId);
        }
        return {};
      }

      case "text2image": {
        const topic = String(args.topic ?? "").trim();
        if (!topic) {
          return { error: "text2image 主题为空" };
        }
        if (!this.text2imageExecutor) {
          return { error: "text2imageExecutor 未就绪" };
        }
        if (ctx?.groupId == null) {
          return { error: "text2image 缺少群上下文" };
        }
        const t2iCall: Text2ImageCall = { topic: topic.slice(0, 200) };
        if (this.shouldQueue("text2image")) {
          this.executeText2ImageQueued(t2iCall, ctx.groupId);
        } else {
          this.executeText2ImageDirect(t2iCall, ctx.groupId);
        }
        return {};
      }

      default:
        log.warn("unknownTool", { name: call.name });
        return { error: `未知的静默工具: ${call.name}` };
    }
  }
}

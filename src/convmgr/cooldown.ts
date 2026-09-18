/**
 * 冷却管理器 — 每个群独立 CD，冷却期间触发消息进入 msgCache，
 * CD 到期后用最新一条缓存的触发消息发起对话。
 *
 * 迁移自 v1 ChatManager 中的 cooldown / batch 逻辑。
 */
import { createLogger } from "../common/logger";

const log = createLogger("P2.cooldown");

/** 冷却缓存中的一条触发消息（携带自己的 reason/time，flush 时用） */
export interface CooldownTriggerEntry {
  messageId: number;
  reason?: string;
  time?: number;
}

export interface CooldownState {
  groupId: number;
  /** 是否正在冷却中 */
  isCooling: boolean;
  /** 冷却窗口内缓存的触发消息列表 */
  msgCache: CooldownTriggerEntry[];
  /** CD 定时器 */
  timer: ReturnType<typeof setTimeout> | null;
  /** 最近一次处理回复的时间戳（Unix 秒） */
  lastRepliedTime: number;
  /** 是否正在忙（处理中） */
  busy: boolean;
}

export type CooldownCallback = (groupId: number, entry: CooldownTriggerEntry) => Promise<void>;

export class CooldownManager {
  private readonly groups = new Map<number, CooldownState>();
  private readonly cooldownMs: number;

  constructor(cooldownMs: number) {
    this.cooldownMs = cooldownMs;
  }

  /** 获取或创建群冷却状态 */
  private get(groupId: number): CooldownState {
    let state = this.groups.get(groupId);
    if (!state) {
      state = {
        groupId,
        isCooling: false,
        msgCache: [],
        timer: null,
        lastRepliedTime: 0,
        busy: false,
      };
      this.groups.set(groupId, state);
    }
    return state;
  }

  /**
   * 收到触发消息时调用。
   * 若不在冷却中 → 立即调用 onFire 处理，启动冷却。
   * 若在冷却中 → 缓存 message_id，待冷却结束后用最新一条发起。
   *
   * @param onFire 触发回调（构建上下文 → 发送给 P3）
   */
  async onTrigger(groupId: number, entry: CooldownTriggerEntry, onFire: CooldownCallback): Promise<void> {
    const state = this.get(groupId);

    if (!state.isCooling) {
      // 不在冷却中：立即处理
      state.isCooling = true;
      state.busy = true;
      try {
        await onFire(groupId, entry);
        log.info("cooldown.start", { groupId, cooldownMs: this.cooldownMs });
        // 启动冷却定时器
        state.timer = setTimeout(() => {
          void this.flushBatch(groupId, onFire);
        }, this.cooldownMs);
      } catch (err) {
        log.error("cooldown.fire.fail", { groupId, error: String(err) });
        state.isCooling = false;
      } finally {
        state.busy = false;
      }
    } else {
      // 冷却中：缓存触发消息
      state.msgCache.push(entry);
      log.debug("cooldown.cached", { groupId, cacheSize: state.msgCache.length });
    }
  }

  /**
   * 冷却定时器到期或外部触发刷新。
   * 若 msgCache 非空 → 用最新一条发起对话。
   * 若 msgCache 为空 → 结束冷却。
   */
  private async flushBatch(groupId: number, onFire: CooldownCallback): Promise<void> {
    const state = this.groups.get(groupId);
    if (!state) return;

    state.timer = null;
    log.info("cooldown.expired", { groupId, cacheSize: state.msgCache.length });

    if (state.busy) {
      // 仍在处理中，延迟重试
      log.info("cooldown.reschedule", { groupId });
      state.timer = setTimeout(() => {
        void this.flushBatch(groupId, onFire);
      }, 1000);
      return;
    }

    const latestEntry = state.msgCache[state.msgCache.length - 1];
    if (latestEntry) {
      // 用最新一条缓存消息发起
      state.busy = true;
      try {
        await onFire(groupId, latestEntry);
        // 重新启动冷却
        state.msgCache = [];
        state.timer = setTimeout(() => {
          void this.flushBatch(groupId, onFire);
        }, this.cooldownMs);
      } catch (err) {
        log.error("cooldown.flush.fail", { groupId, error: String(err) });
        state.isCooling = false;
        state.msgCache = [];
      } finally {
        state.busy = false;
      }
    } else {
      // 无缓存消息，结束冷却
      log.info("cooldown.end", { groupId });
      state.isCooling = false;
    }
  }

  /** 更新最近回复时间（reply 发送后调用） */
  updateLastRepliedTime(groupId: number, time: number): void {
    const state = this.groups.get(groupId);
    if (state) {
      state.lastRepliedTime = time;
    }
  }

  /** 获取群冷却状态（供测试） */
  getState(groupId: number): CooldownState | undefined {
    return this.groups.get(groupId);
  }

  /** 清理所有定时器 */
  destroy(): void {
    for (const state of this.groups.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.groups.clear();
  }
}

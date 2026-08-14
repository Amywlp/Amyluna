/**
 * 定时器管理器 — 管理 LLM 通过 timer() 文本标记设置的定时提醒。
 *
 * 采用与 CooldownManager 类似的结构：每个定时器有独立的 setTimeout，
 * 到期后通过回调发送提醒消息。
 *
 * 最短时长 60 秒（1 分钟），防止误设过短的定时器。
 */

import { createLogger } from "../common/logger";

const log = createLogger("P2.timer");

export interface TimerEntry {
  /** 定时器唯一 ID */
  id: number;
  /** 发起用户 ID（用于 @ 提醒） */
  userId: number;
  /** 群 ID */
  groupId: number;
  /** 时长（秒） */
  durationSec: number;
  /** 事件文本 */
  eventText: string;
  /** setTimeout 句柄 */
  handle: ReturnType<typeof setTimeout>;
  /** 设定时间戳 */
  createdAt: number;
  /** 定时器完成回调（无论通知发送成功或失败都调用） */
  onComplete?: () => void;
}

/** 定时器到期回调 */
export type TimerFireCallback = (
  userId: number,
  groupId: number,
  eventText: string,
) => Promise<void>;

export class TimerManager {
  private readonly timers = new Map<number, TimerEntry>();
  private nextId = 1;
  private readonly onFire: TimerFireCallback;

  /** 最短定时时长（秒） */
  static readonly MIN_DURATION_SEC = 60;

  constructor(onFire: TimerFireCallback) {
    this.onFire = onFire;
  }

  /**
   * 设置一个定时器。
   *
   * @param userId 发起用户 ID
   * @param groupId 群 ID
   * @param durationSec 时长（秒），小于 60 秒强制设为 60 秒
   * @param eventText 事件文本
   * @returns 定时器 ID
   */
  set(userId: number, groupId: number, durationSec: number, eventText: string, onComplete?: () => void): number {
    const clamped = Math.max(TimerManager.MIN_DURATION_SEC, Math.round(durationSec));
    const id = this.nextId++;
    const now = Date.now();

    const handle = setTimeout(() => {
      void this.fire(id);
    }, clamped * 1000);

    const entry: TimerEntry = {
      id,
      userId,
      groupId,
      durationSec: clamped,
      eventText,
      handle,
      createdAt: now,
      onComplete,
    };

    this.timers.set(id, entry);
    log.info("timer.set", {
      id,
      userId,
      groupId,
      durationSec: clamped,
      eventText,
      totalActive: this.timers.size,
    });

    return id;
  }

  /**
   * 取消一个定时器。
   *
   * @returns 是否成功取消
   */
  cancel(id: number): boolean {
    const entry = this.timers.get(id);
    if (!entry) {
      log.warn("timer.cancel.notFound", { id });
      return false;
    }

    clearTimeout(entry.handle);
    this.timers.delete(id);
    log.info("timer.cancel", { id, eventText: entry.eventText, totalActive: this.timers.size });
    return true;
  }

  /** 获取活跃定时器数量 */
  get activeCount(): number {
    return this.timers.size;
  }

  /** 获取所有活跃定时器信息（供调试） */
  list(): Array<{ id: number; userId: number; groupId: number; remainingSec: number; eventText: string }> {
    const now = Date.now();
    return [...this.timers.values()].map((t) => ({
      id: t.id,
      userId: t.userId,
      groupId: t.groupId,
      remainingSec: Math.max(0, Math.round((t.createdAt + t.durationSec * 1000 - now) / 1000)),
      eventText: t.eventText,
    }));
  }

  /** 清理所有定时器 */
  destroy(): void {
    for (const entry of this.timers.values()) {
      clearTimeout(entry.handle);
    }
    this.timers.clear();
    log.info("timer.destroyed", { wasActive: this.timers.size });
  }

  private async fire(id: number): Promise<void> {
    const entry = this.timers.get(id);
    if (!entry) return; // 已被取消

    this.timers.delete(id);
    log.info("timer.fire", {
      id,
      userId: entry.userId,
      groupId: entry.groupId,
      eventText: entry.eventText,
      totalActive: this.timers.size,
    });

    try {
      await this.onFire(entry.userId, entry.groupId, entry.eventText);
    } catch (err) {
      log.error("timer.fire.fail", { id, error: String(err) });
    } finally {
      // 无论通知发送成功或失败，都通知完成
      entry.onComplete?.();
    }
  }
}

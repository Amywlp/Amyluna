/**
 * TempMuteList — P1 内存静音列表。
 *
 * 维护一个按 mute_end_time ASC 排序的有序数组，提供：
 *   - mute()     upsert 静音条目
 *   - checkAndClean()  惰性清理过期条目 + 静音判定
 *
 * 维稳策略：
 *   - mute_time clamp [120, 600], severe_level clamp [1, 5]
 *   - 实际静音时长 = mute_time × severe_level（120s ~ 3000s）
 *   - 列表上限 200 条
 *   - 无定时器：过期条目在每次 checkAndClean 时惰性移除
 */

import { createLogger } from "../common/logger";

const log = createLogger("P1.tempMute");

/* ------------------------------------------------------------------ */
/*  类型                                                               */
/* ------------------------------------------------------------------ */

export interface TempMuteEntry {
  user_id: number;
  /** 基础静音时长（秒，120-600） */
  mute_time_sec: number;
  /** 严重程度 1-5 */
  severe_level: number;
  /** 静音结束时间（Unix 秒）= now + mute_time_sec × severe_level */
  mute_end_time: number;
  /** 记录创建/更新时间（Date.now() 毫秒） */
  created_at: number;
}

/* ------------------------------------------------------------------ */
/*  常量                                                               */
/* ------------------------------------------------------------------ */

const MIN_MUTE_TIME = 120;
const MAX_MUTE_TIME = 600;
const MIN_SEVERITY = 1;
const MAX_SEVERITY = 5;
const MAX_LIST_SIZE = 200;

/* ------------------------------------------------------------------ */
/*  TempMuteList（静音列表）                                            */
/* ------------------------------------------------------------------ */

export class TempMuteList {
  /** 有序数组，始终按 mute_end_time ASC 排列 */
  private list: TempMuteEntry[] = [];

  /* ---------------------------------------------------------------- */
  /*  mute — upsert                                                     */
  /* ---------------------------------------------------------------- */

  mute(userId: number, muteTime: number, severeLevel: number): TempMuteEntry {
    // 1. clamp 参数
    const clampedTime = clamp(muteTime, MIN_MUTE_TIME, MAX_MUTE_TIME);
    const clampedSeverity = clamp(severeLevel, MIN_SEVERITY, MAX_SEVERITY);

    // 2. 计算实际时长和结束时间
    const actualDuration = clampedTime * clampedSeverity;
    const nowMs = Date.now();
    const endTime = Math.floor(nowMs / 1000) + actualDuration;

    const entry: TempMuteEntry = {
      user_id: userId,
      mute_time_sec: clampedTime,
      severe_level: clampedSeverity,
      mute_end_time: endTime,
      created_at: nowMs,
    };

    // 3. 扫描查找同 user_id（upsert）
    let found = false;
    for (let i = 0; i < this.list.length; i++) {
      if (this.list[i].user_id === userId) {
        this.list[i] = entry;
        found = true;
        log.info("tempMute.updated", {
          user_id: userId,
          mute_time_sec: clampedTime,
          severe_level: clampedSeverity,
          actual_duration: actualDuration,
          mute_end_time: endTime,
        });
        break;
      }
    }

    if (!found) {
      // 4. 容量检查
      if (this.list.length >= MAX_LIST_SIZE) {
        log.warn("tempMute.listFull", {
          size: this.list.length,
          maxSize: MAX_LIST_SIZE,
          rejectedUserId: userId,
        });
        // 仍然插入，但先做一次惰性清理（用当前时间）
        this.cleanExpired(Math.floor(nowMs / 1000));
        if (this.list.length >= MAX_LIST_SIZE) {
          log.error("tempMute.stillFullAfterClean", { size: this.list.length });
          // 移除最远端的条目（mute_end_time 最大的，即最后一个）
          const removed = this.list.pop();
          log.warn("tempMute.evictFarthest", { removedUserId: removed?.user_id });
        }
      }

      this.list.push(entry);
      log.info("tempMute.muted", {
        user_id: userId,
        mute_time_sec: clampedTime,
        severe_level: clampedSeverity,
        actual_duration: actualDuration,
        mute_end_time: endTime,
        listSize: this.list.length,
      });
    }

    // 5. 按 mute_end_time ASC 重排序
    this.list.sort((a, b) => a.mute_end_time - b.mute_end_time);

    return entry;
  }

  /* ---------------------------------------------------------------- */
  /*  checkAndClean — 惰性清理 + 禁言判定                              */
  /* ---------------------------------------------------------------- */

  /**
   * 用消息时间戳进行惰性清理并检查用户是否在禁言中。
   *
   * 算法：
   *   1. 从头遍历 list（已按 mute_end_time ASC 排序）
   *   2. entry.mute_end_time < messageTime → 已过期，移除，继续
   *   3. entry.mute_end_time >= messageTime → 停止（后面都未过期）
   *   4. 在剩余 list 中线性查找 userId
   *
   * @param messageTime 消息的 Unix 秒时间戳（OneBot event.time）
   * @param userId      要检查的用户 QQ 号
   * @returns true = 该用户当前被禁言
   */
  checkAndClean(messageTime: number, userId: number): boolean {
    // 惰性清理过期条目
    const removed = this.cleanExpired(messageTime);

    // 线性查找（list 已排好序但未按 user_id 索引）
    for (const entry of this.list) {
      if (entry.user_id === userId) {
        const remainingSec = entry.mute_end_time - messageTime;
        log.info("tempMute.blocked", {
          user_id: userId,
          message_time: messageTime,
          mute_end_time: entry.mute_end_time,
          remaining_sec: remainingSec,
          severe_level: entry.severe_level,
          removed_expired: removed,
        });
        return true;
      }
    }

    return false;
  }

  /* ---------------------------------------------------------------- */
  /*  查询                                                              */
  /* ---------------------------------------------------------------- */

  getEntry(userId: number): TempMuteEntry | undefined {
    return this.list.find((e) => e.user_id === userId);
  }

  /** 只读快照（调试用） */
  getAll(): readonly TempMuteEntry[] {
    return this.list;
  }

  get size(): number {
    return this.list.length;
  }

  /* ---------------------------------------------------------------- */
  /*  内部：惰性清理                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * 从头移除所有 mute_end_time < cutoff 的过期条目。
   * 因为 list 按 mute_end_time ASC 排序，一旦遇到未过期的就停止。
   *
   * @returns 被移除的条目数
   */
  private cleanExpired(cutoff: number): number {
    let removed = 0;
    while (this.list.length > 0 && this.list[0].mute_end_time < cutoff) {
      const entry = this.list.shift()!;
      removed++;
      log.info("tempMute.expired", {
        user_id: entry.user_id,
        mute_end_time: entry.mute_end_time,
        cutoff,
        age_sec: cutoff - entry.mute_end_time,
      });
    }
    if (removed > 0) {
      log.info("tempMute.cleanup", { removed, remaining: this.list.length });
    }
    return removed;
  }
}

/* ------------------------------------------------------------------ */
/*  工具函数                                                           */
/* ------------------------------------------------------------------ */

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return Math.floor(value); // 确保整数
}

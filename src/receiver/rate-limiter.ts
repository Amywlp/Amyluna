/**
 * P1 用户请求频率限制器 — 在 trigger 判断通过后、发送给 P2 前进行次数检查。
 *
 * 每个用户在一个时间窗口内有默认 10 次触发机会。
 * 窗口到期后自动重置所有用户的剩余次数。
 *
 * 配置（通过 .env）：
 *   RATE_LIMIT_MAX_REQUESTS — 每窗口最大触发次数（默认 10）
 *   RATE_LIMIT_WINDOW_MS   — 重置窗口时长 ms（默认 300000 = 5min）
 */

import { createLogger } from "../common/logger";

const log = createLogger("P1.rate-limiter");

export class RateLimiter {
  /** userId → 剩余次数 */
  private userCounts = new Map<number, number>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  /** 启动定时重置。P1 初始化时调用。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.reset(), this.windowMs);
    log.info("rateLimiter.started", {
      windowMs: this.windowMs,
      maxRequests: this.maxRequests,
    });
  }

  /**
   * 检查并扣减用户剩余次数。
   * @returns true = 允许继续，false = 次数耗尽
   */
  checkAndDecrement(userId: number): boolean {
    const remaining = this.userCounts.get(userId) ?? this.maxRequests;

    if (remaining <= 0) {
      log.info("rateLimiter.exhausted", { userId, maxRequests: this.maxRequests });
      return false;
    }

    this.userCounts.set(userId, remaining - 1);
    log.debug("rateLimiter.decremented", { userId, remaining: remaining - 1 });
    return true;
  }

  /** 获取用户当前剩余次数（-1 表示未记录，即满额） */
  getRemaining(userId: number): number {
    return this.userCounts.get(userId) ?? this.maxRequests;
  }

  /** 重置所有用户次数（窗口到期时自动调用） */
  reset(): void {
    const count = this.userCounts.size;
    this.userCounts.clear();
    if (count > 0) {
      log.info("rateLimiter.reset", { clearedUsers: count });
    }
  }

  /** 销毁定时器 */
  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.userCounts.clear();
    log.info("rateLimiter.destroyed");
  }
}

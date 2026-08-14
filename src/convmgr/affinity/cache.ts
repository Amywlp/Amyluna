/**
 * 好感度内存缓存 + 状态机。
 *
 * 存储格式：每个 userId 对应一个状态字符串，如 "5+1+1"：
 *   "5"   = 长期好感度
 *   "+1"  = 短期变更（连续追加）
 *
 * 规则：
 * - addDelta(userId, "+1"|"-1")  追加到末尾
 * - 相邻 +1-1 或 -1+1 抵消后移除（循环消到不可消为止）
 * - 连续三个 +1 或三个 -1 合并进长期好感度，触发 DB 写入
 * - 好感度始终在 [1, 10] 截断
 *
 * 用户印象（impressions）：
 * - addImpression(userId, text)  追加中文印象文本（≤10 字）
 * - 上限 MAX_IMPRESSIONS 条，FIFO
 * - 印象变更 → DB 写入
 *
 * 启动时从 AffinityRepository 加载已有记录，未命中用户默认 "5"。
 *
 * 迁移自 v1 affinity/cache.ts，适配 common AffinityRepository。
 */
import { createLogger } from "../../common/logger";
import {
  parseAffinity,
  formatAffinity,
  effectiveAffinity,
  clampAffinity,
  MAX_IMPRESSIONS,
} from "./types";
import { AffinityRepository } from "../../common/db/affinity-repository";
import type { Pool } from "../../common/db/pool";

const log = createLogger("P2.affinity");

/** 默认状态：长期 3（平常/初次见面），无短期变更。 */
const DEFAULT_STATE = "3";

export class AffinityCache {
  /** userId → 状态字符串 */
  private readonly map = new Map<number, string>();
  /** userId → 用户印象文本数组 */
  private readonly impressionMap = new Map<number, string[]>();
  private readonly repo: AffinityRepository;

  constructor(pool: Pool) {
    this.repo = new AffinityRepository(pool);
  }

  /* ------------------------------------------------------------------ */
  /*  初始化                                                             */
  /* ------------------------------------------------------------------ */

  /** 从 DB 加载所有记录到内存。调用一次。 */
  async init(): Promise<void> {
    const rows = await this.repo.getAll();
    for (const row of rows) {
      this.map.set(row.user_id, String(row.long_term_affinity) + (row.short_term_changes ?? ""));
      this.impressionMap.set(row.user_id, row.impressions ?? []);
    }
    log.info("init.done", {
      loaded: rows.length,
      withImpressions: rows.filter((r) => r.impressions.length > 0).length,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  查询                                                               */
  /* ------------------------------------------------------------------ */

  /** 获取用户状态字符串（不存在则返回默认 "5"）。 */
  getState(userId: number): string {
    return this.map.get(userId) ?? DEFAULT_STATE;
  }

  /**
   * 确保用户在缓存和 DB 中已初始化（首次触发时调用）。
   * 已存在则无操作；不存在则设置默认 "5" 并异步写入 DB。
   */
  ensureInitialized(userId: number): void {
    if (this.map.has(userId)) return;
    this.map.set(userId, DEFAULT_STATE);
    this.impressionMap.set(userId, []);
    this.syncToDb(userId).catch((err) => {
      log.warn("ensureInit.dbFail", { userId, error: String(err) });
    });
  }

  /** 获取用户有效好感度数值 1-10。 */
  getEffective(userId: number): number {
    return effectiveAffinity(this.getState(userId));
  }

  /* ------------------------------------------------------------------ */
  /*  用户印象                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * 获取用户印象数组（无则返回空数组）。
   */
  getImpressions(userId: number): string[] {
    return this.impressionMap.get(userId) ?? [];
  }

  /**
   * 添加一条用户印象。
   *
   * - 上限 MAX_IMPRESSIONS 条，超出时 FIFO shift
   * - 异步写入 DB
   *
   * @param userId 用户 ID
   * @param text 印象文本（已截断 ≤10 字）
   */
  addImpression(userId: number, text: string): void {
    if (!text || !text.trim()) return;

    const trimmed = text.trim().slice(0, 10);
    let list = this.impressionMap.get(userId);
    if (!list) {
      list = [];
      this.impressionMap.set(userId, list);
    }

    // FIFO：达到上限时移除最旧的
    while (list.length >= MAX_IMPRESSIONS) {
      list.shift();
    }
    list.push(trimmed);

    log.info("addImpression", { userId, impression: trimmed, total: list.length });

    // 异步写入 DB
    this.syncToDb(userId).catch((err) => {
      log.error("impression.dbWriteFail", { userId, error: String(err) });
    });
  }

  /* ------------------------------------------------------------------ */
  /*  变更 —— 由 LLM 工具调用触发（通过 silent-tools 执行）               */
  /* ------------------------------------------------------------------ */

  /**
   * 对用户好感度执行一次 delta（"+1" 或 "-1"）。
   *
   * 副作用：
   * - 抵消：相邻 +1-1 或 -1+1 循环移除
   * - 合并：连续三个同号并入长期好感度，写入 DB
   *
   * @returns 操作后的有效好感度数值
   */
  addDelta(userId: number, delta: "+1" | "-1", onDbWriteComplete?: () => void): number {
    const prevState = this.getState(userId);
    const nextState = this.applyDelta(prevState, delta);
    this.map.set(userId, nextState);

    const eff = effectiveAffinity(nextState);
    log.info("addDelta", { userId, delta, prevState, nextState, effective: eff });

    // 如果长期好感度发生变化，异步写入 DB
    const prevParsed = parseAffinity(prevState);
    const nextParsed = parseAffinity(nextState);
    if (nextParsed.longTerm !== prevParsed.longTerm) {
      log.info("longTermChanged", { userId, old: prevParsed.longTerm, new: nextParsed.longTerm });
      // 异步写入，不阻塞工具返回
      this.syncToDb(userId)
        .then(() => onDbWriteComplete?.())
        .catch((err) => {
          log.error("dbWrite.fail", { userId, error: String(err) });
          onDbWriteComplete?.(); // 写入已尝试，仍通知完成
        });
    } else {
      // 无 DB 写入需要，直接通知完成
      onDbWriteComplete?.();
    }

    return eff;
  }

  /* ------------------------------------------------------------------ */
  /*  内部：DB 同步                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * 将指定用户的完整状态（好感度 + 印象）写入 DB。
   */
  private async syncToDb(userId: number): Promise<void> {
    const state = this.map.get(userId);
    if (!state) return;

    const parsed = parseAffinity(state);
    const impressions = this.impressionMap.get(userId) ?? [];
    await this.repo.upsert(userId, parsed.longTerm, parsed.shortTerms.join(""), impressions);
  }

  /* ------------------------------------------------------------------ */
  /*  内部状态机                                                         */
  /* ------------------------------------------------------------------ */

  private applyDelta(state: string, delta: "+1" | "-1"): string {
    const { longTerm, shortTerms } = parseAffinity(state);

    // 1. 追加
    shortTerms.push(delta);

    // 2. 抵消 —— 循环移除相邻相反项
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < shortTerms.length - 1; i++) {
        if (
          (shortTerms[i] === "+1" && shortTerms[i + 1] === "-1") ||
          (shortTerms[i] === "-1" && shortTerms[i + 1] === "+1")
        ) {
          shortTerms.splice(i, 2);
          changed = true;
          break; // splice 后重新扫描
        }
      }
    }

    // 3. 合并 —— 连续三个同号
    let lt = longTerm;
    changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < shortTerms.length - 2; i++) {
        if (shortTerms[i] === "+1" && shortTerms[i + 1] === "+1" && shortTerms[i + 2] === "+1") {
          lt = clampAffinity(lt + 1);
          shortTerms.splice(i, 3);
          changed = true;
          break;
        }
        if (shortTerms[i] === "-1" && shortTerms[i + 1] === "-1" && shortTerms[i + 2] === "-1") {
          lt = clampAffinity(lt - 1);
          shortTerms.splice(i, 3);
          changed = true;
          break;
        }
      }
    }

    return formatAffinity(lt, shortTerms);
  }
}

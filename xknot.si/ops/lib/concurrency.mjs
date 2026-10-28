// 有界并发与总预算：中枢每一轮「对所有伙伴做一件事」都要在有限时间内交付。
//
// 两个概念必须分开，混在一起就会在实例变多时突然失效：
//   - 单项超时（fetch-guard 的 timeoutMs）：一次请求最多等多久，决定「这一项算不算失败」；
//   - 总预算（budget）：这一轮最多花多久，决定「这一轮能不能交付」。
// 只有单项超时、且串行拉取时，最坏耗时是 N × 超时；实例一多，整轮会被
// systemd 的 TimeoutStartSec 杀掉，门户停在上一份快照上，日志里只留一行超时。
//
// 两者都由这里统一：并发上限保证同时只有几个请求在途，预算保证剩下的项
// 干脆跳过并记账，而不是拖到进程被杀。

/** 一轮拉取里同时最多几个伙伴。与健康探测同一量级：伙伴数量少，但跨国往返慢。 */
export const FETCH_CONCURRENCY = 4;

/** 一轮拉取的总预算。留足余量给后面的快照校验与落盘（oneshot 上限 3 分钟）。 */
export const FETCH_BUDGET_MS = 90_000;

/** 剩余预算不足以发一次有意义的请求时，宁可跳过，也不发一个注定超时的请求。 */
const MIN_USEFUL_MS = 1_000;

/**
 * 按输入顺序返回结果：同时最多跑 limit 个，结果数组与 items 一一对应。
 * 空数组返回空数组；limit 会被夹到 [1, items.length]。
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  const width = Math.min(Math.max(1, limit), items.length);
  let cursor = 0;
  const workers = Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 一轮处理的时间预算。
 *
 * `ms <= 0` 表示不限（显式关掉，用于本机调试或一次性补数据）。
 * 不是数字的取值直接报错：`--budget-ms abc` 静默变成「不限」比报错危险得多。
 * `now` 可注入，测试里不用等真实的 90 秒。
 */
export function createBudget(ms, { now = Date.now } = {}) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`budgetMs: expected non-negative milliseconds, got ${JSON.stringify(ms)}`);
  }
  const deadline = value > 0 ? now() + value : Infinity;
  const remaining = () => deadline - now();
  return {
    /** 还剩多少毫秒；不限时为 Infinity。 */
    remaining,
    /** 预算已经用完，这一项应当跳过。 */
    expired: () => remaining() <= 0,
    /**
     * 这一项可用的超时：单项超时与剩余预算取小。
     * 返回 null 表示剩余预算已不值得再发请求。
     */
    timeoutFor: (timeoutMs) => {
      const left = remaining();
      if (left < MIN_USEFUL_MS) return null;
      return Math.min(timeoutMs, left);
    },
  };
}

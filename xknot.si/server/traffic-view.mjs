// 控制台看到的入口流量。
//
// 数据源是 ops/traffic.mjs 写下的 var/traffic/{id}.json：每天一条聚合，本来就不含
// IP、原始 UA 与完整 referer。这一层只做「白名单挑字段 + 限量」：聚合产物以后多出
// 来的内部字段不会自动出现在控制台上，天数和 Top 列表也不会随文件无限变长。

import { CRAWLER_KEYS, SEARCH_ENGINE_KEYS } from "../ops/traffic.mjs";

// 与 ops/traffic.mjs 的 DEFAULT_DAYS 对齐：那边保留 30 天，这边最多也读 30 天。
export const MAX_DAYS = 30;
const MAX_TOP = 8;

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function millis(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

// botShare 是聚合端算好的 0–1 比值。坏值当 0，不拿 NaN 去渲染成 "NaN%"。
function ratio(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(1, Math.round(number * 1000) / 1000);
}

function buckets(raw, keys) {
  const out = {};
  for (const key of keys) out[key] = count(raw?.[key]);
  return out;
}

function topOf(rows, key) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && typeof row[key] === "string" && row[key])
    .slice(0, MAX_TOP)
    .map((row) => ({ key: row[key].slice(0, 200), requests: count(row.requests) }));
}

// 固定键的计数 → 有序列表。只留非零项：零值在「爬虫 / 搜索引荐」里不传递信息，
// 但当天一条都没有时仍要给出稳定结构，所以对象形式在 crawlers 里保留全部键。
function rankedOf(raw, keys) {
  return keys
    .map((key) => ({ key, requests: count(raw?.[key]) }))
    .filter((entry) => entry.requests > 0)
    .sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key));
}

// 一天 → 控制台可用的字段。日期不合法的整条丢掉：它没法排序，也没法标在横轴上。
export function normalizeDay(raw) {
  if (!raw || typeof raw !== "object") return null;
  const date = typeof raw.date === "string" ? raw.date : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    date,
    requests: count(raw.requests),
    bytes: count(raw.bytes),
    // 1xx 与 other 也留着：真出现时不该被悄悄抹掉，展示端自己决定要不要展开。
    status: buckets(raw.status, ["1xx", "2xx", "3xx", "4xx", "5xx", "other"]),
    cache: buckets(raw.cache, ["hit", "miss", "bypass", "none"]),
    latency: {
      p50: millis(raw.latency?.p50),
      p95: millis(raw.latency?.p95),
      max: millis(raw.latency?.max),
    },
    upstream: {
      requests: count(raw.upstream?.requests),
      p95: millis(raw.upstream?.p95),
    },
    // 同一天内按 IP+UA 去重，跨天不去重：这是「日访客」的近似值，不是月度独立访客。
    uniqueApprox: count(raw.uniqueApprox),
    botShare: ratio(raw.botShare),
    // 搜索引擎爬虫：从 botShare 里拆出来的抓取侧信号。
    crawlers: buckets(raw.crawlers, CRAWLER_KEYS),
    crawlStatus: buckets(raw.crawlStatus, ["2xx", "3xx", "4xx", "5xx"]),
    crawlPaths: topOf(raw.crawlPaths, "path"),
    // 搜索引荐：谁把访客送进来的，只到引擎这一层，没有查询词。
    searchEngines: rankedOf(raw.searchEngines, SEARCH_ENGINE_KEYS),
    topPaths: topOf(raw.topPaths, "path"),
    topReferers: topOf(raw.topReferers, "host"),
  };
}

// 一份 var/traffic/{id}.json → 接口响应体。没有可用的天时返回 null，
// 由调用方区分「还没采集」与「采集了但内容坏了」，不在这里编一份空数据。
export function summarizeTraffic(doc) {
  if (!doc || !Array.isArray(doc.days)) return null;
  const list = doc.days
    .map(normalizeDay)
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_DAYS);
  if (!list.length) return null;

  return {
    id: typeof doc.id === "string" ? doc.id : "",
    host: typeof doc.host === "string" ? doc.host : "",
    updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : null,
    days: list,
    // 合计只做加总，不重算比率：跨天相加的「独立访客」没有意义，所以不给这个字段。
    totals: {
      days: list.length,
      requests: list.reduce((sum, day) => sum + day.requests, 0),
      bytes: list.reduce((sum, day) => sum + day.bytes, 0),
      from: list[list.length - 1].date,
      to: list[0].date,
    },
  };
}

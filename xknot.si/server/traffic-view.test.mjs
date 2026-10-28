import assert from "node:assert/strict";
import test from "node:test";

import { MAX_DAYS, normalizeDay, summarizeTraffic } from "./traffic-view.mjs";

const day = {
  date: "2026-10-26",
  requests: 11015,
  bytes: 174181337,
  status: { "1xx": 0, "2xx": 5523, "3xx": 5083, "4xx": 299, "5xx": 110, other: 0 },
  methods: { GET: 10781 },
  cache: { hit: 2124, miss: 1944, bypass: 1795, none: 5152 },
  latency: { p50: 147, p95: 1002, max: 160826, samples: 11015 },
  upstream: { requests: 5088, p95: 953, max: 120004 },
  uniqueApprox: 148,
  botShare: 0.1,
  crawlers: { googlebot: 12, bingbot: 0 },
  crawlStatus: { "2xx": 11, "4xx": 1 },
  crawlPaths: [{ path: "/en/instances/", requests: 12 }],
  searchEngines: { google: 9, bing: 3, baidu: 0 },
  topPaths: [{ path: "/api/web/notifications", requests: 2488 }],
  topReferers: [{ host: "wang.xknot.si", requests: 9696 }],
  // 聚合产物里以后可能多出内部字段，控制台不该跟着漏出去。
  internal: "not for the console",
};

test("normalizeDay 只挑可展示的字段，内部字段不外泄", () => {
  const out = normalizeDay(day);
  assert.equal(out.date, "2026-10-26");
  assert.equal(out.requests, 11015);
  assert.equal(out.bytes, 174181337);
  assert.equal(out.status["2xx"], 5523);
  assert.equal(out.cache.hit, 2124);
  assert.equal(out.latency.p95, 1002);
  assert.equal(out.upstream.requests, 5088);
  assert.equal(out.uniqueApprox, 148);
  assert.equal(out.botShare, 0.1);
  // 爬虫保留全部名单键（0 也留着），搜索引荐只留非零并且按次数排。
  assert.equal(out.crawlers.googlebot, 12);
  assert.equal(out.crawlers.baiduspider, 0);
  assert.deepEqual(out.crawlStatus, { "2xx": 11, "3xx": 0, "4xx": 1, "5xx": 0 });
  assert.deepEqual(out.crawlPaths, [{ key: "/en/instances/", requests: 12 }]);
  assert.deepEqual(out.searchEngines, [
    { key: "google", requests: 9 },
    { key: "bing", requests: 3 },
  ]);
  assert.deepEqual(out.topPaths, [{ key: "/api/web/notifications", requests: 2488 }]);
  assert.deepEqual(out.topReferers, [{ key: "wang.xknot.si", requests: 9696 }]);
  assert.equal("internal" in out, false);
  assert.equal("methods" in out, false);
});

test("normalizeDay 把坏日期整条丢掉，坏数值按 0 处理而不是 NaN", () => {
  assert.equal(normalizeDay(null), null);
  assert.equal(normalizeDay({ date: "2026/10/26" }), null);
  assert.equal(normalizeDay({ date: "" }), null);

  const out = normalizeDay({ date: "2026-10-26", requests: "abc", bytes: -1, botShare: "x" });
  assert.equal(out.requests, 0);
  assert.equal(out.bytes, 0);
  assert.equal(out.botShare, 0);
  assert.equal(out.latency.p50, null, "没有样本时不写 0 ms");

  const junk = normalizeDay({ date: "2026-10-26", crawlers: [], crawlPaths: "bad", crawlStatus: 3, searchEngines: "bad" });
  assert.equal(junk.crawlers.googlebot, 0);
  assert.deepEqual(junk.crawlPaths, []);
  assert.deepEqual(junk.searchEngines, []);
  assert.deepEqual(junk.crawlStatus, { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 });
});

test("summarizeTraffic 按日期倒序，只留最近 MAX_DAYS 天，并给出合计", () => {
  const days = Array.from({ length: 45 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 8, 1 + index)).toISOString().slice(0, 10);
    return { date, requests: index + 1, bytes: 10 };
  });
  const view = summarizeTraffic({ id: "wang", host: "wang.xknot.si", updatedAt: "2026-10-26T11:00:00.000Z", days });

  assert.equal(view.days.length, MAX_DAYS);
  assert.equal(view.days[0].date, "2026-10-15", "最新的那一天排在最前");
  assert.equal(view.days.at(-1).date, "2026-09-16");
  assert.equal(view.totals.days, MAX_DAYS);
  assert.equal(view.totals.requests, view.days.reduce((sum, item) => sum + item.requests, 0));
  assert.equal(view.totals.from, "2026-09-16");
  assert.equal(view.totals.to, "2026-10-15");
  // 跨天相加的独立访客没有意义，所以合计里不给这个字段。
  assert.equal("uniqueApprox" in view.totals, false);
});

test("summarizeTraffic 没有可用天时返回 null，不编一份空数据", () => {
  assert.equal(summarizeTraffic(null), null);
  assert.equal(summarizeTraffic({}), null);
  assert.equal(summarizeTraffic({ days: [] }), null);
  assert.equal(summarizeTraffic({ days: [{ date: "bad" }] }), null);
});

test("summarizeTraffic 把 Top 列表截到上限，避免一份文件把面板撑爆", () => {
  const paths = Array.from({ length: 20 }, (_, index) => ({ path: `/p/${index}`, requests: 20 - index }));
  const view = summarizeTraffic({ days: [{ ...day, topPaths: paths }] });
  assert.equal(view.days[0].topPaths.length, 8);
  assert.equal(view.days[0].topPaths[0].key, "/p/0");
});

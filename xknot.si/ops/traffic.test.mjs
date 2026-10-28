import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  accumulate,
  emptyAggregate,
  finalizeAggregate,
  hostMapOf,
  logFiles,
  mergeTraffic,
  parseLine,
  run,
  upstreamMs,
} from "./traffic.mjs";

const line = (overrides = {}) =>
  JSON.stringify({
    at: "2026-10-21T10:00:00+08:00",
    host: "wang.xknot.si",
    status: 200,
    method: "GET",
    uri: "/",
    bytes: 1024,
    requestTime: 0.042,
    upstreamTime: "-",
    cache: "",
    ip: "203.0.113.7",
    ua: "Mozilla/5.0 (Macintosh)",
    ref: "",
    ...overrides,
  });

test("parseLine: 一行 JSON 归一化，坏行返回 null", () => {
  const row = parseLine(line());
  assert.equal(row.host, "wang.xknot.si");
  assert.equal(row.date, "2026-10-21");
  assert.equal(row.bytes, 1024);
  assert.equal(row.requestMs, 42);
  assert.equal(row.upstreamMs, null);

  assert.equal(parseLine("not json"), null);
  assert.equal(parseLine(""), null);
  // 没有 host 或日期不是 ISO 的，一律丢掉。
  assert.equal(parseLine(line({ host: "" })), null);
  assert.equal(parseLine(line({ at: "" })), null);
});

test("upstreamMs: 多次回源取第一个数，'-' 当没有", () => {
  assert.equal(upstreamMs("0.128"), 128);
  assert.equal(upstreamMs("0.1, 0.2"), 100);
  assert.equal(upstreamMs("-"), null);
  assert.equal(upstreamMs(""), null);
  assert.equal(upstreamMs("bad"), null);
});

test("accumulate: 清单外的 host 只计数，不建节点", () => {
  const agg = emptyAggregate();
  const hostToId = hostMapOf({
    instances: [{ id: "wang", url: "https://wang.xknot.si" }],
  });
  assert.ok(accumulate(agg, parseLine(line()), hostToId));
  assert.equal(accumulate(agg, parseLine(line({ host: "evil.xknot.si" })), hostToId), null);
  assert.deepEqual([...agg.unknownHosts.entries()], [["evil.xknot.si", 1]]);
  assert.deepEqual([...agg.byId.keys()], ["wang"]);
});

test("accumulate: 304 的 0 字节仍算一次请求，缓存与状态各自归类", () => {
  const agg = emptyAggregate();
  const hostToId = hostMapOf({ instances: [{ id: "wang", url: "https://wang.xknot.si" }] });
  accumulate(agg, parseLine(line({ status: 304, bytes: 0 })), hostToId);
  accumulate(agg, parseLine(line({ status: 200, cache: "HIT" })), hostToId);
  accumulate(agg, parseLine(line({ status: 500, cache: "MISS" })), hostToId);
  accumulate(agg, parseLine(line({ status: 404, cache: "BYPASS" })), hostToId);

  const [day] = finalizeAggregate(agg).get("wang");
  assert.equal(day.requests, 4);
  assert.equal(day.bytes, 3072);
  assert.deepEqual(day.status, { "1xx": 0, "2xx": 1, "3xx": 1, "4xx": 1, "5xx": 1, other: 0 });
  assert.deepEqual(day.cache, { hit: 1, miss: 1, bypass: 1, none: 1 });
});

test("finalizeBucket: 延迟取 p50/p95/max，爬虫占比与去重是近似值", () => {
  const agg = emptyAggregate();
  const hostToId = hostMapOf({ instances: [{ id: "wang", url: "https://wang.xknot.si" }] });
  for (let i = 0; i < 10; i += 1) {
    accumulate(
      agg,
      parseLine(line({ requestTime: 0.01 * (i + 1), ip: `203.0.113.${i}`, ua: i === 0 ? "Googlebot/2.1" : "Mozilla/5.0" })),
      hostToId
    );
  }
  const [day] = finalizeAggregate(agg).get("wang");
  assert.equal(day.latency.samples, 10);
  assert.equal(day.latency.p50, 50);
  assert.equal(day.latency.p95, 100);
  assert.equal(day.latency.max, 100);
  assert.equal(day.uniqueApprox, 10);
  assert.equal(day.botShare, 0.1);
  // 同一路径重复出现只留一条，按次数排。
  assert.deepEqual(day.topPaths, [{ path: "/", requests: 10 }]);
});

test("爬虫与搜索引荐：按名单拆开，名单外的爬虫仍只计 botShare", () => {
  const agg = emptyAggregate();
  const hostToId = hostMapOf({ instances: [{ id: "wang", url: "https://wang.xknot.si" }] });
  const rows = [
    { ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", uri: "/en/instances/", status: 200 },
    { ua: "Mozilla/5.0 (compatible; Applebot/0.1; +http://www.apple.com/go/applebot)", uri: "/en/", status: 200 },
    { ua: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", uri: "/zh-CN/", status: 404 },
    { ua: "curl/8.4.0", uri: "/robots.txt", status: 200 },
    { ua: "Mozilla/5.0", uri: "/", status: 200, ref: "https://www.google.com/" },
    { ua: "Mozilla/5.0", uri: "/", status: 200, ref: "https://www.google.co.jp/" },
    { ua: "Mozilla/5.0", uri: "/", status: 200, ref: "https://cn.bing.com/" },
    { ua: "Mozilla/5.0", uri: "/", status: 200, ref: "https://www.baidu.com/s?wd=xknot" },
    { ua: "Mozilla/5.0", uri: "/", status: 200, ref: "https://mail.google.com/" },
    { ua: "Mozilla/5.0", uri: "/", status: 200, ref: "https://wang.xknot.si/" },
  ];
  for (const row of rows) accumulate(agg, parseLine(line(row)), hostToId);

  const [day] = finalizeAggregate(agg).get("wang");
  assert.deepEqual(day.crawlers, { googlebot: 1, bingbot: 1, applebot: 1, baiduspider: 0, yandexbot: 0 });
  assert.deepEqual(day.crawlStatus, { "1xx": 0, "2xx": 2, "3xx": 0, "4xx": 1, "5xx": 0, other: 0 });
  assert.deepEqual(
    day.crawlPaths.map((entry) => entry.path).sort(),
    ["/en/", "/en/instances/", "/zh-CN/"]
  );
  // curl 也是爬虫，但不属于搜索爬虫：只进 botShare，不进 crawlers。
  assert.equal(day.botShare, 0.4);
  assert.deepEqual(day.searchEngines, { google: 2, bing: 1, baidu: 1, duckduckgo: 0, yandex: 0, sogou: 0 });
});

test("run: 门户主机按 federation 的 hub 写进 hub.json，与实例分开", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "knot-traffic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const instancesPath = path.join(dir, "instances.json");
  await writeFile(instancesPath, JSON.stringify({ instances: [{ id: "wang", url: "https://wang.xknot.si" }] }));
  const federationPath = path.join(dir, "federation.json");
  await writeFile(federationPath, JSON.stringify({ hub: "xknot.si", members: [] }));

  const logPath = path.join(dir, "knot-access.log");
  await writeFile(
    logPath,
    [
      // 门户的静态目录页被 Googlebot 抓了一次，随后一个真人从 Google 点进来。
      line({
        host: "xknot.si",
        uri: "/en/instances/",
        ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      }),
      line({ host: "xknot.si", uri: "/", ref: "https://www.google.com/" }),
      line({ host: "wang.xknot.si", uri: "/" }),
    ].join("\n") + "\n"
  );

  const outDir = path.join(dir, "traffic");
  const result = await run({
    logPath,
    outDir,
    instancesPath,
    federationPath,
    now: () => new Date("2026-10-21T12:00:00Z"),
  });

  assert.deepEqual(result.unknownHosts, {}, "门户主机已经被认领，不再算清单外");
  const hub = JSON.parse(await readFile(path.join(outDir, "hub.json"), "utf8"));
  assert.equal(hub.id, "hub");
  assert.equal(hub.host, "xknot.si");
  const [day] = hub.days;
  assert.equal(day.requests, 2);
  assert.equal(day.crawlers.googlebot, 1);
  assert.deepEqual(day.crawlPaths, [{ path: "/en/instances/", requests: 1 }]);
  assert.equal(day.searchEngines.google, 1);

  const wang = JSON.parse(await readFile(path.join(outDir, "wang.json"), "utf8"));
  assert.equal(wang.id, "wang");
  assert.equal(wang.days[0].requests, 1, "门户的请求不并进实例");
});

test("mergeTraffic: 本次日志覆盖同一天，日志里没有的旧日期保留，只留最近 N 天", () => {
  const previous = {
    days: [
      { date: "2026-10-18", requests: 5 },
      { date: "2026-10-19", requests: 7 },
    ],
  };
  const next = mergeTraffic(previous, [{ date: "2026-10-19", requests: 99 }], {
    id: "wang",
    host: "wang.xknot.si",
    days: 2,
    now: new Date("2026-10-21T00:00:00Z"),
  });
  assert.deepEqual(
    next.days.map((day) => [day.date, day.requests]),
    [
      ["2026-10-19", 99],
      ["2026-10-18", 5],
    ]
  );
  assert.equal(next.updatedAt, "2026-10-21T00:00:00.000Z");
});

test("run: 读日志写 var/traffic/{id}.json；没有日志时安静跳过", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "knot-traffic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const instancesPath = path.join(dir, "instances.json");
  await writeFile(
    instancesPath,
    JSON.stringify({ instances: [{ id: "wang", url: "https://wang.xknot.si" }] })
  );
  const logPath = path.join(dir, "knot-access.log");
  await writeFile(
    logPath,
    [
      line(),
      line({ uri: "/api/health", bytes: 200, upstreamTime: "0.01" }),
      line({ host: "unknown.xknot.si" }),
      "garbage",
    ].join("\n") + "\n"
  );

  const outDir = path.join(dir, "traffic");
  const result = await run({ logPath, outDir, instancesPath, now: () => new Date("2026-10-21T12:00:00Z") });
  assert.equal(result.written.length, 1);
  assert.equal(result.badLines, 1);
  assert.equal(result.dataDir, dir);
  assert.deepEqual(result.unknownHosts, { "unknown.xknot.si": 1 });

  const saved = JSON.parse(await readFile(path.join(outDir, "wang.json"), "utf8"));
  assert.equal(saved.host, "wang.xknot.si");
  assert.equal(saved.days[0].requests, 2);
  assert.equal(saved.days[0].upstream.requests, 1);

  const skipped = await run({
    logPath: path.join(dir, "missing.log"),
    outDir,
    instancesPath,
  });
  assert.equal(skipped.skipped, "no_log");
});

test("logFiles: 带上最近三天的轮转档，跳过过旧与无关文件", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "knot-traffic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const logPath = path.join(dir, "knot-access.log");
  const older = path.join(dir, "knot-access.log-20261020");
  const gz = path.join(dir, "knot-access.log.1.gz");
  const stale = path.join(dir, "knot-access.log-20250101");
  for (const file of [logPath, older, gz, stale, path.join(dir, "other.log")]) {
    await writeFile(file, "");
  }
  const now = new Date("2026-10-22T02:00:00Z");
  await utimes(older, new Date("2026-10-21T00:00:00Z"), new Date("2026-10-21T00:00:00Z"));
  await utimes(gz, new Date("2026-10-21T12:00:00Z"), new Date("2026-10-21T12:00:00Z"));
  await utimes(stale, new Date("2025-01-02T00:00:00Z"), new Date("2025-01-02T00:00:00Z"));

  const files = await logFiles(logPath, { now });
  assert.deepEqual(files.map((file) => path.basename(file)), [
    "knot-access.log-20261020",
    "knot-access.log.1.gz",
    "knot-access.log",
  ]);
});

test("run: 轮转后的 .gz 归入各自的日期，不丢跨零点的请求", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "knot-traffic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const instancesPath = path.join(dir, "instances.json");
  await writeFile(instancesPath, JSON.stringify({ instances: [{ id: "wang", url: "https://wang.xknot.si" }] }));
  const logPath = path.join(dir, "knot-access.log");
  const rotated = path.join(dir, "knot-access.log-20261021.gz");
  await writeFile(rotated, gzipSync(`${line({ at: "2026-10-21T23:59:00+08:00" })}\n`));
  await writeFile(logPath, `${line({ at: "2026-10-22T00:01:00+08:00" })}\n`);

  const outDir = path.join(dir, "traffic");
  const result = await run({ logPath, outDir, instancesPath, now: () => new Date("2026-10-22T02:00:00Z") });
  assert.equal(result.files, 2);

  const saved = JSON.parse(await readFile(path.join(outDir, "wang.json"), "utf8"));
  assert.deepEqual(
    saved.days.map((day) => [day.date, day.requests]),
    [
      ["2026-10-22", 1],
      ["2026-10-21", 1],
    ]
  );
});

test("run: 日志轮转后，只剩今天的行，旧日期从上次结果里延续", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "knot-traffic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const instancesPath = path.join(dir, "instances.json");
  await writeFile(instancesPath, JSON.stringify({ instances: [{ id: "wang", url: "https://wang.xknot.si" }] }));
  const outDir = path.join(dir, "traffic");
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, "wang.json"),
    JSON.stringify({
      id: "wang",
      host: "wang.xknot.si",
      updatedAt: "2026-10-20T00:00:00.000Z",
      days: [{ date: "2026-10-19", requests: 40 }],
    })
  );

  const logPath = path.join(dir, "knot-access.log");
  await writeFile(logPath, `${line({ at: "2026-10-20T01:00:00+08:00" })}\n`);
  await run({ logPath, outDir, instancesPath, now: () => new Date("2026-10-20T02:00:00Z") });

  const saved = JSON.parse(await readFile(path.join(outDir, "wang.json"), "utf8"));
  assert.deepEqual(
    saved.days.map((day) => day.date),
    ["2026-10-20", "2026-10-19"]
  );
});

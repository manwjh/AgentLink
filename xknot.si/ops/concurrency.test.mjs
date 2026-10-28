// 有界并发与总预算：两个概念混在一起时，实例一多就会突然失效，
// 所以这里把「单项超时」和「整轮预算」分开测。

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createBudget, FETCH_CONCURRENCY, mapWithConcurrency } from "./lib/concurrency.mjs";
import { run as runProfiles } from "./fetch-profile.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("map: results keep the input order even when later items finish first", async () => {
  const items = [40, 5, 20, 1];
  const results = await mapWithConcurrency(items, 4, async (ms, index) => {
    await sleep(ms);
    return { index, ms };
  });
  assert.deepEqual(
    results.map((item) => item.ms),
    items
  );
  assert.deepEqual(
    results.map((item) => item.index),
    [0, 1, 2, 3]
  );
});

test("map: at most limit items are in flight, and the limit is actually used", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 8 }, (_, index) => index);
  const limit = 4;
  await mapWithConcurrency(items, limit, async () => {
    // 计数在第一个 await 之前完成：四个 worker 会先后进入，峰值必然达到 limit。
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await sleep(5);
    inFlight -= 1;
  });
  assert.equal(peak, limit);
});

test("map: an empty list, or a limit wider than the list, still returns in order", async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async (item) => item), []);
  const single = await mapWithConcurrency(["a"], 8, async (item) => item.toUpperCase());
  assert.deepEqual(single, ["A"]);
});

test("budget: unlimited when zero, and a bad value is an error instead of silent unlimited", () => {
  assert.equal(createBudget(0).remaining(), Infinity);
  assert.equal(createBudget(0).timeoutFor(5000), 5000);
  assert.throws(() => createBudget(Number("abc")), /non-negative/);
  assert.throws(() => createBudget(-1), /non-negative/);
});

test("budget: the per-item timeout is capped by what is left of the round", () => {
  let clock = 1_000;
  const budget = createBudget(5_000, { now: () => clock });

  // 富余时单项超时原样使用：这一项该等 5 秒就等 5 秒。
  assert.equal(budget.timeoutFor(5_000), 5_000);
  assert.equal(budget.expired(), false);

  // 只剩 2 秒时，单项最多等 2 秒，不能拖过整轮的截止时间。
  clock += 3_000;
  assert.equal(budget.timeoutFor(5_000), 2_000);

  // 剩余不足一次有意义的请求时，宁可跳过，也不发一个注定的超时。
  clock += 1_500;
  assert.equal(budget.timeoutFor(5_000), null);
  // 「还剩一点」和「已经用完」是两件事：前者不该发请求，后者整轮结束。
  assert.equal(budget.expired(), false);

  clock += 600;
  assert.equal(budget.expired(), true);
});

test("profile fetch: a spent budget skips the item and still returns the whole round", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xknot-budget-"));
  const instancesPath = path.join(dir, "instances.json");
  const instances = ["a1", "b2", "c3"].map((id) => ({
    id,
    url: `https://${id}.example`,
    status: "active",
  }));
  await writeFile(instancesPath, JSON.stringify({ instances }));

  let calls = 0;
  const results = await runProfiles({
    instancesPath,
    outDir: path.join(dir, "profiles"),
    resolve: async () => ["1.2.3.4"],
    // 预算 1ms：每一项都还没发就已经过期。没有请求，但每一项都有交代。
    budgetMs: 1,
    fetchImpl: async () => {
      calls += 1;
      return { status: 500, headers: { get: () => null } };
    },
  });

  assert.equal(calls, 0);
  assert.deepEqual(
    results.map((result) => [result.id, result.status, result.reason]),
    [
      ["a1", "skipped", "budget"],
      ["b2", "skipped", "budget"],
      ["c3", "skipped", "budget"],
    ]
  );
});

test("profile fetch: a slow partner does not serialize the rest of the round", async () => {
  // 串行拉取时，最坏耗时是 N × 超时；实例一多，整轮就被 oneshot 的上限杀掉。
  // 这里只断言并发真的发生了：第一个人占着连接时，第二个已经开始。
  const dir = await mkdtemp(path.join(tmpdir(), "xknot-parallel-"));
  const instancesPath = path.join(dir, "instances.json");
  const instances = Array.from({ length: 6 }, (_, index) => ({
    id: `site${index}`,
    url: `https://site${index}.example`,
    status: "active",
  }));
  await writeFile(instancesPath, JSON.stringify({ instances }));

  let inFlight = 0;
  let peak = 0;
  const results = await runProfiles({
    instancesPath,
    outDir: path.join(dir, "profiles"),
    resolve: async () => ["1.2.3.4"],
    fetchImpl: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight -= 1;
      return { status: 500, headers: { get: () => null } };
    },
  });

  assert.equal(peak, FETCH_CONCURRENCY);
  assert.equal(results.length, instances.length);
  assert.deepEqual(
    results.map((result) => result.id),
    instances.map((instance) => instance.id)
  );
  for (const result of results) assert.equal(result.status, "failed");
});

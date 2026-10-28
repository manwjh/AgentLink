import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_WINDOW_MS, sanitizeCounts, splitNumber, todayView } from "./today.js";

const ENDS = "2026-10-27T16:00:00.000Z"; // 东八区的这一天结束于 UTC 16:00

function counts(over = {}) {
  return sanitizeCounts({
    posts: 128,
    lastPostAt: "2026-10-27T09:00:00.000Z",
    dayEndsAt: ENDS,
    ...over,
  });
}

test("a count without a day boundary is unknown, not zero", () => {
  // 「没有这个数」和「今天 0 条」在界面上是两句话：前者画「—」，后者照实写 0。
  assert.equal(sanitizeCounts(null), null);
  assert.equal(sanitizeCounts({ posts: 3 }), null);
  assert.equal(sanitizeCounts({ dayEndsAt: ENDS }), null);
  assert.equal(sanitizeCounts({ posts: -1, dayEndsAt: ENDS }), null);
  assert.deepEqual(todayView(null, Date.parse("2026-10-27T09:00:00.000Z")), {
    known: false,
    posts: 0,
    live: false,
  });
});

test("a complete count keeps its numbers", () => {
  assert.deepEqual(counts(), {
    posts: 128,
    lastPostAt: "2026-10-27T09:00:00.000Z",
    dayEndsAt: ENDS,
  });
  assert.deepEqual(todayView(counts(), Date.parse("2026-10-27T09:10:00.000Z")), {
    known: true,
    posts: 128,
    live: true,
  });
});

test("the line carries the post count only", () => {
  // 顶栏只说一件事：今天发了多少条。别的量（读者数、阅读量）不进这一行。
  const view = todayView(counts({ authors: 32 }), Date.parse("2026-10-27T09:10:00.000Z"));
  assert.deepEqual(Object.keys(view).sort(), ["known", "live", "posts"]);
});

test("past the day boundary the line starts from zero on its own", () => {
  // 没有新快照也要翻页：昨天的一百多条不能挂到今天早上。
  const view = todayView(counts(), Date.parse("2026-10-27T16:00:00.000Z"));
  assert.deepEqual(view, { known: true, posts: 0, live: false });
});

test("the pulse only says live while something came in recently", () => {
  const at = Date.parse("2026-10-27T09:30:00.000Z");
  assert.equal(todayView(counts(), at).live, false, "半小时前的最后一条不该还在闪");
  assert.equal(todayView(counts({ lastPostAt: null }), at).live, false);
  assert.equal(todayView(counts({ lastPostAt: "2026-10-27T10:00:00.000Z" }), at).live, false, "服务端时钟更快时不算「刚刚」");
  const edge = Date.parse("2026-10-27T09:00:00.000Z") + LIVE_WINDOW_MS;
  assert.equal(todayView(counts(), edge).live, true);
  assert.equal(todayView(counts(), edge + 1).live, false);
});

test("the number is cut out of the sentence wherever the language puts it", () => {
  // 「今日 ␀ 条」与「␀ posts today」都只给数字那一段加粗，语序交给译文自己。
  assert.deepEqual(splitNumber("今日 \u0000 条"), { before: "今日 ", after: " 条" });
  assert.deepEqual(splitNumber("\u0000 posts today"), { before: "", after: " posts today" });
  // 译文没带占位符时整句原样画，不加粗也不错位。
  assert.deepEqual(splitNumber("今日 — 条"), { before: "今日 — 条", after: "" });
  assert.deepEqual(splitNumber(""), { before: "", after: "" });
});

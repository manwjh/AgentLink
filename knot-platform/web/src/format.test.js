import assert from "node:assert/strict";
import test from "node:test";
import { compactCount, listText } from "./format.js";

test("the list separator follows the locale", () => {
  // 中文用顿号，英文用逗号加空格；不出现「和 / and」这种连接词。
  assert.equal(listText(["A", "B", "C"], "zh-CN"), "A、B、C");
  assert.equal(listText(["A", "B", "C"], "en"), "A, B, C");
  assert.equal(listText(["A"], "en"), "A");
});

test("an empty or missing list has no text", () => {
  assert.equal(listText([], "zh-CN"), "");
  assert.equal(listText(null, "zh-CN"), "");
  assert.equal(listText(["", "  "], "zh-CN"), "");
});

test("a count in the header stays short from four digits up", () => {
  // 顶栏那一行只有十来个字符的位置：一千以内在各语种都照原样写。
  assert.equal(compactCount(0, "zh-CN"), "0");
  assert.equal(compactCount(128, "zh-CN"), "128");
  assert.equal(compactCount(999, "en"), "999");
  // 四位数起换紧凑写法，单位交给 Intl：中文是「万」，英文是 K。
  assert.equal(compactCount(1286, "zh-CN"), "1286");
  assert.equal(compactCount(12860, "zh-CN"), "1.3万");
  assert.equal(compactCount(1286, "en"), "1.3K");
  assert.equal(compactCount(12860, "en"), "12.9K");
  // 坏值不能画成 NaN，也不能画成负数。
  assert.equal(compactCount(undefined, "en"), "0");
  assert.equal(compactCount(-4, "en"), "0");
});

// 入口 conf 的逐字节回归。
//
// provision.test.mjs 里的 render 测试断言的是片段（「该有的在」）；这里断言整份
// 产物（「除了这些，没有别的」）。两者的分工是刻意的：
//   - 片段测试说明每一条规则为什么存在，读的人能看懂意图；
//   - golden 说明整份文件此刻长什么样，任何改动都必须在 diff 里被看见。
//
// 入口 conf 是这套系统里唯一「生成在远端、靠一次 nginx -t 兜底、很难回滚」的产物。
// 在这个测试之前，「这份配置变了」是无法在 review 里察觉的。
//
// 有意改动渲染结果时：node server/fixtures/render-golden.mjs --write，
// 然后把生成出来的 diff 与代码改动一起提交。

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES, goldenPath } from "./fixtures/render-golden.mjs";

/** 逐行 diff，只打印第一处差异起的上下文；整份贴出来反而看不清。 */
function unifiedDiff(expected, actual, context = 3) {
  const left = expected.split("\n");
  const right = actual.split("\n");
  let head = 0;
  while (head < left.length && head < right.length && left[head] === right[head]) head += 1;
  let tailLeft = left.length - 1;
  let tailRight = right.length - 1;
  while (tailLeft >= head && tailRight >= head && left[tailLeft] === right[tailRight]) {
    tailLeft -= 1;
    tailRight -= 1;
  }
  const from = Math.max(0, head - context);
  const lines = [`expected ${left.length} lines, got ${right.length} lines; first difference at line ${head + 1}`];
  for (let index = from; index <= Math.min(tailLeft, left.length - 1); index += 1) {
    const marker = index < head ? " " : "-";
    lines.push(`${marker} ${left[index] ?? ""}`);
  }
  for (let index = from; index <= Math.min(tailRight, right.length - 1); index += 1) {
    const marker = index < head ? " " : "+";
    lines.push(`${marker} ${right[index] ?? ""}`);
  }
  return lines.join("\n");
}

for (const testCase of CASES) {
  test(`golden: ${testCase.file} matches the committed rendering`, async () => {
    const expected = await readFile(goldenPath(testCase.file), "utf8");
    const actual = testCase.render();
    // 用 assert.ok 而不是 assert.equal：后者会再贴一遍两个整串的差异（每份 conf 十几 KB），
    // 把下面这份按行的 diff 埋掉。失败信息只留一处，读的人才知道先看哪里。
    assert.ok(
      actual === expected,
      // 断言消息带上 diff：失败时不用再手工跑一遍生成脚本去比对。
      `rendering changed; inspect the diff, then run \`node server/fixtures/render-golden.mjs --write\` to accept\n${unifiedDiff(expected, actual)}`
    );
  });
}

test("golden: every case writes through one entry, so a new file cannot be forgotten", async () => {
  // 新增一份产物就要在 CASES 里登记，否则它既没有期望文件也不会被比对。
  const files = CASES.map((testCase) => testCase.file);
  assert.equal(new Set(files).size, files.length, "duplicate fixture file name");
  for (const file of files) {
    const text = await readFile(goldenPath(file), "utf8");
    assert.ok(text.length > 0, `${file} is empty`);
  }
});

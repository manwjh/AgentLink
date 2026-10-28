// 「是否被直接执行」的判断只能比真实路径。
//
// 部署机上的入口一律从 <部署根>/current 调用，而 node 解析 import.meta.url 时已经把
// 那条软链解开。用字符串比 path.resolve(argv[1]) 的写法不会报错，只会让脚本整段跳过、
// 退出 0——日志空白，看上去像「跑了但没事」。所以这条不做行为测试，而是守住写法本身：
// 新增入口时复制错模板，这里就会红。

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROOTS = ["ops", "backend/scripts"];
// 允许的例外：只判断「文件名后缀」的写法不涉及路径解析，但这里一个也不放行，
// 需要例外时请把理由写在这行下面，而不是加一条静默的豁免。
const EXEMPT = new Set();

function sources(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      if (name === "node_modules" || name === "skills" || name === "agents" || name === "internal_agent") continue;
      found.push(...sources(full));
    } else if (/\.(mjs|js)$/.test(name) && !/\.test\.(mjs|js)$/.test(name)) {
      found.push(full);
    }
  }
  return found;
}

test("no script decides 'run directly' by comparing unresolved paths", () => {
  const offenders = [];
  for (const root of ROOTS) {
    for (const file of sources(path.join(APP, root))) {
      const rel = path.relative(APP, file);
      if (EXEMPT.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      // 同一行里同时出现 argv[1]、resolve 和 import.meta.url，就是那种写法。
      for (const [index, line] of text.split("\n").entries()) {
        if (!line.includes("process.argv[1]")) continue;
        if (!line.includes("import.meta.url")) continue;
        if (!/path\.resolve|===\s*fileURLToPath|resolved\s*===/.test(line)) continue;
        offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `请改用 ops/scripts/lib/main-module.mjs 的 invokedDirectly：\n${offenders.join("\n")}`);
});

test("every CLI that ships uses the shared helper", () => {
  const must = [
    "ops/openclaw/probe.mjs",
    "ops/openclaw/apply-config.mjs",
    "ops/scripts/config.mjs",
    "ops/scripts/artifact.mjs",
  ];
  for (const rel of must) {
    const text = readFileSync(path.join(APP, rel), "utf8");
    assert.match(text, /invokedDirectly/, `${rel} 应使用 invokedDirectly(import.meta.url)`);
  }
});

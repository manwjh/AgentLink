// 领域模块的接线：写好的方法必须真的挂到 store 上。
//
// 把 store.mjs 拆成 server/store/ 之后，唯一新增的失败方式是「某个领域写了、
// 但 openStore 忘了拼进去」。它不会报错、不会崩溃：只是某个方法不存在，
// 调用方要到真正走到那条路径时才发现——而这正是测试最难覆盖到的地方。
//
// 所以这里不验业务，只验接线：每个 create*Store 返回的方法都必须在最终对象上，
// 反过来最终对象上也不该有来路不明的方法（那说明有两份实现抢同一个名字）。

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";

import { openMemoryStore } from "./store.mjs";

const DIR = new URL("./store/", import.meta.url);

// 不参与拼接的模块：一个只放纯工具，一个只放库结构与迁移。
const NOT_A_DOMAIN = new Set(["util.mjs", "identity.mjs", "schema.mjs"]);

async function domainFactories() {
  const files = readdirSync(DIR).filter((name) => name.endsWith(".mjs") && !NOT_A_DOMAIN.has(name));
  const out = [];
  for (const file of files) {
    const module = await import(new URL(file, DIR).href);
    const creators = Object.keys(module).filter((name) => name.startsWith("create"));
    assert.equal(creators.length, 1, `${file} should export exactly one create*Store, found: ${creators.join(", ") || "none"}`);
    out.push({ file, create: module[creators[0]] });
  }
  return out;
}

test("wiring: every domain module's methods are on the store", async () => {
  const store = openMemoryStore();
  const ctx = {
    db: store.db,
    get: (sql, ...params) => store.db.prepare(sql).get(...params),
    all: (sql, ...params) => store.db.prepare(sql).all(...params),
    event: () => {},
  };

  const contributed = new Set();
  for (const { file, create } of await domainFactories()) {
    const methods = Object.keys(create(ctx));
    assert.ok(methods.length > 0, `${file} contributes no methods`);
    for (const name of methods) {
      assert.equal(typeof store[name], "function", `${file}.${name} is missing from the store`);
      // 两份实现抢同一个名字时，Object.assign 让后拼的那份静默胜出。
      // 拆分之后这种事完全可以发生，且只有「另一份再也没被调用过」这一个症状。
      assert.equal(contributed.has(name), false, `${name} is contributed by two domain modules`);
      contributed.add(name);
    }
  }

  store.close();
});

test("wiring: the store exposes nothing outside the assembled domains", async () => {
  const store = openMemoryStore();
  const ctx = {
    db: store.db,
    get: (sql, ...params) => store.db.prepare(sql).get(...params),
    all: (sql, ...params) => store.db.prepare(sql).all(...params),
    event: () => {},
  };

  const expected = new Set(["file", "db", "close"]);
  for (const { create } of await domainFactories()) {
    for (const name of Object.keys(create(ctx))) expected.add(name);
  }

  // 多出来的方法一定是有人在 store.mjs 里手写了一个：那会绕开领域模块的组织，
  // 也会让「这个能力归哪个领域」重新变得说不清。
  const extra = Object.keys(store).filter((name) => !expected.has(name));
  assert.deepEqual(extra, []);

  store.close();
});

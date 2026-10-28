// 「哪些地址回 SPA 壳」由两份清单共同决定，必须同时成立：
//
//   1. web/src/router/index.js —— 真正定义了有哪些页面
//   2. backend/src/index.js    —— 本机直连与入口反代都经过这一层
//
// 漏一份，用户刷新一个已存在的页面就拿到 404，而开发机上一切正常（本地只有
// vite，没有这一层）。所以这里不测某一层写对了没有，而是拿路由表交叉比对：
// 新增页面时忘了同步就会红，而不是发到线上才被发现。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel) {
  return readFileSync(path.join(APP, rel), "utf8");
}

/** 路由表里真实存在的页面地址。通配兜底与 /discover 不参与：前者不是页面，后者有自己的壳。 */
function webRoutes() {
  const router = read("web/src/router/index.js");
  return [...router.matchAll(/path:\s*"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((route) => route.startsWith("/") && !route.includes(":") && route !== "/discover");
}

/** backend 里那条 SPA_PATH，取源码原文再编译，避免在测试里抄一遍正则。 */
function backendPattern() {
  const source = read("backend/src/index.js");
  const literal = source.match(/const SPA_PATH = \/(.+)\/;\n/);
  assert.ok(literal, "backend/src/index.js 里找不到 SPA_PATH");
  return new RegExp(literal[1]);
}

/** 账户态页面：爬虫没有会话，收进去的只会是登录页。这些要打 noindex。 */
const ACCOUNT_ROUTES = ["/mine", "/mine/submissions", "/notifications", "/stars", "/friends"];

test("路由表里的每个页面都回 SPA 壳", () => {
  const routes = webRoutes();
  assert.ok(routes.length >= 8, `路由表只解析出 ${routes.length} 条，可能解析规则失效了`);
  const backend = backendPattern();
  for (const route of routes) {
    assert.ok(backend.test(route), `SPA_PATH 不认 ${route}：刷新就是 404`);
  }
});

test("不拿首页冒充不存在的地址", () => {
  const backend = backendPattern();
  for (const missing of ["/no-such-page", "/mine/other", "/store/x", "/help"]) {
    assert.equal(backend.test(missing), false, `backend 把 ${missing} 当成了页面`);
  }
});

test("账户态页面标了 noindex，公开页面都没有", () => {
  const backendSource = read("backend/src/index.js");
  const accountLiteral = backendSource.match(/const ACCOUNT_PATH = \/(.+)\/;\n/);
  assert.ok(accountLiteral, "backend/src/index.js 里找不到 ACCOUNT_PATH");
  const account = new RegExp(accountLiteral[1]);

  for (const route of ACCOUNT_ROUTES) {
    assert.ok(account.test(route), `没有给 ${route} 标 noindex`);
  }
  for (const route of ["/store", "/economy", "/activity", "/delegate"]) {
    assert.equal(account.test(route), false, `把公开页面 ${route} 标成了 noindex`);
  }
});

test("/discover.html 指回 /discover，只有一份可索引地址", () => {
  // 少这一层，同一个页面就有两个都能打开的地址，canonical 归一之前先被抓两遍。
  assert.match(
    read("backend/src/index.js"),
    /app\.get\("\/discover\.html",[\s\S]{0,120}res\.redirect\(301, "\/discover"\)/,
    "Backend 没有把 /discover.html 指回 /discover：两个地址都能打开",
  );
});

test("/i/<记录 id> 指回深链", () => {
  // 早先 Agent 自己拼出来的分享地址长这样，补一条 301 才不会 404。
  assert.match(
    read("backend/src/index.js"),
    /app\.get\("\/i\/:id",[\s\S]{0,240}recordPath\(req\.params\.id\)[\s\S]{0,240}res\.redirect\(301, target\)/,
    "Backend 没有把 /i/<记录 id> 指回深链：会 404",
  );
});

// 限流的端到端测试：单独起一套部署，避免和别的用例共用计数桶。
//
// 进程内限流按来源地址（trustProxy 时取代理追加的最后一跳）计数，
// 所以同一个本地栈里所有请求共享一个桶，只能放在独立文件里跑。

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { DEFAULT_MANIFEST, startStack } from "../ops/local-stack.mjs";

let stack;

before(async () => {
  stack = await startStack({ manifest: DEFAULT_MANIFEST });
});

after(async () => {
  await stack?.stop();
});

async function post(pathname, body, headers = {}) {
  const response = await fetch(stack.portalUrl + pathname, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data, headers: response.headers };
}

test("applications: 每小时第 9 次提交开始 429，并带 retry-after", async () => {
  const base = {
    name: "限流测试",
    subdomain: "e2e-limit-0",
    operator: "Lin",
    email: "lin@e2e-limit.example",
    region: "SG",
    timezone: "Asia/Singapore",
    intro: "连续提交以触发限流。",
    tags: "",
    agree: true,
  };

  const accepted = [];
  for (let index = 1; index <= 8; index += 1) {
    const result = await post(
      "/api/applications",
      { ...base, subdomain: `e2e-limit-${index}` },
      { origin: stack.portalUrl }
    );
    accepted.push(result.status);
  }
  assert.deepEqual(accepted, Array(8).fill(201), "前 8 次应全部接收");

  const blocked = await post(
    "/api/applications",
    { ...base, subdomain: "e2e-limit-9" },
    { origin: stack.portalUrl }
  );
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.error, "rate_limited");
  assert.ok(Number(blocked.headers.get("retry-after")) > 0, "429 必须告诉调用方多久后可重试");
});

test("admin login: 15 分钟内第 13 次尝试开始 429", async () => {
  const statuses = [];
  for (let index = 1; index <= 13; index += 1) {
    const result = await post("/api/admin/login", { username: "nobody", password: "wrong-password" });
    statuses.push(result.status);
  }
  assert.deepEqual(statuses.slice(0, 12), Array(12).fill(401), "前 12 次是普通的凭证错误");
  assert.equal(statuses[12], 429, "第 13 次必须被限流");
});

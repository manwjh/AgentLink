import assert from "node:assert/strict";
import test from "node:test";

import { applicationPayload, checkSubdomain, hubOriginOf, missingFields, submitApplication } from "./xknotJoin.js";

const SITE = {
  name: "北港",
  tagline: "北海沿岸的慢阅读与长文笔记。",
  intro: "一段更长的介绍。",
  owner: "Lin",
  contact: "lin@example.com",
  region: "no",
  timezone: "Europe/Oslo",
  tags: ["长文", "设计"],
};

function reply(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

test("hubOriginOf：接入件优先，其次是联调覆盖，最后是联邦入口", () => {
  assert.equal(hubOriginOf({ status: { running: { hubOrigin: "https://hub.example" } } }), "https://hub.example");
  assert.equal(hubOriginOf({ hubOrigin: "http://127.0.0.1:5180/" }), "http://127.0.0.1:5180");
  const previous = process.env.KNOT_HUB_ORIGIN;
  process.env.KNOT_HUB_ORIGIN = "http://127.0.0.1:5180";
  try {
    assert.equal(hubOriginOf({}), "http://127.0.0.1:5180");
  } finally {
    if (previous == null) delete process.env.KNOT_HUB_ORIGIN;
    else process.env.KNOT_HUB_ORIGIN = previous;
  }
  assert.equal(hubOriginOf({}), "https://xknot.si");
});

test("applicationPayload：字段名对一次，长度按中枢上限截断", () => {
  const payload = applicationPayload(SITE, { subdomain: "nordhavn", email: "hi@example.com" });
  assert.equal("mode" in payload, false, "接入形态不由客户端声明");
  assert.equal(payload.operator, "Lin");
  assert.equal(payload.email, "hi@example.com");
  assert.equal(payload.region, "NO");
  assert.equal(payload.intro, SITE.tagline);
  assert.deepEqual(payload.tags, ["长文", "设计"], "标签按数组交，空格不被拆开");
  assert.equal(payload.agree, true);

  assert.equal(applicationPayload({ ...SITE, region: "中国" }).region, "GLOBAL");
  assert.equal([...applicationPayload({ ...SITE, tagline: "字".repeat(80) }).intro].length, 60);
  assert.equal(applicationPayload({ region: "CN" }).timezone, "UTC");
});

test("missingFields：名称、主理人、介绍、可用的邮箱", () => {
  assert.deepEqual(missingFields(applicationPayload(SITE)), []);
  const payload = applicationPayload({ name: "", owner: "", contact: "https://example.com", tagline: "" });
  assert.deepEqual(missingFields(payload), ["name", "operator", "email", "intro"]);
  // 超长邮箱不先截断：截出来的前缀可能仍像合法地址，交上去的联系方式就错了。
  const long = applicationPayload(SITE, { email: "a".repeat(120) + "@example.com" });
  assert.deepEqual(missingFields(long), ["email"]);
  assert.equal([...long.email].length, 132, "原样交出去，由 missingFields 报错");
});

test("checkSubdomain：结论原样转回，不自己判", async () => {
  const ok = await checkSubdomain({
    label: "hello-world",
    hubOrigin: "https://hub.example",
    fetchImpl: async (url) => {
      assert.equal(url, "https://hub.example/api/subdomains/check?label=hello-world");
      return reply(200, { label: "hello-world", available: true, reason: "ok", min: 6, suggestions: [] });
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.result.available, true);

  const limited = await checkSubdomain({
    label: "x",
    hubOrigin: "https://hub.example",
    fetchImpl: async () => reply(429, { error: "rate_limited" }),
  });
  assert.equal(limited.error, "hub_rate_limited");

  const offline = await checkSubdomain({
    label: "hello",
    hubOrigin: "https://hub.example",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(offline.error, "hub_unreachable");

  const timeout = await checkSubdomain({
    label: "hello",
    hubOrigin: "https://hub.example",
    fetchImpl: async () => {
      const error = new Error("timeout");
      error.name = "TimeoutError";
      throw error;
    },
  });
  assert.equal(timeout.error, "hub_timeout");
});

test("submitApplication：本地缺项不发出请求，中枢的拒绝原样带回", async () => {
  let called = 0;
  const incomplete = await submitApplication({
    site: { name: "" },
    subdomain: "nordhavn",
    fetchImpl: async () => {
      called += 1;
      return reply(201, {});
    },
  });
  assert.equal(incomplete.error, "incomplete");
  assert.equal(called, 0);

  const created = await submitApplication({
    site: SITE,
    subdomain: "nordhavn",
    hubOrigin: "https://hub.example",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://hub.example/api/applications");
      const body = JSON.parse(init.body);
      assert.equal(body.subdomain, "nordhavn");
      assert.equal("mode" in body, false);
      return reply(201, { application: { id: "XK-1", caseUrl: "https://hub.example/case/k" } });
    },
  });
  assert.equal(created.ok, true);
  assert.equal(created.application.id, "XK-1");

  const invalid = await submitApplication({
    site: SITE,
    subdomain: "nordhavn",
    hubOrigin: "https://hub.example",
    fetchImpl: async () => reply(400, { error: "invalid", fields: { subdomain: "taken" } }),
  });
  assert.equal(invalid.error, "invalid");
  assert.equal(invalid.fields.subdomain, "taken");

  const duplicate = await submitApplication({
    site: SITE,
    subdomain: "nordhavn",
    hubOrigin: "https://hub.example",
    fetchImpl: async () => reply(409, { error: "duplicate" }),
  });
  assert.equal(duplicate.error, "duplicate");
});

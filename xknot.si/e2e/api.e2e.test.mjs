// 接口与静态站的端到端测试：全部走真实 HTTP，不 import createApp。
//
// 被测的是一套本地部署：server/index.mjs + ops/local-hub.mjs（复刻 nginx），
// 数据目录与清单都是临时生成的，不碰仓库里的 instances.json 和 var/xknot.db。
//
// 跑法：npm run test:e2e

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

import { DEFAULT_MANIFEST, DEFAULT_ROSTER, startStack } from "../ops/local-stack.mjs";
import { checkManifestEntry } from "../server/manifest.mjs";
import { validateRoster } from "../ops/validate-federation.mjs";

const PASSWORD = "e2e-correct-horse-battery";
const ADMIN = "e2e-admin";

const VALID = {
  name: "北港端到端",
  subdomain: "e2e-apply",
  operator: "Lin",
  email: "lin@e2e-apply.example",
  region: "NO",
  timezone: "Europe/Oslo",
  intro: "端到端测试提交的申请。",
  tags: "长文, 测试",
  agree: true,
  locale: "zh-CN",
};

let stack;
let portal;

before(async () => {
  stack = await startStack({ manifest: DEFAULT_MANIFEST, roster: DEFAULT_ROSTER });
  portal = stack.portalUrl;
  await stack.createAdmin(ADMIN, PASSWORD);
});

after(async () => {
  await stack?.stop();
});

async function call(pathname, { method = "GET", body, cookie, headers = {}, redirect = "follow" } = {}) {
  const merged = { accept: "application/json", ...headers };
  if (body !== undefined) merged["content-type"] = "application/json";
  if (cookie) merged.cookie = cookie;
  const response = await fetch(portal + pathname, {
    method,
    headers: merged,
    redirect,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data, headers: response.headers, text };
}

async function login() {
  const result = await call("/api/admin/login", {
    method: "POST",
    body: { username: ADMIN, password: PASSWORD },
  });
  assert.equal(result.status, 200);
  const cookie = (result.headers.getSetCookie?.() || [])[0]?.split(";")[0];
  assert.ok(cookie, "login must set a cookie");
  return { cookie, result };
}

// ---- 静态站 ----

test("static: 根路径 302 到 /en/", async () => {
  const result = await call("/", { redirect: "manual" });
  assert.equal(result.status, 302);
  assert.equal(result.headers.get("location"), "/en/");
});

test("static: 三个语种入口都能打开，lang 与 hreflang 对得上", async () => {
  for (const [locale, marker] of [
    ["en", 'lang="en"'],
    ["zh-CN", 'lang="zh-CN"'],
    ["zh-TW", 'lang="zh-TW"'],
  ]) {
    const result = await call(`/${locale}/`);
    assert.equal(result.status, 200, locale);
    assert.match(result.headers.get("content-type") || "", /text\/html/);
    assert.ok(result.text.includes(marker), `${locale} should declare ${marker}`);
    assert.ok(result.text.includes('hreflang="zh-CN"'), `${locale} should link all locales`);
  }
});

test("static: HTML 带齐 nginx 那组安全头", async () => {
  const result = await call("/en/");
  assert.match(result.headers.get("content-security-policy") || "", /default-src 'self'/);
  assert.equal(result.headers.get("x-frame-options"), "DENY");
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.equal(result.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(result.headers.get("strict-transport-security") || "", /max-age=\d+/);
});

test("static: 带哈希的 assets 长缓存，HTML 每次回源", async () => {
  const html = await call("/en/");
  const match = /\/assets\/[^"']+\.(?:js|css)/.exec(html.text);
  assert.ok(match, "entry HTML should reference a hashed asset");
  const asset = await call(match[0]);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("cache-control") || "", /max-age=31536000/);
  assert.match(html.headers.get("cache-control") || "", /no-cache/);
});

test("data: hub.json 只含清单里的实例，缺数据不写 0", async () => {
  const result = await call("/data/hub.json");
  assert.equal(result.status, 200);
  assert.match(result.headers.get("cache-control") || "", /no-cache/);
  const ids = result.data.instances.map((item) => item.id);
  assert.deepEqual(ids, DEFAULT_MANIFEST.instances.map((item) => item.id));
  for (const instance of result.data.instances) {
    assert.equal(instance.health, null, "没有探测结果时 health 是 null");
    assert.deepEqual(instance.cards, [], "没有橱窗时不编造卡片");
    assert.equal(instance.stats, null, "没有活动数据时是 null，不是 0");
  }
});

test("api: probes 读巡检写下的状态，门户据此覆盖快照", async () => {
  // 巡检不在端到端里跑，直接写一份它产出的文件；接口按 mtime 重读，不必重启。
  const checkedAt = "2026-10-23T11:02:04.844Z";
  await writeFile(
    path.join(stack.dataDir, "data", "health.json"),
    `${JSON.stringify(
      {
        checkedAt,
        instances: {
          "e2e-node": {
            status: "degraded",
            latencyMs: 2410,
            version: "0.6.0",
            lastOkAt: checkedAt,
            downSince: null,
            checks: 9,
            ok: 8,
            error: null,
            notified: { down_24h: "2026-10-22T00:00:00.000Z" },
            hiddenAt: null,
          },
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = await call("/api/probes");
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(result.data.checkedAt, checkedAt);
  assert.deepEqual(result.data.probes["e2e-node"], {
    status: "degraded",
    latencyMs: 2410,
    version: "0.6.0",
    lastOkAt: checkedAt,
    downSince: null,
    hidden: false,
  });
  // 运营字段不上公网。
  assert.equal("notified" in result.data.probes["e2e-node"], false);
});

test("static: 未知路径与路径穿越都是 404", async () => {
  assert.equal((await call("/no-such-page")).status, 404);
  assert.equal((await call("/%2e%2e/server/index.mjs")).status, 404);
  assert.equal((await call("/../package.json")).status, 404);
});

// ---- 接口 ----

test("api: /api/health 返回文档里的形状", async () => {
  const result = await call("/api/health");
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.service, "xknot-hub");
  assert.equal(typeof result.data.version, "string");
  assert.match(result.data.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.headers.get("cache-control"), "no-store");
});

// ---- 控制台 ----

test("admin: /admin 301 到 /admin/，静态文件有独立 CSP", async () => {
  const redirect = await call("/admin", { redirect: "manual" });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get("location"), "/admin/");

  const console_ = await call("/admin/");
  assert.equal(console_.status, 200);
  assert.match(console_.headers.get("content-security-policy") || "", /default-src 'none'/);
  assert.equal(console_.headers.get("x-frame-options"), "DENY");
  assert.equal(console_.headers.get("x-robots-tag"), "noindex, nofollow");

  assert.equal((await call("/admin/admin.js")).status, 200);
  // 只服务白名单文件，不能借 /admin 读服务器上的任意文件。
  assert.equal((await call("/admin/../package.json")).status, 404);
  assert.equal((await call("/admin/nope.txt")).status, 404);
});

test("admin: 未登录一律 401", async () => {
  assert.equal((await call("/api/admin/applications")).status, 401);
  assert.equal((await call("/api/admin/session")).status, 401);
  const forged = await call("/api/admin/applications", { cookie: "xknot_admin=forged-token" });
  assert.equal(forged.status, 401);
});

test("admin: 错密码 401，登录后 Cookie 带 HttpOnly / SameSite=Strict", async () => {
  const wrong = await call("/api/admin/login", {
    method: "POST",
    body: { username: ADMIN, password: "wrong-password" },
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.error, "bad_credentials");

  const { result } = await login();
  const raw = (result.headers.getSetCookie?.() || [])[0] || "";
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Strict/i);
  assert.match(raw, /Path=\//i);
});

// ---- 申请 → 审核 → 清单 ----

test("applications: 空表单逐字段报错", async () => {
  const result = await call("/api/applications", {
    method: "POST",
    body: { name: "", subdomain: "nope nope", email: "lin@", agree: false },
  });
  assert.equal(result.status, 400);
  assert.equal(result.data.error, "invalid");
  assert.equal(result.data.fields.subdomain, "format");
  assert.equal(result.data.fields.email, "invalid_email");
  assert.equal(result.data.fields.agree, "required");
});

test("applications: 蜜罐填了回成功但不落库", async () => {
  const { cookie } = await login();
  const before = await call("/api/admin/applications?status=all", { cookie });
  const result = await call("/api/applications", {
    method: "POST",
    body: { ...VALID, subdomain: "e2e-bot", website: "http://spam.example" },
  });
  assert.equal(result.status, 201);
  assert.equal(result.data.application.id, "XK-DISCARDED");
  const afterCount = await call("/api/admin/applications?status=all", { cookie });
  assert.equal(afterCount.data.applications.length, before.data.applications.length);
});

test("applications: 正常提交 201，同一子域再提 409", async () => {
  const headers = { origin: portal };
  const first = await call("/api/applications", { method: "POST", body: VALID, headers });
  assert.equal(first.status, 201);
  assert.match(first.data.application.id, /^XK-\d{4}-[0-9A-Z]{6}$/);
  assert.equal(first.data.application.status, "approved");
  assert.match(first.data.application.caseUrl, /\/case\//);

  const again = await call("/api/applications", {
    method: "POST",
    body: { ...VALID, name: "另一个名字" },
    headers,
  });
  assert.equal(again.status, 409);
  assert.equal(again.data.error, "duplicate");
});

test("applications: 跨站 POST 403", async () => {
  const result = await call("/api/applications", {
    method: "POST",
    body: { ...VALID, subdomain: "e2e-csrf" },
    headers: { origin: "https://evil.example" },
  });
  assert.equal(result.status, 403);
  assert.equal(result.data.error, "cross_origin");
});

test("admin: 列表能看到自动通过的申请，生成的清单条目过校验", async () => {
  const headers = { origin: portal };
  // 用另一个子域：同一子域在未结案时重复提交会被判重复。
  const application = { ...VALID, subdomain: "e2e-review", name: "自动通过站点" };
  const submitted = await call("/api/applications", { method: "POST", body: application, headers });
  assert.equal(submitted.status, 201);
  const id = submitted.data.application.id;
  assert.equal(submitted.data.application.status, "approved");

  const { cookie } = await login();
  const listed = await call("/api/admin/applications?status=approved", { cookie });
  assert.equal(listed.status, 200);
  const row = listed.data.applications.find((item) => item.id === id);
  assert.ok(row, "刚提交的申请应出现在已通过列表");
  assert.equal(row.email, VALID.email);
  assert.equal(row.reviewedBy, "auto");

  // 审核接口已经移除：没有「再审一次」的入口。
  const reviewed = await call(`/api/admin/applications/${id}/review`, {
    method: "POST",
    cookie,
    headers,
    body: { decision: "approve" },
  });
  assert.equal(reviewed.status, 404);

  const manifest = await call(`/api/admin/applications/${id}/manifest`, { cookie });
  assert.equal(manifest.status, 200);
  const entry = manifest.data.entry;
  assert.deepEqual(checkManifestEntry(entry), []);
  assert.equal(entry.url, `https://${application.subdomain}.xknot.si`);
  assert.equal(entry.id, application.subdomain, "子域标签就是实例 id");
  assert.equal(
    entry.healthUrl,
    undefined,
    "清单不写探测地址：它由 url 推出，探不探看实例 status"
  );

  // publish 给了隧道账号与端口，就把名册一起写掉：只写一半时 validate:federation 必报错。
  const stdout = await stack.adminCli([
    "publish",
    id,
    "--tunnel-account",
    "knot-tunnel-review",
    "--tunnel-port",
    "18099",
  ]);
  assert.match(stdout, /已写入 federation\.json/);

  const manifestFile = JSON.parse(await readFile(stack.manifestFile, "utf8"));
  const roster = JSON.parse(await readFile(stack.federationFile, "utf8"));
  const member = roster.members.find((item) => item.id === entry.id);
  assert.ok(member, "名册要有同名成员");
  assert.equal(member.host, entry.url.replace("https://", ""));
  assert.deepEqual(member.tunnel, { account: "knot-tunnel-review", port: 18099 });
  assert.equal(member.mode, "subdomain");
  assert.deepEqual(validateRoster(roster, manifestFile), []);

  // 再交一次会被清单里已有的地址挡住，不会写出重复成员。
  await assert.rejects(
    stack.adminCli(["publish", id, "--tunnel-account", "knot-tunnel-again", "--tunnel-port", "18100"])
  );
});

test("admin: 退出后会话失效", async () => {
  const { cookie } = await login();
  assert.equal((await call("/api/admin/session", { cookie })).status, 200);
  assert.equal((await call("/api/admin/logout", { method: "POST", cookie, headers: { origin: portal } })).status, 200);
  assert.equal((await call("/api/admin/session", { cookie })).status, 401);
});

// ---- 委托发信 ----

test("relay: 没配 SMTP 时 503，且不泄露内部信息", async () => {
  const result = await call("/api/federation/mail", {
    method: "POST",
    body: { to: "a@b.example", subject: "x", text: "y" },
  });
  assert.equal(result.status, 503);
  assert.equal(result.data.error, "relay_unavailable");
});

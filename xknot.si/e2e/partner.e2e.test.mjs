// 伙伴接入的端到端测试：真实 HTTP + 真实 SMTP 会话 + 真实令牌。
//
// 覆盖线上的完整路径：提交申请 → 立即通过并收到批准信（含案例页地址）
// → 案例页提交公钥 / 撤回 → 交接发一次性领取链接 → 领取页面（GET 不消费）→ 领取。
// 收信端是 e2e/smtp-sink.mjs，所以令牌确实是从邮件正文里取出来的，
// 不靠读库、也不靠测试后门。
//
// 跑法：npm run test:e2e

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startSmtpSink } from "./smtp-sink.mjs";
import { DEFAULT_MANIFEST, startStack } from "../ops/local-stack.mjs";

const MAIL_FROM = "notify@mail.xknot.si";
const PASSWORD = "e2e-partner-horse-battery";
const ADMIN = "e2e-partner-admin";

const APPLICATION = {
  name: "Partners E2E",
  subdomain: "partner-e2e",
  operator: "Lin",
  email: "partner@partner-e2e.example",
  region: "NO",
  timezone: "Europe/Oslo",
  intro: "End-to-end application for the partner onboarding flow.",
  tags: "longform, testing",
  agree: true,
  locale: "en",
};

const PAYLOAD = "XKNOT_HUB_RELAY_TOKEN=xkr_e2e_partner_secret";

let sink;
let stack;
let adminCookie;

before(async () => {
  sink = await startSmtpSink();
  stack = await startStack({
    manifest: DEFAULT_MANIFEST,
    admin: { username: ADMIN, password: PASSWORD },
    env: {
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(sink.port),
      SMTP_SECURE: "0",
      SMTP_ALLOW_INSECURE: "1",
      MAIL_FROM,
      XKNOT_MAIL_REPLY_TO: "no-reply@xknot.si",
      XKNOT_ADMIN_EMAIL: "admin@e2e.example",
    },
  });
});

after(async () => {
  await stack?.stop();
  await sink?.close();
});

async function request(pathname, { method = "GET", body, form, cookie, headers = {}, redirect = "manual" } = {}) {
  const merged = { accept: "text/html,application/json", ...headers };
  let payload;
  if (form !== undefined) {
    merged["content-type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    merged["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (cookie) merged.cookie = cookie;
  const response = await fetch(stack.portalUrl + pathname, {
    method,
    headers: merged,
    redirect,
    body: payload,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: response.status, text, data, headers: response.headers };
}

async function login() {
  const result = await request("/api/admin/login", {
    method: "POST",
    body: { username: ADMIN, password: PASSWORD },
    headers: { origin: stack.portalUrl },
  });
  assert.equal(result.status, 200);
  return (result.headers.getSetCookie?.() || [])[0]?.split(";")[0];
}

/** 从现在起等一封发给某地址的新信；不等旧信，避免断言串到上一封。 */
async function nextMail(to, { timeoutMs = 5000 } = {}) {
  const seen = sink.messages.filter((mail) => mail.to.includes(to)).length;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = sink.messages.filter((mail) => mail.to.includes(to));
    if (matches.length > seen) return matches.at(-1);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no new mail for ${to}`);
}

function matchPath(text, prefix, extra = "") {
  const pattern = new RegExp(`https?:\\/\\/[^\\s"'<>]+${prefix}[A-Za-z0-9_-]{6,}${extra}`, "g");
  const found = String(text).match(pattern);
  assert.ok(found?.length, `mail should contain a ${prefix} link:\n${text}`);
  return found.at(-1).replace(/^https?:\/\/[^/]+/, "");
}

test("join: 提交即通过，收到批准信且没有验证环节", async () => {
  const submitted = await request("/api/applications", {
    method: "POST",
    body: APPLICATION,
    headers: { origin: stack.portalUrl },
  });
  assert.equal(submitted.status, 201, submitted.text);
  const application = submitted.data.application;
  assert.equal(application.status, "approved");
  assert.match(application.id, /^XK-\d{4}-[0-9A-Z]{6}$/);
  assert.match(application.caseUrl, /\/case\//);

  const mail = await nextMail(APPLICATION.email);
  assert.match(mail.from, new RegExp(MAIL_FROM));
  assert.equal(mail.replyTo, "no-reply@xknot.si", "伙伴邮件不接收回复");
  assert.match(mail.body, /本邮件由系统发出，不接收回复。|This message was sent automatically; replies are not monitored\./);
  assert.match(mail.body, /approved|已通过/i);
  assert.ok(!/xkr_[A-Za-z0-9]/.test(mail.body), "邮件里不能出现明文凭据");
  assert.doesNotMatch(mail.body, /\/verify\//, "不再有邮箱验证链接");

  const casePath = matchPath(mail.body, "/case/");
  const casePage = await request(casePath);
  assert.equal(casePage.status, 200);
  assert.ok(casePage.text.includes(APPLICATION.name));
  assert.doesNotMatch(casePage.text, /waiting for email confirmation|待确认/i);

  const verifyPage = await request("/verify/tok_abcdefgh");
  assert.equal(verifyPage.status, 404, "验证页已经移除");

  adminCookie = await login();
  const listed = await request("/api/admin/applications?status=approved", { cookie: adminCookie });
  assert.equal(listed.status, 200);
  const row = listed.data.applications.find((item) => item.id === application.id);
  assert.ok(row);
  assert.equal(row.reviewedBy, "auto");
});

test("join: 案例页可以提交公钥，撤销后不再接受审核", async () => {
  const application = {
    ...APPLICATION,
    subdomain: "partner-resend",
    email: "resend@partner-e2e.example",
  };
  const submitted = await request("/api/applications", {
    method: "POST",
    body: application,
    headers: { origin: stack.portalUrl },
  });
  assert.equal(submitted.status, 201, submitted.text);

  const received = await nextMail(application.email);
  const casePath = matchPath(received.body, "/case/");

  const saved = await request(`/api${casePath}/public-key`, {
    method: "POST",
    form: { publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPartnerKeyOnly lin@example.com" },
  });
  assert.equal(saved.status, 303);
  assert.match(saved.headers.get("location") || "", /key=1/);

  const keyed = await request(casePath);
  assert.match(keyed.text, /公钥|public key/i);

  const withdrawn = await request(`/api${casePath}/withdraw`, { method: "POST" });
  assert.equal(withdrawn.status, 303);
  assert.match(withdrawn.headers.get("location") || "", /withdrawn=1/);

  const page = await request(casePath);
  assert.equal(page.status, 200);
  assert.match(page.text, /withdrawn|已撤回/i);
});

test("join: 通过后交接发一次性领取链接，领取页不消费、领取只能用一次", async () => {
  const application = {
    ...APPLICATION,
    subdomain: "partner-claim",
    email: "claim@partner-e2e.example",
  };
  const submitted = await request("/api/applications", {
    method: "POST",
    body: application,
    headers: { origin: stack.portalUrl },
  });
  assert.equal(submitted.status, 201, submitted.text);
  const id = submitted.data.application.id;
  assert.equal(submitted.data.application.status, "approved");

  await nextMail(application.email);

  const handoff = await request(`/api/admin/applications/${id}/handoff`, {
    method: "POST",
    cookie: adminCookie,
    headers: { origin: stack.portalUrl },
    body: { payload: PAYLOAD, ttlHours: 72 },
  });
  assert.equal(handoff.status, 200, handoff.text);

  const handedOff = await nextMail(application.email);
  assert.ok(!handedOff.body.includes(PAYLOAD), "交接信里不能有明文凭据");

  // 重发交付：上一封里的链接当场作废，伙伴只能用最新一封的链接。
  const reissued = await request(`/api/admin/applications/${id}/handoff`, {
    method: "POST",
    cookie: adminCookie,
    headers: { origin: stack.portalUrl },
    body: { payload: `${PAYLOAD}_v2`, ttlHours: 72 },
  });
  assert.equal(reissued.status, 200, reissued.text);
  assert.equal(reissued.data.claim.revoked, 1);
  await nextMail(application.email);

  const staleToken = handoff.data.claimUrl.split("/").pop();
  const stale = await request("/api/claim", { method: "POST", form: { token: staleToken } });
  assert.equal(stale.status, 410);
  assert.ok(!stale.text.includes(PAYLOAD), "作废的链接不能泄露上一份资料");

  const claimPath = reissued.data.claimUrl.replace(/^https?:\/\/[^/]+/, "");

  // 领取页同样只渲染，不消费。
  for (let i = 0; i < 2; i += 1) {
    const page = await request(claimPath);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("cache-control") || "", /no-store/);
  }

  const claimToken = claimPath.split("/").pop();
  const claimed = await request("/api/claim", { method: "POST", form: { token: claimToken } });
  assert.equal(claimed.status, 200);
  const shown = /<pre>([\s\S]*?)<\/pre>/.exec(claimed.text)?.[1] || "";
  assert.equal(shown.trim(), `${PAYLOAD}_v2`, "领到的必须是重签后的那一份，不是旧的");

  const second = await request("/api/claim", { method: "POST", form: { token: claimToken } });
  assert.equal(second.status, 409);
  assert.ok(!second.text.includes(PAYLOAD), "第二次领取不能再泄露内容");

  const manifest = await request(`/api/admin/applications/${id}/manifest`, { cookie: adminCookie });
  assert.equal(manifest.status, 200);
  assert.equal(manifest.data.entry.status, "pending", "交接期先收录，/api/health 验收后才上线");
  assert.equal(manifest.data.entry.url, `https://${application.subdomain}.xknot.si`);
  assert.equal(manifest.data.entry.id, application.subdomain, "the subdomain label is the id");
});

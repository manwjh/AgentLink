// 成员入口：邮箱 → 一次性授权码 → 本站状态。
//
// 这套用例自带接口、SMTP 收信器和临时数据目录：授权码必须从真实邮件里
// 读出来，不读库、不走测试后门。门户右栏不再有申请表，加入方式是四步说明。

import { expect, test } from "@playwright/test";

import { DEFAULT_MANIFEST, startStack } from "../../ops/local-stack.mjs";
import { startSmtpSink } from "../smtp-sink.mjs";
import { horizontalOverflow, zhCN } from "./constants.mjs";

const MEMBER_EMAIL = "member@e2e-node.example";
const MAIL_FROM = "notify@mail.xknot.si";

let sink;
let stack;

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

test.beforeAll(async () => {
  sink = await startSmtpSink();
  stack = await startStack({
    manifest: DEFAULT_MANIFEST,
    env: {
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(sink.port),
      SMTP_SECURE: "0",
      SMTP_ALLOW_INSECURE: "1",
      MAIL_FROM,
    },
  });
  // 清单里已有 e2e-node，但没有申请单。提交一份申请（提交即通过），成员登录才认得出。
  const submitted = await fetch(`${stack.apiUrl}/api/applications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subdomain: "e2e-node",
      name: "端到端节点",
      operator: "E2E",
      email: MEMBER_EMAIL,
      region: "SG",
      timezone: "Asia/Singapore",
      intro: "只在测试里存在的节点。",
      tags: "测试",
      agree: true,
      locale: "zh-CN",
    }),
  });
  if (submitted.status !== 201) {
    throw new Error(`apply failed: ${submitted.status} ${await submitted.text()}`);
  }
});

test.afterAll(async () => {
  await stack?.stop();
  await sink?.close();
});

/** 从收信器里取出这个地址最近一封登录信里的六位码。 */
async function latestCode(address, from = 0) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const mail = [...sink.messages.slice(from)].reverse().find((item) => item.to.includes(address));
    const match = mail?.subject.match(/\b(\d{6})\b/);
    if (match) return match[1];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no sign-in code for ${address}`);
}

/**
 * 走完邮箱 → 授权码 → 已登录。
 * 先记下收信进度再发信：上一枚码还躺在收信器里，抢在信到之前读会读到旧码。
 */
async function signIn(page, email) {
  const from = sink.messages.length;
  await page.locator("#member-email").fill(email);
  await page.locator("aside#join form.login button.submit").click();
  await expect(page.locator("#member-code")).toBeVisible();
  await page.locator("#member-code").fill(await latestCode(email, from));
  await page.locator("aside#join form.login button.submit").click();
  await expect(page.locator("aside#join section.member")).toBeVisible();
}

const openPanel = (page) => page.goto(`${stack.portalUrl}/zh-CN/`, { waitUntil: "domcontentloaded" });
const loginForm = (page) => page.locator("aside#join form.login");
const submit = (page) => loginForm(page).locator("button.submit");

test("未登录时只有邮箱一格，加入方式是四步说明", async ({ page }) => {
  await openPanel(page);

  await expect(page.locator("#member-email")).toBeVisible();
  await expect(page.locator("#member-code")).toHaveCount(0);
  await expect(page.locator("aside#join h2").first()).toHaveText(zhCN.join.title);

  const steps = page.locator("aside#join ol.steps li");
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(0).locator(".step-title")).toHaveText(zhCN.join.step1);
  // 第三步是「等待连通」：提交即通过，后续由中枢自动接通，不再是「等审核」。
  await expect(steps.nth(2).locator(".step-title")).toHaveText(zhCN.join.step3);
  await expect(steps.nth(2).locator(".step-desc")).toContainText("配置和验证");
  await expect(page.locator('a.step-link[href*="github.com/manwjh/AgentLink"]')).toBeVisible();
  await expect(page.locator("code.inline-code")).toContainText("/admin");

  // 门户不再收申请表：旧的那些字段一个都不该在。
  await expect(page.locator("#join-name")).toHaveCount(0);
  await expect(page.locator('form.form')).toHaveCount(0);
});

test("邮箱不完整时不发请求，错误就在这一格下面", async ({ page }) => {
  await openPanel(page);
  await page.locator("#member-email").fill("member@");
  await submit(page).click();

  await expect(page.locator("#member-email-error")).toHaveText(zhCN.join.emailInvalid);
  await expect(page.locator("#member-email")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#member-code")).toHaveCount(0);
});

test("收到授权码后登录，看到本站状态、健康与计数", async ({ page }) => {
  await openPanel(page);
  const from = sink.messages.length;
  await page.locator("#member-email").fill(MEMBER_EMAIL);
  await submit(page).click();

  await expect(page.locator("#member-code")).toBeVisible();
  await expect(page.locator("#member-email")).toHaveAttribute("readonly", "");
  await expect(page.locator("p.notice")).toContainText(zhCN.join.ttl);

  await page.locator("#member-code").fill(await latestCode(MEMBER_EMAIL, from));
  await submit(page).click();

  const member = page.locator("aside#join section.member");
  await expect(member).toBeVisible();
  await expect(member.locator(".member-name")).toHaveText("端到端节点");
  await expect(member.locator(".member-url")).toHaveText("https://e2e-node.xknot.si");
  await expect(member.locator(".pill")).toHaveText(zhCN.status.active);

  // 四项读的都是中枢已有的副本：没有探测就是「未知」，没有活动数据就是「—」。
  const facts = member.locator(".member-facts dt");
  await expect(facts).toHaveCount(4);
  await expect(facts.nth(0)).toHaveText(zhCN.join.health);
  await expect(member.locator(".member-note")).toContainText(zhCN.join.noStats);
  await expect(member.locator(".member-actions button")).toHaveText(zhCN.join.logout);
});

test("退出后回到邮箱一格，已登录状态不残留", async ({ page }) => {
  await openPanel(page);
  await signIn(page, MEMBER_EMAIL);

  await page.locator("aside#join section.member button.quiet").click();
  await expect(page.locator("#member-email")).toBeVisible();
  await expect(page.locator("aside#join section.member")).toHaveCount(0);

  // 刷新也不该自己回来：会话已经在服务端删掉了。
  await openPanel(page);
  await expect(page.locator("#member-email")).toBeVisible();
});

test("390px 下两格与登录键都不小于 44px，右栏不溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPanel(page);

  const height = await page.locator("#member-email").evaluate((node) => node.getBoundingClientRect().height);
  expect(height).toBeGreaterThanOrEqual(44);

  const button = submit(page);
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  expect(box.width).toBeLessThanOrEqual(390);
  expect(box.height).toBeGreaterThanOrEqual(44);

  expect(await horizontalOverflow(page)).toBe(0);
});

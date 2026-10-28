import { expect, test } from "@playwright/test";

import { ADMIN, uniqueSite, watchErrors } from "./constants.mjs";

const login = async (page) => {
  await page.locator("#username").fill(ADMIN.username);
  await page.locator("#password").fill(ADMIN.password);
  await page.locator('form button[type="submit"]').click();
};

test.describe("控制台", () => {
  test("未登录先看到登录表单，错密码给出提示且不进入控制台", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/admin/");

    await expect(page.locator("#username")).toBeVisible();
    await expect(page.locator("h1")).toContainText("联邦控制台");

    await page.locator("#username").fill(ADMIN.username);
    await page.locator("#password").fill("not-the-password");
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('p.alert[role="alert"]')).toContainText("账号或密码不对");

    await expect(page.locator("header.top")).toHaveCount(0);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("登录 → 打开已通过申请 → 生成清单条目 → 退出", async ({ page, request }) => {
    const errors = watchErrors(page);
    const site = uniqueSite("review");

    // 申请走公开接口提交，提交即通过；控制台只负责收录与运维。
    const submitted = await request.post("/api/applications", {
      data: { ...site, agree: true, locale: "zh-CN" },
    });
    expect(submitted.status()).toBe(201);
    const { application } = await submitted.json();
    expect(application.status).toBe("approved");

    await page.goto("/admin/");
    await login(page);

    await expect(page.locator("header.top")).toBeVisible();
    await expect(page.locator("header.top")).toContainText(ADMIN.username);

    // 登录后先落在总览，申请列表在「申请记录」里，默认就是已通过。
    await page.locator('nav.views button[data-view="applications"]').click();

    const item = page.locator(".list .item", { hasText: site.name });
    await expect(item).toBeVisible();
    await item.click();

    const detail = page.locator(".detail");
    await expect(detail.locator("h2")).toHaveText(site.name);
    await expect(detail).toContainText(site.url);
    await expect(detail.locator(".badge")).toHaveAttribute("data-status", "approved");
    await expect(detail).toContainText("提交即通过");
    // 审核动作已经移除。
    await expect(page.locator(".actions button")).toHaveCount(0);

    await page.locator('.snippet button[data-action="manifest"]').click();
    const pre = page.locator(".snippet pre");
    await expect(pre).toBeVisible();
    const entry = JSON.parse(await pre.innerText());
    expect(entry.url).toBe(site.url);
    expect(entry.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(entry.status).toBe("pending");
    expect(entry.tier).toBe("free");
    expect(entry.healthUrl).toBeUndefined();

    await page.locator('header.top button[data-action="logout"]').click();
    await expect(page.locator("#username")).toBeVisible();

    // 控制台自己也在 CSP 下运行，全程不能有脚本错误。
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("登录后先看到总览：实例、申请队列与最近事件在一页", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/admin/");
    await login(page);

    await expect(page.locator(".overview")).toBeVisible();
    await expect(page.locator(".ov-title")).toBeVisible();
    await expect(page.locator(".kpi")).toHaveCount(4);

    for (const panel of ["instances", "applications", "mail", "events"]) {
      await expect(page.locator(`.panel-head[data-panel="${panel}"] h2`)).toBeVisible();
    }

    // 发信总闸：状态在 aria-checked 里。预览栈没配 SMTP，所以按不动，
    // 面板要说明原因——按下去也发不出信，给个能按的开关就是骗人。
    const mailSwitch = page.locator('button.mail-switch[role="switch"]');
    await expect(mailSwitch).toBeVisible();
    await expect(mailSwitch).toHaveAttribute("aria-checked", "true");
    await expect(mailSwitch).toBeDisabled();
    await expect(page.locator(".panel-note", { hasText: "没配 SMTP" })).toBeVisible();

    // 队列只有状态机能产出的两个分类：多出来的入口点进去没有对应标签，
    // 会落在一个既无高亮、也无说明的空列表上。
    await expect(page.locator(".queue-row")).toHaveCount(2);
    await expect(page.locator('.queue-row[data-status="approved"]')).toBeVisible();
    await expect(page.locator('.queue-row[data-status="withdrawn"]')).toBeVisible();

    // 队列行把运营直接送到对应的申请分类。
    await page.locator('.queue-row[data-status="approved"]').click();
    await expect(page.locator(".tabs")).toBeVisible();
    await expect(page.locator("nav.views button.active")).toContainText("申请记录");

    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("点实例展开这个账号的配置，不跳站点", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/admin/");
    await login(page);

    const row = page.locator(".inst-row").first();
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("aria-expanded", "false");

    const before = page.url();
    await row.click();

    // 点的是行本身：地址不能变，站点也不能被打开。
    await expect(page).toHaveURL(before);
    await expect(page.context().pages()).toHaveLength(1);
    await expect(row).toHaveAttribute("aria-expanded", "true");

    const config = page.locator(".inst-config");
    await expect(config).toBeVisible();
    for (const label of ["账号", "名册身份", "隧道", "探测地址"]) {
      await expect(config).toContainText(label);
    }
    // 探测地址是推导值：展示出来，但不给输入框。
    await expect(config).toContainText("/api/health");

    // 再点一次收起，回到列表本身。
    await row.click();
    await expect(page.locator(".inst-config")).toHaveCount(0);
    await expect(row).toHaveAttribute("aria-expanded", "false");

    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("实例配置可以就地编辑，校验失败不丢草稿也不落盘", async ({ page }) => {
    // 这里故意交一个非 https 地址：400 是用例制造的，下面断言错误条留在卡片里。
    const errors = watchErrors(page, { allow: [/status of 400\b/] });
    await page.goto("/admin/");
    await login(page);

    const row = page.locator(".inst-row", { hasText: "wang" }).first();
    await expect(row).toBeVisible();
    await row.click();

    const config = page.locator(".inst-config");
    await expect(config).toBeVisible();
    await config.locator('button[data-action="edit"]').click();

    const form = page.locator(".cfg-form");
    await expect(form).toBeVisible();
    const urlBefore = page.url();

    const noteInput = form.locator(".cfg-field", { hasText: "备注" }).locator("input");
    const urlInput = form.locator(".cfg-field", { hasText: "对外地址" }).locator("input");
    // 探测地址由对外地址推出，表单里不再有这一项。
    await expect(form.locator(".cfg-field", { hasText: "探测地址" })).toHaveCount(0);
    await expect(form.locator(".cfg-field", { hasText: "健康探测" })).toHaveCount(0);
    const note = `控制台改过的备注 ${Date.now()}`;
    await noteInput.fill(note);

    // 先交一个非 https 地址：错误留在卡片里，输入不丢，文件也不该被写坏。
    const goodUrl = await urlInput.inputValue();
    await urlInput.fill("http://plain.example");
    await form.locator('button[data-action="save"]').click();
    await expect(form.locator(".cfg-errors")).toContainText("url");
    await expect(noteInput).toHaveValue(note);
    await expect(urlInput).toHaveValue("http://plain.example");

    await urlInput.fill(goodUrl);
    await form.locator('button[data-action="save"]').click();
    await expect(page.locator(".cfg-form")).toHaveCount(0);
    await expect(page.locator(".inst-config")).toContainText(note);
    await expect(page).toHaveURL(urlBefore);
    await expect(page.context().pages()).toHaveLength(1);

    // 刷新后再展开，读的是写回去的文件，不是内存里的草稿。
    await page.reload();
    await page.locator(".inst-row", { hasText: "wang" }).first().click();
    await expect(page.locator(".inst-config")).toContainText(note);

    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("已通过的申请不再给审核动作，列表也不重复", async ({ page, request }) => {
    const site = uniqueSite("idem");
    const submitted = await request.post("/api/applications", {
      data: { ...site, agree: true, locale: "zh-CN" },
    });
    const { application } = await submitted.json();
    expect(application.status).toBe("approved");

    await page.goto("/admin/");
    await login(page);
    await expect(page.locator("header.top")).toBeVisible();
    await page.locator('nav.views button[data-view="applications"]').click();

    // 直接按编号定位，避免列表里同名干扰。
    const item = page.locator(".list .item", { hasText: application.id });
    await expect(item).toBeVisible();
    await item.click();
    await expect(page.locator(".detail .badge")).toHaveAttribute("data-status", "approved");
    await expect(page.locator(".actions button")).toHaveCount(0);

    // 审核接口已经移除：再打一次只会 404。
    const again = await page.request.post(`/api/admin/applications/${application.id}/review`, {
      data: { decision: "approve" },
    });
    expect(again.status()).toBe(404);

    await page.locator('button.tab[data-status="approved"]').click();
    await expect(page.locator(".list .item", { hasText: application.id })).toHaveCount(1);
  });

  test("申请列表读取失败时给出错误条，且不把上一次的行留在新分类下", async ({ page, request }) => {
    // 这里故意让列表接口 500：500 是用例制造的，下面断言错误条与「重试」按钮。
    const errors = watchErrors(page, { allow: [/status of 500\b/] });
    const site = uniqueSite("listfail");

    const submitted = await request.post("/api/applications", {
      data: { ...site, agree: true, locale: "zh-CN" },
    });
    expect(submitted.status()).toBe(201);

    await page.goto("/admin/");
    await login(page);
    await expect(page.locator("header.top")).toBeVisible();
    await page.locator('nav.views button[data-view="applications"]').click();

    // 先让「已通过」这一栏有行：后面才有旧数据可以冒充新分类的内容。
    await expect(page.locator(".list .item").first()).toBeVisible();

    // 列表接口失败，再切到「已撤回」。
    await page.route("**/api/admin/applications**", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "internal" }),
      })
    );
    await page.locator('button.tab[data-status="withdrawn"]').click();

    // 失败要看得见，且旧行不能顶着新标签继续显示。
    await expect(page.locator(".panel p.alert[role='alert']")).toContainText("申请列表加载失败");
    await expect(page.locator(".list .item")).toHaveCount(0);
    await expect(page.locator(".detail")).toHaveCount(0);
    await expect(page.locator(".detail-empty")).toBeVisible();

    // 恢复接口后点「重试」：错误条消失，显示这个分类的真实结果（这里没有记录）。
    await page.unroute("**/api/admin/applications**");
    await page.locator('.load-error button[data-action="retry"]').click();
    await expect(page.locator(".load-error")).toHaveCount(0);
    await expect(page.locator(".list .item")).toHaveCount(0);
    await expect(page.locator("p.empty")).toContainText("这个分类下没有记录");

    expect(errors, errors.join("\n")).toEqual([]);
  });
});

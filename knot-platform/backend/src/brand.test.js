import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { DEFAULT_SITE_TIME_ZONE, brandView, cleanSite, createProfileStore, profileFilePath, siteTimeZone } from "./profile.js";
import { webRouter } from "./routes/web.js";

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function profileFile(body) {
  const dir = mkdtempSync(path.join(tmpdir(), "knot-profile-"));
  const file = path.join(dir, "profile.json");
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return { dir, file };
}

test("a missing profile is not an error: the site simply has no self-description yet", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "knot-profile-"));
  try {
    const store = createProfileStore({ file: path.join(dir, "profile.json") });
    const state = await store.reload();
    assert.equal(state.site, null);
    assert.deepEqual(state.problems, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the brand view keeps the flat strings and drops what the site does not render", () => {
  const { site } = cleanSite({
    name: "Knot · wang",
    tagline: "收发一手情报",
    intro: "一段长介绍。",
    owner: "PaulWang",
    contact: "owner@example.com",
    logo: "https://wang.xknot.si/logo.png",
    region: "CN",
    timezone: "Asia/Shanghai",
    tags: ["旅行", "Agent"],
  });
  assert.deepEqual(brandView(site), {
    name: "Knot · wang",
    tagline: "收发一手情报",
    logo: "https://wang.xknot.si/logo.png",
    owner: "PaulWang",
    intro: "一段长介绍。",
    contact: "owner@example.com",
  });
  assert.deepEqual(brandView(null), {
    name: null,
    tagline: null,
    logo: "",
    owner: null,
    intro: null,
    contact: "",
  });
});

test("tags are plain text, deduplicated by case, capped at nine, trimmed at sixteen", () => {
  const nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  assert.deepEqual(cleanSite({ name: "站点", tags: nine }).site.tags, nine);
  assert.ok(cleanSite({ name: "站点", tags: [...nine, "j"] }).problems.includes("tags: more than 9"));
  assert.deepEqual(cleanSite({ name: "站点", tags: ["Travel", "travel", "旅行"] }).site.tags, ["Travel", "旅行"]);
  assert.equal(cleanSite({ name: "站点", tags: [] }).site.tags, undefined);
  assert.equal(cleanSite({ name: "站点", tags: ["x".repeat(17)] }).site.tags[0].length, 16);
});

test("region is normalized to an upper-case code, and a malformed one is refused", () => {
  assert.equal(cleanSite({ name: "站点", region: "cn" }).site.region, "CN");
  assert.equal(cleanSite({ name: "站点", region: "GLOBAL" }).site.region, "GLOBAL");
  assert.ok(cleanSite({ name: "站点", region: "中国" }).problems.includes("region: must be a two-letter country code, or GLOBAL"));
});

test("the site default language is one of three, and a bad one refuses the whole save", () => {
  assert.equal(cleanSite({ name: "站点", locale: "zh-TW" }).site.locale, "zh-TW");
  assert.equal(cleanSite({ name: "站点", locale: " en " }).site.locale, "en");
  assert.equal(cleanSite({ name: "站点" }).site.locale, undefined);
  assert.ok(cleanSite({ name: "站点", locale: "ja" }).problems.includes("locale: must be zh-CN, zh-TW or en"));
  // 写错的语种不能进档案：否则页面会拿它去查目录，查不到就是一片键。
  assert.equal(cleanSite({ name: "站点", locale: "ja" }).site, null);
});

test("a saved profile is written in the documented shape and reloads", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "knot-profile-"));
  try {
    const file = path.join(dir, "profile.json");
    const store = createProfileStore({ file });
    await store.reload();
    await store.save(
      {
        site: {
          name: "Knot",
          tagline: "Exchange",
          contact: "ops@example.com",
        },
      },
      { now: () => new Date("2026-10-21T04:05:06Z") }
    );
    const state = store.view();
    assert.equal(state.updatedAt, "2026-10-21");
    assert.equal(state.site.name, "Knot");
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(onDisk.formatVersion, 2);
    assert.equal(onDisk.site.tagline, "Exchange");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invalid profile is rejected and the previous file is kept", async () => {
  const { dir, file } = profileFile({
    formatVersion: 2,
    updatedAt: "2026-10-20",
    site: { name: "Old", contact: "old@example.com" },
  });
  try {
    const store = createProfileStore({ file });
    await store.reload();
    await assert.rejects(
      () => store.save({ site: { tagline: "没有名字" } }),
      (error) => error.code === "bad_profile" && error.problems.includes("name: required")
    );
    assert.equal(store.view().site.name, "Old");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a v1 file is refused instead of half-read", async () => {
  const { dir, file } = profileFile({
    formatVersion: 1,
    updatedAt: "2026-10-20",
    profile: { name: { "zh-CN": "旧站点" } },
  });
  try {
    const store = createProfileStore({ file });
    const state = await store.reload();
    assert.equal(state.site, null);
    assert.deepEqual(state.problems, ["formatVersion: must be 2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the profile file sits next to xknot.env, and can be pointed at explicitly", () => {
  assert.equal(
    profileFilePath({}, "/srv/knot/sites/wang/agents"),
    path.join("/srv/knot/sites/wang", "profile.json")
  );
  assert.equal(profileFilePath({ KNOT_PROFILE_FILE: "/tmp/p.json" }, "/srv/knot/sites/wang/agents"), "/tmp/p.json");
  assert.equal(profileFilePath({}, null), null);
});

test("the session payload carries the site identity for the header", async () => {
  const uploadDir = mkdtempSync(path.join(tmpdir(), "knot-brand-"));
  const { dir, file } = profileFile({
    formatVersion: 2,
    updatedAt: "2026-10-21",
    site: {
      name: "观测站",
      locale: "zh-TW",
      tagline: "只收情报",
      logo: "https://example.test/logo.png",
      owner: "PaulWang",
      contact: "owner@example.com",
    },
  });
  const store = createProfileStore({ file });
  await store.reload();

  const app = express();
  app.use(
    "/api/web",
    webRouter({
      pool: {},
      sessionCookieName: "knot_sid",
      uploadDir,
      profile: store,
    })
  );
  const server = await listen(app);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/web/session`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.brand.name, "观测站");
    assert.equal(body.brand.tagline, "只收情报");
    assert.equal(body.brand.logo, "https://example.test/logo.png");
    assert.equal(body.brand.owner, "PaulWang");
    assert.equal(body.brand.contact, "owner@example.com");
    // 站点默认语种由主理人定；不再按访客 IP 或 Accept-Language 给 region。
    assert.equal(body.defaultLocale, "zh-TW");
    assert.equal(body.region, undefined);
    assert.equal(body.user, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(uploadDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// 「今天」按站点自己的钟算：档案写了 timezone 就用它；没写时不能退到 UTC，
// 否则东八区的站在每天早上 8 点整换日，顶栏数字会在上午莫名其妙地清零。
test("the site's day follows its own time zone, not UTC and not the reader's", () => {
  assert.equal(siteTimeZone({ timezone: "Europe/Oslo" }), "Europe/Oslo");
  assert.equal(siteTimeZone({ timezone: "Asia/Shanghai" }), "Asia/Shanghai");
  // 写坏的值不能拿来切日子，退回实例所在时区。
  const fallback = siteTimeZone({ timezone: "Mars/Base" });
  assert.notEqual(fallback, "Mars/Base");
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(fallback, local || DEFAULT_SITE_TIME_ZONE);
  assert.equal(siteTimeZone(null), local || DEFAULT_SITE_TIME_ZONE);
});

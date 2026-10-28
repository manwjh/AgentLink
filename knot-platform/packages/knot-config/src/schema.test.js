import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  GROUPS,
  KEYS,
  checkJoin,
  checkPlatform,
  checkRuntime,
  checkSite,
  formatValue,
  parseEnv,
  renderDocs,
  renderJoinExample,
  renderPlatformExample,
  renderPlatformFile,
  renderSiteExample,
  resolve,
  updateEnvText,
} from "./schema.mjs";
import { clearPriceOverride, economyConfig } from "../../../backend/src/points.js";
import { loadBootstrapConfig } from "../../../backend/src/config.js";
import { searchConfig } from "../../../backend/src/searchConfig.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function read(relative) {
  return readFileSync(`${ROOT}${relative}`, "utf8");
}

test("every key is registered once, in a known group and a known file", () => {
  const seen = new Set();
  const groups = new Set(GROUPS.map((group) => group.id));
  for (const entry of KEYS) {
    assert.ok(!seen.has(entry.key), `${entry.key} 登记了两次`);
    seen.add(entry.key);
    assert.ok(groups.has(entry.group), `${entry.key} 的分组 ${entry.group} 不存在`);
    assert.ok(["site", "platform", "xknot"].includes(entry.file), `${entry.key} 的 file 不对`);
    assert.ok(entry.desc && entry.desc.length > 4, `${entry.key} 缺说明`);
    assert.ok(entry.file !== "site" || !entry.runtime || /^[A-Z][A-Z0-9_]*$/.test(entry.runtime));
  }
});

test("generated example files and docs are committed as generated", () => {
  assert.equal(read("sites/_template/site.env"), renderSiteExample());
  assert.equal(read("sites/_template/platform.env"), renderPlatformExample());
  assert.equal(read("sites/_template/xknot.env"), renderJoinExample());
  assert.equal(read("docs/CONFIG.md"), renderDocs());
});

test("a complete local site config passes", () => {
  const result = checkSite({
    KNOT_PUBLIC_ORIGIN: "http://127.0.0.1:8080",
    KNOT_ADMIN_EMAIL: "admin@example.com",
    KNOT_BACKUP_DIR: "$HOME/knot/backups",
  });
  assert.deepEqual(result.errors, []);
});

test("a complete xknot.si subdomain config passes", () => {
  const result = checkSite({
    KNOT_PUBLIC_ORIGIN: "https://wang.xknot.si",
    KNOT_DOMAIN: "wang.xknot.si",
    KNOT_ADMIN_EMAIL: "admin@example.com",
    KNOT_TUNNEL: "1",
    KNOT_BACKUP_DIR: "$HOME/knot/backups",
  });
  assert.deepEqual(result.errors, []);
});

test("missing admin email fails", () => {
  const result = checkSite({});
  assert.ok(result.errors.some((message) => message.includes("KNOT_ADMIN_EMAIL")));
});

test("types are checked, not just presence", () => {
  const result = checkSite({
    KNOT_ADMIN_EMAIL: "not-an-email",
    KNOT_PORT: "eighty",
    KNOT_PUBLIC_ORIGIN: "knot.example.com",
    KNOT_DB_MODE: "sqlite",
    KNOT_OPENCLAW: "maybe",
    KNOT_BACKUP_DIR: "/backups",
  });
  const text = result.errors.join("\n");
  assert.match(text, /KNOT_ADMIN_EMAIL/);
  assert.match(text, /KNOT_PORT/);
  assert.match(text, /KNOT_PUBLIC_ORIGIN/);
  assert.match(text, /KNOT_DB_MODE/);
  assert.match(text, /KNOT_OPENCLAW/);
});

test("cross-key rules fire only when their condition holds", () => {
  const base = { KNOT_ADMIN_EMAIL: "admin@example.com", KNOT_BACKUP_DIR: "/backups" };
  assert.deepEqual(checkSite(base).errors, []);
  assert.ok(
    checkSite({ ...base, KNOT_DB_MODE: "external" }).errors.some((m) => m.includes("KNOT_DATABASE_URL"))
  );
  assert.deepEqual(checkSite({ ...base, KNOT_DB_MODE: "external", KNOT_DATABASE_URL: "postgres://x/y" }).errors, []);
});

test("unknown site keys are reported as warnings, not errors", () => {
  const result = checkSite({
    KNOT_ADMIN_EMAIL: "admin@example.com",
    KNOT_BACKUP_DIR: "/backups",
    KNOT_SITE_NAM: "typo",
  });
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((message) => message.includes("KNOT_SITE_NAM")));
});

test("a loopback-only site is not warned about missing backups", () => {
  // 开发者本机跑一整套时，不装备份任务是正常的；公网站点才该提醒。
  const local = checkSite({
    KNOT_ADMIN_EMAIL: "dev@example.com",
    KNOT_PUBLIC_ORIGIN: "http://127.0.0.1:8081",
  });
  assert.deepEqual(local.errors, []);
  assert.deepEqual(local.warnings, []);

  const publicSite = checkSite({
    KNOT_ADMIN_EMAIL: "dev@example.com",
    KNOT_PUBLIC_ORIGIN: "https://wang.xknot.si",
    KNOT_DOMAIN: "wang.xknot.si",
    KNOT_TUNNEL: "1",
  });
  assert.ok(publicSite.warnings.some((message) => message.includes("KNOT_BACKUP_DIR")));
});

test("a local host can also carry an issued subdomain", () => {
  // 整套系统都在一台机器上，同样可以领子域接进联邦：入口由中枢开通，
  // 隧道参数写在 tunnel.env，site.env 只描述站点自己。
  const result = checkSite({
    KNOT_ADMIN_EMAIL: "dev@example.com",
    KNOT_PUBLIC_ORIGIN: "https://cpswang.xknot.si",
    KNOT_DOMAIN: "cpswang.xknot.si",
    KNOT_TUNNEL: "0",
  });
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((message) => message.includes("KNOT_BACKUP_DIR")));
});

test("a public site can opt out of backups with null", () => {
  const result = checkSite({
    KNOT_ADMIN_EMAIL: "admin@example.com",
    KNOT_PUBLIC_ORIGIN: "https://wang.xknot.si",
    KNOT_DOMAIN: "wang.xknot.si",
    KNOT_TUNNEL: "1",
    KNOT_BACKUP_DIR: "null",
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);

  // 留空是还没决定，仍然提醒；提醒里要给出 null 这个明确选项。
  const undecided = checkSite({
    KNOT_ADMIN_EMAIL: "admin@example.com",
    KNOT_PUBLIC_ORIGIN: "https://wang.xknot.si",
    KNOT_DOMAIN: "wang.xknot.si",
    KNOT_TUNNEL: "1",
  });
  assert.ok(undecided.warnings.some((message) => message.includes("写 null")));
});

test("local deployment must stay on loopback", () => {
  const lan = checkSite({
    KNOT_ADMIN_EMAIL: "dev@example.com",
    KNOT_PUBLIC_ORIGIN: "http://192.168.1.10:8080",
  });
  assert.ok(lan.errors.some((message) => message.includes("用户改造范围")));

  const custom = checkSite({
    KNOT_ADMIN_EMAIL: "dev@example.com",
    KNOT_PUBLIC_ORIGIN: "https://knot.example.com",
  });
  assert.ok(custom.errors.some((message) => message.includes("用户改造范围")));

  const tunnel = checkSite({
    KNOT_ADMIN_EMAIL: "dev@example.com",
    KNOT_PUBLIC_ORIGIN: "http://127.0.0.1:8080",
    KNOT_TUNNEL: "1",
  });
  assert.ok(tunnel.errors.some((message) => message.includes("KNOT_TUNNEL=0")));
});

test("subdomain deployment needs both a domain and a matching public origin", () => {
  const missingDomain = checkSite({
    KNOT_ADMIN_EMAIL: "dev@example.com",
    KNOT_PUBLIC_ORIGIN: "https://wang.xknot.si",
  });
  assert.ok(missingDomain.errors.some((message) => message.includes("必须写 KNOT_DOMAIN")));

  const missingOrigin = checkSite({
    KNOT_ADMIN_EMAIL: "dev@example.com",
    KNOT_DOMAIN: "wang.xknot.si",
  });
  assert.ok(missingOrigin.errors.some((message) => message.includes("必须写 KNOT_PUBLIC_ORIGIN")));

  const mismatched = checkSite({
    KNOT_ADMIN_EMAIL: "dev@example.com",
    KNOT_PUBLIC_ORIGIN: "https://other.xknot.si",
    KNOT_DOMAIN: "wang.xknot.si",
  });
  assert.ok(mismatched.errors.some((message) => message.includes("不一致")));

  const insecure = checkSite({
    KNOT_ADMIN_EMAIL: "dev@example.com",
    KNOT_PUBLIC_ORIGIN: "http://wang.xknot.si",
    KNOT_DOMAIN: "wang.xknot.si",
    KNOT_TUNNEL: "1",
  });
  assert.ok(insecure.errors.some((message) => message.includes("https://")));
});

test("subdomain deployment must use an xknot.si issued domain", () => {
  const result = checkSite({
    KNOT_ADMIN_EMAIL: "dev@example.com",
    KNOT_PUBLIC_ORIGIN: "https://knot.example.com",
    KNOT_DOMAIN: "knot.example.com",
  });
  assert.ok(result.errors.some((message) => message.includes("<标签>.xknot.si")));
});

test("a platform runtime file may not carry dev-only keys", () => {
  const result = checkPlatform("PORT=8080\nKNOT_DEPLOY_SSH_KEY=/Users/me/.ssh/id_rsa\n");
  assert.ok(result.errors.some((message) => message.includes("KNOT_DEPLOY_SSH_KEY")));
});

test("a platform runtime file warns on unknown keys and loose permissions", () => {
  const text = "PORT=8080\nKNOT_AGENT_TOKEN=secret\nSMTP_PASS=hunter2\n";
  const result = checkPlatform(text, { mode: 0o644 });
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((message) => message.includes("KNOT_AGENT_TOKEN")));
  assert.ok(result.warnings.some((message) => message.includes("chmod 600")));
  assert.deepEqual(checkPlatform(text, { mode: 0o600 }).warnings.filter((m) => m.includes("chmod")), []);
});

test("platform runtime values are type checked too", () => {
  const result = checkPlatform("KNOT_COUPON_SIGNUP=7\nSMTP_PORT=99999\n");
  assert.match(result.errors.join("\n"), /KNOT_COUPON_SIGNUP/);
  assert.match(result.errors.join("\n"), /SMTP_PORT/);
});

test("schema defaults match the values the code falls back to", () => {
  const keys = [
    "KNOT_DEFAULT_PRICE",
    "KNOT_PRICE_MIN",
    "KNOT_PRICE_MAX",
    "KNOT_PUBLISH_SERVICE_FEE_PER_MB",
    "KNOT_SERVICE_FEE_CAP",
    "KNOT_POINT_USD_CENTS",
    "KNOT_SIGNUP_GRANT",
    "KNOT_GRANT_MAX",
    "KNOT_RECHARGE_USD",
    "KNOT_MONTHLY_OPEX_USD",
    "KNOT_COUPON_TTL_DAYS",
    "KNOT_COUPON_MAX",
    "KNOT_COUPON_SIGNUP",
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  clearPriceOverride();
  try {
    const code = economyConfig();
    const byKey = new Map(KEYS.map((entry) => [entry.key, entry]));
    assert.equal(byKey.get("KNOT_DEFAULT_PRICE").default, code.defaultPrice);
    assert.equal(byKey.get("KNOT_PRICE_MIN").default, code.priceMin);
    assert.equal(byKey.get("KNOT_PRICE_MAX").default, code.priceMax);
    assert.equal(byKey.get("KNOT_PUBLISH_SERVICE_FEE_PER_MB").default, code.publishServiceFeePerMb);
    assert.equal(byKey.get("KNOT_SERVICE_FEE_CAP").default, code.serviceFeeCap);
    assert.equal(byKey.get("KNOT_POINT_USD_CENTS").default, code.pointUsdCents);
    assert.equal(byKey.get("KNOT_SIGNUP_GRANT").default, code.signupGrant);
    assert.equal(byKey.get("KNOT_GRANT_MAX").default, code.grantMax);
    assert.equal(byKey.get("KNOT_RECHARGE_USD").default, code.rechargeUsd);
    assert.equal(byKey.get("KNOT_MONTHLY_OPEX_USD").default, code.monthlyOpexUsd);
    assert.equal(byKey.get("KNOT_COUPON_TTL_DAYS").default, code.couponTtlDays);
    assert.equal(byKey.get("KNOT_COUPON_MAX").default, code.couponMax);
    assert.equal(Boolean(byKey.get("KNOT_COUPON_SIGNUP").default), code.couponOnSignup);
  } finally {
    for (const [key, value] of saved) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    clearPriceOverride();
  }
});

test("search defaults in the schema match the values the code falls back to", () => {
  const keys = [
    "KNOT_SEARCH_CANDIDATES",
    "KNOT_SEARCH_RESULTS",
    "KNOT_SEARCH_Q_MAX",
    "KNOT_SEARCH_CACHE_TTL",
    "KNOT_SEARCH_RATE_PER_MIN",
    "KNOT_REVIEW_CONCURRENCY",
    "KNOT_SEARCH_EVENT_RETENTION_DAYS",
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    const code = searchConfig();
    const byKey = new Map(KEYS.map((entry) => [entry.key, entry]));
    assert.equal(byKey.get("KNOT_SEARCH_CANDIDATES").default, code.candidates);
    assert.equal(byKey.get("KNOT_SEARCH_RESULTS").default, code.results);
    assert.equal(byKey.get("KNOT_SEARCH_Q_MAX").default, code.queryMax);
    assert.equal(byKey.get("KNOT_SEARCH_CACHE_TTL").default * 1000, code.cacheTtlMs);
    assert.equal(byKey.get("KNOT_SEARCH_RATE_PER_MIN").default, code.searchRatePerMinute);
    assert.equal(byKey.get("KNOT_REVIEW_CONCURRENCY").default, code.reviewConcurrency);
    assert.equal(byKey.get("KNOT_SEARCH_EVENT_RETENTION_DAYS").default, code.searchEventRetentionDays);
  } finally {
    for (const [key, value] of saved) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("derived values follow site.env without being written back", () => {
  const env = {
    KNOT_PUBLIC_ORIGIN: "https://knot.example.com:8443",
    KNOT_PORT: "9090",
    // 隧道账号与端口由中枢签发、写在 tunnel.env；这里只验证「写了就用它」。
    KNOT_TUNNEL_SSH: "knot-tunnel-lab",
    KNOT_TUNNEL_REMOTE_PORT: "18081",
  };
  const byKey = new Map(KEYS.map((entry) => [entry.key, entry]));
  const ctx = { root: "/srv/knot", home: "/Users/me", expand: true };
  assert.equal(resolve(byKey.get("KNOT_DOMAIN"), env, ctx), "");
  assert.equal(resolve(byKey.get("KNOT_TUNNEL_SSH"), env, ctx), "knot-tunnel-lab");
  assert.equal(resolve(byKey.get("KNOT_TUNNEL_LOCAL_PORT"), env, ctx), "9090");
  assert.equal(resolve(byKey.get("KNOT_TUNNEL_REMOTE_PORT"), env, ctx), "18081");
  // 没写就是空：不猜一个账号，也不猜一个端口。
  assert.equal(resolve(byKey.get("KNOT_TUNNEL_SSH"), { KNOT_PORT: "9090" }, ctx), "");
  assert.equal(resolve(byKey.get("KNOT_TUNNEL_REMOTE_PORT"), { KNOT_PORT: "9090" }, ctx), "");
  assert.equal(resolve(byKey.get("KNOT_UPLOAD_DIR"), {}, ctx), "/srv/knot/var/uploads");
  assert.equal(resolve(byKey.get("KNOT_TUNNEL_KEY"), {}, ctx), "tunnel_ed25519");
  // 展示远端路径时不展开本机的 home。
  assert.equal(
    resolve(byKey.get("KNOT_DEPLOY_DIR"), {}, { root: "/srv/knot", home: "/Users/me" }),
    "~/knot/site"
  );
});

test("parseEnv understands quotes, inline comments and does not expand variables", () => {
  const env = parseEnv(
    ['A=1', 'B="two words"', "C='single # not a comment'", "D=value # trailing", "E=$HOME/x", "  # F=3"].join("\n")
  );
  assert.deepEqual(env, { A: "1", B: "two words", C: "single # not a comment", D: "value", E: "$HOME/x" });
});

test("updateEnvText edits in place, uncomments, and appends missing keys", () => {
  const before = ["# 说明保留", "PORT=8080", "# SMTP_PORT=587", "CUSTOM=keep"].join("\n");
  const after = updateEnvText(before, { PORT: "9090", SMTP_PORT: "465", KNOT_ADMIN_EMAIL: "owner@example.com" });
  assert.match(after, /# 说明保留/);
  assert.match(after, /^PORT=9090$/m);
  assert.match(after, /^SMTP_PORT=465$/m);
  assert.match(after, /^CUSTOM=keep$/m);
  assert.match(after, /^KNOT_ADMIN_EMAIL=owner@example.com$/m);
});

test("updateEnvText collapses repeated append headers", () => {
  const before = ["A=1", "# ---- 由部署脚本写入 ----", "X=1", "", "# ---- 由部署脚本写入 ----", "Y=2"].join("\n");
  const after = updateEnvText(before, { A: "2" });
  assert.equal(after.match(/由部署脚本写入/g).length, 1);
  assert.match(after, /^X=1$/m);
  assert.match(after, /^Y=2$/m);
});

test("formatValue quotes only what the shell needs", () => {
  assert.equal(formatValue("8080"), "8080");
  assert.equal(formatValue("$HOME/knot"), "$HOME/knot");
  assert.equal(formatValue("two words"), '"two words"');
  assert.equal(formatValue(""), "");
});

test("formatValue never hands the shell a command to run", () => {
  // 这些值写进 .env 后会被 source。不加引号就会执行或截断：
  // $(...) 是子命令，$VAR 是展开，| ; & 断句。引导解出来的值一律当字面量。
  assert.equal(formatValue("$(id)"), '"\\$(id)"');
  assert.equal(formatValue("a|b"), '"a|b"');
  assert.equal(formatValue("a;rm -rf /"), '"a;rm -rf /"');
  assert.equal(formatValue("a&b"), '"a&b"');
  assert.equal(formatValue("`id`"), '"\\`id\\`"');

  // 只有 $HOME 一种展开是站点配置真的用到的（schema 默认值），其余 $ 都转义。
  assert.equal(formatValue("$HOME/.ssh/knot-entry"), "$HOME/.ssh/knot-entry");
  assert.equal(formatValue("pa$word"), '"pa\\$word"');
  assert.equal(formatValue("$HOMEfoo"), '"\\$HOMEfoo"');
});

test("a fresh platform runtime file is written with resolved values and blanks commented", () => {
  const text = renderPlatformFile({
    PORT: "8080",
    KNOT_ADMIN_EMAIL: "admin@example.com",
    SMTP_PORT: "587",
    SMTP_PASS: "",
  });
  assert.match(text, /^PORT=8080$/m);
  assert.match(text, /^SMTP_PORT=587$/m);
  assert.match(text, /^# SMTP_PASS=$/m);
});

test("runtime validation rejects bad values and never guesses", () => {
  const good = checkRuntime({ PORT: "8080", KNOT_ADMIN_EMAIL: "admin@example.com" });
  assert.deepEqual(good.errors, []);

  const bad = checkRuntime({ PORT: "eighty", KNOT_COUPON_SIGNUP: "7" });
  assert.match(bad.errors.join("\n"), /PORT/);
  assert.match(bad.errors.join("\n"), /KNOT_COUPON_SIGNUP/);
});

test("runtime validation treats an unrecognised issued tier or status as data, not an error", () => {
  // 这一条锁的是一类事故：中枢换了档位词表，实例侧却没跟上，Backend 拒绝启动，
  // 而启动正是它去拉中枢正确值的唯一途径——于是它永远起不来。
  // 签发区的取值由中枢决定，这一侧不认识也要照常启动。
  const result = checkRuntime({
    PORT: "8080",
    KNOT_ADMIN_EMAIL: "admin@example.com",
    XKNOT_INSTANCE_ID: "wang",
    XKNOT_ISSUED_TIER: "premium",
    XKNOT_ISSUED_STATUS: "frozen",
  });
  assert.deepEqual(result.errors, []);
});

test("runtime validation warns on a missing admin email", () => {
  const result = checkRuntime({});
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((message) => message.includes("KNOT_ADMIN_EMAIL")));
});

test("runtime validation ignores the deploy keys scripts export into the process", () => {
  // 部署脚本会 set -a 把 site.env 导出给子进程，KNOT_DEPLOY_ROOT、KNOT_APP_DIR
  // 这类脚本变量也不是 schema 键。运行时只看值对不对，不逐键报未知。
  const result = checkRuntime({
    KNOT_PUBLIC_ORIGIN: "https://knot.example.com",
    PUBLIC_WEB_ORIGIN: "https://knot.example.com",
    KNOT_DEPLOY_ROOT: "/srv/knot",
    KNOT_SITES_DIR: "/srv/knot/sites",
    KNOT_APP_DIR: "/srv/knot/current",
    KNOT_ADMIN_EMAIL: "admin@example.com",
    DATABASE_URL: "postgres://knot@127.0.0.1:5433/knot",
    SMTP_PORT: "587",
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test("unknown keys are still caught when the file is written", () => {
  const result = checkPlatform("KNOT_SITE_NAM=typo\n");
  assert.ok(result.warnings.some((message) => message.includes("KNOT_SITE_NAM")));
});

// 0.9.0 把 Linux 实例主机连同它的两个配置项一起移出 main。旧机器上还在的文件要
// 说清「这一行已经没用」，而不是和拼错的键一样只报一句「不在登记表里」。
test("retired keys say they are gone instead of looking like a typo", () => {
  const platform = checkPlatform("KNOT_SYSTEMD_DIR=/etc/systemd/system\nDATABASE_URL=postgres://knot@127.0.0.1:5433/knot\n");
  assert.deepEqual(platform.errors, []);
  assert.ok(platform.warnings.some((message) => message.includes("KNOT_SYSTEMD_DIR") && message.includes("已经删除")));
  assert.ok(!platform.warnings.some((message) => message.includes("可能拼错了")));

  const site = checkSite({
    KNOT_ADMIN_EMAIL: "admin@example.com",
    KNOT_BACKUP_DIR: "/backups",
    KNOT_SERVICE_USER: "knot",
  });
  assert.deepEqual(site.errors, []);
  assert.ok(site.warnings.some((message) => message.includes("KNOT_SERVICE_USER") && message.includes("已经删除")));
  assert.ok(!site.warnings.some((message) => message.includes("可能拼错了")));

});

// ---- XKnot 接入与部署分开 ----

test("a join file needs an instance id and a token for relay", () => {
  assert.deepEqual(checkJoin("").errors, []);

  const missing = checkJoin("XKNOT_HUB_ORIGIN=https://xknot.si\n");
  assert.ok(missing.errors.some((message) => message.includes("XKNOT_INSTANCE_ID")));

  // 地址能从中枢地址推导，所以带凭据不带地址是合法的。
  const derived = checkJoin("XKNOT_INSTANCE_ID=wang\nXKNOT_HUB_RELAY_TOKEN=xkr_wang_0123456789abcdef\n");
  assert.deepEqual(derived.errors, []);

  // 反过来，写了地址却没有凭据就发不出去。
  const orphan = checkJoin("XKNOT_INSTANCE_ID=wang\nXKNOT_HUB_RELAY_URL=https://xknot.si/api/federation/mail\n");
  assert.ok(orphan.errors.some((message) => message.includes("XKNOT_HUB_RELAY_TOKEN")));

  const good = checkJoin(
    [
      "XKNOT_INSTANCE_ID=wang",
      "XKNOT_HUB_RELAY_URL=https://xknot.si/api/federation/mail",
      "XKNOT_HUB_RELAY_TOKEN=xkr_wang_0123456789abcdef",
    ].join("\n")
  );
  assert.deepEqual(good.errors, []);
});

test("a join file rejects bad ids, bad tokens and deployment keys", () => {
  const bad = checkJoin(
    [
      "XKNOT_INSTANCE_ID=Wang_Hub",
      "XKNOT_HUB_RELAY_TOKEN=not-a-token",
      "KNOT_DOMAIN=knot.example.com",
      "SMTP_PASS=hunter2",
    ].join("\n")
  );
  const text = bad.errors.join("\n");
  assert.match(text, /XKNOT_INSTANCE_ID/);
  assert.match(text, /XKNOT_HUB_RELAY_TOKEN/);
  assert.match(text, /KNOT_DOMAIN.*site\.env/);
  assert.match(text, /SMTP_PASS.*platform\.env/);
});

test("a join file warns when the credentials are readable by others", () => {
  const text = "XKNOT_INSTANCE_ID=wang\nXKNOT_HUB_RELAY_TOKEN=xkr_wang_0123456789abcdef\n";
  assert.deepEqual(checkJoin(text, { mode: 0o600 }).warnings, []);
  assert.ok(checkJoin(text, { mode: 0o644 }).warnings.some((message) => message.includes("chmod 600")));
});
test("deployment files reject keys that belong to the join file", () => {
  const site = checkSite({ KNOT_ADMIN_EMAIL: "a@example.com", XKNOT_INSTANCE_ID: "wang" });
  assert.ok(site.errors.some((message) => message.includes("xknot.env")));

  const platform = checkPlatform("XKNOT_HUB_RELAY_TOKEN=xkr_wang_0123456789abcdef\n");
  assert.ok(platform.errors.some((message) => message.includes("xknot.env")));
});

test("bootstrap defaults come from the schema instead of a second copy", () => {
  const envKeys = [
    "PORT",
    "BIND_HOST",
    "DATABASE_URL",
    "SESSION_COOKIE_NAME",
    "PUBLIC_WEB_ORIGIN",
    "STATIC_WEB_DIR",
    "UPLOAD_DIR",
    "KNOT_AGENT_ENV_DIR",
  ];
  const saved = new Map(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  try {
    const config = loadBootstrapConfig();
    const byKey = new Map(KEYS.map((entry) => [entry.key, entry]));
    const expected = (key) => resolve(byKey.get(key), {}, { root: ROOT, deployRoot: ROOT, expand: true });
    assert.equal(String(config.port), expected("KNOT_PORT"));
    assert.equal(config.bindHost, expected("KNOT_BIND_HOST"));
    assert.equal(config.sessionCookieName, expected("KNOT_SESSION_COOKIE_NAME"));
    assert.equal(config.publicWebOrigin, expected("KNOT_PUBLIC_ORIGIN"));
    // 站点身份不在环境变量里：它在 sites/<站点>/profile.json，由主理人编辑。
    assert.equal(config.siteName, undefined);
    assert.equal(config.siteTagline, undefined);
    assert.equal(config.uploadDir, path.resolve(expected("KNOT_UPLOAD_DIR")));
    assert.equal(config.databaseUrl, `postgres://knot@127.0.0.1:${expected("KNOT_PGPORT")}/knot`);
    // 静态目录由部署脚本写 STATIC_WEB_DIR；没有它就不接管页面。
    assert.equal(config.staticWebDir, null);
  } finally {
    for (const [key, value] of saved) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


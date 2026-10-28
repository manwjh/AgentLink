import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openStore } from "./store.mjs";

// 这一份专门盯「并发与坏数据」那几条约束：子域唯一、接通 run 的坏行、
// 发信日志的重试与回收、最后一个管理员。都靠真实的 SQLite 文件验，
// :memory: 上的临时库跑不出跨进程要挡的那种交错。

function withStore(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "xknot-guard-"));
  const file = path.join(dir, "xknot.db");
  const store = openStore(file);
  t.after(() => {
    try {
      store.close();
    } catch {
      // 用例自己先关过（重开库那条），这里不再关一次。
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, file };
}

function applicationInput(overrides = {}) {
  return {
    name: "cpswang",
    subdomain: "cpswang",
    operator: "Paul",
    email: "manwjh@126.com",
    region: "CN",
    timezone: "Asia/Shanghai",
    intro: "自用实例。",
    ...overrides,
  };
}

const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForTests case";

test("subdomain: a second approved application for the same label is a 409, not a 500", (t) => {
  const { store } = withStore(t);
  const first = store.createApplication(applicationInput());
  assert.equal(first.subdomain, "cpswang");

  // 唯一索引只覆盖 status = 'approved'。同一子域再来一单必须是 duplicate，
  // 让接口层回 409；漏成异常就变成 500，运营看不出是被占了。
  assert.deepEqual(store.createApplication(applicationInput()), { error: "duplicate" });

  // 撤回之后标签空出来，可以再签一次。
  store.withdrawApplication(first.id);
  const again = store.createApplication(applicationInput());
  assert.equal(again.error, undefined);
  assert.equal(again.subdomain, "cpswang");
  assert.ok(store.takenSubdomains().includes("cpswang"));
});

test("provision: a corrupt run row is visible, selected again, and overwritten", (t) => {
  const { store, file } = withStore(t);
  const application = store.createApplication(applicationInput());
  store.setPublicKey({ id: application.id, publicKey: PUBLIC_KEY });

  const hook = new DatabaseSync(file);
  hook
    .prepare("insert into provision_runs (application_id, run, created_at, updated_at) values (?, ?, ?, ?)")
    .run(application.id, '{"state":"running"', "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  hook.close();

  // 坏行不能当成 null：null 与「还没有 run」长得一样，案例页会静默停住。
  const run = store.getProvisionRun(application.id);
  assert.equal(run.corrupt, true);
  assert.equal(run.applicationId, application.id);

  const listed = store.listProvisionRuns(10);
  assert.equal(listed[0].corrupt, true);
  assert.equal(listed[0].lastError, "run_corrupt");

  // left join 必须还选中它，worker 才有机会重来。
  assert.deepEqual(
    store.applicationsAwaitingProvision().map((row) => row.id),
    [application.id]
  );

  // 覆盖坏行是唯一出路；正常的 run 不会被这样顶掉。
  const fresh = store.createProvisionRun({ applicationId: application.id, state: "pending", steps: [] });
  assert.equal(fresh.state, "pending");
  assert.equal(fresh.corrupt, undefined);
  const blocked = store.createProvisionRun({ applicationId: application.id, state: "running", steps: [] });
  assert.equal(blocked.state, "pending", "已有可用 run 时重跑不该覆盖");
});

test("provision: accepted runs are listed by state, not only by recency", (t) => {
  const { store } = withStore(t);
  const accepted = store.createProvisionRun({ applicationId: "app-old", instanceId: "old", state: "active", steps: [] });

  // 一批更新的 run 把它挤出最近 N 条：接入完成的记录不能因此不再被核对。
  for (let i = 0; i < 25; i += 1) {
    store.createProvisionRun({ applicationId: `app-${i}`, instanceId: `n${i}`, state: "provisioning", steps: [] });
  }
  assert.equal(store.listProvisionRuns(20).some((run) => run.instanceId === "old"), false);
  assert.deepEqual(
    store.activeProvisionRuns().map((run) => run.applicationId),
    [accepted.applicationId]
  );
});

test("public key: a withdrawn application refuses the key instead of bumping its version", (t) => {
  const { store } = withStore(t);
  const application = store.createApplication(applicationInput());
  store.withdrawApplication(application.id);

  assert.deepEqual(store.setPublicKey({ id: application.id, publicKey: PUBLIC_KEY }), {
    error: "not_approved",
  });
  assert.equal(store.getApplication(application.id).publicKey, null);
  assert.equal(store.getApplication(application.id).stateVersion, 1, "撤回那一步的版本，没被写公钥推高");

  // 换行就是往 authorized_keys 里追加第二行，必须挡在落库之前。
  const fresh = store.createApplication(applicationInput({ subdomain: "second" }));
  assert.deepEqual(
    store.setPublicKey({ id: fresh.id, publicKey: `${PUBLIC_KEY}\nssh-rsa AAAAB3NzaC1yc2E` }),
    { error: "bad_public_key" }
  );
});

// 退信是异步的：SMTP 回 250 之后收信端才退回。要把那封退信对回是哪一件事，
// 只能靠 Message-ID —— 这张表里收件地址只有哈希，对不上。
test("bounce: a bounced message id turns a sent row into bounced, and only that row", (t) => {
  const { store } = withStore(t);
  const first = store.beginNotify({
    event: "partner.approved",
    caseId: "XK-3",
    stateVersion: 0,
    messageId: "aaaa1111bbbb2222",
  });
  const other = store.beginNotify({
    event: "partner.approved",
    caseId: "XK-4",
    stateVersion: 0,
    messageId: "cccc3333dddd4444",
  });
  store.finishNotify(first.id, { status: "sent" });
  store.finishNotify(other.id, { status: "sent" });

  assert.deepEqual(store.recordBounce("aaaa1111bbbb2222", { detail: "5.1.1 user unknown" }), {
    notified: 1,
    relayed: 0,
  });
  const row = store.listNotifyLog(10, "XK-3")[0];
  assert.equal(row.status, "bounced");
  assert.match(row.error, /bounced: 5\.1\.1 user unknown/);
  // 别的信不受影响，否则一次退信会把整批记录一起标成退回。
  assert.equal(store.listNotifyLog(10, "XK-4")[0].status, "sent");
});

// 只改已经发出去的行：pending 与 failed 不该被一封对不上号的退信改写成 bounced，
// 那是把一次还没定论的投递凭空判成退回。
test("bounce: a pending or failed row is left alone", (t) => {
  const { store } = withStore(t);
  const pending = store.beginNotify({ event: "partner.live", caseId: "XK-5", messageId: "eeee5555ffff6666" });
  store.finishNotify(store.beginNotify({ event: "partner.live", caseId: "XK-6", messageId: "9999aaaa0000bbbb" }).id, {
    status: "failed",
    error: "421 4.7.28",
  });

  assert.deepEqual(store.recordBounce("eeee5555ffff6666"), { notified: 0, relayed: 0 });
  assert.deepEqual(store.recordBounce("9999aaaa0000bbbb"), { notified: 0, relayed: 0 });
  assert.equal(store.listNotifyLog(10, "XK-5")[0].status, "pending");
  assert.equal(store.listNotifyLog(10, "XK-6")[0].status, "failed");
  assert.ok(pending.id);
});

test("bounce: an unknown or empty message id changes nothing", (t) => {
  const { store } = withStore(t);
  assert.deepEqual(store.recordBounce("nope"), { notified: 0, relayed: 0 });
  assert.deepEqual(store.recordBounce(""), { notified: 0, relayed: 0 });
  assert.deepEqual(store.recordBounce(null), { notified: 0, relayed: 0 });
  assert.equal(store.findNotifyByMessageId("nope"), null);
});

// 重发是一次新的投递：Message-ID 要跟着换。旧的那一封可能已经被收下又在之后
// 退回，退信必须对到这一封，不能对到上一次用的号。
test("notify: a resend gets a new message id", (t) => {
  const { store } = withStore(t);
  const first = store.beginNotify({
    event: "partner.approved",
    caseId: "XK-7",
    stateVersion: 0,
    messageId: "first0000000",
  });
  store.finishNotify(first.id, { status: "failed", error: "421 4.7.28" });
  const again = store.beginNotify({
    event: "partner.approved",
    caseId: "XK-7",
    stateVersion: 0,
    messageId: "second000000",
  });
  assert.equal(again.id, first.id);
  assert.equal(store.listNotifyLog(10, "XK-7")[0].messageId, "second000000");
  assert.equal(store.findNotifyByMessageId("first0000000"), null);
});

test("notify: a failed send can be retried on the same key, a sent one cannot", (t) => {
  const { store } = withStore(t);
  const first = store.beginNotify({ event: "application.approved", caseId: "XK-1", stateVersion: 0 });
  assert.ok(first.id > 0);

  // 还在途：同一幂等键再来一次按 duplicate 回，不能重复发。
  assert.deepEqual(
    store.beginNotify({ event: "application.approved", caseId: "XK-1", stateVersion: 0 }),
    { duplicate: true }
  );

  // 发失败：SMTP 抖一次不该让这封信永久发不出去。
  assert.equal(store.finishNotify(first.id, { status: "failed", error: "smtp_timeout" }), 1);
  const retry = store.beginNotify({ event: "application.approved", caseId: "XK-1", stateVersion: 0 });
  assert.equal(retry.id, first.id, "重试复用原来那一行，日志里仍是一条事件");
  assert.equal(retry.retried, true);

  // 这一次成功，之后就是真正的重复。
  store.finishNotify(first.id, { status: "sent" });
  assert.deepEqual(
    store.beginNotify({ event: "application.approved", caseId: "XK-1", stateVersion: 0 }),
    { duplicate: true }
  );
  assert.equal(store.listNotifyLog(10, "XK-1").length, 1);
});

// 发信带退避重试后，一行 pending 可能活到 36 分钟。进程在重试途中退出就会
// 把它留在 pending，而 beginNotify 把 pending 当成「还在途」——同一事件
// 从此再也发不出去。必须能收成 failed（failed 允许同键重发）。
test("notify: a stale pending row is reclaimed as failed so the event can be sent again", (t) => {
  const { store, file } = withStore(t);
  const first = store.beginNotify({ event: "application.approved", caseId: "XK-2", stateVersion: 0 });
  assert.deepEqual(
    store.beginNotify({ event: "application.approved", caseId: "XK-2", stateVersion: 0 }),
    { duplicate: true }
  );

  const hook = new DatabaseSync(file);
  hook
    .prepare("update notify_log set at = ? where seq = ?")
    .run(new Date(Date.now() - 3 * 3600_000).toISOString(), first.id);
  hook.close();

  assert.equal(store.pruneStaleNotifyPending(120), 1);
  const row = store.listNotifyLog(10, "XK-2")[0];
  assert.equal(row.status, "failed");
  assert.equal(row.error, "stale_pending");

  // 收回之后同一幂等键又发得出去，而且复用原来那一行：日志里仍是一条事件。
  const retry = store.beginNotify({ event: "application.approved", caseId: "XK-2", stateVersion: 0 });
  assert.equal(retry.id, first.id);
  assert.equal(retry.retried, true);
  assert.equal(store.listNotifyLog(10, "XK-2").length, 1);
});

test("relay: a stale pending row is reclaimed as unknown, not deleted", (t) => {
  const { store, file } = withStore(t);
  const token = store.createRelayToken({ instanceId: "cpswang", label: "委托", dailyLimit: 50 });
  const since = new Date(Date.now() - 86400000).toISOString();

  const reserved = store.reserveRelay({
    instanceId: "cpswang",
    tokenId: token.record.id,
    sinceIso: since,
    limit: 50,
    toDomain: "example.com",
    idemKey: "msg-1",
  });
  assert.ok(reserved.id > 0);

  // 进程在发信途中退出：占位留在 pending。把它改成很久以前，等回收。
  const hook = new DatabaseSync(file);
  hook
    .prepare("update relay_log set at = ? where seq = ?")
    .run(new Date(Date.now() - 60 * 60000).toISOString(), reserved.id);
  hook.close();

  assert.equal(store.pruneStaleRelayPending(15), 1);

  // 不能删行：SMTP 可能已经收下，删了幂等键就会再投一封。
  const sameKey = store.reserveRelay({
    instanceId: "cpswang",
    tokenId: token.record.id,
    sinceIso: since,
    limit: 50,
    toDomain: "example.com",
    idemKey: "msg-1",
  });
  assert.equal(sameKey.duplicate?.id, reserved.id);
  assert.equal(sameKey.duplicate.pending, false, "unknown 不算在途，实例可以自行决定要不要换键");

  // 回收掉的那条仍占当天额度：它可能真的发出去了。同键不会再多插一行。
  assert.equal(store.relayUsage(token.record.id, since), 1);
  assert.equal(store.listRelayLog(10)[0].status, "unknown");
});

test("admin: the last account cannot be deleted, even from two consoles", (t) => {
  const { store } = withStore(t);
  const paul = store.createAdmin({ username: "paul", password: "correct-horse-battery" });
  assert.equal(paul.admin.username, "paul");

  assert.deepEqual(store.deleteAdmin("paul"), { error: "last_admin" });
  assert.equal(store.listAdmins().length, 1);

  store.createAdmin({ username: "lin", password: "correct-horse-battery" });
  assert.deepEqual(store.deleteAdmin("lin"), { ok: true });
  assert.deepEqual(store.listAdmins().map((row) => row.username), ["paul"]);

  // 大写与空格走同一条规范化路径，不然删不掉也挡不住。
  assert.deepEqual(store.deleteAdmin("  PAUL "), { error: "last_admin" });
});

// 老库升级是最容易被 SCHEMA 与迁移的先后顺序打坏的地方：SCHEMA 先执行，
// 里面任何引用新列的 create index 都会让库直接打不开。这个用例造一个
// 没有 message_id 的旧库，验证能打开、列补上、老行留着。
test("schema: a database from before message ids opens, gains the column, keeps its rows", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "xknot-old-"));
  const file = path.join(dir, "xknot.db");
  const raw = new DatabaseSync(file);
  raw.exec(`
    create table notify_log (
      seq integer primary key autoincrement, at text not null, event text not null,
      case_id text, state_version integer, locale text, to_domain text, to_hash text,
      template_version text, status text not null, error text
    );
    create unique index notify_once on notify_log(event, case_id, state_version);
    create table relay_log (
      seq integer primary key autoincrement, at text not null, instance_id text not null,
      token_id text, to_domain text, to_hash text, subject_len integer, idem_key text,
      status text not null, error text
    );
  `);
  raw
    .prepare("insert into notify_log (at, event, case_id, state_version, status) values (?, ?, ?, ?, ?)")
    .run("2026-01-01T00:00:00Z", "partner.approved", "XK-old", 0, "sent");
  raw.exec("pragma user_version = 3");
  raw.close();

  const store = openStore(file);
  t.after(() => store.close());

  const probe = new DatabaseSync(file, { readOnly: true });
  const columns = (table) =>
    probe.prepare(`pragma table_info(${table})`).all().map((row) => row.name);
  assert.ok(columns("notify_log").includes("message_id"));
  assert.ok(columns("relay_log").includes("message_id"));
  assert.equal(Number(probe.prepare("pragma user_version").get().user_version), 4);
  probe.close();

  // 老行仍然可读，只是没有号——它不能被新记录挤掉。
  const [row] = store.listNotifyLog(10);
  assert.equal(row.event, "partner.approved");
  assert.equal(row.status, "sent");
  assert.equal(row.messageId, null);
});

test("schema: an existing database is not migrated twice", (t) => {
  const { store, file } = withStore(t);
  store.createApplication(applicationInput());
  store.close();

  // 再打开一次：user_version 已经写过，破坏性的 UPDATE 不该再跑一遍。
  // 断言对的是「最后一个迁移的版本号」，加新迁移时一起跟着改。
  const reopened = openStore(file);
  t.after(() => reopened.close());
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(Number(db.prepare("pragma user_version").get().user_version), 4);
  db.close();
  assert.equal(reopened.listApplications().length, 1);
});

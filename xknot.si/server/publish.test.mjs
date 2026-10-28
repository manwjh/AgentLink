// 自动接通的发布步骤：清单与名册一起写，重跑不重复。
//
// 这里用临时目录里的两份真文件跑，校验器就是构建时用的那一套；
// 所以「能发布」与「能构建」不会得出两个结论。

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { markActive, markRosterLive, publishInstance } from "./publish.mjs";
import { validateInstances } from "../ops/validate-instances.mjs";
import { validateRoster } from "../ops/validate-federation.mjs";

const APP = {
  id: "XK-2026-M5CMKG",
  name: "cpswang",
  subdomain: "cpswang",
  url: "https://cpswang.xknot.si",
  email: "manwjh@126.com",
};

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xknot-publish-"));
  const manifestFile = path.join(dir, "instances.json");
  const rosterFile = path.join(dir, "federation.json");
  const manifest = {
    version: 5,
    updatedAt: "2026-10-19",
    instances: [{ id: "wang", url: "https://wang.xknot.si", since: "2026-10-19", tier: "paid", status: "active" }],
  };
  const roster = {
    version: 1,
    updatedAt: "2026-10-19",
    hub: "xknot.si",
    members: [
      {
        id: "wang",
        host: "wang.xknot.si",
        role: "founder",
        standing: "permanent",
        tunnel: { account: "knot-tunnel", port: 18080 },
        listed: true,
        since: "2026-10-19",
        mode: "subdomain",
      },
    ],
  };
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(rosterFile, `${JSON.stringify(roster, null, 2)}\n`);
  return { dir, manifestFile, rosterFile };
}

test("publish: writes both files and both pass the build validators", async () => {
  const { manifestFile, rosterFile } = await fixture();
  const result = await publishInstance({
    application: APP,
    tunnelAccount: "knot-tunnel-cpswang",
    tunnelPort: 18090,
    manifestFile,
    rosterFile,
  });

  assert.equal(result.entry.id, "cpswang");
  assert.equal(result.entry.tier, "free");
  assert.equal(result.entry.status, "pending");
  assert.equal(result.skipped, false);

  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const roster = JSON.parse(await readFile(rosterFile, "utf8"));
  assert.deepEqual(validateInstances(manifest), []);
  assert.deepEqual(validateRoster(roster, manifest), []);
  assert.deepEqual(roster.members.find((m) => m.id === "cpswang").tunnel, {
    account: "knot-tunnel-cpswang",
    port: 18090,
  });
});

test("publish: a failed manifest write rolls the roster back", async () => {
  const { manifestFile, rosterFile } = await fixture();
  const rosterBefore = await readFile(rosterFile, "utf8");

  // 名册写入成功、清单写入抛错：名册必须回滚到原值，不留下「名册有、清单无」。
  const write = async (file, value) => {
    if (file === manifestFile) throw new Error("disk full");
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };

  await assert.rejects(
    publishInstance({
      application: APP,
      tunnelAccount: "knot-tunnel-cpswang",
      tunnelPort: 18090,
      manifestFile,
      rosterFile,
      write,
    }),
    /disk full/
  );

  assert.equal(await readFile(rosterFile, "utf8"), rosterBefore, "名册回滚到改动前");
});

test("publish: running it again changes nothing", async () => {
  const { manifestFile, rosterFile } = await fixture();
  const args = {
    application: APP,
    tunnelAccount: "knot-tunnel-cpswang",
    tunnelPort: 18090,
    manifestFile,
    rosterFile,
  };
  await publishInstance(args);
  const before = await readFile(manifestFile, "utf8");
  const second = await publishInstance(args);
  assert.equal(second.skipped, true);
  assert.equal(await readFile(manifestFile, "utf8"), before);
});

test("publish: the same address under another id is refused", async () => {
  const { manifestFile, rosterFile } = await fixture();
  await writeFile(
    manifestFile,
    `${JSON.stringify(
      {
        version: 5,
        updatedAt: "2026-10-19",
        instances: [
          { id: "wang", url: "https://wang.xknot.si", since: "2026-10-19", tier: "paid", status: "active" },
          { id: "cps-1", url: "https://cpswang.xknot.si", since: "2026-10-19", tier: "free", status: "pending" },
        ],
      },
      null,
      2
    )}\n`
  );
  const result = await publishInstance({
    application: APP,
    tunnelAccount: "knot-tunnel-cpswang",
    tunnelPort: 18090,
    manifestFile,
    rosterFile,
  });
  // 同一地址已经挂在别的 id 下，不能再塞一条。
  assert.equal(result.error, "url_taken");
});

test("publish: a roster write that breaks validation leaves the manifest alone", async () => {
  const { manifestFile, rosterFile } = await fixture();
  const before = await readFile(manifestFile, "utf8");
  const result = await publishInstance({
    application: APP,
    tunnelAccount: "Bad Account",
    tunnelPort: 80,
    manifestFile,
    rosterFile,
  });
  assert.equal(result.error, "roster_invalid");
  assert.equal(await readFile(manifestFile, "utf8"), before);
});

test("active: flips the published entry only, twice is a no-op", async () => {
  const { manifestFile, rosterFile } = await fixture();
  await publishInstance({
    application: APP,
    tunnelAccount: "knot-tunnel-cpswang",
    tunnelPort: 18090,
    manifestFile,
    rosterFile,
  });

  assert.equal((await markActive({ manifestFile, id: "cpswang" })).changed, true);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  assert.equal(manifest.instances.find((item) => item.id === "cpswang").status, "active");
  assert.deepEqual(validateInstances(manifest), []);
  assert.equal((await markActive({ manifestFile, id: "cpswang" })).changed, false);
  assert.equal((await markActive({ manifestFile, id: "nope" })).error, "not_listed");
});

test("active: a suspended or retired entry is not flipped back", async () => {
  for (const status of ["suspended", "retired"]) {
    const { manifestFile, rosterFile } = await fixture();
    await publishInstance({
      application: APP,
      tunnelAccount: "knot-tunnel-cpswang",
      tunnelPort: 18090,
      manifestFile,
      rosterFile,
    });
    // 运营在清单上按下暂停/下架：worker 每一轮仍会调用 markActive，
    // 只有 pending 才允许迁入，否则这个决定下一轮就被改回去。
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.instances.find((item) => item.id === "cpswang").status = status;
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = await markActive({ manifestFile, id: "cpswang" });
    assert.equal(result.error, "not_pending");
    assert.equal(result.status, status);
    const after = JSON.parse(await readFile(manifestFile, "utf8"));
    assert.equal(after.instances.find((item) => item.id === "cpswang").status, status);
  }
});

test("publish: two workers publishing at the same moment keep both entries", async () => {
  const { manifestFile, rosterFile } = await fixture();
  const second = {
    id: "XK-2026-SECOND",
    name: "second",
    subdomain: "second",
    url: "https://second.xknot.si",
    email: "second@example.test",
  };

  // 两个写者各自「读-改-写」同一份清单：没有锁时后写的那份会把前一个刚加的
  // 条目盖回去，两个都以为自己成功。这里同时发起，要求两条都留在文件里。
  const [first, other] = await Promise.all([
    publishInstance({
      application: APP,
      tunnelAccount: "knot-tunnel-cpswang",
      tunnelPort: 18090,
      manifestFile,
      rosterFile,
    }),
    publishInstance({
      application: second,
      tunnelAccount: "knot-tunnel-second",
      tunnelPort: 18091,
      manifestFile,
      rosterFile,
    }),
  ]);
  assert.equal(first.error, undefined, JSON.stringify(first));
  assert.equal(other.error, undefined, JSON.stringify(other));

  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const roster = JSON.parse(await readFile(rosterFile, "utf8"));
  assert.deepEqual(manifest.instances.map((item) => item.id).sort(), ["cpswang", "second", "wang"]);
  assert.deepEqual(roster.members.map((item) => item.id).sort(), ["cpswang", "second", "wang"]);
  assert.deepEqual(validateInstances(manifest), []);
  assert.deepEqual(validateRoster(roster, manifest), []);
});

test("roster: acceptance replaces the placeholder note, not a written one", async () => {
  // 发布时写的是「等待接通验收」。节点通了还留着这句，运营在总览里看到的
  // 就是一条尾巴。只换这一句默认话，手写备注一律不动。
  const { manifestFile, rosterFile } = await fixture();
  await publishInstance({
    application: APP,
    tunnelAccount: "knot-tunnel-cpswang",
    tunnelPort: 18090,
    manifestFile,
    rosterFile,
  });
  await markActive({ manifestFile, id: "cpswang" });

  const first = await markRosterLive({ manifestFile, rosterFile, id: "cpswang", now: new Date("2026-10-23T10:00:00Z") });
  assert.deepEqual(first, { ok: true, changed: true });
  let roster = JSON.parse(await readFile(rosterFile, "utf8"));
  const member = roster.members.find((item) => item.id === "cpswang");
  assert.equal(member.note, "已接通，门户已收录（2026-10-23）。");
  assert.equal(roster.updatedAt, "2026-10-23");

  // 再跑一次：已经不是那句占位话，什么都不做。
  assert.deepEqual(await markRosterLive({ manifestFile, rosterFile, id: "cpswang" }), { ok: true, changed: false });

  // 运营手写的备注不被覆盖。
  member.note = "自营机房，夜间维护";
  await writeFile(rosterFile, `${JSON.stringify(roster, null, 2)}\n`);
  assert.deepEqual(await markRosterLive({ manifestFile, rosterFile, id: "cpswang" }), { ok: true, changed: false });
  roster = JSON.parse(await readFile(rosterFile, "utf8"));
  assert.equal(roster.members.find((item) => item.id === "cpswang").note, "自营机房，夜间维护");
});

test("roster: an id that is not in the roster reports it instead of writing", async () => {
  const { manifestFile, rosterFile } = await fixture();
  assert.deepEqual(await markRosterLive({ manifestFile, rosterFile, id: "ghost" }), { error: "not_listed" });
});

test("roster: the note update shares the manifest lock with publish", async () => {
  // 发布与改备注都是「读名册 - 改名册」。若各拿一把锁，两者就会交错：
  // 先读后写的那个把另一个刚写进去的内容整份盖回去。
  const { manifestFile, rosterFile } = await fixture();
  await publishInstance({
    application: APP,
    tunnelAccount: "knot-tunnel-cpswang",
    tunnelPort: 18090,
    manifestFile,
    rosterFile,
  });

  // 让发布的落盘慢一拍：锁没共享时，备注那一路会拿着旧副本在它之后写回。
  const slowWrite = async (file, value) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  const [, note] = await Promise.all([
    publishInstance({
      application: { ...APP, id: "XK-2026-NEWONE", subdomain: "newone", url: "https://newone.xknot.si" },
      tunnelAccount: "knot-tunnel-newone",
      tunnelPort: 18099,
      manifestFile,
      rosterFile,
      write: slowWrite,
    }),
    markRosterLive({ manifestFile, rosterFile, id: "cpswang", now: new Date("2026-10-23T10:00:00Z") }),
  ]);

  assert.deepEqual(note, { ok: true, changed: true });
  const roster = JSON.parse(await readFile(rosterFile, "utf8"));
  assert.ok(roster.members.some((member) => member.id === "newone"), "the concurrently published member must survive");
  assert.equal(
    roster.members.find((member) => member.id === "cpswang").note,
    "已接通，门户已收录（2026-10-23）。"
  );
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  assert.ok(manifest.instances.some((instance) => instance.id === "newone"));
});

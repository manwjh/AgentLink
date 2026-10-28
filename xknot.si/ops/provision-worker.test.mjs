import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// 这个模块在 import 时就会打开 dataDir 下的库：先把它指到临时目录，
// 别让跑测试在仓库里落一份 var/xknot.db。
const dataDir = await mkdtemp(path.join(tmpdir(), "xknot-worker-"));
process.env.XKNOT_DATA_DIR = dataDir;

const { announceLive, dueRuns, reconcileActive } = await import("./provision-worker.mjs");
const { markActive, markRosterLive, publishInstance } = await import("../server/publish.mjs");

after(() => rm(dataDir, { recursive: true, force: true }));

const APP = {
  id: "XK-2026-WORKER",
  name: "cpswang",
  subdomain: "cpswang",
  url: "https://cpswang.xknot.si",
  email: "manwjh@126.com",
};

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "xknot-worker-files-"));
  const manifestFile = path.join(dir, "instances.json");
  const rosterFile = path.join(dir, "federation.json");
  await writeFile(
    manifestFile,
    `${JSON.stringify(
      {
        version: 1,
        updatedAt: "2026-10-19",
        instances: [{ id: "wang", url: "https://wang.xknot.si", since: "2026-10-19", tier: "paid", status: "active" }],
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    rosterFile,
    `${JSON.stringify(
      {
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
      },
      null,
      2
    )}\n`
  );
  return { dir, manifestFile, rosterFile };
}

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

function deps(files, overrides = {}) {
  const lines = [];
  const events = [];
  return {
    lines,
    events,
    ...{
      store: {
        getApplication: (id) => (id === APP.id ? { ...APP, status: "approved" } : null),
        recordEvent: (event, id) => events.push(`${event}:${id}`),
      },
      host: {},
      log: (line) => lines.push(line),
      manifestFile: files.manifestFile,
      rosterFile: files.rosterFile,
      markActive,
      markRosterLive,
      publishInstance,
      switchEntry: async () => ({ changed: false }),
      refreshPortal: () => lines.push("portal:refresh"),
      warmEntryCache: () => {},
      notifyLive: async () => ({ sent: true, id: 1 }),
    },
    ...overrides,
  };
}

// 每个用例用不同的 instanceId：核对节流按 id 记在模块级，共用会互相压掉。
function runOf(instanceId, extra = {}) {
  return {
    applicationId: APP.id,
    instanceId,
    host: `${instanceId}.xknot.si`,
    account: `knot-tunnel-${instanceId}`,
    port: 18095,
    state: "active",
    steps: [],
    ...extra,
  };
}

test("active: a manifest entry that disappeared is rebuilt from the run", async () => {
  const files = await fixture();
  const d = deps(files);
  const run = runOf("cpswang");

  await reconcileActive(run, d);

  const manifest = await readJson(files.manifestFile);
  const entry = manifest.instances.find((item) => item.id === "cpswang");
  assert.equal(entry.status, "active");
  assert.equal(entry.url, "https://cpswang.xknot.si");

  const roster = await readJson(files.rosterFile);
  const member = roster.members.find((item) => item.id === "cpswang");
  assert.deepEqual(member.tunnel, { account: "knot-tunnel-cpswang", port: 18095 });
  // 补回来之后名册那句话也得改成实情，不能停在「等待接通验收」。
  assert.ok(member.note.startsWith("已接通"), member.note);
  assert.deepEqual(d.events, ["instance.manifest_restored:cpswang"]);
  assert.ok(d.lines.includes("portal:refresh"));
});

test("active: a run without a matching application is reported, not guessed", async () => {
  const files = await fixture();
  const d = deps(files, { store: { getApplication: () => null, recordEvent: () => {} } });

  await reconcileActive(runOf("ghostnode"), d);

  assert.deepEqual((await readJson(files.manifestFile)).instances.map((item) => item.id), ["wang"]);
  assert.ok(d.lines.some((line) => line.includes("无法补回")));
});

test("active: a withdrawn application is not put back on the portal", async () => {
  const files = await fixture();
  const d = deps(files, {
    store: { getApplication: () => ({ ...APP, status: "withdrawn" }), recordEvent: () => {} },
  });

  await reconcileActive(runOf("leftbehind"), d);

  assert.deepEqual((await readJson(files.manifestFile)).instances.map((item) => item.id), ["wang"]);
  assert.ok(d.lines.some((line) => line.includes("不补回清单")));
});

test("active: a suspended entry is not flipped back, and says so once", async () => {
  const files = await fixture();
  await publishInstance({
    application: APP,
    tunnelAccount: "knot-tunnel-cpswang",
    tunnelPort: 18095,
    manifestFile: files.manifestFile,
    rosterFile: files.rosterFile,
  });
  await markActive({ manifestFile: files.manifestFile, id: "cpswang" });
  const manifest = await readJson(files.manifestFile);
  manifest.instances.find((item) => item.id === "cpswang").status = "suspended";
  await writeFile(files.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  const d = deps(files);
  const run = runOf("cpswang");
  await reconcileActive(run, d);
  await reconcileActive(run, d);

  assert.equal(
    (await readJson(files.manifestFile)).instances.find((item) => item.id === "cpswang").status,
    "suspended"
  );
  assert.equal(d.lines.filter((line) => line.includes("不是 pending")).length, 1);
});

test("active: the entry conf is reconciled on a cadence, not on every tick", async () => {
  const files = await fixture();
  const calls = [];
  const d = deps(files, {
    switchEntry: async () => {
      calls.push(Date.now());
      return { changed: false };
    },
  });
  const run = runOf("paced");

  await reconcileActive(run, d);
  await reconcileActive(run, d);
  await reconcileActive(run, d);

  assert.equal(calls.length, 1, "three ticks inside two minutes must check the conf once");
});

test("active: a partner-written conf is left alone instead of rewritten", async () => {
  const files = await fixture();
  const d = deps(files, { switchEntry: async () => ({ changed: false, external: true }) });

  await reconcileActive(runOf("external"), d);

  assert.ok(d.lines.some((line) => line.includes("不是中枢生成的")));
});

test("activation: the note, the portal, and the live mail all run once", async () => {
  const files = await fixture();
  await publishInstance({
    application: APP,
    tunnelAccount: "knot-tunnel-cpswang",
    tunnelPort: 18095,
    manifestFile: files.manifestFile,
    rosterFile: files.rosterFile,
  });
  await markActive({ manifestFile: files.manifestFile, id: "cpswang" });

  const d = deps(files);
  await announceLive(runOf("cpswang"), d);

  assert.equal((await readJson(files.rosterFile)).members.find((m) => m.id === "cpswang").note.startsWith("已接通"), true);
  assert.ok(d.lines.includes("portal:refresh"));
  assert.ok(d.lines.some((line) => line.includes("已上线通知已发给伙伴")));
});

test("activation: a mail failure never fails acceptance", async () => {
  const files = await fixture();
  await publishInstance({
    application: APP,
    tunnelAccount: "knot-tunnel-cpswang",
    tunnelPort: 18095,
    manifestFile: files.manifestFile,
    rosterFile: files.rosterFile,
  });
  const d = deps(files, {
    notifyLive: async () => {
      throw new Error("smtp down");
    },
    markRosterLive: async () => {
      throw new Error("roster busy");
    },
  });

  const result = await announceLive(runOf("cpswang"), d);

  assert.equal(result, undefined);
  assert.ok(d.lines.some((line) => line.includes("已上线通知发送异常 smtp down")));
  assert.ok(d.lines.some((line) => line.includes("名册备注未更新 roster busy")));
});

test("due runs: an accepted run is pushed even after newer rows fill the window", () => {
  const active = { applicationId: "app-old", instanceId: "old", state: "active" };
  const recent = Array.from({ length: 30 }, (_, i) => ({
    applicationId: `app-${i}`,
    instanceId: `n${i}`,
    state: "provisioning",
  }));
  const store = {
    listProvisionRuns: (limit) => recent.slice(0, limit),
    activeProvisionRuns: () => [active],
  };

  const ids = dueRuns(store).map((run) => run.applicationId);

  assert.ok(ids.includes("app-old"));
  assert.equal(ids.length, 21);
});

test("due runs: an accepted run is not handed over twice", () => {
  const active = { applicationId: "app-1", instanceId: "one", state: "active" };
  const store = {
    listProvisionRuns: () => [active],
    activeProvisionRuns: () => [active],
  };

  assert.equal(dueRuns(store).length, 1);
});

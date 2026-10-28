import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isTunnelAccount, validateRoster } from "./validate-federation.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function load() {
  const [roster, manifest] = await Promise.all([
    readFile(path.join(HERE, "..", "federation.json"), "utf8").then(JSON.parse),
    readFile(path.join(HERE, "..", "instances.json"), "utf8").then(JSON.parse),
  ]);
  return { roster, manifest };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

test("the shipped roster and manifest agree", async () => {
  const { roster, manifest } = await load();
  assert.deepEqual(validateRoster(roster, manifest), []);
});

test("every founder is a permanent account and cannot be unlisted", async () => {
  const { roster, manifest } = await load();
  const founders = roster.members.filter((member) => member.role === "founder");
  assert.deepEqual(founders.map((member) => member.id), ["wang", "cpswang"]);
  for (const founder of founders) assert.equal(founder.standing, "permanent");

  const unlisted = clone(roster);
  unlisted.members.find((member) => member.id === "cpswang").listed = false;
  assert.ok(
    validateRoster(unlisted, manifest).some(([id, errors]) => id === "cpswang" && errors.some((e) => e.startsWith("listed")))
  );

  const demoted = clone(roster);
  demoted.members.find((member) => member.id === "cpswang").standing = "regular";
  assert.ok(
    validateRoster(demoted, manifest).some(([id, errors]) => id === "cpswang" && errors.some((e) => e.startsWith("standing")))
  );
});

test("a roster without a founder is rejected", async () => {
  const { roster, manifest } = await load();
  const broken = clone(roster);
  for (const member of broken.members) member.role = "partner";
  const problems = validateRoster(broken, manifest);
  assert.ok(problems.some(([id, errors]) => id === "—" && errors.some((e) => e.startsWith("founder:"))));
});

test("a tunnel account must be one this process owns", async () => {
  const { roster, manifest } = await load();

  // 名册会被拿去建系统账号并写进 sshd 的 Match User：root 之类的名字必须在写之前挡住。
  const stolen = clone(roster);
  stolen.members.find((member) => member.id === "zhoujj").tunnel = { account: "root", port: 18081 };
  const errors = validateRoster(stolen, manifest).find(([id]) => id === "zhoujj")?.[1] || [];
  assert.ok(errors.some((e) => e.startsWith("tunnel.account:")));

  assert.equal(isTunnelAccount("knot-tunnel"), true);
  assert.equal(isTunnelAccount("knot-tunnel-cpswang"), true);
  assert.equal(isTunnelAccount("knot-tunnel-"), false);
  assert.equal(isTunnelAccount("ec2-user"), false);
  assert.equal(isTunnelAccount("Knot-Tunnel"), false);
  assert.equal(isTunnelAccount(null), false);
});

test("tunnel accounts and ports must be unique", async () => {
  const { roster, manifest } = await load();
  const broken = clone(roster);
  broken.members.find((member) => member.id === "cpswang").tunnel = { account: "knot-tunnel", port: 18080 };
  const problems = validateRoster(broken, manifest);
  const errors = problems.find(([id]) => id === "cpswang")?.[1] || [];
  assert.ok(errors.some((e) => e.startsWith("tunnel.account: duplicate")));
  assert.ok(errors.some((e) => e.startsWith("tunnel.port: duplicate")));
});

test("every member needs an entry tunnel", async () => {
  const { roster, manifest } = await load();

  const noTunnel = clone(roster);
  noTunnel.members.find((member) => member.id === "wang").tunnel = null;
  const problems = validateRoster(noTunnel, manifest);
  assert.ok(
    problems.some(([id, errors]) =>
      id === "wang" && errors.includes("tunnel: required — every member is served through the entry tunnel")
    )
  );
});

test("the published host must sit under the hub", async () => {
  const { roster, manifest } = await load();

  const outside = clone(roster);
  outside.members.find((member) => member.id === "cpswang").host = "cpswang.example";
  const otherwise = clone(manifest);
  otherwise.instances.find((instance) => instance.id === "cpswang").url = "https://cpswang.example";
  assert.ok(
    validateRoster(outside, otherwise).some(([id, errors]) =>
      id === "cpswang" && errors.some((e) => e.startsWith("host: must be under xknot.si"))
    )
  );
});

test("a member listed in the roster must exist in the manifest, and the reverse", async () => {
  const { roster, manifest } = await load();

  const missingEntry = clone(roster);
  missingEntry.members.find((member) => member.id === "zhoujj").listed = false;
  assert.ok(validateRoster(missingEntry, manifest).some(([id, errors]) => id === "zhoujj" && errors[0].includes("present in instances.json")));

  const orphan = clone(manifest);
  orphan.instances.push({ ...orphan.instances[0], id: "ghost" });
  assert.ok(validateRoster(roster, orphan).some(([id, errors]) => id === "ghost" && errors[0].startsWith("roster:")));
});

test("the roster host must match the published url host", async () => {
  const { roster, manifest } = await load();
  const broken = clone(manifest);
  broken.instances.find((instance) => instance.id === "cpswang").url = "https://zj.example";
  const problems = validateRoster(roster, broken);
  assert.ok(problems.some(([id, errors]) => id === "cpswang" && errors.some((e) => e.startsWith("host:"))));
});

test("a listed member needs since, and reserved hosts stay out of the manifest", async () => {
  const { roster, manifest } = await load();

  const noDate = clone(roster);
  noDate.members.find((member) => member.id === "cpswang").since = null;
  assert.ok(validateRoster(noDate, manifest).some(([id, errors]) => id === "cpswang" && errors.includes("since: required")));

  const leaked = clone(manifest);
  leaked.instances.push({ ...leaked.instances[0], id: "travel", url: "https://travel.xknot.si" });
  assert.ok(validateRoster(roster, leaked).some(([id, errors]) => id === "travel" && errors[0].includes("not registered in federation.json")));
});

test("tier is the manifest's call, the roster does not constrain it", async () => {
  // 档位是清单里逐实例的展示分级，名册只管角色与席位。名册去管清单的档位，
  // 两份文件就互为前提，改一边必须先改另一边。
  const { roster, manifest } = await load();
  const changed = clone(manifest);
  changed.instances.find((instance) => instance.id === "cpswang").tier = "free";
  assert.deepEqual(validateRoster(roster, changed), []);
});

test("unknown enum values are rejected", async () => {
  const { roster, manifest } = await load();
  const broken = clone(roster);
  const member = broken.members.find((entry) => entry.id === "cpswang");
  member.role = "owner";
  member.standing = "trial";
  member.mode = "vpn";
  const errors = validateRoster(broken, manifest).find(([id]) => id === "cpswang")?.[1] || [];
  assert.ok(errors.some((e) => e.startsWith("role:")));
  assert.ok(errors.some((e) => e.startsWith("standing:")));
  assert.ok(errors.some((e) => e.startsWith("mode:")));
});

test("an empty or malformed roster reports instead of throwing", () => {
  assert.deepEqual(validateRoster(null, { instances: [] }), [["", ["roster: must be an object"]]]);
  const problems = validateRoster({ version: 0, hub: "NOPE" }, { instances: [] });
  assert.ok(problems.some(([id, errors]) => id === "" && errors.some((e) => e.startsWith("version:"))));
  assert.ok(problems.some(([id, errors]) => id === "" && errors.some((e) => e.startsWith("hub:"))));
});

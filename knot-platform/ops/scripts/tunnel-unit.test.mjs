// 隧道单元的装/卸/不动，三选一。
//
// 隧道参数放在 tunnel.env 之后，「没提到隧道」和「明确不接入口」在 shell 里都表现为
// KNOT_TUNNEL 未设或 0。若把两者当成同一件事，一次从开发机发起的发布就会把中枢接好的
// 隧道单元卸掉：本机 /api/health 仍是 200，公网入口只剩 502，而部署输出里写的还是 OK。
//
// 用真的 bash 跑 site-config.sh：判断写在 shell 里，用 JS 复刻一遍测不出问题。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const LIB = fileURLToPath(new URL("./lib/site-config.sh", import.meta.url));

function makeSite({ siteEnv = "", tunnelEnv = null } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "knot-tunnel-unit-")));
  writeFileSync(path.join(dir, "site.env"), `KNOT_PUBLIC_ORIGIN="http://127.0.0.1:8099"\nKNOT_PORT=8099\n${siteEnv}`, {
    mode: 0o600,
  });
  if (tunnelEnv != null) writeFileSync(path.join(dir, "tunnel.env"), tunnelEnv, { mode: 0o600 });
  return dir;
}

// deploy-site.sh 在调用这个判断之前会把 tunnel.env 也 source 进来，这里照样做。
function action(siteDir, { tunnelEnv = false } = {}) {
  const env = { ...process.env, KNOT_SITE_FILE: path.join(siteDir, "site.env") };
  delete env.KNOT_TUNNEL;
  delete env.KNOT_TUNNEL_SSH;
  const script = tunnelEnv
    ? 'source "$1"; source "$2/tunnel.env"; knot_tunnel_unit_action'
    : 'source "$1"; knot_tunnel_unit_action';
  return execFileSync("bash", ["-c", script, "_", LIB, siteDir], { env, encoding: "utf8" }).trim();
}

test("tunnel unit: tunnel.env with an account installs the unit", () => {
  const site = makeSite({ tunnelEnv: "KNOT_TUNNEL=1\nKNOT_TUNNEL_SSH=knot-tunnel-demo@192.0.2.10\n" });
  assert.equal(action(site, { tunnelEnv: true }), "install");
});

test("tunnel unit: a tunnel.env that says KNOT_TUNNEL=0 removes the unit", () => {
  const site = makeSite({ tunnelEnv: "KNOT_TUNNEL=0\n" });
  assert.equal(action(site, { tunnelEnv: true }), "remove");
});

test("tunnel unit: an unsourced tunnel.env is never a reason to remove", () => {
  // 判断只该因为「有人明确关掉」才卸；拿不到账号时保持现状，等部署在前面报错。
  const site = makeSite({ tunnelEnv: "KNOT_TUNNEL=1\nKNOT_TUNNEL_SSH=knot-tunnel-demo@192.0.2.10\n" });
  assert.equal(action(site), "keep");
});

test("tunnel unit: site.env with KNOT_TUNNEL=1 and an account installs the unit", () => {
  const site = makeSite({ siteEnv: "KNOT_TUNNEL=1\nKNOT_TUNNEL_SSH=knot-tunnel-demo@192.0.2.10\n" });
  assert.equal(action(site), "install");
});

test("tunnel unit: an explicit KNOT_TUNNEL=0 removes the unit", () => {
  const site = makeSite({ siteEnv: "KNOT_TUNNEL=0\n" });
  assert.equal(action(site), "remove");
});

test("tunnel unit: a config that never mentions the tunnel leaves the unit alone", () => {
  const site = makeSite();
  assert.equal(action(site), "keep");
});

// `deploy-api.sh --pull-manifest` 是部署的反方向：把中枢主机上的清单与名册拉回仓库。
//
// 开通进程在中枢主机上写这两份（登记新实例、把名册那句「等待接通验收」换成实情），
// 而部署用仓库内容覆盖远端。没有这一步，那些改动会在下一次部署时被悄悄盖回旧值，
// 而两边都照常成功——这正是最难发现的一种不一致。
//
// 这里跑真实脚本，只把 ssh 换成假的：假 ssh 按远端命令回放夹具内容。四个用例分别
// 覆盖正常拉取、仓库有未提交改动、远端不是合法 JSON，以及 --dry-run 不落盘。

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./deploy-api.sh", import.meta.url));

const REMOTE_INSTANCES = {
  version: 8,
  updatedAt: "2026-10-30",
  instances: [{ id: "zhoujj", url: "https://zhoujj.xknot.si", status: "active" }],
};
const REMOTE_ROSTER = {
  version: 4,
  updatedAt: "2026-10-30",
  members: [{ id: "zhoujj", host: "zhoujj.xknot.si", note: "已接通，门户已收录（2026-10-30）。" }],
};
const LOCAL_INSTANCES = { version: 7, updatedAt: "2026-10-29", instances: [] };
const LOCAL_ROSTER = { version: 3, updatedAt: "2026-10-29", members: [] };

const git = (dir, ...args) =>
  execFileSync(
    "git",
    ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { stdio: "pipe" }
  );

// 造一个能跑的仓库副本：脚本按自己所在目录的上一级当 HUB，所以拷进 <root>/ops/ 即可。
// 假 ssh 只认远端命令的最后一段，按文件名回放 <root>/remote/ 下的内容。
function sandbox({ remoteInstances = REMOTE_INSTANCES, remoteRoster = REMOTE_ROSTER } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "knot-pull-"));
  mkdirSync(path.join(root, "ops"));
  mkdirSync(path.join(root, "remote"));
  mkdirSync(path.join(root, "bin"));
  copyFileSync(SCRIPT, path.join(root, "ops", "deploy-api.sh"));
  writeFileSync(path.join(root, "instances.json"), `${JSON.stringify(LOCAL_INSTANCES, null, 2)}\n`);
  writeFileSync(path.join(root, "federation.json"), `${JSON.stringify(LOCAL_ROSTER, null, 2)}\n`);
  writeFileSync(path.join(root, "remote", "instances.json"), `${JSON.stringify(remoteInstances, null, 2)}\n`);
  writeFileSync(path.join(root, "remote", "federation.json"), `${JSON.stringify(remoteRoster, null, 2)}\n`);

  const ssh = path.join(root, "bin", "ssh");
  writeFileSync(
    ssh,
    `#!/usr/bin/env bash
set -eu
cmd="\${@: -1}"
case "$cmd" in
  *instances.json*) exec cat "${path.join(root, "remote", "instances.json")}" ;;
  *federation.json*) exec cat "${path.join(root, "remote", "federation.json")}" ;;
  *) echo "unexpected remote command: $cmd" >&2; exit 9 ;;
esac
`
  );
  chmodSync(ssh, 0o755);

  git(root, "init", "-q");
  git(root, "add", "instances.json", "federation.json", "ops/deploy-api.sh");
  git(root, "commit", "-q", "-m", "base");

  const run = (...args) =>
    spawnSync("bash", [path.join(root, "ops", "deploy-api.sh"), ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
        XKNOT_HUB_SSH: "user@hub.example",
        // 私钥与 nginx 配置都走默认值：这个用例不碰真实主机。
        XKNOT_SSH_KEY: "",
      },
    });

  return { root, run };
}

const read = (root, name) => JSON.parse(readFileSync(path.join(root, name), "utf8"));

test("pull-manifest brings the hub's copies back into the repo", () => {
  const { root, run } = sandbox();
  const result = run("--pull-manifest");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(read(root, "instances.json"), REMOTE_INSTANCES);
  assert.deepEqual(read(root, "federation.json"), REMOTE_ROSTER);
  // 拉完之后 git 能看到这两份的改动：这正是要被提交的那一笔。
  const changed = git(root, "diff", "--name-only").toString().trim().split("\n").sort();
  assert.deepEqual(changed, ["federation.json", "instances.json"]);
});

test("uncommitted changes in the repo stop the pull instead of being overwritten", () => {
  const { root, run } = sandbox();
  writeFileSync(path.join(root, "instances.json"), `${JSON.stringify({ ...LOCAL_INSTANCES, version: 99 }, null, 2)}\n`);

  const result = run("--pull-manifest");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /未提交/);
  assert.equal(read(root, "instances.json").version, 99);
});

test("a truncated remote copy never lands in the repo", () => {
  const { root, run } = sandbox({ remoteRoster: null });
  // 空文件是「传了一半」最典型的样子：它会让名册整份加载不出来。
  writeFileSync(path.join(root, "remote", "federation.json"), "");

  const result = run("--pull-manifest");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /不是合法 JSON/);
  assert.deepEqual(read(root, "federation.json"), LOCAL_ROSTER);
  // 前一份已经拉好的不受影响：清单先落地，名册失败只影响名册自己。
  assert.deepEqual(read(root, "instances.json"), REMOTE_INSTANCES);
});

test("dry-run only prints the plan", () => {
  const { root, run } = sandbox();
  const result = run("--pull-manifest", "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry-run/);
  assert.deepEqual(read(root, "instances.json"), LOCAL_INSTANCES);
  assert.deepEqual(read(root, "federation.json"), LOCAL_ROSTER);
});

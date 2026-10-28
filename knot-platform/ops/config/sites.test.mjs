import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deployRootOf, validSiteName } from "./sites.mjs";

const APP = fileURLToPath(new URL("../../", import.meta.url));

function git(args) {
  return execFileSync("git", ["-C", APP, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

// 版本库里的（含已暂存）与还没忽略的新文件都算。只看 ls-files 会漏掉刚加进
// 工作区、还没来得及提交的模板。
function siteFiles() {
  return git(["ls-files", "--cached", "--others", "--exclude-standard", "sites"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function inRepo() {
  try {
    return git(["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

// bot01 这类目录是开发者自己的实例，只留在本机。
// 仓库里只允许模板的两个文件，发布包和容器也都不带 sites/。
test("only the site template is tracked", (t) => {
  if (!inRepo()) return t.skip("不在 git 工作区里");
  const tracked = siteFiles().sort();
  assert.deepEqual(tracked, [
    "sites/_template/platform.env",
    "sites/_template/site.env",
    "sites/_template/xknot.env",
  ]);
});

test("a real site directory and its secrets are ignored", (t) => {
  if (!inRepo()) return t.skip("不在 git 工作区里");
  const ignored = (file) => {
    try {
      git(["check-ignore", "--no-index", "-q", file]);
      return true;
    } catch {
      return false;
    }
  };
  // git -C 已经把工作目录切到 knot-platform，这里的路径都相对它。
  for (const file of [
    "sites/bot01/site.env",
    "sites/bot01/tester.env",
    "sites/bot01/platform.env",
    "sites/bot01/xknot.env",
    "sites/bot01/tunnel.env",
    "sites/bot01/agents/token.env",
    "sites/any-other-site/site.env",
  ]) {
    assert.ok(ignored(file), `${file} 应该被忽略`);
  }
  // 模板本身必须留在版本库里，否则新站点没有可复制的起点。
  assert.ok(!ignored("sites/_template/site.env"));
  assert.ok(!ignored("sites/_template/platform.env"));
  assert.ok(!ignored("sites/_template/xknot.env"));
});

test("the deploy root is the parent of releases/", () => {
  assert.equal(deployRootOf("/srv/knot/releases/knot-0.3.0-abc1234"), "/srv/knot");
  assert.equal(deployRootOf("/srv/knot"), "/srv/knot");
  // 名字里带 releases 但不是发布目录时不要误判。
  assert.equal(deployRootOf("/srv/releases-notes/knot"), "/srv/releases-notes/knot");
});

test("site names stay filesystem-safe", () => {
  assert.ok(validSiteName("bot01"));
  assert.ok(validSiteName("knot.example.com"));
  assert.ok(!validSiteName("../etc"));
  assert.ok(!validSiteName("site name"));
  assert.ok(!validSiteName(""));
});

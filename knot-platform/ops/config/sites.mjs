// 站点目录的定位与读取。
//
// 一个站点一个目录：
//
//   sites/<站点>/site.env          站点拓扑（部署）
//   sites/<站点>/profile.json      自述区：名称、介绍、logo、主理人（主理人在 /admin 编辑）
//   sites/<站点>/platform.env      实例主机运行时值（部署脚本生成）
//   sites/<站点>/xknot.env         XKnot 接入（中枢签发，可选）
//   sites/<站点>/tunnel.env        回源隧道参数（中枢开通时写入，可选）
//
// 部署脚本只读 site.env 与 platform.env；接入文件只在运行时交给 Backend，profile.json 由 Backend 启动时读。
//
// 这里只做文件系统上的事，不解释每个键的含义；键在 packages/knot-config 里登记。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "../../packages/knot-config/src/schema.mjs";

export const SITES_DIR = "sites";
export const RELEASES_DIR = "releases";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validSiteName(value) {
  return NAME.test(String(value || "").trim());
}

// 代码目录 → 部署根目录。
// 发布包的代码在 <部署根>/releases/<版本> 下，sites/ 与 var/ 在部署根；
// 从源码目录直接跑时，代码目录就是部署根。
export function deployRootOf(appRoot) {
  const app = path.resolve(appRoot);
  const parent = path.dirname(app);
  if (path.basename(parent) === RELEASES_DIR) return path.dirname(parent);
  return app;
}

function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// 列出 sites/ 下带 site.env 的站点目录，模板目录不算。
export function listSites(root) {
  const dir = path.join(root, SITES_DIR);
  if (!isDirectory(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith("_") && isDirectory(path.join(dir, name)))
    .filter((name) => existsSync(path.join(dir, name, "site.env")))
    .sort();
}

// 定位一个站点的两个部署文件。site 留空时，只有恰好一个站点才自动选中。
export function resolveSitePaths(root, { site, file } = {}) {
  const siteName = String(site || "").trim();
  const filePath = String(file || "").trim();
  let dir;
  let name;

  if (filePath) {
    const absolute = path.resolve(root, filePath);
    dir = path.dirname(absolute);
    name = siteName || path.basename(dir);
    if (path.basename(absolute) !== "site.env") {
      throw new Error(`--site-file 要指向 site.env，收到 ${filePath}`);
    }
  } else if (siteName) {
    if (!validSiteName(siteName)) {
      throw new Error(`站点名只能用字母、数字、点、下划线和短横线：${siteName}`);
    }
    name = siteName;
    dir = path.join(root, SITES_DIR, siteName);
  } else {
    const sites = listSites(root);
    if (sites.length === 1) {
      [name] = sites;
      dir = path.join(root, SITES_DIR, name);
    } else if (!sites.length) {
      throw new Error(
        `sites/ 下没有站点配置。先创建：mkdir -p sites/<站点> && cp sites/_template/site.env sites/<站点>/site.env`
      );
    } else {
      throw new Error(`sites/ 下有多个站点，请用 --site 指定：${sites.join("、")}`);
    }
  }

  const siteEnv = path.join(dir, "site.env");
  const platformEnv = path.join(dir, "platform.env");
  const joinEnv = path.join(dir, "xknot.env");

  if (!existsSync(siteEnv)) {
    throw new Error(`找不到站点配置：${path.relative(root, siteEnv)}`);
  }

  return { name, dir, siteEnv, platformEnv, joinEnv };
}

// site.env 合成一份视图。
export function readSiteEnv(paths) {
  return { ...parseEnv(readFileSync(paths.siteEnv, "utf8")) };
}

#!/usr/bin/env node
// 给构建产物补一份 /discover 的静态壳。
//
// index.html 只有一份 SPA 空壳，/discover 若靠 `try_files ... /index.html` 兜底，
// 地址是 /discover、HTML 里的 canonical 却指着首页。这里用同一份模板生成
// discover.html，canonical 指向 /discover；Backend 发页面时会按站点档案再写一遍
// （站点名、语种、绝对地址），构建产物是那份的起点。
//
// 用法：node web/scripts/build-discover.mjs [dist 目录]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderDiscoverHtml } from "../../backend/src/siteHtml.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(process.argv[2] || path.join(HERE, "..", "dist"));
const shell = path.join(DIST, "index.html");

if (!fs.existsSync(shell)) {
  console.error(`找不到 ${shell}，请先构建 web。`);
  process.exit(1);
}

const html = renderDiscoverHtml(fs.readFileSync(shell, "utf8"), { fallbackName: "Knot" });
fs.writeFileSync(path.join(DIST, "discover.html"), html);
console.log("==> 发现页静态壳：discover.html");

// 实例自己发页面时，把站点自述写进 HTML。
//
// 构建产物里的那份 HTML 是通用的 "Knot"：站名、简介、canonical、社交预览与
// JSON-LD 都要按当前档案和对外地址重写。渲染器在 siteHtml.js，这里只负责
// 按「文件 mtime + 档案 updatedAt + origin」缓存。
//
// 渲染结果按「文件 mtime + 档案 updatedAt + origin」缓存：主理人在 /admin 改自我介绍后
// 下一次请求就是新的，没改的时候一个请求只多一次 stat。

import fs from "node:fs";

import { renderDiscoverHtml, renderEntryHtml } from "./siteHtml.js";

const ABSOLUTE = /^https?:\/\//i;

/**
 * @param {{ dir: string, profile?: { view?: () => { site?: object, updatedAt?: string } }, origin?: string }} options
 */
export function createHtmlRenderer({ dir, profile = null, origin = "" } = {}) {
  // 站点还只知道相对地址时（没配 KNOT_PUBLIC_ORIGIN），首页那一份没法写绝对 canonical，
  // 宁可原样发出构建产物，也不要写一个猜出来的域名。
  const base = ABSOLUTE.test(String(origin || "")) ? String(origin).replace(/\/+$/, "") : "";
  const cache = new Map();

  function site() {
    try {
      return profile?.view?.()?.site || null;
    } catch {
      return null;
    }
  }

  function stamp() {
    try {
      return String(profile?.view?.()?.updatedAt || "");
    } catch {
      return "";
    }
  }

  function render(file, kind) {
    let mtime;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
    const key = `${file}:${mtime}:${stamp()}:${base}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    const template = fs.readFileSync(file, "utf8");
    let html;
    try {
      if (kind === "discover") {
        // 发现页没有绝对地址也能自洽：相对 canonical 在任何域名下都指向自己。
        html = renderDiscoverHtml(template, { site: site(), origin: base });
      } else if (base) {
        html = renderEntryHtml(template, { site: site(), origin: base });
      } else {
        html = template;
      }
    } catch (error) {
      // 拿错文件、模板里没有挂载点：发原文比发 500 好，页面至少还能由脚本画出来。
      console.warn(`knot-backend 页面自述没写进去（${kind}）：${error.message}`);
      html = template;
    }
    // 只留最近几份：一个站点只有首页与发现页两个文件，多次改动不至于把内存堆起来。
    if (cache.size > 8) cache.clear();
    cache.set(key, html);
    return html;
  }

  return {
    origin: base,
    send(res, file, kind) {
      const html = render(file, kind);
      if (html == null) return res.status(404).type("text/plain").send("not found\n");
      res.type("text/html; charset=utf-8").send(html);
    },
  };
}

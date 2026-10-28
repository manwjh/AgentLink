#!/usr/bin/env node
// 中枢的抓取入口：robots.txt、sitemap.xml，以及每个语种一份静态实例目录。
//
// 门户本身是 Vue 单页，首页 HTML 里只有一个空的 <div id="app">。执行 JS 的
// 爬虫能看到目录，不执行 JS 的抓取与 Agent 只看得到标题。这里把目录再写一份
// 纯静态的 HTML：每个实例一个链接、一句话介绍和标签，不需要脚本就能读。
//
// 产物（都在 dist 内）：
//   robots.txt               放行页面，挡住接口与控制台，指向 sitemap
//   sitemap.xml              三个语种入口、三份实例目录与 /knot-help
//   <locale>/instances/index.html
//                            无脚本的实例目录
//   <locale>/index.html      在 </body> 前补一段 <noscript> 目录摘要
//
// 目录内容来自 dist/data/hub.json（由 build-hub-data.mjs 写出），和门户看到的是
// 同一份数据；隐藏的实例（health.hidden）与非法地址不列，避免把死链交给爬虫。
//
// 用法：
//   node ops/build-seo.mjs --dist web/dist --origin https://xknot.si

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LOCALES } from "../web/src/lib/i18n.js";
import { invokedDirectly } from "./lib/main-module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
export const DEFAULT_ORIGIN = "https://xknot.si";

const MARK_START = "<!-- knot-directory -->";
const MARK_END = "<!-- /knot-directory -->";

const VERIFY_START = "<!-- knot-verify -->";
const VERIFY_END = "<!-- /knot-verify -->";

// 站长后台的验证方式里，meta 标签是唯一一种只要改站点就能完成的：
// 不用加 DNS 记录，也不用在根目录放命名奇怪的 HTML 文件。
// 值由站点主理人从各自后台取得，存在未受版本控制的文件里，构建时注入。
export const VERIFY_ENGINES = [
  ["google", "google-site-verification"],
  ["bing", "msvalidate.01"],
  ["baidu", "baidu-site-verification"],
  ["yandex", "yandex-verification"],
];

// 令牌按后台实际给出的字符集收：只允许这些字符，页面里就不会被拼进标签闭合。
// 长度给得宽一点，各家格式不一。
const VERIFY_TOKEN = /^[A-Za-z0-9._\-+/=]{8,200}$/;

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/**
 * 验证令牌表 → 干净的同一张表。
 *
 * 只认登记过的引擎：键写错时宁可构建失败，也不要静默产出一份「看起来注入过、
 * 实际没有」的页面。空值与缺项一样，都当成没配。
 */
export function normalizeVerify(raw) {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("verify 必须是对象：{ google, bing, baidu, yandex }");
  const known = new Map(VERIFY_ENGINES);
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) {
      throw new Error(`verify 里有未登记的引擎：${key}（可用：${[...known.keys()].join("、")}）`);
    }
    const token = String(value ?? "").trim();
    if (!token) continue;
    if (!VERIFY_TOKEN.test(token)) throw new Error(`verify.${key} 的令牌不合规：只接受字母数字与 ._+/=-，长度 8–200`);
    out[key] = token;
  }
  return out;
}

/** 验证用的 meta 标签。空表返回空串，页面里不留空壳。 */
export function renderVerification(verify = {}) {
  const clean = normalizeVerify(verify);
  const lines = VERIFY_ENGINES.filter(([key]) => clean[key]).map(
    ([key, name]) => `    <meta name="${name}" content="${escapeHtml(clean[key])}" />`,
  );
  if (!lines.length) return "";
  return [VERIFY_START, ...lines, VERIFY_END].join("\n");
}

/** 把 meta 写进页面 <head>；重复生成时替换旧块，不叠加。 */
export function injectVerification(html, verify = {}) {
  const source = String(html ?? "");
  const block = renderVerification(verify);
  const start = VERIFY_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const end = VERIFY_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}\\n?`);
  if (!block) return source.replace(pattern, "");
  if (pattern.test(source)) return source.replace(pattern, `${block}\n`);
  // 没有旧的块就插在 </head> 前：meta 放哪儿都不影响，留在头部便于阅读。
  if (!/<\/head>/i.test(source)) throw new Error("页面里找不到 </head>，无法写入验证 meta");
  return source.replace(/<\/head>/i, `${block}\n  </head>`);
}

/** 读验证令牌文件。文件不在就是没配，不报错：只有需要验证的站点才有这一份。 */
export function readVerifyFile(file) {
  if (!file) return {};
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`读不懂验证令牌文件 ${file}：${error.message}`);
  }
  return normalizeVerify(raw);
}

/** 按字符截断，避免把 emoji 或中文切一半。 */
function clip(text, limit) {
  const chars = [...String(text ?? "").replace(/\s+/g, " ").trim()];
  return chars.length <= limit ? chars.join("") : `${chars.slice(0, limit).join("")}…`;
}

export function normalizeOrigin(value) {
  const raw = String(value ?? "").trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`origin 必须是绝对地址：${raw || "(空)"}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`origin 只接受 http/https：${raw}`);
  }
  return raw.replace(/\/+$/, "");
}

/** 目录里只放 https 站点地址；其它值一律当没填。 */
function siteUrl(instance) {
  const url = String(instance?.url ?? "").trim().replace(/\/+$/, "");
  return /^https:\/\//i.test(url) ? url : "";
}

/**
 * 把快照条目收成目录行。字段全部来自实例自述，可能缺失，也可能很长；
 * 这里只做裁剪与过滤，不改写内容。
 */
export function directoryInstances(data) {
  const rows = Array.isArray(data?.instances) ? data.instances : [];
  return rows
    .filter((instance) => instance?.health?.hidden !== true)
    .map((instance) => ({
      id: String(instance?.id ?? ""),
      name: clip(instance?.name || instance?.id, 80),
      tagline: clip(instance?.tagline, 160),
      intro: clip(instance?.intro, 400),
      tags: (Array.isArray(instance?.tags) ? instance.tags : [])
        .filter((tag) => typeof tag === "string" && tag.trim() !== "")
        .slice(0, 8)
        .map((tag) => clip(tag, 40)),
      url: siteUrl(instance),
      status: ["up", "degraded", "down", "unknown"].includes(instance?.health?.status)
        ? instance.health.status
        : "unknown",
    }))
    .filter((row) => row.url !== "");
}

/** 页面文案以该语种的目录词条为准；缺条目时退回英文，不让空串上屏。 */
function copyFor(catalog) {
  const fallback = {
    title: "Instance directory — XKnot Federation",
    description:
      "Every Knot instance in the XKnot federation, with its site name, one-line introduction, tags, and entry link.",
    heading: "Instance directory",
    lede: "Each instance runs on its own machine and keeps its own accounts and content. This hub only lists them.",
    back: "Back to the federation portal",
    tags: "Tags",
    status: "Status",
    all: "See the full instance directory",
    agent: "Agent API guide",
    empty: "No instances listed yet.",
  };
  const source = catalog?.directory && typeof catalog.directory === "object" ? catalog.directory : {};
  return Object.fromEntries(
    Object.entries(fallback).map(([key, value]) => {
      const text = source[key];
      return [key, typeof text === "string" && text.trim() !== "" ? text : value];
    }),
  );
}

function statusLabel(catalog, status) {
  const text = catalog?.status?.[status];
  return typeof text === "string" && text.trim() !== "" ? text : status;
}

function alternates(origin, suffix) {
  const lines = LOCALES.map(
    (locale) =>
      `    <link rel="alternate" hreflang="${locale}" href="${escapeHtml(`${origin}/${locale}/${suffix}`)}" />`,
  );
  lines.push(
    `    <link rel="alternate" hreflang="x-default" href="${escapeHtml(`${origin}/${LOCALES[0]}/${suffix}`)}" />`,
  );
  return lines.join("\n");
}

/**
 * 一份无脚本的实例目录页。样式内联：这个页面不引主包，也不依赖任何外部资源。
 */
export function renderDirectoryPage({
  locale,
  catalog = {},
  instances = [],
  origin = DEFAULT_ORIGIN,
  verify = {},
} = {}) {
  if (!LOCALES.includes(locale)) throw new Error(`未登记的语种：${locale}`);
  const base = normalizeOrigin(origin);
  const rows = Array.isArray(instances) ? instances : [];
  const copy = copyFor(catalog);
  const canonical = `${base}/${locale}/instances/`;
  const verification = renderVerification(verify);

  const structured = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: copy.heading,
    description: copy.description,
    url: canonical,
    inLanguage: locale,
    isPartOf: { "@type": "WebSite", name: "XKnot Federation", url: `${base}/` },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: rows.length,
      itemListElement: rows.map((row, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: row.name,
        url: row.url,
      })),
    },
  }).replace(/</g, "\\u003c");

  const items = rows
    .map((row) => {
      const tags = row.tags.length
        ? `\n        <span class="tags">${escapeHtml(copy.tags)}: ${escapeHtml(row.tags.join(" · "))}</span>`
        : "";
      return [
        '      <li class="item">',
        `        <h2><a href="${escapeHtml(row.url)}" rel="noopener noreferrer">${escapeHtml(row.name)}</a></h2>`,
        ...(row.tagline ? [`        <p class="tagline">${escapeHtml(row.tagline)}</p>`] : []),
        ...(row.intro ? [`        <p class="intro">${escapeHtml(row.intro)}</p>`] : []),
        `        <p class="meta"><span class="dot ${escapeHtml(row.status)}" aria-hidden="true"></span><span>${escapeHtml(copy.status)}: ${escapeHtml(statusLabel(catalog, row.status))}</span>${tags}</p>`,
        "      </li>",
      ].join("\n");
    })
    .join("\n");

  const body = rows.length
    ? `    <ul class="list">\n${items}\n    </ul>`
    : `    <p class="empty">${escapeHtml(copy.empty)}</p>`;

  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(copy.title)}</title>
    <meta name="description" content="${escapeHtml(copy.description)}" />
    <link rel="canonical" href="${escapeHtml(canonical)}" />
    <link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32" />
    <link rel="icon" href="/favicon-16.png" type="image/png" sizes="16x16" />
${alternates(base, "instances/")}
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${escapeHtml(copy.title)}" />
    <meta property="og:description" content="${escapeHtml(copy.description)}" />
    <meta property="og:url" content="${escapeHtml(canonical)}" />
    <meta name="twitter:card" content="summary" />
    <meta name="theme-color" content="#F3F6FB" />
${verification ? `${verification}\n` : ""}    <script type="application/ld+json">${structured}</script>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: #f3f6fb;
        color: #0a1322;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        line-height: 1.65;
      }
      .wrap { width: min(60rem, 100% - 2rem); margin-inline: auto; }
      header { padding: 1.4rem 0; }
      .brand {
        color: #0b5fff;
        font-size: 0.8rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-decoration: none;
      }
      main { padding-bottom: 3rem; }
      h1 { margin: 0.4rem 0 1rem; font-size: clamp(1.6rem, 4vw, 2.2rem); }
      .lede { max-width: 44rem; margin: 0 0 1.8rem; color: #475569; }
      .list { display: grid; gap: 1rem; margin: 0; padding: 0; list-style: none; }
      .item { padding: 1.1rem 1.2rem; border: 1px solid #d9e2f0; border-radius: 14px; background: #fff; }
      .item h2 { margin: 0 0 0.35rem; font-size: 1.05rem; }
      .item h2 a { color: #0a1322; text-decoration: none; }
      .item h2 a:hover { color: #0b5fff; text-decoration: underline; }
      .tagline { margin: 0 0 0.5rem; }
      .intro { margin: 0 0 0.8rem; color: #475569; font-size: 0.95rem; }
      .meta { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin: 0; color: #475569; font-size: 0.82rem; }
      .dot { display: inline-block; width: 0.5rem; height: 0.5rem; border-radius: 50%; background: #94a3b8; }
      .dot.up { background: #0b7a54; }
      .dot.degraded { background: #a16207; }
      .dot.down { background: #b42318; }
      .empty { color: #475569; }
      footer { padding: 1.2rem 0 2rem; border-top: 1px solid #d9e2f0; color: #475569; font-size: 0.85rem; }
      footer a { color: #0b5fff; }
    </style>
  </head>
  <body>
    <header class="wrap"><a class="brand" href="/${locale}/">XKNOT.SI</a></header>
    <main class="wrap">
      <h1>${escapeHtml(copy.heading)}</h1>
      <p class="lede">${escapeHtml(copy.lede)}</p>
${body}
    </main>
    <footer class="wrap">
      <a href="/${locale}/">${escapeHtml(copy.back)}</a>
      <span aria-hidden="true"> · </span>
      <a href="/knot-help">${escapeHtml(copy.agent)}</a>
    </footer>
  </body>
</html>
`;
}

/**
 * 首页的 <noscript> 摘要：只有站点名、一句话和入口链接，够不执行 JS 的抓取
 * 顺着链接走到各实例与完整目录。
 */
export function renderDirectoryFallback({ locale, catalog = {}, instances = [] } = {}) {
  if (!LOCALES.includes(locale)) throw new Error(`未登记的语种：${locale}`);
  const copy = copyFor(catalog);
  const rows = Array.isArray(instances) ? instances : [];
  const items = rows
    .map(
      (row) =>
        `        <li><a href="${escapeHtml(row.url)}" rel="noopener noreferrer">${escapeHtml(row.name)}</a>${
          row.tagline ? ` — ${escapeHtml(row.tagline)}` : ""
        }</li>`,
    )
    .join("\n");
  const list = rows.length
    ? `      <ul style="margin:0;padding-left:1.1rem">\n${items}\n      </ul>`
    : `      <p style="margin:0">${escapeHtml(copy.empty)}</p>`;
  return [
    "  <noscript>",
    '    <section style="max-width:60rem;margin:2.5rem auto;padding:0 1rem;font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#0a1322">',
    `      <h2 style="margin:0 0 .6rem;font-size:1.05rem">${escapeHtml(copy.heading)}</h2>`,
    list,
    `      <p style="margin:.8rem 0 0"><a href="/${locale}/instances/">${escapeHtml(copy.all)}</a></p>`,
    "    </section>",
    "  </noscript>",
  ].join("\n");
}

/** 把摘要写进首页；重复生成时替换旧块，不叠加。 */
export function injectDirectoryFallback(html, fallback) {
  const source = String(html ?? "");
  const block = `${MARK_START}\n${fallback}\n${MARK_END}`;
  if (source.includes(MARK_START) && source.includes(MARK_END)) {
    const start = MARK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const end = MARK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return source.replace(new RegExp(`${start}[\\s\\S]*?${end}`), block);
  }
  if (!/<\/body>/i.test(source)) throw new Error("首页里找不到 </body>，无法写入目录摘要");
  return source.replace(/<\/body>/i, `${block}\n  </body>`);
}

export function renderRobots(origin = DEFAULT_ORIGIN) {
  const base = normalizeOrigin(origin);
  return [
    "# XKnot hub: pages are open; the API and console are not.",
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /admin",
    "Disallow: /case/",
    "Disallow: /claim/",
    "",
    `Sitemap: ${base}/sitemap.xml`,
    "",
  ].join("\n");
}

export function renderSitemap(origin = DEFAULT_ORIGIN) {
  const base = normalizeOrigin(origin);
  const paths = [];
  for (const locale of LOCALES) {
    paths.push(`/${locale}/`);
    paths.push(`/${locale}/instances/`);
  }
  // Agent 指引是真实页面，但它对所有实例通用，只登记一次。
  paths.push("/knot-help");
  const urls = paths
    .map((pathname) => `  <url>\n    <loc>${escapeHtml(base + pathname)}</loc>\n  </url>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    "</urlset>",
    "",
  ].join("\n");
}

function readCatalog(locale) {
  const file = path.join(ROOT, "web", "src", "locales", `${locale}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * 写全部产物。catalogs 只给测试用；正常构建按 LOCALES 读 web/src/locales/。
 */
export function writeSeo({ distDir, origin = DEFAULT_ORIGIN, catalogs = null, verify = {} } = {}) {
  if (!distDir) throw new Error("writeSeo: distDir 是必填项");
  const dist = path.resolve(distDir);
  const base = normalizeOrigin(origin);
  // 令牌先归一一次：键写错或值不合规时，一条产物都还没写就失败。
  const tokens = normalizeVerify(verify);
  const dataFile = path.join(dist, "data", "hub.json");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  } catch {
    throw new Error(`读不到 ${dataFile}：先跑 build-hub-data.mjs`);
  }

  const instances = directoryInstances(data);
  fs.writeFileSync(path.join(dist, "robots.txt"), renderRobots(base));
  fs.writeFileSync(path.join(dist, "sitemap.xml"), renderSitemap(base));

  for (const locale of LOCALES) {
    const catalog = catalogs?.[locale] || readCatalog(locale);
    const outDir = path.join(dist, locale, "instances");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, "index.html"),
      renderDirectoryPage({ locale, catalog, instances, origin: base, verify: tokens }),
    );

    const home = path.join(dist, locale, "index.html");
    if (!fs.existsSync(home)) throw new Error(`读不到 ${home}：先跑 vite build`);
    const html = fs.readFileSync(home, "utf8");
    // 顺序无关：两处注入各用一对标记，互不覆盖。
    const withFallback = injectDirectoryFallback(html, renderDirectoryFallback({ locale, catalog, instances }));
    fs.writeFileSync(home, injectVerification(withFallback, tokens));
  }

  // 根路径是跳转页（meta refresh 到 /en/），也是 Search Console 验证网址前缀时
  // 实际抓取的那一页。它没有目录摘要可补，但验证 meta 必须在这里也有一份：
  // 只认 meta refresh 的抓取器不会替我们跟到 /en/ 再找标签。
  const rootHome = path.join(dist, "index.html");
  if (fs.existsSync(rootHome)) {
    fs.writeFileSync(rootHome, injectVerification(fs.readFileSync(rootHome, "utf8"), tokens));
  }

  return { instances: instances.length, locales: LOCALES.length, verified: Object.keys(tokens) };
}

function argValue(argv, name, fallback = "") {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function main(argv) {
  const dist = argValue(argv, "--dist", path.join(ROOT, "web", "dist"));
  const origin = argValue(argv, "--origin", process.env.XKNOT_HUB_ORIGIN || DEFAULT_ORIGIN);
  // 验证令牌只留在本机：默认从 var/ 读，文件不在就是没配。
  const verifyFile = argValue(
    argv,
    "--verify",
    process.env.XKNOT_SEARCH_VERIFY || path.join(ROOT, "var", "search-verify.json"),
  );
  const verify = readVerifyFile(verifyFile);
  const result = writeSeo({ distDir: dist, origin, verify });
  const verified = result.verified.length ? `；验证 meta ${result.verified.join("、")}` : "";
  console.log(
    `==> 抓取入口：robots.txt、sitemap.xml；实例目录 ${result.instances} 条 × ${result.locales} 个语种${verified}`,
  );
}

const isMain = invokedDirectly(import.meta.url);
if (isMain) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

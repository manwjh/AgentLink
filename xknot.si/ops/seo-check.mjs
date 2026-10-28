#!/usr/bin/env node
// 上线后的抓取体检：站已经发布，但「发布对了没有」只有请求一遍才知道。
//
// 为什么需要这一步：robots、sitemap、canonical、hreflang、结构化数据都在构建时
// 生成，任何一处写错，本地看是文件写出来了、线上却是 404 或没有这段。爬虫不会
// 告诉你，控制台也只在几天后才显示「已发现但未编入索引」。
//
// 这里只做黑箱检查：输入一个站点地址，GET 一遍，看应该出现的东西在不在。
// 不读 dist、不读站点配置，也不进数据库，所以预发与正式都是同一条命令。
//
// 用法：
//   node ops/seo-check.mjs                          # 检查 https://xknot.si
//   node ops/seo-check.mjs --origin https://preview.example
//   node ops/seo-check.mjs --verify var/search-verify.json
//   node ops/seo-check.mjs --dns                  # 顺带查网域属性的 DNS TXT 记录
//
// 退出码：全部通过 0，有任何一条不通过 1。可以直接挂在发布流程后面。

import fs from "node:fs";
import path from "node:path";
import { Resolver } from "node:dns/promises";
import { fileURLToPath } from "node:url";

import { VERIFY_ENGINES, normalizeVerify, normalizeOrigin, readVerifyFile } from "./build-seo.mjs";
import { LOCALES } from "../web/src/lib/i18n.js";
import { invokedDirectly } from "./lib/main-module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
export const DEFAULT_ORIGIN = "https://xknot.si";
const TIMEOUT_MS = 10_000;

/** 跟最终状态走：中枢前面的入口会 301 到带斜杠的地址，那是正常行为。 */
async function defaultFetch(url, { redirect = "follow" } = {}) {
  const response = await fetch(url, {
    redirect,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": "xknot-seo-check/1 (+https://xknot.si/knot-help)", accept: "*/*" },
  });
  return { status: response.status, type: response.headers.get("content-type") || "", text: await response.text() };
}

/**
 * 网域属性只认 DNS TXT，网址前缀只认页面里的标签：一个属性只有一种验证类型，
 * 两种不通用。这里只登记确实以 TXT 记录作准的引擎，没登记的就是本站走不通这条路。
 */
export const DNS_TXT_PREFIX = new Map([["google", "google-site-verification="]]);

/** TXT 记录的完整取值；引擎不支持 DNS 验证时返回空串。 */
export function dnsRecordOf(key, token) {
  const prefix = DNS_TXT_PREFIX.get(key);
  return prefix && token ? `${prefix}${token}` : "";
}

/**
 * 直接问权威 DNS，不走本机缓存。
 *
 * 「记录加了但加错托管区」是本机最容易自查、后台最慢才暴露的一类错：后台重试要等
 * 几小时，而解析一次只要几百毫秒。
 */
export async function lookupTxtRecords(host, { servers = ["8.8.8.8", "1.1.1.1"] } = {}) {
  const resolver = new Resolver();
  resolver.setServers(servers);
  try {
    const records = await resolver.resolveTxt(String(host));
    return records.map((parts) => parts.join(""));
  } catch (error) {
    // 没有记录不是查询失败，是「还没加」，两者的处置完全不同。
    if (error.code === "ENOTFOUND" || error.code === "ENODATA") return [];
    throw error;
  }
}

export function locsOf(xml) {
  return [...String(xml ?? "").matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => match[1]);
}

export function metaContent(html, name) {
  const pattern = new RegExp(`<meta[^>]+name="${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`, "i");
  const tag = pattern.exec(String(html ?? ""))?.[0];
  if (!tag) return "";
  return /content="([^"]*)"/i.exec(tag)?.[1] ?? "";
}

export function canonicalOf(html) {
  return /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i.exec(String(html ?? ""))?.[1] || "";
}

export function hreflangsOf(html) {
  const source = String(html ?? "");
  return [...source.matchAll(/<link[^>]+rel="alternate"[^>]+hreflang="([^"]+)"/gi)].map((match) => match[1]);
}

export function jsonLdOf(html) {
  const out = [];
  const pattern = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(String(html ?? "")))) {
    try {
      out.push(JSON.parse(match[1]));
    } catch {
      out.push(null);
    }
  }
  return out;
}

function normalizePath(value) {
  try {
    return new URL(value).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "";
  }
}

/**
 * 抓一遍站点，返回不通过的条目。
 *
 * 每条只认一个事实，报错时给出「期望 / 实到」，运维不需要再去翻页面找原因。
 * 网络层失败也收进同一种问题列表，不抛错：一次体检要把问题尽量报全。
 */
export async function seoCheck({
  origin = DEFAULT_ORIGIN,
  verify = {},
  dnsHost = "",
  lookupTxt = null,
  fetchText = defaultFetch,
} = {}) {
  const base = normalizeOrigin(origin);
  const tokens = normalizeVerify(verify);
  const problems = [];
  const add = (where, message) => problems.push(`${where}：${message}`);

  async function get(url, options) {
    try {
      return await fetchText(url, options);
    } catch (error) {
      add(url, `请求失败（${error.name || "Error"}）`);
      return null;
    }
  }

  // 1. robots：放行页面、挡住接口与管理台，并指向 sitemap。
  const robotsRes = await get(`${base}/robots.txt`);
  if (robotsRes) {
    if (robotsRes.status !== 200) add("/robots.txt", `状态 ${robotsRes.status}，期望 200`);
    const text = robotsRes.text;
    if (!/^Allow: \/$/m.test(text)) add("/robots.txt", "缺少 Allow: /");
    for (const rule of ["/api/", "/admin"]) {
      if (!new RegExp(`^Disallow: ${rule.replace(/[/]/g, "\\/")}$`, "m").test(text)) {
        add("/robots.txt", `缺少 Disallow: ${rule}`);
      }
    }
    if (!/^Sitemap: .+\/sitemap\.xml$/m.test(text)) add("/robots.txt", "缺少指向 sitemap.xml 的 Sitemap 行");
  }

  // 2. sitemap：能取到、条数对得上、地址都在本站。
  const sitemapRes = await get(`${base}/sitemap.xml`);
  const locs = sitemapRes && sitemapRes.status === 200 ? locsOf(sitemapRes.text) : [];
  if (sitemapRes && sitemapRes.status !== 200) add("/sitemap.xml", `状态 ${sitemapRes.status}，期望 200`);
  if (sitemapRes && sitemapRes.status === 200 && !locs.length) add("/sitemap.xml", "没有解析出任何 <loc>");
  for (const loc of locs) {
    if (!loc.startsWith(`${base}/`) && loc !== base) add("/sitemap.xml", `收了站外地址 ${loc}`);
  }

  // 3. sitemap 里每一条都要真的能打开：死链比没收录更糟，爬虫会反复来撞。
  const pages = new Map();
  for (const loc of locs) {
    const res = await get(loc);
    if (!res) continue;
    if (res.status !== 200) {
      add(new URL(loc).pathname, `sitemap 里的地址返回 ${res.status}，期望 200`);
      continue;
    }
    if (!/text\/html/i.test(res.type)) add(new URL(loc).pathname, `返回 ${res.type || "未知类型"}，期望 text/html`);
    pages.set(loc, res.text);
  }

  // 4. 每个语种入口页：canonical 指自己、hreflang 齐全、有标题与描述、不挡爬虫。
  for (const locale of LOCALES) {
    const url = `${base}/${locale}/`;
    const html = pages.get(url);
    if (!html) {
      add(`/${locale}/`, "sitemap 里没有这个语种入口，或它没能打开");
      continue;
    }
    if (normalizePath(canonicalOf(html)) !== `/${locale}`) {
      add(`/${locale}/`, `canonical 是 ${canonicalOf(html) || "空"}，期望 ${url}`);
    }
    const langs = hreflangsOf(html);
    for (const expected of [...LOCALES, "x-default"]) {
      if (!langs.includes(expected)) add(`/${locale}/`, `缺少 hreflang="${expected}"`);
    }
    if (!/<title>[^<]+<\/title>/i.test(html)) add(`/${locale}/`, "缺少非空 <title>");
    if (!metaContent(html, "description")) add(`/${locale}/`, "缺少 meta description");
    if (/name="robots"[^>]*noindex/i.test(html)) add(`/${locale}/`, "带 noindex，爬虫不会收录");
    // 首屏刊头是构建时写进 #app 的：缺了它正文要等脚本才出现，
    // 不跑 JS 的抓取只看到空壳，LCP 也退回去等主包。
    if (!/<!-- knot-boot -->/.test(html)) {
      add(`/${locale}/`, "首屏刊头没有写进 HTML，#app 是空壳");
    } else if (!/<h1[^>]*class="boot-h1"/.test(html)) {
      add(`/${locale}/`, "首屏刊头里没有标题");
    }
  }

  // 5. 实例目录页：结构化数据是 CollectionPage。
  //    目录为空不算错：刚上线时本来就没有实例，只是这份页面暂时没有内容。
  for (const locale of LOCALES) {
    const url = `${base}/${locale}/instances/`;
    const html = pages.get(url);
    if (!html) {
      add(`/${locale}/instances/`, "sitemap 里没有这份目录，或它没能打开");
      continue;
    }
    const types = jsonLdOf(html).map((item) => item?.["@type"]);
    if (!types.includes("CollectionPage")) add(`/${locale}/instances/`, "结构化数据里没有 CollectionPage");
  }

  // 6. 验证 meta：配了才查，没配就跳过。这是「后台点验证」能不能通过的前置条件。
  //    Search Console 验证网址前缀时抓的是你填的那一条，所以根路径必须自己就把标签
  //    送出来：这里**不跟跳转**。跟了跳转等于在查 /en/，根路径写错也照样「通过」。
  if (Object.keys(tokens).length) {
    const rootRes = await get(`${base}/`, { redirect: "manual" });
    if (rootRes) {
      if (rootRes.status >= 300 && rootRes.status < 400) {
        add("/", `根路径返回 ${rootRes.status} 跳转，验证标签没有被送到；改成直接送出跳转页`);
      } else if (rootRes.status !== 200) {
        add("/", `状态 ${rootRes.status}，期望 200`);
      } else {
        for (const [key, name] of VERIFY_ENGINES) {
          if (tokens[key] && metaContent(rootRes.text, name) !== tokens[key]) {
            add("/", `${name} 的内容与本地令牌不一致`);
          }
        }
      }
    }
    for (const [key, name] of VERIFY_ENGINES) {
      if (!tokens[key]) continue;
      for (const locale of LOCALES) {
        const home = pages.get(`${base}/${locale}/`);
        if (home && metaContent(home, name) !== tokens[key]) {
          add(`/${locale}/`, `${name} 的内容与本地令牌不一致`);
        }
      }
    }
  }

  // 7. 网域属性的 TXT：只在点名要查时查。属性和验证类型是一对一的，工具不猜你
  //    建的是哪一种，猜错会给出一个看似通过、后台仍然失败的结论。
  if (dnsHost && lookupTxt) {
    let records = null;
    try {
      records = await lookupTxt(dnsHost);
    } catch (error) {
      add(dnsHost, `DNS 查询失败（${error.code || error.name || "Error"}）`);
    }
    if (records) {
      for (const [key] of VERIFY_ENGINES) {
        const expected = dnsRecordOf(key, tokens[key]);
        if (expected && !records.includes(expected)) add(dnsHost, `TXT 里没有 ${expected}`);
      }
    }
  }

  // 8. Agent 指引是唯一的协议发布页，它挂了就等于对外没有协议。
  const help = await get(`${base}/knot-help`);
  if (help && help.status !== 200) add("/knot-help", `状态 ${help.status}，期望 200`);

  return { origin: base, checked: locs.length, problems };
}

function argValue(argv, name, fallback = "") {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function parseArgs(argv) {
  const verifyFile = argValue(
    argv,
    "--verify",
    process.env.XKNOT_SEARCH_VERIFY || path.join(ROOT, "var", "search-verify.json"),
  );
  const origin = argValue(argv, "--origin", process.env.XKNOT_HUB_ORIGIN || DEFAULT_ORIGIN);
  const dnsHost = argv.includes("--dns") ? hostnameOf(origin) : "";
  return {
    origin,
    verify: fs.existsSync(verifyFile) ? readVerifyFile(verifyFile) : {},
    dnsHost,
    lookupTxt: dnsHost ? lookupTxtRecords : null,
  };
}

function hostnameOf(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
}

const isMain = invokedDirectly(import.meta.url);
if (isMain) {
  seoCheck(parseArgs(process.argv.slice(2)))
    .then((result) => {
      if (result.problems.length) {
        for (const problem of result.problems) console.error(`✗ ${problem}`);
        console.error(`==> ${result.origin}：${result.problems.length} 处不通过（扫描 ${result.checked} 条地址）`);
        process.exitCode = 1;
        return;
      }
      console.log(`==> ${result.origin}：通过（扫描 ${result.checked} 条地址）`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

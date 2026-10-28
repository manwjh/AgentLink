import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { escapeHtml, injectBoot, renderBoot, renderDirectoryPage, renderRobots, renderSitemap } from "./build-seo.mjs";
import { LOCALES } from "../web/src/lib/i18n.js";
import {
  canonicalOf,
  dnsRecordOf,
  hreflangsOf,
  jsonLdOf,
  locsOf,
  metaContent,
  seoCheck,
} from "./seo-check.mjs";

const TYPES = { ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml" };

const BOOT_CATALOGS = {
  en: { hero: { wordmark: "XKNOT", name: "FEDERATION" }, portal: { tagline: "A decentralized information network." } },
  "zh-CN": { hero: { wordmark: "XKNOT", name: "联邦" }, portal: { tagline: "去中心化的信息网络。" } },
  "zh-TW": { hero: { wordmark: "XKNOT", name: "聯邦" }, portal: { tagline: "去中心化的資訊網路。" } },
};

// 一份「本来应该长这样」的站点：入口页带上首屏刊头、canonical、hreflang、标题与描述，
// 目录页与 robots / sitemap 直接用构建时的同一段代码生成，测的才是真产物。
function homeHtml(origin, locale, { noindex = false, canonical = null, noBoot = false } = {}) {
  const alternates = LOCALES.map(
    (item) => `    <link rel="alternate" hreflang="${item}" href="${origin}/${item}/" />`,
  );
  alternates.push(`    <link rel="alternate" hreflang="x-default" href="${origin}/${LOCALES[0]}/" />`);
  const app = noBoot
    ? '<div id="app"></div>'
    : injectBoot('<div id="app"></div>', renderBoot({ locale, catalog: BOOT_CATALOGS[locale] })).trim();
  return [
    "<!doctype html>",
    `<html lang="${locale}">`,
    "  <head>",
    '    <meta charset="utf-8" />',
    `    <title>XKnot Federation — ${locale}</title>`,
    '    <meta name="description" content="A read-only hub for independent Knot instances." />',
    ...(noindex ? ['    <meta name="robots" content="noindex" />'] : []),
    `    <link rel="canonical" href="${canonical || `${origin}/${locale}/`}" />`,
    ...alternates,
    "  </head>",
    `  <body>${app}</body>`,
    "</html>",
  ].join("\n");
}

function writeSite(origin, { extraLocs = [], homes = {}, verifyMeta = "" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "xknot-seo-check-"));
  const put = (rel, text) => {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  put("robots.txt", renderRobots(origin));
  put("sitemap.xml", renderSitemap(origin).replace("</urlset>", extraLocs.map((loc) => `  <url><loc>${loc}</loc></url>`).join("\n") + "</urlset>"));
  // 根路径真实形态：跳转到 /en/ 的短页。验证网址前缀时抓的就是这一页。
  put(
    "index.html",
    [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="utf-8" />',
      "    <title>XKnot Federation</title>",
      '    <meta name="robots" content="noindex" />',
      `    <link rel="canonical" href="${origin}/${LOCALES[0]}/" />`,
      '    <meta http-equiv="refresh" content="0; url=/en/" />',
      ...(verifyMeta ? [verifyMeta] : []),
      "  </head>",
      "  <body></body>",
      "</html>",
    ].join("\n"),
  );
  for (const locale of LOCALES) {
    const head = verifyMeta ? `${verifyMeta}\n` : "";
    put(`${locale}/index.html`, homeHtml(origin, locale, homes[locale]).replace("  </head>", `${head}  </head>`));
    put(
      `${locale}/instances/index.html`,
      renderDirectoryPage({ locale, instances: [], origin, verify: {} }),
    );
  }
  put("knot-help.html", `<!doctype html><html><head><title>Agent guide</title></head><body>ok</body></html>`);
  return dir;
}

async function serve(t, dir) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://local");
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/knot-help") rel = "/knot-help.html";
    if (rel.endsWith("/")) rel += "index.html";
    try {
      const body = readFileSync(path.join(dir, rel));
      res.writeHead(200, { "content-type": TYPES[path.extname(rel)] || "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("seo-check：构建产物原样上线时全部通过", async (t) => {
  const dir = writeSite("https://example.test");
  const origin = await serve(t, dir);
  // origin 必须与写进 canonical 的一致，所以用固定地址写、再从本地端口读。
  const result = await seoCheck({ origin: "https://example.test", fetchText: (url) => fetchTo(origin, url) });
  assert.deepEqual(result.problems, []);
  assert.equal(result.checked, 7);
});

test("seo-check：canonical 指错、带 noindex、robots 缺 sitemap 都被指出", async (t) => {
  const dir = writeSite("https://example.test", {
    homes: { en: { canonical: "https://example.test/zh-CN/" }, "zh-CN": { noindex: true } },
  });
  const origin = await serve(t, dir);
  writeFileSync(path.join(dir, "robots.txt"), "User-agent: *\nAllow: /\n");
  const result = await seoCheck({ origin: "https://example.test", fetchText: (url) => fetchTo(origin, url) });
  const text = result.problems.join("\n");
  assert.match(text, /\/en\/：canonical/);
  assert.match(text, /\/zh-CN\/：带 noindex/);
  assert.match(text, /\/robots.txt：缺少指向 sitemap\.xml/);
});

test("seo-check：首屏刊头没写进 HTML 时算不通过（空壳要等脚本）", async (t) => {
  const dir = writeSite("https://example.test", { homes: { en: { noBoot: true } } });
  const origin = await serve(t, dir);
  const result = await seoCheck({ origin: "https://example.test", fetchText: (url) => fetchTo(origin, url) });
  assert.match(result.problems.join("\n"), /\/en\/：首屏刊头没有写进 HTML/);
  // 另外两个语种照常通过：只报缺的那一份。
  assert.doesNotMatch(result.problems.join("\n"), /\/zh-CN\/：首屏刊头/);
});

test("seo-check：sitemap 里的死链与站外地址都算不通过", async (t) => {
  const dir = writeSite("https://example.test", {
    extraLocs: ["https://example.test/gone", "https://elsewhere.test/en/"],
  });
  const origin = await serve(t, dir);
  const result = await seoCheck({ origin: "https://example.test", fetchText: (url) => fetchTo(origin, url) });
  const text = result.problems.join("\n");
  assert.match(text, /\/gone：sitemap 里的地址返回 404/);
  assert.match(text, /收了站外地址 https:\/\/elsewhere\.test\/en\//);
});

test("seo-check：配了令牌但页面没注入，算不通过；注入了则通过", async (t) => {
  const token = { google: "abc123XYZ_-9" };
  const dir = writeSite("https://example.test");
  const origin = await serve(t, dir);
  const missing = await seoCheck({ origin: "https://example.test", verify: token, fetchText: (url) => fetchTo(origin, url) });
  const text = missing.problems.join("\n");
  assert.match(text, /google-site-verification 的内容与本地令牌不一致/);
  // 根路径是验证网址前缀时真正被抓的那一页，也必须单独报出来。
  assert.match(text, /^\/：google-site-verification/m);

  const injected = writeSite(
    "https://example.test",
    { verifyMeta: `    <meta name="google-site-verification" content="${token.google}" />` },
  );
  const origin2 = await serve(t, injected);
  const ok = await seoCheck({ origin: "https://example.test", verify: token, fetchText: (url) => fetchTo(origin2, url) });
  assert.deepEqual(ok.problems, []);
});

test("seo-check：根路径用跳转代替送页面时算不通过（不跟跳转去查 /en/）", async (t) => {
  const token = { google: "abc123XYZ_-9" };
  const dir = writeSite(
    "https://example.test",
    { verifyMeta: `    <meta name="google-site-verification" content="${token.google}" />` },
  );
  const origin = await serve(t, dir);
  // 真实形态曾经是 location = / 直接 302 到 /en/：页面里的标签永远送不到。
  const result = await seoCheck({
    origin: "https://example.test",
    verify: token,
    fetchText: (url, options) => fetchTo(origin, url, options),
  });
  // 这一份站点根路径是 200，先确认它通过。
  assert.deepEqual(result.problems, []);

  const redirecting = await seoCheck({
    origin: "https://example.test",
    verify: token,
    fetchText: async (url, options) => {
      if (new URL(url).pathname === "/" && options?.redirect === "manual") {
        return { status: 302, type: "text/html", text: "" };
      }
      return fetchTo(origin, url, options);
    },
  });
  assert.match(redirecting.problems.join("\n"), /根路径返回 302 跳转，验证标签没有被送到/);
});

test("seo-check：站点整个打不开时报网络失败，不抛错", async () => {
  const result = await seoCheck({
    origin: "https://example.test",
    fetchText: async () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.ok(result.problems.length > 0);
  assert.match(result.problems[0], /请求失败/);
});

test("seo-check：--dns 时网域属性的 TXT 缺失点名报出来，加了就通过", async (t) => {
  const token = { google: "abc123XYZ_-9" };
  const dir = writeSite("https://example.test", {
    verifyMeta: `    <meta name="google-site-verification" content="${token.google}" />`,
  });
  const origin = await serve(t, dir);
  const base = {
    origin: "https://example.test",
    verify: token,
    dnsHost: "example.test",
    fetchText: (url, options) => fetchTo(origin, url, options),
  };

  const missing = await seoCheck({ ...base, lookupTxt: async () => ["v=spf1 include:spf1.dm.aliyun.com -all"] });
  // 同一张 TXT 表里已经有 SPF 不代表验证通过，缺的就是缺的那一条。
  assert.deepEqual(missing.problems, [`example.test：TXT 里没有 google-site-verification=${token.google}`]);

  const present = await seoCheck({
    ...base,
    lookupTxt: async () => ["v=spf1 include:spf1.dm.aliyun.com -all", `google-site-verification=${token.google}`],
  });
  assert.deepEqual(present.problems, []);
});

test("seo-check：没点名 --dns 就不去查 DNS，查不通也只报不抛", async (t) => {
  const token = { google: "abc123XYZ_-9" };
  const dir = writeSite("https://example.test", {
    verifyMeta: `    <meta name="google-site-verification" content="${token.google}" />`,
  });
  const origin = await serve(t, dir);
  let asked = 0;
  const counted = async () => {
    asked += 1;
    return [];
  };
  const base = { origin: "https://example.test", verify: token, fetchText: (url, options) => fetchTo(origin, url, options) };

  await seoCheck({ ...base, lookupTxt: counted });
  assert.equal(asked, 0, "没给 dnsHost 时不应该发起 DNS 查询");

  const failed = await seoCheck({
    ...base,
    dnsHost: "example.test",
    lookupTxt: async () => {
      throw Object.assign(new Error("queryTxt ESERVFAIL"), { code: "ESERVFAIL" });
    },
  });
  assert.deepEqual(failed.problems, ["example.test：DNS 查询失败（ESERVFAIL）"]);
});

test("解析小工具：loc、meta、canonical、hreflang 与结构化数据", () => {
  assert.deepEqual(locsOf('<urlset><url><loc> https://a.test/en/ </loc></url></urlset>'), ["https://a.test/en/"]);
  const html = [
    '<meta name="msvalidate.01" content="tok" />',
    '<link rel="canonical" href="https://a.test/en/" />',
    '<link rel="alternate" hreflang="x-default" href="https://a.test/en/" />',
    '<script type="application/ld+json">{"@type":"CollectionPage"}</script>',
  ].join("\n");
  assert.equal(metaContent(html, "msvalidate.01"), "tok");
  assert.equal(metaContent(html, "missing"), "");
  assert.equal(canonicalOf(html), "https://a.test/en/");
  assert.deepEqual(hreflangsOf(html), ["x-default"]);
  assert.deepEqual(jsonLdOf(html), [{ "@type": "CollectionPage" }]);
  assert.equal(escapeHtml("a&b"), "a&amp;b");
  // 只有登记过 TXT 记录格式的引擎才算得上 DNS 验证，其余的不能凭空编一条。
  assert.equal(dnsRecordOf("google", "tok"), "google-site-verification=tok");
  assert.equal(dnsRecordOf("bing", "tok"), "");
  assert.equal(dnsRecordOf("google", ""), "");
});

// 把「写进产物的绝对地址」映射到本地端口：体检要的只是这份页面，不是 DNS。
async function fetchTo(localOrigin, url, options = {}) {
  const target = String(url).replace("https://example.test", localOrigin);
  const response = await fetch(target, { redirect: options?.redirect || "follow" });
  return { status: response.status, type: response.headers.get("content-type") || "", text: await response.text() };
}

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LOCALES } from "../web/src/lib/i18n.js";
import {
  DEFAULT_ORIGIN,
  VERIFY_ENGINES,
  directoryInstances,
  injectBoot,
  injectDirectoryFallback,
  injectVerification,
  normalizeOrigin,
  normalizeVerify,
  readVerifyFile,
  BOOT_STYLE,
  renderBoot,
  renderDirectoryFallback,
  renderDirectoryPage,
  renderRobots,
  renderSitemap,
  renderVerification,
  writeSeo,
} from "./build-seo.mjs";

const SAMPLE = {
  instances: [
    {
      id: "wang",
      name: "XKnot创世",
      tagline: "面向 Agent 的信息交换网",
      intro: "第一个 Knot 实例。",
      tags: ["创世节点", "Agent"],
      url: "https://wang.xknot.si/",
      health: { status: "up", hidden: false },
    },
    {
      id: "hidden",
      name: "Hidden",
      url: "https://hidden.xknot.si",
      health: { status: "down", hidden: true },
    },
    {
      id: "bad",
      name: "Bad",
      url: "javascript:alert(1)",
      health: { status: "up" },
    },
  ],
};

const CATALOGS = {
  en: {
    directory: { link: "Instance directory", title: "Instance directory — XKnot Federation" },
    status: { up: "Operational", down: "Down", unknown: "Unknown" },
  },
  "zh-CN": {
    directory: {
      link: "实例目录",
      title: "实例目录 — XKnot 联邦",
      heading: "实例目录",
      all: "查看完整实例目录",
    },
    status: { up: "运行中", down: "离线", unknown: "未知" },
  },
  "zh-TW": {
    directory: { link: "實例目錄", title: "實例目錄 — XKnot 聯邦" },
    status: { up: "運作中", down: "離線", unknown: "未知" },
  },
};

test("directoryInstances 只列可跳转的 https 站点，隐藏条目不出现", () => {
  const rows = directoryInstances(SAMPLE);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["wang"],
  );
  assert.equal(rows[0].url, "https://wang.xknot.si");
});

test("robots 放行页面，挡住接口与管理台，并给出 sitemap 绝对地址", () => {
  const text = renderRobots("https://example.test/");
  assert.match(text, /^User-agent: \*$/m);
  assert.match(text, /^Allow: \/$/m);
  assert.match(text, /^Disallow: \/api\/$/m);
  assert.match(text, /^Disallow: \/admin$/m);
  assert.match(text, /^Sitemap: https:\/\/example\.test\/sitemap\.xml$/m);
  assert.equal(renderRobots(), renderRobots(DEFAULT_ORIGIN));
});

test("sitemap 收三个语种入口、三份目录与 knot-help", () => {
  const text = renderSitemap("https://example.test");
  const locs = [...text.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(locs, [
    "/en/",
    "/en/instances/",
    "/zh-CN/",
    "/zh-CN/instances/",
    "/zh-TW/",
    "/zh-TW/instances/",
    "/knot-help",
  ].map((pathname) => `https://example.test${pathname}`));
  assert.ok(locs.length === 7);
});

test("静态目录页带 canonical、hreflang、实例链接与结构化数据", () => {
  const page = renderDirectoryPage({
    locale: "zh-CN",
    catalog: CATALOGS["zh-CN"],
    instances: directoryInstances(SAMPLE),
    origin: "https://example.test",
  });
  assert.match(page, /<html lang="zh-CN">/);
  assert.match(page, /<title>实例目录 — XKnot 联邦<\/title>/);
  assert.match(page, /<link rel="canonical" href="https:\/\/example\.test\/zh-CN\/instances\/" \/>/);
  for (const locale of LOCALES) {
    assert.match(page, new RegExp(`hreflang="${locale}"`));
  }
  assert.match(page, /hreflang="x-default"/);
  assert.match(page, /<a href="https:\/\/wang\.xknot\.si" rel="noopener noreferrer">XKnot创世<\/a>/);
  assert.match(page, /运行中/);
  assert.match(page, /创世节点 · Agent/);
  assert.match(page, /"@type":"ItemList"/);
  assert.doesNotMatch(page, /hidden\.xknot\.si/);
});

test("目录页转义站点自述，不把 </script> 直接写进页面", () => {
  const page = renderDirectoryPage({
    locale: "en",
    catalog: CATALOGS.en,
    instances: directoryInstances({
      instances: [
        {
          id: "x",
          name: "</script><script>alert(1)</script>",
          tagline: "a & b",
          url: "https://x.xknot.si",
        },
      ],
    }),
    origin: "https://example.test",
  });
  assert.doesNotMatch(page, /<script>alert\(1\)<\/script>/);
  assert.match(page, /&lt;\/script&gt;/);
  assert.match(page, /a &amp; b/);
});

test("空目录给出空状态，不生成空列表", () => {
  const page = renderDirectoryPage({ locale: "en", catalog: CATALOGS.en, instances: [], origin: "https://example.test" });
  assert.match(page, /No instances listed yet\./);
  assert.doesNotMatch(page, /<ul class="list">/);
});

test("首页摘要只有一段，重复注入不会叠加", () => {
  const html = "<!doctype html><html><body><div id=\"app\"></div></body></html>";
  const fallback = renderDirectoryFallback({
    locale: "en",
    catalog: CATALOGS.en,
    instances: directoryInstances(SAMPLE),
  });
  const once = injectDirectoryFallback(html, fallback);
  const twice = injectDirectoryFallback(once, fallback);
  assert.equal(twice, once);
  assert.equal(twice.match(/<!-- knot-directory -->/g).length, 1);
  assert.match(twice, /<noscript>/);
  assert.match(twice, /https:\/\/wang\.xknot\.si/);
});

// 首屏文案：本语种优先，缺条目退回英文，与页面上 makeT 的回退链一致。
const BOOT_CATALOGS = {
  en: {
    hero: {
      wordmark: "XKNOT",
      name: "FEDERATION",
      eyebrow: "DISTRIBUTED NETWORK",
      protocol: "FEDERATION PROTOCOL v1.0",
      summary: "A read-only hub.",
    },
    portal: { tagline: "A decentralized information network." },
    directory: { link: "Instance directory", title: "Instance directory — XKnot Federation" },
    status: { up: "Operational" },
  },
  "zh-CN": {
    hero: { wordmark: "XKNOT", name: "联邦", eyebrow: "分布式网络", summary: "中枢只读。" },
    portal: { tagline: "去中心化的信息网络。" },
  },
  "zh-TW": { hero: { wordmark: "XKNOT", name: "聯邦" } },
};

test("首屏刊头用本语种词条，缺条目退回英文", () => {
  const zh = renderBoot({ locale: "zh-CN", catalog: BOOT_CATALOGS["zh-CN"], fallback: BOOT_CATALOGS.en });
  assert.match(zh, /<span class="boot-name">联邦<\/span>/);
  assert.match(zh, /去中心化的信息网络。/);
  assert.match(zh, /中枢只读。/);
  assert.doesNotMatch(zh, /A decentralized information network\./);

  // 繁体只登记了标题：其余条目按回退链取英文，不留空标签。
  const tw = renderBoot({ locale: "zh-TW", catalog: BOOT_CATALOGS["zh-TW"], fallback: BOOT_CATALOGS.en });
  assert.match(tw, /<span class="boot-name">聯邦<\/span>/);
  assert.match(tw, /A decentralized information network\./);

  // 一条文案都没有就不写：半截刊头比空壳更难读。
  assert.equal(renderBoot({ locale: "en", catalog: {} }), "");
  assert.throws(() => renderBoot({ locale: "fr", catalog: BOOT_CATALOGS.en }), /未登记的语种/);
});

test("首屏刊头转义文案，不把标签拼进页面", () => {
  const boot = renderBoot({
    locale: "en",
    catalog: { hero: { wordmark: "</h1><script>alert(1)</script>" }, portal: { tagline: "a & b" } },
  });
  assert.doesNotMatch(boot, /<script>alert\(1\)<\/script>/);
  assert.match(boot, /&lt;\/h1&gt;&lt;script&gt;/);
  assert.match(boot, /a &amp; b/);
});

test("首屏写进 #app，重复注入不叠加，撤掉后不留样式", () => {
  const html = '<!doctype html><html><body><div id="app"></div></body></html>';
  const boot = renderBoot({ locale: "en", catalog: BOOT_CATALOGS.en });
  const once = injectBoot(html, boot);
  assert.match(once, /<div id="app">\n<!-- knot-boot -->/);
  assert.equal(once.match(/<!-- knot-boot -->/g).length, 1);
  assert.equal(injectBoot(once, boot), once);
  // 样式跟着这一块走：撤掉首屏时一起消失，不在主样式之外留副本。
  const removed = injectBoot(once, "");
  assert.doesNotMatch(removed, /knot-boot/);
  assert.doesNotMatch(removed, /boot-mast/);
  assert.throws(() => injectBoot("<html><body></body></html>", boot), /id="app"/);
});

test("首屏样式与 App.vue 里的刊头同步：改了组件样式没跟过来就会失败", () => {
  const app = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "src", "App.vue"),
    "utf8",
  );
  const ruleOf = (css, selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    return match ? match[1] : "";
  };
  const propsOf = (block, props) => {
    const out = {};
    for (const prop of props) {
      const match = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(block);
      if (match) out[prop] = match[1].replace(/\s+/g, " ").trim();
    }
    return out;
  };

  // 首屏刊头是组件刊头的静态副本：这几条决定文字的位置与字号，
  // 对不上就等于挂载时跳一次版，所以逐条比。
  const pairs = [
    [".wordmark", ".boot-wordmark", ["font-family", "font-size", "font-weight", "line-height", "letter-spacing"]],
    [".name-outline", ".boot-name", ["font-family", "font-size", "font-weight", "letter-spacing"]],
    [".lede", ".boot-lede", ["max-width", "font-size", "line-height"]],
    [".mast-note", ".boot-note", ["max-width", "font-size", "line-height"]],
    [".eyebrow", ".boot-eyebrow", ["display", "gap", "flex-wrap", "font-family", "font-size", "letter-spacing"]],
    [".mast-copy", ".boot-mast", ["display", "flex-direction", "gap"]],
  ];
  for (const [appSelector, bootSelector, props] of pairs) {
    const appRule = propsOf(ruleOf(app, appSelector), props);
    const bootRule = propsOf(ruleOf(BOOT_STYLE, bootSelector), props);
    assert.deepEqual(bootRule, appRule, `${bootSelector} 与 App.vue 的 ${appSelector} 不一致：同步改 BOOT_STYLE`);
  }
});

test("origin 只接受 http/https 绝对地址", () => {
  assert.equal(normalizeOrigin("https://xknot.si///"), "https://xknot.si");
  assert.throws(() => normalizeOrigin("xknot.si"), /绝对地址/);
  assert.throws(() => normalizeOrigin("ftp://xknot.si"), /http\/https/);
});

test("验证令牌：只认登记过的引擎，值按字符集收，空值当没配", () => {
  assert.deepEqual(normalizeVerify({ google: " abc-1234 ", bing: "" }), { google: "abc-1234" });
  assert.deepEqual(normalizeVerify(null), {});
  assert.throws(() => normalizeVerify(["google"]), /必须是对象/);
  // 键写错要构建失败：静默忽略只会产出一份「以为注入过」的页面。
  assert.throws(() => normalizeVerify({ googel: "abc12345" }), /未登记的引擎：googel/);
  // 引号、尖括号一律拒收，令牌不会被拼进标签结构。
  assert.throws(() => normalizeVerify({ google: 'abc"><script>' }), /令牌不合规/);
  assert.throws(() => normalizeVerify({ google: "short" }), /令牌不合规/);
});

test("验证 meta：只出配过的引擎，重复注入不叠加，撤掉后不留空块", () => {
  const html = "<!doctype html><html><head><title>t</title></head><body></body></html>";
  const once = injectVerification(html, { google: "tok-12345", baidu: "code-67890" });
  assert.match(once, /<meta name="google-site-verification" content="tok-12345" \/>/);
  assert.match(once, /<meta name="baidu-site-verification" content="code-67890" \/>/);
  assert.doesNotMatch(once, /msvalidate\.01/);
  assert.equal(injectVerification(once, { google: "tok-12345", baidu: "code-67890" }), once);
  assert.equal(once.match(/<!-- knot-verify -->/g).length, 1);

  const swapped = injectVerification(once, { bing: "bing-token-1" });
  assert.doesNotMatch(swapped, /google-site-verification/);
  assert.match(swapped, /msvalidate\.01" content="bing-token-1"/);

  assert.doesNotMatch(injectVerification(swapped, {}), /knot-verify/);
  assert.equal(renderVerification({}), "");
  assert.equal(VERIFY_ENGINES.length, 4);
});

test("验证令牌文件读不到就是没配，读不懂则明确报错", () => {
  assert.deepEqual(readVerifyFile(""), {});
  assert.deepEqual(readVerifyFile("/nonexistent/search-verify.json"), {});

  const dir = mkdtempSync(path.join(tmpdir(), "xknot-verify-"));
  try {
    const good = path.join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ google: "tok-abc-123" }));
    assert.deepEqual(readVerifyFile(good), { google: "tok-abc-123" });

    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    assert.throws(() => readVerifyFile(bad), /读不懂验证令牌文件/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeSeo 写出 robots、sitemap 与三个语种的目录页", () => {
  const dist = mkdtempSync(path.join(tmpdir(), "xknot-seo-"));
  try {
    mkdirSync(path.join(dist, "data"), { recursive: true });
    writeFileSync(path.join(dist, "data", "hub.json"), JSON.stringify(SAMPLE));
    for (const locale of LOCALES) {
      mkdirSync(path.join(dist, locale), { recursive: true });
      writeFileSync(
        path.join(dist, locale, "index.html"),
        '<!doctype html><html><body><div id="app"></div></body></html>',
      );
    }

    const result = writeSeo({ distDir: dist, origin: "https://example.test", catalogs: CATALOGS });
    assert.deepEqual(result, { instances: 1, locales: LOCALES.length, verified: [] });
    assert.ok(existsSync(path.join(dist, "robots.txt")));
    assert.ok(existsSync(path.join(dist, "sitemap.xml")));

    for (const locale of LOCALES) {
      const page = readFileSync(path.join(dist, locale, "instances", "index.html"), "utf8");
      assert.match(page, new RegExp(`<html lang="${locale}">`));
      assert.match(page, /https:\/\/wang\.xknot\.si/);
      const home = readFileSync(path.join(dist, locale, "index.html"), "utf8");
      assert.equal(home.match(/<!-- knot-directory -->/g).length, 1);
    }
    assert.match(
      readFileSync(path.join(dist, "en", "instances", "index.html"), "utf8"),
      /Instance directory — XKnot Federation/,
    );

    // 再写一次仍只有一段摘要，构建可以重复执行。
    writeSeo({ distDir: dist, origin: "https://example.test", catalogs: CATALOGS });
    assert.equal(
      readFileSync(path.join(dist, "en", "index.html"), "utf8").match(/<!-- knot-directory -->/g).length,
      1,
    );
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("writeSeo 把验证 meta 写进根路径、语种入口与目录页", () => {
  const dist = mkdtempSync(path.join(tmpdir(), "xknot-seo-verify-"));
  try {
    mkdirSync(path.join(dist, "data"), { recursive: true });
    writeFileSync(path.join(dist, "data", "hub.json"), JSON.stringify(SAMPLE));
    // 根路径是跳转页：Search Console 验证网址前缀时抓的就是它。
    writeFileSync(
      path.join(dist, "index.html"),
      '<!doctype html><html><head><title>t</title><meta http-equiv="refresh" content="0; url=/en/" /></head><body></body></html>',
    );
    for (const locale of LOCALES) {
      mkdirSync(path.join(dist, locale), { recursive: true });
      writeFileSync(
        path.join(dist, locale, "index.html"),
        '<!doctype html><html><head><title>t</title></head><body><div id="app"></div></body></html>',
      );
    }

    const result = writeSeo({
      distDir: dist,
      origin: "https://example.test",
      catalogs: CATALOGS,
      verify: { google: "g-token-12345", bing: "b-token-67890" },
    });
    assert.deepEqual(result.verified, ["google", "bing"]);

    const root = readFileSync(path.join(dist, "index.html"), "utf8");
    assert.match(root, /<meta name="google-site-verification" content="g-token-12345" \/>/);
    assert.match(root, /<meta http-equiv="refresh" content="0; url=\/en\/" \/>/, "跳转本身要保持原样");

    for (const locale of LOCALES) {
      const home = readFileSync(path.join(dist, locale, "index.html"), "utf8");
      assert.match(home, /<meta name="google-site-verification" content="g-token-12345" \/>/);
      assert.match(home, /<meta name="msvalidate\.01" content="b-token-67890" \/>/);
      // 目录摘要与验证 meta 各占一对标记，互不覆盖。
      assert.equal(home.match(/<!-- knot-directory -->/g).length, 1);
      assert.equal(home.match(/<!-- knot-verify -->/g).length, 1);
      const page = readFileSync(path.join(dist, locale, "instances", "index.html"), "utf8");
      assert.match(page, /google-site-verification/);
    }

    // 再写一次仍然只有一份；去掉令牌后整块消失。
    writeSeo({ distDir: dist, origin: "https://example.test", catalogs: CATALOGS, verify: { google: "g-token-12345" } });
    const home = readFileSync(path.join(dist, "en", "index.html"), "utf8");
    assert.equal(home.match(/<!-- knot-verify -->/g).length, 1);
    assert.doesNotMatch(home, /msvalidate\.01/);

    writeSeo({ distDir: dist, origin: "https://example.test", catalogs: CATALOGS, verify: {} });
    assert.doesNotMatch(readFileSync(path.join(dist, "en", "index.html"), "utf8"), /knot-verify/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("writeSeo 把首屏写进三个语种入口，重复构建不叠加", () => {
  const dist = mkdtempSync(path.join(tmpdir(), "xknot-seo-boot-"));
  try {
    mkdirSync(path.join(dist, "data"), { recursive: true });
    writeFileSync(path.join(dist, "data", "hub.json"), JSON.stringify(SAMPLE));
    for (const locale of LOCALES) {
      mkdirSync(path.join(dist, locale), { recursive: true });
      writeFileSync(
        path.join(dist, locale, "index.html"),
        '<!doctype html><html><body><div id="app"></div></body></html>',
      );
    }

    writeSeo({ distDir: dist, origin: "https://example.test", catalogs: BOOT_CATALOGS });
    const zh = readFileSync(path.join(dist, "zh-CN", "index.html"), "utf8");
    assert.equal(zh.match(/<!-- knot-boot -->/g).length, 1);
    assert.match(zh, /去中心化的信息网络。/);
    // 三处注入各用一对标记：首屏、目录摘要、验证 meta 互不覆盖。
    assert.equal(zh.match(/<!-- knot-directory -->/g).length, 1);
    const en = readFileSync(path.join(dist, "en", "index.html"), "utf8");
    assert.match(en, /<h1 class="boot-h1">/);
    assert.match(en, /A decentralized information network\./);

    writeSeo({ distDir: dist, origin: "https://example.test", catalogs: BOOT_CATALOGS });
    const twice = readFileSync(path.join(dist, "zh-CN", "index.html"), "utf8");
    assert.equal(twice.match(/<!-- knot-boot -->/g).length, 1);
    assert.equal(twice.match(/<style>/g).length, 1, "首屏样式不能叠加");
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("writeSeo 缺快照时明确报错", () => {
  const dist = mkdtempSync(path.join(tmpdir(), "xknot-seo-missing-"));
  try {
    assert.throws(() => writeSeo({ distDir: dist }), /build-hub-data\.mjs/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

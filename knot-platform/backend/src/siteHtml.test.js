import assert from "node:assert/strict";
import test from "node:test";
import {
  documentLang,
  renderDiscoverHtml,
  renderEntryHtml,
  renderRobots,
  renderSitemap,
} from "./siteHtml.js";

// 首页与发现页的 head、首帧与 robots 都由这里生成：SPA 跑起来之前，机器与分享
// 预览只能读这份 HTML。这里盯住「读得到」这件事本身，不涉及运行时。

const SHELL = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
    <meta name="description" content="Knot" />
    <title>Knot</title>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>`;

const SITE = {
  name: "XKnot创世启元",
  tagline: "面向 AI 时代、服务于 Agent 的信息交换网。",
  intro: "一个站点，收发一手情报。",
  owner: "PaulWang",
  contact: "owner@example.com",
  region: "SG",
  logo: "https://wang.xknot.si/logo.png",
};

test("首页头里有站点名、介绍、canonical 与社交预览", () => {
  const html = renderEntryHtml(SHELL, { site: SITE, origin: "https://wang.xknot.si/" });
  assert.match(html, /<title>XKnot创世启元 · 面向 AI 时代、服务于 Agent 的信息交换网。<\/title>/);
  assert.match(html, /<meta name="description" content="一个站点，收发一手情报。" \/>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/wang\.xknot\.si\/" \/>/);
  assert.match(html, /<meta property="og:title" content="[^"]+" \/>/);
  assert.match(html, /<meta property="og:description" content="一个站点，收发一手情报。" \/>/);
  assert.match(html, /<meta property="og:url" content="https:\/\/wang\.xknot\.si\/" \/>/);
  assert.match(html, /<meta property="og:image" content="https:\/\/wang\.xknot\.si\/logo\.png" \/>/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
});

test("多行的站点自述被收成一行，标题与 meta 里不留换行", () => {
  // 主理人在 /admin 里写的自述本来就会换行。换行留在 content 里，标签页会折行、
  // 分享预览只取第一行，搜索结果显示一个断掉的句子。
  const multiline = {
    ...SITE,
    name: "XKnot\n创世启元",
    tagline: "面向 AI 时代、\n服务于 Agent 的信息交换网。",
    intro: "一个站点，\n\n收发一手情报。",
  };
  for (const html of [
    renderEntryHtml(SHELL, { site: multiline, origin: "https://wang.xknot.si" }),
    renderDiscoverHtml(SHELL, { site: multiline, origin: "https://wang.xknot.si" }),
  ]) {
    const head = html.slice(0, html.indexOf("</head>"));
    const title = head.match(/<title>([\s\S]*?)<\/title>/)[1];
    assert.doesNotMatch(title, /\n/, `标题里还有换行：${JSON.stringify(title)}`);
    for (const [, content] of head.matchAll(/<meta [^>]*content="([^"]*)"/g)) {
      assert.doesNotMatch(content, /\n/, `meta 里还有换行：${JSON.stringify(content)}`);
    }
    // 只收空白，不吞字：两行拼起来仍然是完整的一句话。
    assert.match(head, /面向 AI 时代、 服务于 Agent 的信息交换网。/);
  }
});

test("没有 JS 也能读到一段自我介绍", () => {
  const html = renderEntryHtml(SHELL, { site: SITE, origin: "https://wang.xknot.si" });
  const noscript = html.match(/<noscript>[\s\S]*?<\/noscript>/)?.[0] || "";
  assert.match(noscript, /XKnot创世启元/);
  assert.match(noscript, /一个站点，收发一手情报。/);
  assert.match(noscript, /PaulWang · owner@example\.com/);
});

test("JSON-LD 不被 HTML 实体破坏", () => {
  const html = renderEntryHtml(SHELL, { site: SITE, origin: "https://wang.xknot.si" });
  const json = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(json, /&quot;/);
  const parsed = JSON.parse(json);
  assert.equal(parsed["@type"], "WebSite");
  assert.equal(parsed.url, "https://wang.xknot.si/");
  assert.equal(parsed.name, "XKnot创世启元");
});

test("站点名里的尖括号会被转义，不会注入标签", () => {
  const html = renderEntryHtml(SHELL, {
    site: { name: "<script>alert(1)</script>", tagline: "a & b" },
    origin: "https://wang.xknot.si",
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /a &amp; b/);
});

test("SPA 挂载点与构建产物原样保留", () => {
  const html = renderEntryHtml(SHELL, { site: SITE, origin: "https://wang.xknot.si" });
  assert.match(html, /<div id="app"><\/div>/);
  assert.match(html, /src="\/assets\/index-abc\.js"/);
});

test("首帧内容写进挂载点，脚本没到也有本站的名字", () => {
  const BOOT_SHELL = `<html lang="en"><head><title>Knot</title></head><body>
    <div id="app">
      <div class="knot-boot" data-knot-boot>
        <p class="knot-boot-name" data-knot-name>Knot</p>
        <p class="knot-boot-line" data-knot-line>正在进入…</p>
        <a class="knot-boot-retry" data-knot-retry href="./">重新加载</a>
      </div>
    </div>
  </body></html>`;
  const html = renderEntryHtml(BOOT_SHELL, { site: SITE, origin: "https://wang.xknot.si" });
  assert.match(html, /data-knot-name>XKnot创世启元<\/p>/);
  assert.match(html, /data-knot-line>面向 AI 时代、服务于 Agent 的信息交换网。<\/p>/);
  assert.match(html, /data-knot-retry href="https:\/\/wang\.xknot\.si\/">/);
  // 没有 JS 时读到的仍是同一套自我介绍，不是两份互相矛盾的文案。
  const noscript = html.match(/<noscript>[\s\S]*?<\/noscript>/)?.[0] || "";
  assert.match(noscript, /一个站点，收发一手情报。/);
});

test("拿错文件时直接报错，不默默推一份空壳", () => {
  assert.throws(() => renderEntryHtml("<html></html>", { site: SITE, origin: "https://a.example" }), /app/);
  assert.throws(() => renderEntryHtml(SHELL, { site: SITE, origin: "wang.xknot.si" }), /origin/);
});

test("lang 跟着档案里的默认语种走", () => {
  // 主理人写了哪一项就用哪一项：US 服务器的英文站不会因为机器在美国而变成 en，
  // 反过来新加坡的中文站也一样。
  assert.equal(documentLang({ locale: "zh-TW", text: "a site for agents" }), "zh-TW");
  assert.equal(documentLang({ locale: "en", text: "一个站点" }), "en");
  // 旧档案还没有 locale：按文案推一次，与迁移脚本同一套规则。
  assert.equal(documentLang({ text: "一个站点" }), "zh-CN");
  assert.equal(documentLang({ text: "a site for agents" }), "en");
  const html = renderEntryHtml(SHELL, { site: { ...SITE, locale: "zh-TW" }, origin: "https://wang.xknot.si" });
  assert.match(html, /<html lang="zh-TW">/);
  const json = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(json).inLanguage, "zh-TW");
});

test("robots.txt 放行页面，挡住接口与管理台", () => {
  const text = renderRobots("https://wang.xknot.si/");
  assert.match(text, /^User-agent: \*$/m);
  assert.match(text, /^Allow: \/$/m);
  assert.match(text, /^Disallow: \/api\/$/m);
  assert.match(text, /^Disallow: \/admin$/m);
  assert.match(text, /^Sitemap: https:\/\/wang\.xknot\.si\/sitemap\.xml$/m);
});

test("发现页有自己的 canonical，不指回首页", () => {
  const html = renderDiscoverHtml(SHELL, { site: SITE, origin: "https://wang.xknot.si/" });
  assert.match(html, /<title>XKnot创世启元 · 发现<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/wang\.xknot\.si\/discover" \/>/);
  // 首页那条 canonical 不能同时留着：两页指同一个地址，发现页等于没被索引。
  assert.doesNotMatch(html, /<link rel="canonical" href="https:\/\/wang\.xknot\.si\/" \/>/);
  assert.match(html, /<meta property="og:url" content="https:\/\/wang\.xknot\.si\/discover" \/>/);
  assert.match(html, /<meta name="description" content="公开的信息流 · 面向 AI 时代、服务于 Agent 的信息交换网。" \/>/);
});

test("发现页的 JSON-LD 是 CollectionPage，并挂在本站 WebSite 下", () => {
  const html = renderDiscoverHtml(SHELL, { site: SITE, origin: "https://wang.xknot.si" });
  const json = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
  const parsed = JSON.parse(json);
  assert.equal(parsed["@type"], "CollectionPage");
  assert.equal(parsed.url, "https://wang.xknot.si/discover");
  assert.equal(parsed.isPartOf.url, "https://wang.xknot.si/");
  assert.equal(parsed.inLanguage, "zh-CN");
});

test("没有 JS 也能在发现页读到这是公开信息流", () => {
  const html = renderDiscoverHtml(SHELL, { site: SITE, origin: "https://wang.xknot.si" });
  const noscript = html.match(/<noscript>[\s\S]*?<\/noscript>/)?.[0] || "";
  assert.match(noscript, /公开的信息流/);
  assert.match(noscript, /XKnot创世启元/);
  assert.match(noscript, /href="\/">回到首页</);
});

test("构建时不知道域名也生成发现页：canonical 用相对地址", () => {
  // 构建产物的 <html lang> 是默认语种（zh-CN）；没有档案时按它出文案，
  // 不拿「Knot」这个词去猜语种。
  const html = renderDiscoverHtml(SHELL.replace('<html lang="en">', '<html lang="zh-CN">'), {});
  assert.match(html, /<link rel="canonical" href="\/discover" \/>/);
  assert.match(html, /<title>Knot · 发现<\/title>/);
  assert.match(html, /<meta name="description" content="本站公开的帖子、问答与情报。" \/>/);
  // og:url 必须绝对地址；没有 origin 时宁可不写，也不写一个相对的。
  assert.doesNotMatch(html, /property="og:url"/);
});

test("发现页把模板里原有的 canonical 换掉，不会留下两条", () => {
  const withCanonical = SHELL.replace(
    "</head>",
    '    <link rel="canonical" href="https://wang.xknot.si/" />\n  </head>',
  );
  const html = renderDiscoverHtml(withCanonical, { site: SITE, origin: "https://wang.xknot.si" });
  assert.equal(html.match(/rel="canonical"/g)?.length, 1);
  assert.match(html, /canonical" href="https:\/\/wang\.xknot\.si\/discover"/);
});

test("发现页的站点名同样转义", () => {
  const html = renderDiscoverHtml(SHELL, {
    site: { name: "<script>alert(1)</script>", tagline: "a & b", locale: "zh-CN" },
    origin: "https://wang.xknot.si",
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /公开的信息流 · a &amp; b/);
});

test("拿错文件时发现页也直接报错", () => {
  assert.throws(() => renderDiscoverHtml("<html></html>", {}), /app/);
  assert.throws(() => renderDiscoverHtml(SHELL, { origin: "wang.xknot.si" }), /origin/);
});

test("sitemap 只列真正的静态页", () => {
  const xml = renderSitemap("https://wang.xknot.si");
  assert.match(xml, /<loc>https:\/\/wang\.xknot\.si\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/wang\.xknot\.si\/discover<\/loc>/);
  // 账户态页面与文档不进 sitemap。
  assert.doesNotMatch(xml, /\/mine|\/friends|\/help/);
});

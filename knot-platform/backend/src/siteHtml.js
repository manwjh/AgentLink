// 站点自述写进 HTML：首页与发现页的 head、首帧文案、robots.txt 与 sitemap.xml。
//
// 站点名称、介绍和 logo 属于「自述区」，主理人在 /admin 里随时改，而构建产物
// 不知道域名，也不知道这份档案。所以这一层在发页面的时候才做：Backend 读
// web/dist 的那份模板，按当前档案与对外地址渲染一遍。
//
// 这里不渲染信息流，也不产出静态站点：只把「首页 HTML 里一个字都没有」
// 变成「首页 HTML 里有站点名、一句话介绍和详细介绍」。
//
// 浏览器拿到的仍然是同一份 SPA 外壳，所以本模块只替换 head、首帧与 noscript。

import { inferLocale, isLocale } from "@knot/locale";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// /discover 的文字随站点默认语种走。它是信息流本身，不是首页的复述：
// 首页回答「这个站是什么」，这一页回答「这里现在有什么」。
const DISCOVER_COPY = {
  en: {
    title: "Discover",
    heading: "Public posts and intel",
    description: "Public posts, questions, and intel from this Knot instance.",
    loading: "Loading public posts…",
    back: "Open the front page",
  },
  "zh-CN": {
    title: "发现",
    heading: "公开的信息流",
    description: "本站公开的帖子、问答与情报。",
    loading: "正在读取公开内容…",
    back: "回到首页",
  },
  "zh-TW": {
    title: "發現",
    heading: "公開的資訊流",
    description: "本站公開的貼文、問答與情報。",
    loading: "正在讀取公開內容…",
    back: "回到首頁",
  },
};

function discoverCopy(lang) {
  return DISCOVER_COPY[lang] || DISCOVER_COPY["zh-CN"];
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/**
 * 静态 HTML 的 lang 描述页面里真正写着的那段文字。
 * 档案里的 `locale` 是主理人自己定的，直接用；还没有这一项的旧档案按文案推一次。
 */
export function documentLang({ locale, text } = {}) {
  if (isLocale(locale)) return locale;
  return inferLocale(text);
}

/**
 * 把多行文字收成一行。
 *
 * 站点自述是主理人在 /admin 里写的，带换行很正常。换行进了 <title> 与 meta 的
 * content，标签页会折行、分享预览截在第一行，搜索引擎也读到一个断句的句子。
 * HTML 里读得到的那几段正文不走这里，换行在那里仍然是换行。
 */
function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** 按字符截断，避免把 emoji 或中文切一半。 */
function clip(text, limit) {
  const chars = [...oneLine(text)];
  return chars.length <= limit ? chars.join("") : chars.slice(0, limit).join("");
}

function cleanSite(site, fallbackName) {
  const name = String(site?.name || "").trim() || fallbackName;
  return {
    name,
    // 站点默认语种：主理人在 /admin 里定。旧档案没有这一项时留空，下面按文案推一次。
    locale: isLocale(site?.locale) ? site.locale : "",
    tagline: String(site?.tagline || "").trim(),
    intro: String(site?.intro || "").trim(),
    logo: /^https:\/\//i.test(String(site?.logo || "")) ? String(site.logo).trim() : "",
    owner: String(site?.owner || "").trim(),
    contact: String(site?.contact || "").trim(),
  };
}

function metaTag(attr, key, value) {
  return `    <meta ${attr}="${key}" content="${escapeHtml(oneLine(value))}" />`;
}

/**
 * 把一份 SPA 空壳变成对外可读的首页。
 * template 里必须有 `<div id="app"></div>`：没有就说明拿错了文件，宁可直接报错。
 */
export function renderEntryHtml(template, { site, origin, fallbackName = "Knot" } = {}) {
  const html = String(template || "");
  // 挂载点可以带首帧内容：脚本没到或被旧内核拒绝执行时，那一段就是页面本身。
  if (!/<div[^>]*\bid="app"[^>]*>/i.test(html)) {
    throw new Error("入口首页里找不到 <div id=\"app\">，这不像是 web/dist/index.html");
  }
  const base = String(origin || "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new Error(`origin 必须是绝对地址：${origin}`);

  const info = cleanSite(site, fallbackName);
  const text = [info.name, info.tagline, info.intro].filter(Boolean).join(" ");
  const lang = documentLang({ locale: info.locale, text });
  const description = clip(info.intro || info.tagline || info.name, 160);
  const title = clip(info.tagline ? `${info.name} · ${info.tagline}` : info.name, 70);

  const head = [
    `    <link rel="canonical" href="${escapeHtml(base + "/")}" />`,
    metaTag("property", "og:type", "website"),
    metaTag("property", "og:site_name", info.name),
    metaTag("property", "og:title", title),
    metaTag("property", "og:description", description),
    metaTag("property", "og:url", base + "/"),
    ...(info.logo ? [metaTag("property", "og:image", info.logo)] : []),
    metaTag("name", "twitter:card", info.logo ? "summary_large_image" : "summary"),
    metaTag("name", "twitter:title", title),
    metaTag("name", "twitter:description", description),
  ].join("\n");
  // JSON-LD 在 <script> 里不解码 HTML 实体，不能走 escapeHtml；
  // 只要把 `<` 换成 \u003c，就挡住了 `</script>` 提前闭合这条注入路径。
  const structured = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: info.name,
    url: base + "/",
    description,
    inLanguage: lang,
    ...(info.owner ? { author: { "@type": "Person", name: info.owner } } : {}),
  }).replace(/</g, "\\u003c");

  // 标题已经是站点名，正文段落里不再重复一遍。
  const lines = [info.tagline, info.intro, [info.owner, info.contact].filter(Boolean).join(" · ")]
    .filter(Boolean)
    .map((line) => `        <p>${escapeHtml(String(line).replace(/\s+/g, " "))}</p>`)
    .join("\n");

  const noscript = [
    "    <noscript>",
    "      <style>.knot-static{max-width:36rem;margin:3rem auto;padding:0 1rem;font-family:system-ui,-apple-system,sans-serif;line-height:1.7;color:#050505}.knot-static h1{margin:0 0 .5rem;font-size:1.7rem;line-height:1.2}.knot-static p{margin:.6rem 0;color:#65676b}.knot-static p:first-of-type{color:#050505;font-size:1.05rem}</style>",
    '      <div class="knot-static">',
    `        <h1>${escapeHtml(info.name)}</h1>`,
    lines,
    "      </div>",
    "    </noscript>",
  ].join("\n");

  let out = html
    .replace(/<html[^>]*>/i, `<html lang="${lang}">`)
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);

  if (/<meta name="description"[^>]*>/i.test(out)) {
    out = out.replace(/<meta name="description"[^>]*>/i, metaTag("name", "description", description).trim());
  } else {
    out = out.replace(/\n[ \t]*<\/head>/i, `\n    <meta name="description" content="${escapeHtml(description)}" />\n  </head>`);
  }

  out = out
    .replace(
      /\n[ \t]*<\/head>/i,
      `\n${head}\n    <script type="application/ld+json">${structured}</script>\n  </head>`,
    )
    // 首帧内容：构建产物里写的是通用文案，这里按站点档案换成本站的名字与一句话介绍。
    // 正则只认带 data-knot-* 的那个节点，不碰页面里的同名元素以外的结构。
    .replace(/(<[^>]*data-knot-name[^>]*>)[\s\S]*?(<\/[a-z]+>)/i, `$1${escapeHtml(info.name)}$2`)
    .replace(
      /(<[^>]*data-knot-line[^>]*>)[\s\S]*?(<\/[a-z]+>)/i,
      `$1${escapeHtml(info.tagline || description || "正在进入…")}$2`,
    )
    .replace(/(data-knot-retry[^>]*href=")[^"]*(")/i, `$1${escapeHtml(base + "/")}$2`)
    .replace(/\n[ \t]*<\/body>/i, `\n${noscript}\n  </body>`);

  return out;
}

/**
 * 发现页的静态壳。
 *
 * `/discover` 以前是 `try_files ... /index.html` 兜底出来的：浏览器地址是 /discover，
 * HTML 里的 canonical 却指着首页，爬虫于是把两页当成同一页，sitemap 里那条 /discover
 * 也等于白写。这里给它一份独立的 HTML，canonical 指向自己。
 *
 * 构建时没有站点档案和 origin，也照样生成一份：Backend 直接发 web/dist 里的这一份，
 * 相对 canonical（`/discover`）在哪个域名下都能解析，不会指回首页。
 */
export function renderDiscoverHtml(template, { site, origin = "", fallbackName = "Knot" } = {}) {
  const html = String(template || "");
  if (!/<div[^>]*\bid="app"[^>]*>/i.test(html)) {
    throw new Error("入口发现页里找不到 <div id=\"app\">，这不像是 web/dist/index.html");
  }
  const base = String(origin || "").replace(/\/+$/, "");
  if (base && !/^https?:\/\//i.test(base)) throw new Error(`origin 必须是绝对地址：${origin}`);

  const info = cleanSite(site, fallbackName);
  // 语种优先级：档案里写了的用写的；有文案就按文案推；两样都没有（构建时）
  // 才用模板自己的 <html lang>，不要拿「Knot」这个词去猜语种。
  const templateLang = html.match(/<html[^>]*\blang="([^"]+)"/i)?.[1] || "";
  const hasCopy = Boolean(info.tagline || info.intro);
  const locale =
    info.locale ||
    (hasCopy
      ? inferLocale(`${info.tagline} ${info.intro}`)
      : isLocale(templateLang)
        ? templateLang
        : "");
  const lang = documentLang({
    locale,
    text: [info.name, info.tagline, info.intro].filter(Boolean).join(" "),
  });
  const copy = discoverCopy(lang);
  const description = clip(
    info.tagline ? `${copy.heading} · ${info.tagline}` : info.intro || copy.description,
    160,
  );
  const title = clip(`${info.name} · ${copy.title}`, 70);
  const canonical = base ? `${base}/discover` : "/discover";

  const head = [
    `    <link rel="canonical" href="${escapeHtml(canonical)}" />`,
    metaTag("property", "og:type", "website"),
    metaTag("property", "og:site_name", info.name),
    metaTag("property", "og:title", title),
    metaTag("property", "og:description", description),
    ...(base ? [metaTag("property", "og:url", canonical)] : []),
    ...(info.logo ? [metaTag("property", "og:image", info.logo)] : []),
    metaTag("name", "twitter:card", info.logo ? "summary_large_image" : "summary"),
    metaTag("name", "twitter:title", title),
    metaTag("name", "twitter:description", description),
  ].join("\n");

  const structured = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: title,
    description,
    inLanguage: lang,
    ...(base
      ? { url: canonical, isPartOf: { "@type": "WebSite", name: info.name, url: `${base}/` } }
      : {}),
  }).replace(/</g, "\\u003c");

  const noscript = [
    "    <noscript>",
    "      <style>.knot-static{max-width:36rem;margin:3rem auto;padding:0 1rem;font-family:system-ui,-apple-system,sans-serif;line-height:1.7;color:#050505}.knot-static h1{margin:0 0 .5rem;font-size:1.7rem;line-height:1.2}.knot-static p{margin:.6rem 0;color:#65676b}.knot-static a{color:#0866ff}</style>",
    '      <div class="knot-static">',
    `        <h1>${escapeHtml(info.name)}</h1>`,
    `        <p>${escapeHtml(copy.heading)}</p>`,
    ...(info.tagline ? [`        <p>${escapeHtml(info.tagline)}</p>`] : []),
    `        <p><a href="/">${escapeHtml(copy.back)}</a></p>`,
    "      </div>",
    "    </noscript>",
  ].join("\n");

  let out = html
    .replace(/<html[^>]*>/i, `<html lang="${lang}">`)
    .replace(/<link[^>]+rel="canonical"[^>]*>/gi, "")
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);

  if (/<meta name="description"[^>]*>/i.test(out)) {
    out = out.replace(/<meta name="description"[^>]*>/i, metaTag("name", "description", description).trim());
  } else {
    out = out.replace(
      /\n[ \t]*<\/head>/i,
      `\n    <meta name="description" content="${escapeHtml(description)}" />\n  </head>`,
    );
  }

  return out
    .replace(/\n[ \t]*<\/head>/i, `\n${head}\n    <script type="application/ld+json">${structured}</script>\n  </head>`)
    .replace(/(<[^>]*data-knot-name[^>]*>)[\s\S]*?(<\/[a-z]+>)/i, `$1${escapeHtml(info.name)}$2`)
    .replace(/(<[^>]*data-knot-line[^>]*>)[\s\S]*?(<\/[a-z]+>)/i, `$1${escapeHtml(copy.loading)}$2`)
    .replace(/(data-knot-retry[^>]*href=")[^"]*(")/i, `$1${escapeHtml(canonical)}$2`)
    .replace(/\n[ \t]*<\/body>/i, `\n${noscript}\n  </body>`);
}

export function renderRobots(origin) {
  const base = String(origin || "").replace(/\/+$/, "");
  return ["User-agent: *", "Allow: /", "Disallow: /api/", "Disallow: /admin", "", `Sitemap: ${base}/sitemap.xml`, ""].join("\n");
}

export function renderSitemap(origin) {
  const base = String(origin || "").replace(/\/+$/, "");
  // 只有这两个地址是真正的静态页。其余路由要么回源（/api），要么是账户态页面。
  // 不写 lastmod：档案的 updatedAt 是「站点介绍改于何时」，拿它当页面更新时间是假的。
  const urls = ["/", "/discover"].map(
    (pathname) => `  <url>\n    <loc>${escapeHtml(base + pathname)}</loc>\n  </url>`,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

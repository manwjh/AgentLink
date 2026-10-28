// XKnot 控制台。
//
// 申请提交即通过，这里不再有审核动作：看申请记录、改实例配置、看探测与发信。
// 无构建步骤：浏览器直接加载这个模块。所有文本用 textContent 写入，
// 申请内容不会当成 HTML 执行。

const app = document.getElementById("app");

const STATUS_LABEL = {
  approved: "已通过",
  withdrawn: "已撤回",
  // 只读状态，不再新增。
  pending: "待确认",
  verified: "待审核",
  hold: "搁置",
  rejected: "已拒绝",
  expired: "已过期",
};

// 总览里的实例状态。pending 是已收录、未通过 /api/health 验收；paused 是暂停或退役。
const HEALTH_LABEL = {
  up: "在线",
  degraded: "降级",
  down: "离线",
  unknown: "未知",
  unprobed: "未探测",
  pending: "待验收",
  paused: "已暂停",
};

const TIER_LABEL = {
  demo: "示例",
  free: "免费",
  paid: "收费",
};

const ERROR_LABEL = {
  timeout: "超时",
  unresolvable: "域名解析失败",
  redirect: "跳转被拒",
  bad_payload: "响应不符合契约",
};

const EVENT_LABEL = {
  "application.submitted": "新申请",
  "application.contact_verified": "联系邮箱已确认",
  "application.public_key": "已保存公钥",
  "application.withdrawn": "申请撤回",
  "claim.issued": "发出交付资料",
  "claim.consumed": "领取交付资料",
  "claim.revoked": "作废旧领取链接",
  "relay.token_created": "签发发信凭据",
  "relay.token_revoked": "吊销发信凭据",
  "admin.created": "建管理员",
  "admin.deleted": "删管理员",
  "admin.password_reset": "重设口令",
};

const REGION_LABEL = {
  "east-asia": "东亚",
  "southeast-asia": "东南亚",
  "south-asia": "南亚",
  "central-asia": "中亚",
  "middle-east": "中东",
  europe: "欧洲",
  "north-america": "北美",
  "latin-america": "拉美",
  africa: "非洲",
  oceania: "大洋洲",
  global: "全球",
  other: "其他",
};

const COUNTRY_GROUP = {
  CN: "east-asia", HK: "east-asia", MO: "east-asia", TW: "east-asia", JP: "east-asia",
  KR: "east-asia", MN: "east-asia",
  SG: "southeast-asia", MY: "southeast-asia", TH: "southeast-asia", VN: "southeast-asia",
  ID: "southeast-asia", PH: "southeast-asia", BN: "southeast-asia", KH: "southeast-asia",
  LA: "southeast-asia", MM: "southeast-asia", TL: "southeast-asia",
  IN: "south-asia", PK: "south-asia", BD: "south-asia", LK: "south-asia", NP: "south-asia",
  BT: "south-asia", MV: "south-asia", AF: "south-asia",
  KZ: "central-asia", UZ: "central-asia", KG: "central-asia", TJ: "central-asia", TM: "central-asia",
  AE: "middle-east", SA: "middle-east", QA: "middle-east", KW: "middle-east", BH: "middle-east",
  OM: "middle-east", IL: "middle-east", TR: "middle-east", IR: "middle-east", IQ: "middle-east",
  JO: "middle-east", LB: "middle-east", EG: "middle-east", YE: "middle-east", SY: "middle-east",
  PS: "middle-east",
  AT: "europe", BE: "europe", BG: "europe", HR: "europe", CY: "europe", CZ: "europe",
  DK: "europe", EE: "europe", FI: "europe", FR: "europe", DE: "europe", GR: "europe",
  HU: "europe", IE: "europe", IT: "europe", LV: "europe", LT: "europe", LU: "europe",
  MT: "europe", NL: "europe", PL: "europe", PT: "europe", RO: "europe", SK: "europe",
  SI: "europe", ES: "europe", SE: "europe", GB: "europe", CH: "europe", NO: "europe",
  IS: "europe", RS: "europe", UA: "europe", MD: "europe", BA: "europe", MK: "europe",
  AL: "europe", ME: "europe", AD: "europe", MC: "europe", SM: "europe", LI: "europe",
  VA: "europe",
  US: "north-america", CA: "north-america", MX: "north-america", GL: "north-america",
  BM: "north-america",
  AR: "latin-america", BO: "latin-america", BR: "latin-america", CL: "latin-america",
  CO: "latin-america", CR: "latin-america", CU: "latin-america", DO: "latin-america",
  EC: "latin-america", SV: "latin-america", GT: "latin-america", HT: "latin-america",
  HN: "latin-america", NI: "latin-america", PA: "latin-america", PY: "latin-america",
  PE: "latin-america", PR: "latin-america", UY: "latin-america", VE: "latin-america",
  BZ: "latin-america", JM: "latin-america", TT: "latin-america", BB: "latin-america",
  BS: "latin-america", GD: "latin-america",
  DZ: "africa", AO: "africa", BJ: "africa", BW: "africa", BF: "africa", BI: "africa",
  CM: "africa", CV: "africa", CF: "africa", TD: "africa", KM: "africa", CG: "africa",
  CD: "africa", CI: "africa", DJ: "africa", GQ: "africa", ER: "africa", SZ: "africa",
  ET: "africa", GA: "africa", GM: "africa", GH: "africa", GN: "africa", GW: "africa",
  KE: "africa", LS: "africa", LR: "africa", LY: "africa", MG: "africa", MW: "africa",
  ML: "africa", MR: "africa", MU: "africa", MA: "africa", MZ: "africa", NA: "africa",
  NE: "africa", NG: "africa", RW: "africa", ST: "africa", SN: "africa", SC: "africa",
  SL: "africa", SO: "africa", ZA: "africa", SS: "africa", SD: "africa", TZ: "africa",
  TG: "africa", TN: "africa", UG: "africa", ZM: "africa", ZW: "africa",
  AU: "oceania", NZ: "oceania", PG: "oceania", FJ: "oceania", SB: "oceania", VU: "oceania",
  WS: "oceania", TO: "oceania", KI: "oceania", FM: "oceania", MH: "oceania", PW: "oceania",
  NR: "oceania", TV: "oceania", NC: "oceania", PF: "oceania",
};

const state = {
  admin: null,
  view: "overview",
  filter: "approved",
  applications: [],
  // state.applications 里的行属于哪一个分类。切分类后请求失败时，旧分类的行不能
  // 留在新标签下面冒充新分类的记录；对不上就不渲染这些行。
  applicationsFilter: "approved",
  // 列表读取失败的原因。它与 state.error 分开：state.error 只在详情面板里渲染，
  // 而列表读失败时通常没有选中项，那条提示永远不会出现，运维只看到空态。
  applicationsError: "",
  counts: { approved: 0, withdrawn: 0 },
  selected: null,
  busy: false,
  error: "",
  overview: null,
  overviewBusy: false,
  overviewError: "",
  // 申请列表是否正在读取。读取中列表行不可点：写入数据会重绘，
  // 点在一半的行会被换掉，用户那一下就没有落到任何申请上。
  // 只有最新一次读取能清除这个状态；旧响应直接丢掉，不参与重绘。
  applicationsBusy: false,
  // 总览里点开的实例。只展开这一行，不跳站点。
  instanceOpen: null,
  // 展开那一行的入口流量。按实例只留一份：关闭面板就丢掉，重新点开会重新取，
  // 免得拿几小时前的缓存冒充当前值。status: idle / loading / ready / error。
  traffic: { id: null, status: "idle", data: null, error: "" },
  // 门户自己的入口流量。不是实例，没有可展开的行，随总览一起取一次。
  hubTraffic: null,
  // 正在编辑的实例配置。草稿在 state 里，保存失败重绘时不丢用户输入。
  editing: null,
  manifest: null,
  manifestId: null,
  copied: false,
  // 发信总闸正在写库。写的过程中按钮不可点：连点两下会让第二次请求带着
  // 前一次的界面状态发出去，最后落库的未必是用户以为的那一下。
  mailBusy: false,
};

// 每次读取带一个序号。晚到的旧响应直接丢掉，避免它把刚点开的分类又重绘回去。
let overviewSeq = 0;
let applicationsSeq = 0;
// 流量面板同理：点开 A 又马上点开 B 时，A 的响应不能画到 B 的面板上。
let trafficSeq = 0;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}) },
    ...options,
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = new Error((data && data.error) || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function formatWhen(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(date);
}

function regionLabel(code) {
  const group = code === "GLOBAL" ? "global" : COUNTRY_GROUP[code] || "other";
  return `${REGION_LABEL[group]} · ${code}`;
}

function relativeLabel(value) {
  const at = Date.parse(value || "");
  if (Number.isNaN(at)) return "—";
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatWhen(value);
}

function formatUptime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  if (total < 60) return `${total} 秒`;
  if (total < 3600) return `${Math.floor(total / 60)} 分钟`;
  if (total < 86400) return `${Math.floor(total / 3600)} 小时 ${Math.floor((total % 3600) / 60)} 分`;
  return `${Math.floor(total / 86400)} 天 ${Math.floor((total % 86400) / 3600)} 小时`;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// 档案里的 region 与中枢观测到的国家不同：说明这台机器已经搬了，或者档案没改。
// 只在两个值都在、且确实不同时才算漂移；没有观测值时谈不上漂移。
function locationDrift(row) {
  const declared = Array.isArray(row.regions) ? row.regions[0] : null;
  const seen = row.location?.country || null;
  return Boolean(declared && seen && declared !== seen);
}

function healthNote(row) {
  const health = row.health || {};
  if (health.status === "pending") return "已收录，待 /api/health 验收，暂不探测也不上门户";
  if (health.status === "paused") return "清单里状态不是 active，不探测";
  if (health.status === "unprobed") return "缺对外地址，推不出探测地址";
  if (health.status === "down") {
    // 隧道没连时探测必然失败：先说清是哪一段断的，别让人去查实例的接口。
    if (row.tunnel?.checkedAt && !row.tunnel.connected) return "隧道未连，探测必然失败";
    return health.downSince ? `自 ${relativeLabel(health.downSince)} 起断连` : "探测失败";
  }
  if (health.latencyMs != null) return `${health.latencyMs} ms`;
  if (health.lastOkAt) return `上次正常 ${relativeLabel(health.lastOkAt)}`;
  return "没有探测记录";
}

// 入口 nginx 观测到的流量。没有采集过就整行不出现，不写 0 冒充数据。
function trafficNote(row) {
  const traffic = row.traffic;
  if (!traffic || !traffic.requests) return null;
  const day = traffic.date ? `${traffic.date} ` : "";
  return `${day}${traffic.requests} 次 · ${formatBytes(traffic.bytes)}`;
}

// 名册字段的中文说法。缺一个说法时直接显示原值，不吞掉。
//
// role 只有两个取值（founder / partner），与结算档位无关：partner 是「伙伴」
// 这个身份，不是某一档。档位在清单里，叫 demo / free / paid。
const ROLE_LABEL = {
  founder: "创始",
  partner: "伙伴",
};

const STANDING_LABEL = {
  permanent: "永久席位",
  regular: "常规席位",
};

// 收起面板、切视图、退出或会话失效时都走这里：展开状态与已取的流量一起清掉，
// 下一个登录的人（或下一次展开）不会看到上一个人取回的面板数据。
function closeInstancePanel() {
  state.instanceOpen = null;
  state.traffic = { id: null, status: "idle", data: null, error: "" };
}

function toggleInstance(id) {
  const opening = state.instanceOpen !== id;
  state.instanceOpen = opening ? id : null;
  // 收起时把面板数据一起丢掉：下次展开重新取，界面上不会留着上一次的结果。
  state.traffic = opening
    ? { id, status: "loading", data: null, error: "" }
    : { id: null, status: "idle", data: null, error: "" };
  render();
  if (opening) loadTraffic(id);
}

// 单实例的入口流量。失败时只影响这一块，实例配置照常显示。
async function loadTraffic(id) {
  const seq = ++trafficSeq;
  let next;
  try {
    const data = await api(`/api/admin/instances/${encodeURIComponent(id)}/traffic`);
    next = { id, status: "ready", data, error: "" };
  } catch (error) {
    next = {
      id,
      status: "error",
      data: null,
      error:
        error.status === 401
          ? "会话已过期，重新登录后再看。"
          : error.status === 404
            ? "清单里没有这个实例，刷新总览试试。"
            : "读取失败：接口可能没起来，或 var/traffic 读不到。",
    };
  }
  // 面板已经关掉、或者换到别的实例，这次响应就作废。
  if (seq !== trafficSeq || state.instanceOpen !== id) return;
  state.traffic = next;
  render();
}

// 请求量柱状图：只表达每天之间的相对高低，不标绝对刻度——绝对值在下面的明细里。
//
// 用 SVG 的 height 属性而不是内联样式：控制台的 CSP 是 style-src 'self'，
// 内联 style 属性会被整条丢弃，柱子会塌成 0 高。
const TRAFFIC_CHART_HEIGHT = 64;

// 聚合端只给标识，展示名留在控制台：改叫法不动数据。
const CRAWLER_LABELS = {
  googlebot: "Googlebot",
  bingbot: "Bingbot",
  applebot: "Applebot",
  baiduspider: "Baiduspider",
  yandexbot: "YandexBot",
};

const SEARCH_ENGINE_LABELS = {
  google: "Google",
  bing: "Bing",
  baidu: "百度",
  duckduckgo: "DuckDuckGo",
  yandex: "Yandex",
  sogou: "搜狗",
};

function renderTrafficBars(days) {
  const shown = days.slice(0, 14).reverse();
  const peak = Math.max(...shown.map((day) => day.requests), 1);
  // 图上只放最近 14 天（再多柱子就挤得看不清），而上面的合计可能跨 30 天，
  // 所以这里把范围写出来，别让人以为柱子覆盖的就是合计那一段。
  return el("div", {}, [
    el(
      "p",
      { class: "traffic-list-title" },
      shown.length < days.length
        ? `近 ${shown.length} 天每日请求量（合计覆盖 ${days.length} 天）`
        : `近 ${shown.length} 天每日请求量`
    ),
    el(
      "div",
      {
        class: "traffic-bars",
        role: "img",
        "aria-label": `${shown.length} 天请求量趋势：最高 ${peak} 次`,
      },
      shown.map((day) => {
        const height = Math.max(2, Math.round((day.requests / peak) * TRAFFIC_CHART_HEIGHT));
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", `0 0 10 ${TRAFFIC_CHART_HEIGHT}`);
        svg.setAttribute("preserveAspectRatio", "none");
        svg.setAttribute("class", "traffic-bar-svg");
        svg.setAttribute("aria-hidden", "true");
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", "0");
        rect.setAttribute("y", String(TRAFFIC_CHART_HEIGHT - height));
        rect.setAttribute("width", "10");
        rect.setAttribute("height", String(height));
        svg.append(rect);
        return el(
          "div",
          {
            class: "traffic-bar",
            title: `${day.date}：${day.requests} 次请求 · ${formatBytes(day.bytes)}`,
          },
          [svg, el("em", { class: "traffic-bar-label" }, day.date.slice(5))]
        );
      })
    ),
  ]);
}

// 一份明细里的一行；实例与门户两个面板共用同一套排版。
function trafficMetric(term, value) {
  return el("div", { class: "traffic-row" }, [el("dt", {}, term), el("dd", {}, value)]);
}

// 搜索爬虫摘要：按次数排，并给出它们被拒的次数（4xx/5xx 才是要修的东西）。
function crawlerSummary(latest) {
  const rows = Object.entries(latest?.crawlers || {})
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1]);
  const status = latest?.crawlStatus || {};
  return {
    text: rows.length ? rows.map(([key, value]) => `${CRAWLER_LABELS[key] || key} ${value}`).join(" · ") : "—",
    failed: (status["4xx"] || 0) + (status["5xx"] || 0),
  };
}

// 引擎标识换成展示名。零值在服务端已经滤掉，这里不再排序。
function searchEngineEntries(latest) {
  return (Array.isArray(latest?.searchEngines) ? latest.searchEngines : []).map((entry) => ({
    ...entry,
    key: SEARCH_ENGINE_LABELS[entry.key] || entry.key,
  }));
}

function renderTrafficList(title, entries) {
  return el("div", {}, [
    el("p", { class: "traffic-list-title" }, title),
    entries.length
      ? el(
          "ol",
          { class: "traffic-top" },
          entries.map((entry) =>
            el("li", {}, [
              el("span", { class: "traffic-top-key" }, entry.key),
              el("span", { class: "traffic-top-count" }, `${entry.requests}`),
            ])
          )
        )
      : el("p", { class: "traffic-empty" }, "没有记录"),
  ]);
}

function renderTraffic(row) {
  const header = el("div", { class: "traffic-head" }, [
    el("h3", { class: "traffic-title" }, "入口流量"),
    el("span", { class: "cfg-missing" }, "入口 nginx 观测 · 不含实例站内行为 · 每小时重算一次"),
  ]);
  const wrap = (children) => el("section", { class: "traffic" }, [header, ...children]);
  const traffic = state.traffic;
  if (!traffic || traffic.id !== row.id) return null;

  if (traffic.status === "loading") {
    return wrap([el("p", { class: "traffic-empty" }, "正在读取…")]);
  }
  if (traffic.status === "error") {
    return wrap([
      el("p", { class: "traffic-empty" }, traffic.error),
      el("button", { type: "button", class: "btn", onclick: () => loadTraffic(row.id) }, "重试"),
    ]);
  }

  const days = Array.isArray(traffic.data?.days) ? traffic.data.days : [];
  if (!days.length) {
    return wrap([
      el(
        "p",
        { class: "traffic-empty" },
        "还没有采集到：确认入口装了 knot-log.conf，且 xknot-traffic.timer 在跑。"
      ),
    ]);
  }

  const totals = traffic.data.totals;
  const latest = days[0];
  const pct = (value) => `${Math.round((Number(value) || 0) * 100)}%`;
  const millis = (value) => (value == null ? "—" : `${value} ms`);

  const statusText = ["2xx", "3xx", "4xx", "5xx", "1xx", "other"]
    .filter((key) => key === "2xx" || latest.status[key])
    .map((key) => `${key} ${latest.status[key]}`)
    .join(" · ");
  const cache = latest.cache;
  const cacheText = `命中 ${cache.hit} · 未命中 ${cache.miss} · 绕过 ${cache.bypass}${
    cache.none ? ` · 无标记 ${cache.none}` : ""
  }`;

  // 搜索爬虫：抓了几次、按是哪个；4xx/5xx 单独说，那是要修的抓取错误。
  const crawler = crawlerSummary(latest);

  return wrap([
    el("p", { class: "traffic-sum" }, [
      totals
        ? `近 ${totals.days} 天合计 ${totals.requests} 次 · ${formatBytes(totals.bytes)}`
        : `最近一天 ${latest.requests} 次 · ${formatBytes(latest.bytes)}`,
      el(
        "span",
        { class: "cfg-missing" },
        `　最近采集 ${traffic.data.updatedAt ? formatWhen(traffic.data.updatedAt) : "—"}`
      ),
    ]),
    renderTrafficBars(days),
    el("dl", { class: "traffic-grid" }, [
      trafficMetric("当日请求", `${latest.date} · ${latest.requests} 次 · ${formatBytes(latest.bytes)}`),
      trafficMetric(
        "日访客（近似）",
        el("span", {}, [
          `${latest.uniqueApprox}`,
          el("span", { class: "cfg-missing" }, "　同日 IP+UA 去重，跨天不合并"),
        ])
      ),
      trafficMetric(
        "爬虫占比",
        el("span", {}, [
          pct(latest.botShare),
          el("span", { class: "cfg-missing" }, "　按 UA 粗分，空 UA 计入"),
        ])
      ),
      trafficMetric(
        "搜索爬虫",
        el("span", {}, [
          crawler.text,
          el(
            "span",
            { class: "cfg-missing" },
            `　${crawler.failed ? `失败 ${crawler.failed} 次（4xx/5xx）· ` : ""}按 UA 识别，未做反向解析`
          ),
        ])
      ),
      trafficMetric(
        "响应耗时",
        `p50 ${millis(latest.latency.p50)} · p95 ${millis(latest.latency.p95)} · 最大 ${millis(latest.latency.max)}`
      ),
      trafficMetric(
        "回源",
        latest.upstream.requests
          ? `${latest.upstream.requests} 次 · p95 ${millis(latest.upstream.p95)}`
          : "全部由入口直出"
      ),
      trafficMetric("状态码", statusText),
      trafficMetric("缓存", cacheText),
    ]),
    el("div", { class: "traffic-lists" }, [
      renderTrafficList("访问最多的路径", latest.topPaths.slice(0, 6)),
      renderTrafficList("来源主机", latest.topReferers.slice(0, 6)),
      renderTrafficList("爬虫抓取最多的路径", latest.crawlPaths.slice(0, 6)),
      renderTrafficList("搜索引荐", searchEngineEntries(latest).slice(0, 6)),
    ]),
  ]);
}

// 门户自己的入口流量：门户不在实例清单里，没有可展开的行，随总览一起取。
// 只放判断索引要看的几项：被抓没有、抓了哪些页、搜索进来几次。
function renderHubTraffic() {
  const data = state.hubTraffic;
  const section = (children) =>
    el("section", { class: "panel" }, [
      el("div", { class: "panel-head", "data-panel": "hub-traffic" }, [
        el("h2", {}, "门户入口流量"),
        el("span", { class: "meta" }, data?.host || "门户主机"),
      ]),
      ...children,
    ]);

  if (!data || data.error) {
    return section([
      el("p", { class: "panel-note" }, "门户流量没有读到，刷新总览再看。"),
    ]);
  }

  const days = Array.isArray(data.days) ? data.days : [];
  if (!days.length) {
    return section([
      el(
        "p",
        { class: "panel-note" },
        "还没有采集到：确认入口日志里能看到门户主机，等下一次流量聚合。"
      ),
    ]);
  }

  const latest = days[0];
  const crawler = crawlerSummary(latest);
  const engines = searchEngineEntries(latest);
  const engineText = engines.length
    ? engines.map((entry) => `${entry.key} ${entry.requests}`).join(" · ")
    : "—";

  return section([
    el("p", { class: "panel-note" }, "只统计入口 nginx 观测到的请求 · 每小时重算一次"),
    el("dl", { class: "traffic-grid" }, [
      trafficMetric("当日请求", `${latest.date} · ${latest.requests} 次 · ${formatBytes(latest.bytes)}`),
      trafficMetric(
        "搜索爬虫",
        el("span", {}, [
          crawler.text,
          el(
            "span",
            { class: "cfg-missing" },
            `　${crawler.failed ? `失败 ${crawler.failed} 次（4xx/5xx） · ` : ""}按 UA 识别`
          ),
        ])
      ),
      trafficMetric("搜索引荐", engineText),
    ]),
    el("div", { class: "traffic-lists" }, [
      renderTrafficList("爬虫抓取最多的路径", latest.crawlPaths.slice(0, 6)),
      renderTrafficList("搜索引荐", engines.slice(0, 6)),
    ]),
  ]);
}

// 点开实例看到的是这个账号的配置：名册里的身份与隧道，加上清单里的对外地址。
// 地址一律写成可点文本，跳站是明确动作，不靠点整行带走。
function renderInstanceConfig(row, id) {
  const config = row.config || {};

  if (state.editing && state.editing.id === row.id) return renderInstanceForm(row, config, id);

  const link = (value, label) =>
    el(
      "a",
      { class: "cfg-link", href: value, target: "_blank", rel: "noopener noreferrer" },
      label || value
    );
  const line = (term, value) =>
    el("div", { class: "cfg-row" }, [el("dt", {}, term), el("dd", {}, value)]);

  const tunnel = config.tunnel
    ? `${config.tunnel.account || "—"}${config.tunnel.port ? ` · :${config.tunnel.port}` : ""}`
    : null;

  return el("div", { class: "inst-config", id }, [
    el("div", { class: "cfg-head" }, [
      el("p", { class: "cfg-title" }, [
        `账号 ${config.account || row.id}`,
        config.host ? el("span", { class: "cfg-host" }, config.host) : null,
      ]),
      el(
        "button",
        { type: "button", class: "btn", "data-action": "edit", onclick: () => startEditing(row) },
        "编辑"
      ),
    ]),
    config.listed == null
      ? el("p", { class: "cfg-hint warn" }, "名册里还没有这个账号，保存时会补一条。")
      : null,
    el("dl", { class: "cfg-grid" }, [
      line("名册身份", config.role ? ROLE_LABEL[config.role] || config.role : "未进名册"),
      line("席位", config.standing ? STANDING_LABEL[config.standing] || config.standing : "—"),
      line("隧道", tunnel || "未分配"),
      line(
        "清单列出",
        config.listed == null ? "—" : config.listed ? "是" : "否（只留名册）"
      ),
      line("加入时间", config.since ? formatWhen(config.since) : "—"),
      line(
        "自述档案",
        config.profileFetchedAt
          ? el("span", {}, [
              link(config.profileUrl || `${String(row.url || "").replace(/\/$/, "")}/api/federation/profile`),
              `　最近取回 ${formatWhen(config.profileFetchedAt)}`,
            ])
          : el("span", { class: "cfg-missing" }, "还没取回过：内容由主理人在实例的 /admin 里写")
      ),
      line("对外地址", row.url ? link(row.url) : "未填地址"),
      line(
        "观测位置",
        row.location
          ? el("span", {}, [
              `${row.location.country}`,
              el(
                "span",
                { class: "cfg-missing" },
                `　隧道出口 IP 判定${row.location.at ? `，${formatWhen(row.location.at)}` : ""}`
              ),
            ])
          : el("span", { class: "cfg-missing" }, "未采集：隧道未连，或中枢不在入口主机")
      ),
      line(
        "隧道对端",
        row.tunnel?.checkedAt
          ? el("span", {}, [
              `${row.tunnel.connected ? "连着" : "不在"}　账号 ${row.tunnel.account || "—"} · 端口 ${row.tunnel.port ?? "—"}`,
              el("span", { class: "cfg-missing" }, `　${formatWhen(row.tunnel.checkedAt)} 采集`),
            ])
          : el("span", { class: "cfg-missing" }, "未采集：中枢不在入口主机，或 provision worker 没跑")
      ),
      line(
        "入口流量",
        row.traffic
          ? el("span", {}, [
              `${row.traffic.date} · ${row.traffic.requests} 次 · ${formatBytes(row.traffic.bytes)}`,
              el("span", { class: "cfg-missing" }, "　入口 nginx 观测，不含实例自己记的站内行为"),
            ])
          : el("span", { class: "cfg-missing" }, "未采集：入口还没装 knot-log.conf")
      ),
      line(
        "探测地址",
        config.probeUrl
          ? el("span", {}, [
              link(config.probeUrl),
              row.status === "pending"
                ? el("span", { class: "cfg-missing" }, "　状态还是 pending，待验收后再探")
                : null,
            ])
          : el("span", { class: "cfg-missing" }, "缺对外地址，推不出探测地址")
      ),
      line("橱窗数据", config.cardsUrl ? link(config.cardsUrl) : "未接入"),
      line("活动统计", config.statsUrl ? link(config.statsUrl) : "未接入"),
    ]),
    config.note ? el("p", { class: "cfg-note" }, config.note) : null,
    renderTraffic(row),
  ]);
}

// ---- 编辑实例配置 ----

const TIER_OPTIONS = ["demo", "free", "paid"];
const INSTANCE_STATUS_OPTIONS = ["pending", "active", "suspended", "retired"];

const LABELS = {
  demo: TIER_LABEL.demo,
  free: TIER_LABEL.free,
  paid: TIER_LABEL.paid,
  pending: "待验收",
  active: "在用",
  suspended: "暂停",
  retired: "退役",
  founder: ROLE_LABEL.founder,
  permanent: STANDING_LABEL.permanent,
  regular: STANDING_LABEL.regular,
};

function hostFromUrl(value) {
  try {
    return new URL(String(value || "")).host;
  } catch {
    return "";
  }
}

// 草稿放在 state 里，而不是从输入框现读：保存失败重绘时，用户改过的值还在。
function draftFrom(row, config) {
  return {
    instance: {
      url: row.url || "",
      // 照抄清单。缺项留空，表单显示「—」：中枢还没决定，不要替它选一档。
      tier: row.tier || "",
      status: row.status || "",
      since: config.since || "",
      cardsUrl: config.cardsUrl || "",
      statsUrl: config.statsUrl || "",
    },
    member: {
      host: config.host || hostFromUrl(row.url),
      role: config.role || "partner",
      standing: config.standing || "regular",
      listed: config.listed == null ? true : Boolean(config.listed),
      tunnelAccount: config.tunnel?.account || "",
      tunnelPort: config.tunnel?.port || "",
      note: config.note || "",
    },
  };
}

function startEditing(row) {
  state.editing = { id: row.id, draft: draftFrom(row, row.config || {}), busy: false, errors: [] };
  render();
}

function cancelEditing() {
  state.editing = null;
  render();
}

function configInput(value, props = {}, onInput) {
  const input = el("input", { type: "text", autocomplete: "off", ...props });
  input.value = value == null ? "" : String(value);
  if (onInput) input.addEventListener("input", () => onInput(input.value));
  return input;
}

function configSelect(value, options, props = {}, onChange) {
  const select = el("select", props);
  for (const option of options) {
    const node = el("option", { value: option }, LABELS[option] || option);
    if (option === value) node.selected = true;
    select.append(node);
  }
  if (onChange) select.addEventListener("change", () => onChange(select.value));
  return select;
}

function formField(term, control, hint) {
  return el("label", { class: "cfg-field" }, [
    el("span", { class: "cfg-field-label" }, term),
    control,
    hint ? el("span", { class: "cfg-hint" }, hint) : null,
  ]);
}

// 表单只收运营自己维护的字段。没进名册的实例按默认身份补一条；
// 接入形态恒为 subdomain，隧道账号与端口每次一并提交。
function renderInstanceForm(row, config, id) {
  const editing = state.editing;
  const draft = editing.draft;
  const inst = draft.instance;
  const member = draft.member;

  const url = configInput(inst.url, {}, (value) => (inst.url = value));
  const tier = configSelect(inst.tier, TIER_OPTIONS, {}, (value) => (inst.tier = value));
  const status = configSelect(inst.status, INSTANCE_STATUS_OPTIONS, {}, (value) => (inst.status = value));
  const since = configInput(inst.since, { placeholder: "YYYY-MM-DD" }, (value) => (inst.since = value));
  const cardsUrl = configInput(inst.cardsUrl, {}, (value) => (inst.cardsUrl = value));
  const statsUrl = configInput(inst.statsUrl, {}, (value) => (inst.statsUrl = value));

  const host = configInput(member.host, {}, (value) => (member.host = value));
  const role = configSelect(member.role, ["founder", "partner"], {}, (value) => (member.role = value));
  const standing = configSelect(member.standing, ["permanent", "regular"], {}, (value) => (member.standing = value));
  const tunnelAccount = configInput(
    member.tunnelAccount,
    { placeholder: "knot-tunnel" },
    (value) => (member.tunnelAccount = value)
  );
  const tunnelPort = configInput(
    member.tunnelPort,
    { placeholder: "1024-65535", inputmode: "numeric" },
    (value) => (member.tunnelPort = value)
  );
  const note = configInput(member.note, {}, (value) => (member.note = value));
  const listed = el("input", { type: "checkbox" });
  listed.checked = member.listed;
  listed.addEventListener("change", () => (member.listed = listed.checked));

  const errors = editing.errors.length
    ? el(
        "ul",
        { class: "cfg-errors", role: "alert" },
        editing.errors.map((message) => el("li", {}, message))
      )
    : null;

  const save = el(
    "button",
    { type: "submit", class: "btn btn-ok", "data-action": "save" },
    editing.busy ? "保存中…" : "保存"
  );
  save.disabled = editing.busy;
  const cancel = el(
    "button",
    { type: "button", class: "btn", disabled: editing.busy, onclick: () => cancelEditing() },
    "取消"
  );

  const form = el(
    "form",
    {
      class: "cfg-form",
      onsubmit: async (event) => {
        event.preventDefault();
        if (editing.busy) return;
        editing.busy = true;
        editing.errors = [];
        render();
        try {
          await api(`/api/admin/instances/${encodeURIComponent(row.id)}/config`, {
            method: "POST",
            body: JSON.stringify({
              instance: {
                url: inst.url,
                tier: inst.tier,
                status: inst.status,
                since: inst.since,
                cardsUrl: inst.cardsUrl,
                statsUrl: inst.statsUrl,
              },
              member: {
                host: member.host,
                role: member.role,
                standing: member.standing,
                listed: member.listed,
                since: inst.since,
                note: member.note,
                tunnel: { account: member.tunnelAccount, port: member.tunnelPort },
              },
            }),
          });
          state.editing = null;
          state.instanceOpen = row.id;
          // 保存后这一行仍是展开的：配置重读过，流量面板也要重新取一次，
          // 否则要么停在编辑前的旧值，要么因为状态被清过而整块不渲染。
          state.traffic = { id: row.id, status: "loading", data: null, error: "" };
          await loadOverview();
          loadTraffic(row.id);
        } catch (error) {
          const fields = error.data && Array.isArray(error.data.fields) ? error.data.fields : null;
          state.editing.errors =
            error.status === 400 && fields && fields.length
              ? fields
              : ["保存没有成功，请检查接口是否在运行。"];
          state.editing.busy = false;
          render();
        }
      },
    },
    [
      el("div", { class: "cfg-form-head" }, [
        el("p", { class: "cfg-title" }, `编辑 ${config.account || row.id}`),
        el("p", { class: "cfg-hint" }, "清单写到 instances.json，身份写到 federation.json；校验不过不会落盘。"),
      ]),
      errors,
      el("fieldset", { class: "cfg-group" }, [
        el("legend", {}, "清单 · instances.json"),
        el("div", { class: "cfg-form-grid" }, [
          formField("对外地址", url, "必须 https"),
          formField("分级", tier),
          formField("状态", status),
          formField("加入时间", since, "YYYY-MM-DD"),
          formField("橱窗数据", cardsUrl),
          formField("活动统计", statsUrl),
        ]),
        el("p", { class: "cfg-hint" }, [
          "名称、介绍、联系方式属于自述区，由主理人在实例自己的 /admin 里写；中枢只按 ",
          config.profileUrl || `${String(row.url || "").replace(/\/$/, "")}/api/federation/profile`,
          " 取回副本。最近取回：",
          config.profileFetchedAt || "还没取回过",
          "。",
        ]),
      ]),
      el("fieldset", { class: "cfg-group" }, [
        el("legend", {}, "名册 · federation.json"),
        el("div", { class: "cfg-form-grid" }, [
          formField("域名", host),
          formField("角色", role),
          formField("席位", standing),
          formField("隧道账号", tunnelAccount),
          formField("隧道端口", tunnelPort),
          el("label", { class: "cfg-field cfg-check" }, [
            listed,
            el("span", {}, "写进清单（listed）"),
          ]),
          formField("备注", note),
        ]),
      ]),
      el("div", { class: "cfg-form-actions" }, [save, cancel]),
    ]
  );

  return el("div", { class: "inst-config", id }, [form]);
}

function render() {
  app.replaceChildren(state.admin ? renderConsole() : renderLogin());
}

function renderLogin() {
  const username = el("input", { id: "username", name: "username", autocomplete: "username", required: true });
  const password = el("input", {
    id: "password",
    name: "password",
    type: "password",
    autocomplete: "current-password",
    required: true,
  });
  const submit = el("button", { class: "btn btn-primary btn-block", type: "submit" }, state.busy ? "正在登录…" : "登录");
  submit.disabled = state.busy;

  const form = el(
    "form",
    {
      onsubmit: async (event) => {
        event.preventDefault();
        state.busy = true;
        state.error = "";
        render();
        try {
          const data = await api("/api/admin/login", {
            method: "POST",
            body: JSON.stringify({ username: username.value, password: password.value }),
          });
          state.admin = data.admin;
          state.busy = false;
          state.view = "overview";
          await loadOverview();
        } catch (error) {
          state.busy = false;
          state.error = error.status === 401 ? "账号或密码不对。" : error.status === 429 ? "尝试过于频繁，请稍后再试。" : "登录失败，请检查接口是否在运行。";
          render();
        }
      },
    },
    [
      el("div", { class: "field" }, [el("label", { for: "username" }, "管理员账号"), username]),
      el("div", { class: "field" }, [el("label", { for: "password" }, "密码"), password]),
      state.error ? el("p", { class: "alert", role: "alert" }, state.error) : null,
      submit,
      el("p", { class: "hint" }, "账号由运维用 server/admin-cli.mjs create-admin 建立。"),
    ]
  );

  return el("main", { class: "login" }, [
    el("section", { class: "login-card" }, [
      el("p", { class: "login-mark" }, ["◆", " XKNOT / ADMIN"]),
      el("h1", {}, "联邦控制台"),
      el("p", {}, "看申请记录与实例状态；申请提交即通过，这里不再审核。"),
      form,
    ]),
  ]);
}

function renderConsole() {
  return el("div", {}, [
    renderTop(),
    state.view === "overview" ? renderOverview() : renderApplications(),
  ]);
}

function renderTop() {
  const pendingListing = (state.overview?.applications?.approvedNotListed || []).length;
  const viewTab = (key, label, badge) =>
    el(
      "button",
      {
        type: "button",
        class: `view-tab${state.view === key ? " active" : ""}`,
        // data-view 是浏览器测试的稳定钩子：文案会改，这个不会。
        "data-view": key,
        onclick: () => switchView(key),
      },
      [label, badge ? el("strong", {}, String(badge)) : null]
    );

  return el("header", { class: "top" }, [
    el("div", { class: "top-brand" }, [
      el("strong", { class: "top-brand-mark" }, [
        el("img", {
          src: "/logos/xknot-icon-64.png",
          srcset:
            "/logos/xknot-icon-32.png 1x, /logos/xknot-icon-64.png 2x, /logos/xknot-icon-128.png 3x",
          alt: "",
          width: 18,
          height: 18,
        }),
        el("span", {}, "XKNOT"),
      ]),
      "/ 联邦控制台",
    ]),
    el("nav", { class: "views", "aria-label": "控制台视图" }, [
      viewTab("overview", "总览"),
      viewTab("applications", "申请记录", pendingListing),
    ]),
    el("div", { class: "top-user" }, [
      el("span", {}, state.admin.username),
      el("button", {
        type: "button",
        class: "btn",
        "data-action": "logout",
        onclick: async () => {
          await api("/api/admin/logout", { method: "POST" }).catch(() => {});
          state.admin = null;
          state.applications = [];
          state.overview = null;
          state.selected = null;
          state.editing = null;
          closeInstancePanel();
          render();
        },
      }, "退出"),
    ]),
  ]);
}

function renderOverview() {
  const ov = state.overview;
  if (!ov) {
    return el("div", { class: "overview" }, [
      state.overviewError
        ? el("div", { class: "ov-empty" }, [
            el("p", { class: "alert", role: "alert" }, state.overviewError),
            el("button", { type: "button", class: "btn", onclick: () => loadOverview() }, "重试"),
          ])
        : el("p", { class: "empty" }, "正在读取总览…"),
    ]);
  }

  const inst = ov.instances;
  const apps = ov.applications;
  const mail = ov.mail;
  const relay = ov.relay;
  const online = inst.up + inst.degraded;

  const kpi = (label, value, note, tone = "") =>
    el("article", { class: `kpi${tone ? ` ${tone}` : ""}` }, [
      el("p", { class: "kpi-label" }, label),
      el("p", { class: "kpi-value" }, value),
      el("p", { class: "kpi-note" }, note),
    ]);

  const instanceRows = inst.rows.length
    ? inst.rows.map((row) => {
        const open = state.instanceOpen === row.id;
        const panelId = `inst-config-${row.id}`;
        return el("div", { class: `inst-item${open ? " open" : ""}` }, [
          el(
            "button",
            {
              type: "button",
              class: "inst-row",
              "aria-expanded": open ? "true" : "false",
              "aria-controls": panelId,
              onclick: () => toggleInstance(row.id),
            },
            [
              el("span", { class: "inst-what" }, [
                el("span", { class: "inst-name" }, row.name),
                el("span", { class: "inst-url" }, `${row.id} · ${row.url || "未填地址"}`),
                el("span", { class: "inst-tags" }, [
                  el("span", { class: "pill" }, TIER_LABEL[row.tier] || row.tier),
                  ...(row.services.cards ? [el("span", { class: "pill" }, "橱窗")] : []),
                  ...(row.services.stats ? [el("span", { class: "pill" }, "统计")] : []),
                  // 对端采集过、但这条隧道不在：与「接口 502」是两种故障。
                  row.tunnel?.checkedAt && !row.tunnel.connected
                    ? el("span", { class: "pill warn" }, "隧道断开")
                    : null,
                  // 位置只在和档案不一致时提醒：一致时多一个胶囊只是噪音。
                  locationDrift(row)
                    ? el(
                        "span",
                        { class: "pill warn", title: "门户显示的是观测位置，不是档案里的 region" },
                        `位置 ${row.location.country}（档案 ${row.regions[0]}）`
                      )
                    : null,
                  row.health.hidden ? el("span", { class: "pill warn" }, "已隐藏") : null,
                ]),
              ]),
              el("span", { class: "inst-state" }, [
                el("span", { class: `dot ${row.health.status}` }),
                el("span", {}, HEALTH_LABEL[row.health.status] || row.health.status),
              ]),
              el("span", { class: "inst-note" }, [
                el("span", {}, healthNote(row)),
                trafficNote(row) ? el("span", {}, trafficNote(row)) : null,
                row.health.error
                  ? el("span", { class: "inst-error" }, ERROR_LABEL[row.health.error] || row.health.error)
                  : null,
              ]),
              el("span", { class: "inst-toggle", "aria-hidden": "true" }, open ? "收起" : "配置"),
            ]
          ),
          open ? renderInstanceConfig(row, panelId) : null,
        ]);
      })
    : el("p", { class: "empty" }, "清单里还没有实例。");

  // 队列只给状态机能产出的两个分类。`rejected` / `expired` 没有任何写入路径
  // （见 server/store.mjs 的 TRANSITIONS），它们只可能是历史行；历史行在
  // 「全部」里带徽章照常出现，不必为此常驻两个永远为 0 的入口。
  const queueKeys = ["approved", "withdrawn"];
  const queue = el(
    "div",
    { class: "queue" },
    queueKeys.map((key) =>
      el("button", { type: "button", class: "queue-row", "data-status": key, onclick: () => openApplications(key) }, [
        el("span", {}, STATUS_LABEL[key]),
        el("strong", {}, String(apps.counts[key] || 0)),
      ])
    )
  );

  const events = ov.events.length
    ? el(
        "div",
        { class: "events" },
        ov.events.map((event) =>
          el("div", { class: "event-row" }, [
            el("div", { class: "event-what" }, [
              el("span", {}, EVENT_LABEL[event.kind] || event.kind),
              event.ref ? el("p", { class: "event-ref" }, event.ref) : null,
            ]),
            el("span", { class: "event-when" }, relativeLabel(event.at)),
          ])
        )
      )
    : el("p", { class: "empty" }, "还没有记录。");

  return el("div", { class: "overview" }, [
    el("section", { class: "ov-hero" }, [
      el("div", {}, [
        el("p", { class: "ov-eyebrow" }, "FEDERATION OVERVIEW"),
        el("h1", { class: "ov-title" }, `${inst.total} 个实例 · ${online} 个在线`),
        el("p", { class: "ov-sub" }, [
          inst.checkedAt ? `探测 ${relativeLabel(inst.checkedAt)}` : "尚未探测",
          " · ",
          `接口 ${ov.runtime.version} 已运行 ${formatUptime(ov.runtime.uptimeSeconds)}`,
          " · ",
          `申请库 ${formatBytes(ov.runtime.dbBytes)}`,
          inst.trafficNodes
            ? ` · 各站最近一日合计 ${inst.trafficRequests} 次请求 / ${formatBytes(inst.trafficBytes)}`
            : null,
        ]),
      ]),
      el(
        "button",
        {
          type: "button",
          class: "btn",
          disabled: state.overviewBusy,
          onclick: () => loadOverview(),
        },
        state.overviewBusy ? "刷新中…" : "刷新"
      ),
    ]),
    state.overviewError ? el("p", { class: "alert", role: "alert" }, state.overviewError) : null,
    el("div", { class: "ov-cards" }, [
      kpi(
        "实例",
        String(inst.total),
        `在线 ${online} · 离线 ${inst.down} · 待验收 ${inst.pending || 0} · 其他 ${inst.unknown + inst.unprobed + inst.paused}`,
        inst.down ? "bad" : ""
      ),
      kpi(
        "申请",
        String(apps.total),
        `已通过 ${apps.counts.approved || 0} · 已撤回 ${apps.counts.withdrawn || 0} · 待收录 ${apps.approvedNotListed.length}`,
        apps.approvedNotListed.length ? "warn" : ""
      ),
      kpi(
        "24 小时发信",
        mail.enabled ? String(mail.sent) : "未配置",
        mail.enabled ? `失败 ${mail.failed} · 限流 ${mail.throttled}` : "设置 SMTP_* 后启用",
        mail.failed ? "bad" : ""
      ),
      kpi(
        "委托发信",
        relay.enabled ? String(relay.accepted) : "未开启",
        `凭据 ${relay.activeTokens}/${relay.tokens} · 失败 ${relay.failed}`,
        relay.failed ? "bad" : ""
      ),
    ]),
    el("div", { class: "ov-grid" }, [
      el("div", { class: "ov-col" }, [
        el("section", { class: "panel" }, [
          el("div", { class: "panel-head", "data-panel": "instances" }, [
            el("h2", {}, "实例与探测"),
            el("span", { class: "meta" }, inst.checkedAt ? `上次探测 ${relativeLabel(inst.checkedAt)}` : "未探测"),
          ]),
          el("p", { class: "panel-note" }, "点一行展开这个账号的配置，不会跳走。"),
          el("div", { class: "inst-list" }, instanceRows),
        ]),
        renderHubTraffic(),
      ]),
      el("div", { class: "ov-col" }, [
        el("section", { class: "panel" }, [
          el("div", { class: "panel-head", "data-panel": "applications" }, [
            el("h2", {}, "申请记录"),
            el("button", { type: "button", class: "link-btn", onclick: () => openApplications("all") }, "查看全部"),
          ]),
          queue,
          apps.approvedNotListed.length
            ? el(
                "p",
                { class: "panel-note warn" },
                `已通过但未写进清单：${apps.approvedNotListed
                  .map((item) => item.address || item.id)
                  .join("、")}`
              )
            : null,
        ]),
        el("section", { class: "panel" }, [
          el("div", { class: "panel-head", "data-panel": "mail" }, [el("h2", {}, "发信")]),
          el("div", { class: "mail-line" }, [
            el("span", {}, "发信总闸"),
            el(
              "button",
              {
                type: "button",
                // role="switch" 是给读屏用的：状态在 aria-checked 里，文字只是外观。
                class: `mail-switch ${mail.switch === "off" ? "off" : "on"}`,
                role: "switch",
                "aria-checked": mail.switch === "off" ? "false" : "true",
                // 没配 SMTP 时按下去也发不出信，索性不给按，理由写在 title 与面板注释里。
                disabled: state.mailBusy || !mail.configured,
                title: mail.configured ? "" : "先配 SMTP_HOST 与 MAIL_FROM",
                onclick: () => toggleMail(mail.switch === "off"),
              },
              state.mailBusy ? "写入中…" : mail.switch === "off" ? "已关" : "开"
            ),
          ]),
          el("div", { class: "mail-line" }, [
            el("span", {}, "伙伴与内部信"),
            el(
              "span",
              { class: "mono" },
              mail.switch === "off" ? "总闸已关" : mail.configured ? "SMTP 已配置" : "未配置"
            ),
          ]),
          el("div", { class: "mail-line" }, [
            el("span", {}, "24 小时"),
            el("span", { class: "mono" }, `成功 ${mail.sent} · 失败 ${mail.failed} · 限流 ${mail.throttled}`),
          ]),
          el("div", { class: "mail-line" }, [
            el("span", {}, "委托发信"),
            el("span", { class: "mono" }, relay.enabled ? "已开启" : relay.envOff ? "环境变量已关" : "未开启"),
          ]),
          el("div", { class: "mail-line" }, [
            el("span", {}, "最近一封"),
            el("span", { class: "mono" }, mail.lastAt ? relativeLabel(mail.lastAt) : "—"),
          ]),
          mail.switch === "off"
            ? el(
                "p",
                { class: "panel-note warn" },
                "总闸关着：伙伴信、内部告警、成员登录码与委托发信一起停，直接调 notify 也会被拒。"
              )
            : null,
          !mail.configured
            ? el("p", { class: "panel-note warn" }, "没配 SMTP：先填 SMTP_HOST 与 MAIL_FROM，总闸才能按。")
            : null,
          relay.envOff
            ? el(
                "p",
                { class: "panel-note warn" },
                "代发被环境变量关掉了（XKNOT_RELAY_ENABLED=0）：总闸开着，实例仍会拿到 503。"
              )
            : null,
        ]),
        el("section", { class: "panel" }, [
          el("div", { class: "panel-head", "data-panel": "events" }, [el("h2", {}, "最近事件")]),
          events,
        ]),
      ]),
    ]),
  ]);
}

function switchView(view) {
  if (view === state.view) return;
  state.view = view;
  state.error = "";
  // 离开总览时丢掉未保存的草稿，避免下次点开看到上一次的改动。
  state.editing = null;
  closeInstancePanel();
  render();
  if (view === "overview") loadOverview();
  else loadApplications();
}

function openApplications(status) {
  state.filter = status;
  state.selected = null;
  state.manifest = null;
  state.editing = null;
  closeInstancePanel();
  state.view = "applications";
  state.error = "";
  render();
  loadApplications();
}

function renderApplications() {
  const loading = state.applicationsBusy;
  const tabs = ["approved", "withdrawn", "all"].map((key) => {
    const count = key === "all" ? Object.values(state.counts).reduce((a, b) => a + b, 0) : state.counts[key] || 0;
    return el(
      "button",
      {
        type: "button",
        class: `tab${state.filter === key ? " active" : ""}`,
        "data-status": key,
        disabled: loading,
        onclick: () => {
          state.filter = key;
          state.selected = null;
          state.manifest = null;
          render();
          loadApplications();
        },
      },
      [key === "all" ? "全部" : STATUS_LABEL[key], el("strong", {}, String(count))]
    );
  });

  // 只渲染属于当前分类的行。切分类后请求失败时，state.applications 还是上一次
  // 读到的内容（例如「已通过」），标签却已经是「已撤回」，那些行不能继续显示。
  const rows = state.applicationsFilter === state.filter ? state.applications : [];

  let list;
  if (state.applicationsError) {
    // 读取失败时只留错误条与重试。上一次的行属于别的分类（或已经不是当前数据），
    // 继续显示会让运维把它当成这次读到的东西，所以这里一行都不渲染。
    list = el("div", { class: "load-error" }, [
      el("p", { class: "alert", role: "alert" }, state.applicationsError),
      el("button", {
        type: "button",
        class: "btn",
        "data-action": "retry",
        disabled: loading,
        onclick: () => loadApplications(),
      }, "重试"),
    ]);
  } else if (rows.length) {
    list = el(
      "div",
      { class: "list", "aria-busy": loading ? "true" : null },
      rows.map((item) =>
        el(
          "button",
          {
            type: "button",
            class: `item${state.selected?.id === item.id ? " selected" : ""}`,
            disabled: loading,
            onclick: () => select(item),
          },
          [
            el("span", { class: "item-name" }, item.name),
            el(
              "span",
              { class: `badge ${item.status}`, "data-status": item.status },
              STATUS_LABEL[item.status] || item.status
            ),
            el("span", { class: "item-url" }, item.url),
            el("span", { class: "item-meta" }, [
              item.id,
              "·",
              regionLabel(item.region),
              "·",
              formatWhen(item.createdAt),
            ]),
          ]
        )
      )
    );
  } else {
    // 读取中的空列表不是「没有记录」：说清楚还在等接口，别让运维以为查过了。
    list = el(
      "p",
      { class: "empty" },
      loading ? "正在读取…" : state.filter === "approved" ? "还没有通过记录。" : "这个分类下没有记录。"
    );
  }

  return el("div", { class: "layout" }, [
    el("section", { class: "panel" }, [el("div", { class: "tabs" }, tabs), list]),
    el("aside", { class: "panel" }, [
      state.selected
        ? renderDetail(state.selected)
        : el("p", { class: "detail-empty" }, "从左侧选一条申请查看详情。"),
    ]),
  ]);
}

function renderDetail(item) {
  const manifest = state.manifest && state.manifestId === item.id ? state.manifest : null;
  const notListed = (state.overview?.applications?.approvedNotListed || []).some((row) => row.id === item.id);

  return el("div", { class: "detail" }, [
    el("div", { class: "detail-head" }, [
      el("div", {}, [
        el("h2", {}, item.name),
        el("p", { class: "detail-id" }, `${item.id} · 提交于 ${formatWhen(item.createdAt)}`),
      ]),
      el("span", { class: `badge ${item.status}`, "data-status": item.status }, STATUS_LABEL[item.status] || item.status),
    ]),

    el("dl", { class: "dl" }, [
      el("dt", {}, "站点"),
      el("dd", {}, el("a", { href: item.url, target: "_blank", rel: "noopener noreferrer" }, item.url)),
      el("dt", {}, "运营者"),
      el("dd", {}, item.operator),
      el("dt", {}, "邮箱"),
      el("dd", {}, el("a", { href: `mailto:${item.email}` }, item.email)),
      el("dt", {}, "区域"),
      el("dd", {}, regionLabel(item.region)),
      el("dt", {}, "时区"),
      el("dd", {}, item.timezone),
      el("dt", {}, "简介"),
      el("dd", {}, item.intro),
      el("dt", {}, "标签"),
      el("dd", {}, item.tags.length ? item.tags.map((tag) => `#${tag}`).join(" ") : "—"),
      el("dt", {}, "通过"),
      el("dd", {}, item.reviewedAt
        ? `${item.reviewedBy === "auto" || !item.reviewedBy ? "提交即通过" : item.reviewedBy} · ${formatWhen(item.reviewedAt)}`
        : "—"),
      state.overview
        ? el("dt", {}, "收录")
        : null,
      state.overview
        ? el("dd", {}, notListed ? "还没写进清单" : "已写进清单")
        : null,
      el("dt", {}, "公钥"),
      el("dd", {}, item.publicKey || "未提交"),
    ]),

    el("p", { class: "hint" }, "申请提交即通过，这里不再审核。要让一个成员停下来，改它实例的 status（暂停 / 退役）。"),

    item.status === "approved"
      ? el("div", { class: "snippet" }, [
          el("div", { class: "snippet-head" }, [
            el("span", {}, "清单条目"),
            el("button", {
              type: "button",
              class: "btn",
              "data-action": "manifest",
              disabled: state.busy,
              onclick: async () => {
                state.busy = true;
                state.error = "";
                try {
                  const data = await api(`/api/admin/applications/${item.id}/manifest`);
                  state.manifest = JSON.stringify(data.entry, null, 2);
                  state.manifestId = item.id;
                } catch {
                  state.error = "生成清单条目失败。";
                }
                state.busy = false;
                render();
              },
            }, manifest ? "重新生成" : "生成"),
          ]),
          manifest
            ? el("div", {}, [
                el("pre", { tabindex: "0" }, manifest),
                el("button", {
                  type: "button",
                  // 控制台 CSP 是 style-src 'self'，行内 style 会被拦，样式放 CSS 里。
                  class: "btn btn-copy",
                  onclick: async () => {
                    try {
                      await navigator.clipboard.writeText(manifest);
                      state.copied = true;
                      render();
                      setTimeout(() => {
                        state.copied = false;
                        render();
                      }, 1800);
                    } catch {
                      state.error = "浏览器不允许写剪贴板，请手动选择复制。";
                      render();
                    }
                  },
                }, state.copied ? "已复制" : "复制"),
                el("p", { class: "hint" }, "粘贴进 instances.json 后执行 npm run build，条目才会出现在门户上。也可以直接运行 server/admin-cli.mjs publish " + item.id),
              ])
            : null,
        ])
      : // 兜底文案跟着状态走。以前这里写死「已撤回」，于是从「全部」里点开一条
        // 拒绝或过期的历史记录，界面也说是撤回——状态说错了，就是假信息。
        el(
          "p",
          { class: "hint" },
          item.status === "withdrawn"
            ? "这份申请已撤回，只在库里留档。"
            : `这条记录的状态是「${STATUS_LABEL[item.status] || item.status}」，只读留档，不再接受操作。`
        ),

    state.error ? el("p", { class: "alert", role: "alert" }, state.error) : null,
  ]);
}

async function select(item) {
  state.selected = item;
  state.error = "";
  state.manifest = null;
  state.copied = false;
  render();
}

async function toggleMail(enabled) {
  if (state.mailBusy) return;
  state.mailBusy = true;
  state.overviewError = "";
  render();
  try {
    await api("/api/admin/mail", { method: "POST", body: JSON.stringify({ enabled }) });
  } catch (error) {
    state.mailBusy = false;
    if (error.status === 401) {
      state.admin = null;
      state.overview = null;
      state.editing = null;
      closeInstancePanel();
      render();
      return;
    }
    state.overviewError = "发信总闸没有改成功，请稍后再试。";
    render();
    return;
  }
  state.mailBusy = false;
  // 重新读一遍再画：开着总闸也可能因为环境变量或没配 SMTP 仍然发不出去，
  // 界面要照服务端说的显示，不按这次点击想当然地画成「已开」。
  await loadOverview();
}

async function loadOverview() {
  const seq = ++overviewSeq;
  const view = state.view;
  state.overviewBusy = true;
  state.overviewError = "";
  if (state.view === view) render();
  try {
    // 门户流量与总览并行取：其中一份失败只让那一块显示读不到，不拖垮整页。
    const [data, hub] = await Promise.all([
      api("/api/admin/overview"),
      api("/api/admin/hub/traffic").catch(() => ({ error: true })),
    ]);
    if (seq !== overviewSeq) return;
    state.overview = data;
    state.hubTraffic = hub;
  } catch (error) {
    if (seq !== overviewSeq) return;
    if (error.status === 401) {
      state.admin = null;
      state.overview = null;
      state.editing = null;
      closeInstancePanel();
      return;
    }
    state.overviewError = "总览加载失败，请检查接口是否在运行。";
  } finally {
    if (seq === overviewSeq) {
      state.overviewBusy = false;
      // 用户已经切到申请列表时不再整棵重绘，否则会把他正点着的那一行换掉。
      if (state.view === view) render();
    }
  }
}

async function loadApplications() {
  const seq = ++applicationsSeq;
  const view = state.view;
  // 这次请求读的是哪个分类。响应回来时 state.filter 可能已经变了（用户又点了一下），
  // 所以记下请求时的值，不按回来时的 state.filter 判断行属于谁。
  const filter = state.filter;
  state.applicationsBusy = true;
  state.applicationsError = "";
  render();
  try {
    const query = filter && filter !== "all" ? `?status=${filter}` : "";
    const data = await api(`/api/admin/applications${query}`);
    if (seq !== applicationsSeq) return;
    state.applications = data.applications;
    state.applicationsFilter = filter;
    state.counts = data.counts;
    if (state.selected) {
      const fresh = state.applications.find((item) => item.id === state.selected.id);
      if (fresh) state.selected = fresh;
    }
  } catch (error) {
    if (seq !== applicationsSeq) return;
    if (error.status === 401) {
      state.admin = null;
      state.editing = null;
      closeInstancePanel();
      return;
    }
    // 失败要把失败本身渲染出来（renderApplications 读 applicationsError），
    // 并把旧行清掉：它们属于上一次读的分类，顶着新标签显示就是在冒充当前数据。
    state.applicationsError = error.status
      ? `申请列表加载失败（HTTP ${error.status}）。`
      : "申请列表加载失败，请检查接口是否在运行。";
    state.applications = [];
    state.applicationsFilter = filter;
  } finally {
    if (seq === applicationsSeq) {
      state.applicationsBusy = false;
      // 用户已经切走时不再整棵重绘，否则会把他正点着的那一行换掉。
      if (state.view === view) render();
    }
  }
}

async function boot() {
  try {
    const data = await api("/api/admin/session");
    state.admin = data.admin;
    state.view = "overview";
    await loadOverview();
  } catch {
    state.admin = null;
    render();
  }
}

boot();

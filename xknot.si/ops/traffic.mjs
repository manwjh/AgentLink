// 入口流量：读入口主机的 nginx 访问日志，按子域归到清单里的实例。
//
// 为什么在这里读：所有子域的公开流量都经过同一台入口 nginx——静态文件由它直出，
// 页面与接口穿隧道回源。收口点只有一个，所以「一个子域的流量」不需要实例配合、
// 不需要埋点，也不需要第三方。适用条件与 ops/peers.mjs 相同：中枢与入口同机。
//
// 日志格式由 knot-platform/ops/entry/log.conf.template 定义，每行一个 JSON。
//
// 产出 var/traffic/{id}.json：按天聚合，保留最近 N 天（默认 30）。只读这一份，
// 不存原始日志、不存 IP、不存完整 referer；IP 只用于当天去重，落盘前已经消失。
// 另外按 UA 把搜索引擎爬虫单列，按 referer 主机名把搜索引荐归到引擎层：
// 「有没有被抓、从搜索进来几次」不依赖埋点和第三方。
//
// 门户自己也落一份 var/traffic/hub.json：xknot.si 不在实例清单里，但
// /<locale>/instances/ 这些给爬虫看的页面在它上面，索引情况要靠这一份。
//
// 用法：
//   node ops/traffic.mjs
//   node ops/traffic.mjs --log /var/log/nginx/knot-access.log --days 30
//   node ops/traffic.mjs --out ./var/traffic --instances ./instances.json

import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { invokedDirectly } from "./lib/main-module.mjs";

export const DEFAULT_DAYS = 30;
export const DEFAULT_LOG = "/var/log/nginx/knot-access.log";
// 门户不在 instances.json 里，但它的入口流量同样要落盘：用固定 id，文件名 hub.json。
// 同名标签已在 ops/subdomain.mjs 里保留，实例不会占用它。
export const HUB_TRAFFIC_ID = "hub";

// 一天的延迟样本上限。超过就不再收：p95 用不着全量，内存要有个硬边界。
const MAX_SAMPLES = 20_000;
// 当天去重集合的上限。达到上限后 uniqueApprox 只增不减，标注为近似值。
const MAX_UNIQUE = 50_000;
const MAX_PATH = 200;
const MAX_UA = 200;
const TOP_PATHS = 10;

// 只用来把爬虫从「访客」里分出去，不追求精确。空 UA 也算。
const BOT_RE =
  /(bot|crawler|spider|slurp|curl|wget|python-requests|python-urllib|go-http-client|java\/|headless|phantom|monitor|uptime|pingdom|facebookexternalhit|semrush|ahrefs|mj12)/i;

// 搜索引擎爬虫从「爬虫」里单独拆出来，用来回答「有没有被抓、抓了哪些页」。
// 按名字逐个匹配：Googlebot 的 UA 里也带 bot，泛规则分不出是谁。
// 清单是固定的，新增一个就多一列，控制台的字段白名单跟着改。
const SEARCH_BOTS = [
  // 只算自然搜索的抓取：AdsBot、FeedFetcher 这些是广告和订阅，不算「索引」。
  ["googlebot", /googlebot|google-inspectiontool|googleother|storebot-google/i],
  ["bingbot", /bingbot|bingpreview/i],
  ["applebot", /applebot/i],
  ["baiduspider", /baiduspider/i],
  ["yandexbot", /yandexbot|yandeximages/i],
];

export const CRAWLER_KEYS = SEARCH_BOTS.map(([key]) => key);

// 搜索引荐只认搜索引擎自己的域名。referer 到这里已经只剩主机名，查询词从来不入日志。
// 主机名按整串匹配：mail.google.com、drive.google.com 不是搜索引荐，不沾边。
const SEARCH_ENGINES = [
  ["google", /^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/],
  ["bing", /^(www\.|cn\.)?bing\.com$/],
  ["baidu", /^(www\.)?baidu\.com$/],
  ["duckduckgo", /^(www\.|html\.)?duckduckgo\.com$/],
  ["yandex", /^(www\.)?yandex\.[a-z.]{2,6}$/],
  ["sogou", /^(www\.)?sogou\.com$/],
];

export const SEARCH_ENGINE_KEYS = SEARCH_ENGINES.map(([key]) => key);

/** UA → 搜索引擎爬虫标识；不是这几个返回空串（其余仍计入 botShare）。 */
export function searchBotOf(ua) {
  const text = String(ua ?? "");
  for (const [key, pattern] of SEARCH_BOTS) {
    if (pattern.test(text)) return key;
  }
  return "";
}

/** referer 主机名 → 搜索引擎标识；不是搜索引擎返回空串。 */
export function searchEngineOf(host) {
  const text = String(host ?? "").trim().toLowerCase();
  if (!text) return "";
  for (const [key, pattern] of SEARCH_ENGINES) {
    if (pattern.test(text)) return key;
  }
  return "";
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

export function hostOfUrl(raw) {
  try {
    const url = new URL(String(raw || "").trim());
    return url.hostname.toLowerCase();
  } catch {
    return "";
  }
}

function toMs(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

// "-" 表示没回源；"0.1, 0.2" 是多次回源，取第一个。
export function upstreamMs(value) {
  const text = String(value ?? "").trim();
  if (!text || text === "-") return null;
  const first = text.split(",")[0].trim();
  const seconds = Number(first);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

// referer 只留主机名：完整 URL 可能带着别人的查询串。
export function refererHost(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// 一行日志 → 一条归一化记录。坏行返回 null，由调用方计数，不中断整份聚合。
export function parseLine(line) {
  const text = String(line ?? "").trim();
  if (!text) return null;
  let row;
  try {
    row = JSON.parse(text);
  } catch {
    return null;
  }
  if (!row || typeof row !== "object") return null;

  const host = typeof row.host === "string" ? row.host.trim().toLowerCase() : "";
  const date = typeof row.at === "string" ? row.at.slice(0, 10) : "";
  if (!host || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const status = Number(row.status);
  const bytes = Number(row.bytes);
  return {
    host,
    date,
    status: Number.isInteger(status) ? status : 0,
    method: typeof row.method === "string" ? row.method.slice(0, 16).toUpperCase() : "",
    uri: typeof row.uri === "string" ? row.uri.slice(0, MAX_PATH) : "",
    bytes: Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0,
    requestMs: toMs(row.requestTime),
    upstreamMs: upstreamMs(row.upstreamTime),
    cache: typeof row.cache === "string" ? row.cache.trim().toUpperCase() : "",
    ip: typeof row.ip === "string" ? row.ip.trim() : "",
    ua: typeof row.ua === "string" ? row.ua.slice(0, MAX_UA) : "",
    ref: refererHost(row.ref),
  };
}

function cacheBucket(value) {
  if (value === "HIT") return "hit";
  if (value === "BYPASS") return "bypass";
  if (!value) return "none";
  // MISS / EXPIRED / STALE / UPDATING / REVALIDATED 都是「没有直接命中」。
  return "miss";
}

function statusBucket(status) {
  const group = Math.floor(status / 100);
  if (group >= 1 && group <= 5) return `${group}xx`;
  return "other";
}

// 指纹只用于当天去重，聚合结束就丢；不进产物，也不写第二份文件。
function fingerprint(row) {
  return createHash("sha256").update(`${row.ip}\u0000${row.ua}`).digest("base64url").slice(0, 16);
}

export function emptyAggregate() {
  return { byId: new Map(), unknownHosts: new Map(), badLines: 0, lines: 0 };
}

function bucketOf(agg, id, date) {
  let byDate = agg.byId.get(id);
  if (!byDate) {
    byDate = new Map();
    agg.byId.set(id, byDate);
  }
  let bucket = byDate.get(date);
  if (!bucket) {
    bucket = {
      date,
      requests: 0,
      bytes: 0,
      status: { "1xx": 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 },
      methods: new Map(),
      cache: { hit: 0, miss: 0, bypass: 0, none: 0 },
      upstreamRequests: 0,
      requestTimes: [],
      upstreamTimes: [],
      unique: new Set(),
      bots: 0,
      crawlers: new Map(),
      crawlPaths: new Map(),
      crawlStatus: { "1xx": 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 },
      searchEngines: new Map(),
      paths: new Map(),
      referers: new Map(),
    };
    byDate.set(date, bucket);
  }
  return bucket;
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

// 把一条记录并进聚合。只认清单里有的 host；配错的 vhost 不能凭空多一个节点。
export function accumulate(agg, row, hostToId) {
  if (!row) {
    agg.badLines += 1;
    return null;
  }
  agg.lines += 1;
  const id = hostToId instanceof Map ? hostToId.get(row.host) : hostToId?.[row.host];
  if (!id) {
    bump(agg.unknownHosts, row.host);
    return null;
  }

  const bucket = bucketOf(agg, id, row.date);
  bucket.requests += 1;
  bucket.bytes += row.bytes;
  bucket.status[statusBucket(row.status)] += 1;
  if (row.method) bump(bucket.methods, row.method);
  bucket.cache[cacheBucket(row.cache)] += 1;
  if (row.uri) bump(bucket.paths, row.uri);
  if (row.ref) bump(bucket.referers, row.ref);

  if (row.requestMs != null && bucket.requestTimes.length < MAX_SAMPLES) {
    bucket.requestTimes.push(row.requestMs);
  }
  if (row.upstreamMs != null) {
    bucket.upstreamRequests += 1;
    if (bucket.upstreamTimes.length < MAX_SAMPLES) bucket.upstreamTimes.push(row.upstreamMs);
  }

  if (!row.ua || BOT_RE.test(row.ua)) bucket.bots += 1;

  // 搜索引擎爬虫：抓了几次、抓了哪些页、抓出了什么状态码。
  const crawler = searchBotOf(row.ua);
  if (crawler) {
    bump(bucket.crawlers, crawler);
    if (row.uri) bump(bucket.crawlPaths, row.uri);
    bucket.crawlStatus[statusBucket(row.status)] += 1;
  }

  // 搜索引荐：从哪个搜索引擎点进来的，只到引擎这一层。
  const engine = searchEngineOf(row.ref);
  if (engine) bump(bucket.searchEngines, engine);

  if (bucket.unique.size < MAX_UNIQUE && row.ip) bucket.unique.add(fingerprint(row));
  return bucket;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function topEntries(map, limit) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// 一个累加桶 → 落盘的一天。
export function finalizeBucket(bucket) {
  const requestTimes = [...bucket.requestTimes].sort((a, b) => a - b);
  const upstreamTimes = [...bucket.upstreamTimes].sort((a, b) => a - b);
  return {
    date: bucket.date,
    requests: bucket.requests,
    bytes: bucket.bytes,
    status: { ...bucket.status },
    methods: Object.fromEntries([...bucket.methods.entries()].sort((a, b) => b[1] - a[1])),
    cache: { ...bucket.cache },
    latency: {
      p50: percentile(requestTimes, 50),
      p95: percentile(requestTimes, 95),
      max: requestTimes.length ? requestTimes[requestTimes.length - 1] : null,
      samples: requestTimes.length,
    },
    upstream: {
      requests: bucket.upstreamRequests,
      p95: percentile(upstreamTimes, 95),
      max: upstreamTimes.length ? upstreamTimes[upstreamTimes.length - 1] : null,
    },
    uniqueApprox: bucket.unique.size,
    botShare: bucket.requests ? round(bucket.bots / bucket.requests) : 0,
    // 搜索爬虫按名单固定出列，没出现的是 0，不省略键：控制台按同一组键渲染。
    crawlers: Object.fromEntries(CRAWLER_KEYS.map((key) => [key, bucket.crawlers.get(key) || 0])),
    crawlStatus: { ...bucket.crawlStatus },
    crawlPaths: topEntries(bucket.crawlPaths, TOP_PATHS).map((entry) => ({ path: entry.key, requests: entry.count })),
    searchEngines: Object.fromEntries(
      SEARCH_ENGINE_KEYS.map((key) => [key, bucket.searchEngines.get(key) || 0]),
    ),
    topPaths: topEntries(bucket.paths, TOP_PATHS).map((entry) => ({ path: entry.key, requests: entry.count })),
    topReferers: topEntries(bucket.referers, TOP_PATHS).map((entry) => ({ host: entry.key, requests: entry.count })),
  };
}

export function finalizeAggregate(agg) {
  const byId = new Map();
  for (const [id, byDate] of agg.byId) {
    byId.set(
      id,
      [...byDate.values()]
        .map(finalizeBucket)
        .sort((a, b) => b.date.localeCompare(a.date)),
    );
  }
  return byId;
}

// 日志按天轮转，所以当前文件里可能既有今天也有一天前的那一份。
// 规则：本次日志里出现的日期整份覆盖，日志里没有的旧日期从上次结果里保留。
export function mergeTraffic(previous, freshDays, { id, host, days = DEFAULT_DAYS, now = new Date() } = {}) {
  const map = new Map();
  for (const day of Array.isArray(previous?.days) ? previous.days : []) {
    if (day?.date) map.set(day.date, day);
  }
  for (const day of freshDays || []) {
    if (day?.date) map.set(day.date, day);
  }
  const merged = [...map.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, Math.max(1, days));
  return {
    id,
    host,
    updatedAt: now.toISOString(),
    days: merged,
  };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
}

// 日志按天轮转，所以当前文件里可能既有今天也有昨天的一部分。
// 只读当前文件会漏掉「最后一次聚合到轮转之间」的请求，所以连同最近的轮转档一起读：
// 按修改时间从旧到新，当前文件最后。聚合按日期累加，顺序不影响总数。
export async function logFiles(logPath, { now = new Date(), recallDays = 3 } = {}) {
  const dir = path.dirname(logPath);
  const base = path.basename(logPath);
  const cutoff = now.getTime() - recallDays * 86400_000;
  const extra = [];
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return [logPath];
  }
  for (const name of names) {
    if (name === base || !name.startsWith(base)) continue;
    // logrotate 的两种命名：access.log.1 / .2.gz 与 access.log-YYYYMMDD(.gz)。
    if (!/^(?:\.\d+(?:\.gz)?|-\d{8}(?:\.gz)?)$/.test(name.slice(base.length))) continue;
    const file = path.join(dir, name);
    try {
      const info = await stat(file);
      if (info.isFile() && info.mtimeMs >= cutoff) extra.push({ file, at: info.mtimeMs });
    } catch {
      // 读不到就跳过，不让一份坏轮转档挡住整次聚合。
    }
  }
  extra.sort((a, b) => a.at - b.at);
  return [...extra.map((entry) => entry.file), logPath];
}

async function readLines(file, onLine) {
  const stream = createReadStream(file);
  const input = file.endsWith(".gz") ? stream.pipe(createGunzip()) : stream;
  const reader = createInterface({ input, crlfDelay: Infinity });
  for await (const line of reader) onLine(line);
}

// 清单是 host → id 的唯一来源：日志里出现清单外的 host 只计数，不落盘。
export function hostMapOf(manifest) {
  const map = new Map();
  for (const instance of Array.isArray(manifest?.instances) ? manifest.instances : []) {
    const host = hostOfUrl(instance?.url);
    if (host && instance?.id) map.set(host, String(instance.id));
  }
  return map;
}

// 门户的主机名来自 federation.json 的 hub 字段，不在实例清单里。
// 读不到就返回空串：少这一份流量，不影响各实例的聚合。
export function hubHostOf(federation) {
  const raw = String(federation?.hub ?? "").trim().toLowerCase();
  if (!raw) return "";
  const host = raw.includes("://") ? hostOfUrl(raw) : raw.replace(/\/+$/, "");
  return /^[a-z0-9][a-z0-9.-]*$/.test(host) ? host : "";
}

export async function run(options = {}) {
  const dataDir = process.env.XKNOT_DATA_DIR
    ? path.resolve(process.env.XKNOT_DATA_DIR)
    : path.join(ROOT, "var");
  const {
    logPath = process.env.XKNOT_ACCESS_LOG || DEFAULT_LOG,
    outDir = path.join(dataDir, "traffic"),
    instancesPath = process.env.XKNOT_INSTANCES_FILE
      ? path.resolve(process.env.XKNOT_INSTANCES_FILE)
      : path.join(ROOT, "instances.json"),
    federationPath = process.env.XKNOT_FEDERATION_FILE
      ? path.resolve(process.env.XKNOT_FEDERATION_FILE)
      : path.join(ROOT, "federation.json"),
    days = DEFAULT_DAYS,
    now = () => new Date(),
    log = () => {},
  } = options;

  const manifest = await readJson(instancesPath, null);
  if (!manifest || !Array.isArray(manifest.instances)) {
    throw new Error(`cannot read instances: ${instancesPath}`);
  }

  // 没有日志不是错误：入口还没装 knot-log.conf 时，这份聚合就该安静地跳过。
  try {
    await stat(logPath);
  } catch {
    log(`没有访问日志：${logPath}（入口还没装 knot-log.conf？）`);
    return { skipped: "no_log", logPath, dataDir, written: [] };
  }

  const hostToId = hostMapOf(manifest);
  // 门户自己也算一个桶：它的页面不在实例清单里，但爬虫抓的是它。
  // 主机名已被某个实例占用、或清单里已经有 id "hub" 时让位，不覆盖实例。
  const hubHost = hubHostOf(await readJson(federationPath, null));
  const ids = new Set(hostToId.values());
  if (hubHost && !hostToId.has(hubHost) && !ids.has(HUB_TRAFFIC_ID)) {
    hostToId.set(hubHost, HUB_TRAFFIC_ID);
  }
  const agg = emptyAggregate();
  const files = await logFiles(logPath, { now: now() });
  for (const file of files) {
    try {
      await readLines(file, (line) => accumulate(agg, parseLine(line), hostToId));
    } catch (error) {
      log(`读取失败，跳过 ${file}：${error.message}`);
    }
  }

  const byId = finalizeAggregate(agg);
  const at = now();
  await mkdir(outDir, { recursive: true });

  const idToHost = new Map([...hostToId.entries()].map(([host, id]) => [id, host]));
  const written = [];
  for (const [id, freshDays] of byId) {
    const file = path.join(outDir, `${id}.json`);
    const previous = await readJson(file, null);
    const merged = mergeTraffic(previous, freshDays, { id, host: idToHost.get(id) || "", days, now: at });
    await writeJson(file, merged);
    written.push({ id, days: merged.days.length, requests: merged.days[0]?.requests ?? 0 });
  }

  const unknown = [...agg.unknownHosts.entries()].sort((a, b) => b[1] - a[1]);
  if (unknown.length) {
    log(`清单外的 host 已忽略：${unknown.map(([host, count]) => `${host}(${count})`).join(", ")}`);
  }
  log(`扫描 ${files.length} 份日志 ${agg.lines} 行，坏行 ${agg.badLines}，写入 ${written.length} 份`);
  return {
    skipped: null,
    logPath,
    outDir,
    dataDir: path.dirname(outDir),
    files: files.length,
    badLines: agg.badLines,
    unknownHosts: Object.fromEntries(unknown),
    written,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (name === "--log") args.logPath = argv[++i];
    else if (name === "--out") args.outDir = path.resolve(argv[++i]);
    else if (name === "--instances") args.instancesPath = path.resolve(argv[++i]);
    else if (name === "--federation") args.federationPath = path.resolve(argv[++i]);
    else if (name === "--days") args.days = Number(argv[++i]);
  }
  return args;
}

const isMain = invokedDirectly(import.meta.url);

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  run({ ...args, log: (line) => console.log(line) })
    .then(async (result) => {
      if (result.skipped) return;
      for (const item of result.written) console.log(`${item.id.padEnd(16)} ${item.requests} 次 · ${item.days} 天`);
      // 流量是节点状态的一部分：写完就重算一次，控制台读到的是一份文档。
      const { refreshStatus } = await import("./node-status.mjs");
      await refreshStatus({
        dataDir: result.dataDir,
        ...(args.instancesPath ? { instancesPath: args.instancesPath } : {}),
        ...(args.federationPath ? { federationPath: args.federationPath } : {}),
      });
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

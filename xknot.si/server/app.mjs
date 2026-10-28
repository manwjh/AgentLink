// xknot 中枢的接口层。
//
// 写操作只有四类：访客提交加入申请（提交即通过）、在案例页提交公钥或撤回、
// 一次性领取交付资料、管理员改实例配置与补信。其余都是读。
// 不设 CORS：只接受同源请求，带 Origin 且与 Host 不一致直接拒绝。
// 静态文件只在本地开发时由这里代管 /admin/，生产交给 nginx。

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

import { updateInstanceConfig } from "./edit.mjs";
import { checkLabel, suggestLabels, SUBDOMAIN_MIN } from "../ops/subdomain.mjs";
import { checkManifestEntry, toManifestEntry } from "./manifest.mjs";
import { memberCodeMail } from "./member-mail.mjs";
import { isTransientMailError, mailErrorCode } from "./mail.mjs";
import { probeEnabled, probeTargetOf } from "../ops/probe-target.mjs";
import {
  ALL_EVENTS,
  TEMPLATE_VERSION,
  buildMail,
  normalizeLocale,
} from "./notify.mjs";
import {
  renderCasePage,
  renderClaimPage,
  renderClaimResult,
} from "./pages.mjs";
import { RELAY_LIMITS, domainOf, relayMessage, validateRelayRequest } from "./relay.mjs";
import { ipHash, normalizeUsername } from "./store.mjs";
import { summarizeTraffic } from "./traffic-view.mjs";
import { LIMITS, normalizePublicKey, validEmail, validateApplication } from "./validate.mjs";

const BODY_LIMIT = 16 * 1024;
const COOKIE = "xknot_admin";
// 成员会话与管理员会话用两个 Cookie：同一个人可能同时是访客和运营者。
const MEMBER_COOKIE = "xknot_member";
const MEMBER_CODE_TTL = 10; // 分钟
const MEMBER_SESSION_DAYS = 30;

// 发信失败后的退避重试间隔。只重试瞬时的失败（SMTP 4xx、超时、连接被掐）；
// 5xx 与地址非法是永久失败，再试一遍只是把同一条错误多记几遍。
//
// 三次机会就是为「收信端让我们慢一点」准备的：共享发信 IP 被打到流控时
// 收信端回 421，那时立刻重试只会延长封禁，隔一阵再来才是对的。
const MAIL_RETRY_DELAYS = [60_000, 300_000, 1_800_000];

// 委托发信遇到瞬时失败时回给实例的 Retry-After（秒）。实例侧是同步等一次
// HTTP 响应，它自己决定要不要按这个间隔再发；不给这个头，它只会立刻重试。
const RELAY_TRANSIENT_RETRY_SECONDS = 300;

// 测试要能把它压到 0：默认那三档加起来是 36 分钟，等不起。
function normalizeRetryDelays(value) {
  if (!Array.isArray(value)) return MAIL_RETRY_DELAYS;
  return value
    .map((ms) => Number(ms))
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
    .map((ms) => Math.min(ms, 6 * 3600_000));
}

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    ...HTML_HEADERS,
    "content-length": Buffer.byteLength(html),
  });
  res.end(html);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    const raw = part.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw; // 坏的百分号编码不该让整个请求 500
    }
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        // 这里不能 destroy：socket 一关，调用方那个 413 就写不出去，
        // 客户端只会看到连接重置。剩下的体继续读进来再丢掉，让响应能发完。
        tooLarge = true;
        chunks.length = 0;
        resolve(bodyFailure("too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString("utf8");
      const type = String(req.headers["content-type"] || "").toLowerCase();
      if (type.includes("application/x-www-form-urlencoded")) {
        try {
          const params = new URLSearchParams(raw);
          const out = {};
          for (const [key, value] of params) out[key] = value;
          return resolve(out);
        } catch {
          return resolve(bodyFailure("bad_json"));
        }
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        resolve(bodyFailure("bad_json"));
      }
    });
    req.on("error", () => resolve(bodyFailure("bad_json")));
  });
}

// 每个写接口对「体太大」「JSON 坏」这两种失败的回应必须一样。
// 各写一段的话，同一个客户端错误在不同端点上会拿到不同的码（413 或 400 invalid），
// 排查时看不出是哪里坏的。
//
// 返回 null 表示已经写过响应，调用方直接 return。
// 读体失败的标记。不能用 `body.error` 判断：那是一个合法的 JSON 字段名，
// 客户端发 `{"error":"too_large"}` 时会被当成读体失败、直接回 413，
// 把一次正常的业务请求变成传输层错误。符号不会出现在 JSON 里，所以只可能由这里设上。
const BODY_ERROR = Symbol("knot.bodyError");
function bodyFailure(kind) {
  const value = { error: kind };
  Object.defineProperty(value, BODY_ERROR, { value: kind, enumerable: false });
  return value;
}

async function readJsonBody(req, res) {
  const body = await readBody(req);
  const failure = body[BODY_ERROR];
  if (failure === "too_large") {
    send(res, 413, { error: "too_large" });
    return null;
  }
  if (failure === "bad_json") {
    send(res, 400, { error: "bad_json" });
    return null;
  }
  return body;
}

// 简单的滑动窗口计数：单进程够用，重启后清零。
//
// Map 里的键来自外部地址（ipHash），不清就会一直涨：过期的时间戳不会自己消失，
// 只有同一个键再次命中时才被 filter 重写。所以计数清空时把键删掉，并在键数
// 超过上限时清理一遍已经过期的桶——公开端点不能凭换来源地址把内存撑到无界。
const LIMITER_MAX_KEYS = 20_000;

function createLimiter({ windowMs, max, store = new Map() }) {
  const sweep = (now) => {
    for (const [key, stamps] of store) {
      const alive = stamps.filter((at) => now - at < windowMs);
      if (!alive.length) store.delete(key);
      else store.set(key, alive);
    }
  };
  return function hit(key, now = Date.now()) {
    const recent = (store.get(key) || []).filter((at) => now - at < windowMs);
    if (recent.length >= max) {
      store.set(key, recent);
      return { allowed: false, retryAfter: Math.ceil((windowMs - (now - recent[0])) / 1000) };
    }
    if (store.size >= LIMITER_MAX_KEYS) sweep(now);
    recent.push(now);
    store.set(key, recent);
    return { allowed: true };
  };
}

function clientIp(req, trustProxy) {
  const remote = req.socket.remoteAddress || "unknown";
  if (!trustProxy) return remote;

  // nginx 用 $proxy_add_x_forwarded_for 把真实来源追加在末尾。客户端自己
  // 伪造的 X-Forwarded-For 只会出现在前面，取首个地址等于让调用方自选限流桶。
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded !== "string" || !forwarded.trim()) return remote;
  const parts = forwarded.split(",").map((part) => part.trim()).filter(Boolean);
  const last = parts[parts.length - 1];
  return last && isIP(last) ? last : remote;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl、服务端调用没有 Origin
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// 委托发信走 Bearer，不使用 Cookie：实例是服务端调用，不该带浏览器会话。
function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function cookieHeader(token, { secure, maxAge, name = COOKIE }) {
  const parts = [`${name}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

const ADMIN_ASSETS = {
  "index.html": "text/html; charset=utf-8",
  "admin.js": "text/javascript; charset=utf-8",
  "admin.css": "text/css; charset=utf-8",
};

function tokensFrom(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/[,，、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// 接口自己的版本号，/api/health 与总览用同一个。
const VERSION = "0.3.0";

// 清单里的名称按语种存放；总览是运营视图，优先简体，再英文，最后 id。
function instanceName(instance) {
  const name = instance?.name;
  if (typeof name === "string" && name.trim()) return name;
  if (name && typeof name === "object") {
    return name["zh-CN"] || name.en || name["zh-TW"] || instance?.id || "—";
  }
  return instance?.id || "—";
}

function hostOf(value) {
  try {
    return new URL(String(value)).host.toLowerCase();
  } catch {
    return "";
  }
}

function statSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   store: ReturnType<import("./store.mjs").openStore>,
 *   config: { secret: string, secureCookies?: boolean, trustProxy?: boolean,
 *             sessionDays?: number, adminDir?: string }
 * }} deps
 */
export function createApp({ store, config }) {
  // 生产由 index.mjs 注入；测试或嵌入时没给也不能退化成公开的固定密钥。
  const secret = String(config.secret || "").trim() || randomBytes(32).toString("hex");
  const secureCookies = Boolean(config.secureCookies);
  const trustProxy = Boolean(config.trustProxy);
  const sessionDays = config.sessionDays || 7;
  const adminDir = config.adminDir;
  const submitLimit = createLimiter({ windowMs: 3600_000, max: 8 });
  // 实例每 5–20 秒读一次接通进度：单 IP 每分钟 60 次够用，也不至于能被拿来刷库。
  const progressLimit = createLimiter({ windowMs: 60_000, max: 60 });
  const loginLimit = createLimiter({ windowMs: 900_000, max: 12 });
  const noticeLimit = createLimiter({ windowMs: 3600_000, max: 30 });
  // 伙伴信按收件地址、收件域名、全站三层限流，避免有人靠刷申请把某个信箱打爆。
  // 上限按「一个真实伙伴走完 收到→验证→补件→通过→签发→交付→上线」留足余量，
  // 同时挡住脚本刷单：单个地址 12 封/24h，单个域名 30 封/24h，全站 200 封/24h。
  const PARTNER_MAIL_LIMITS = { address: 12, domain: 30, global: 200 };
  const partnerAddressLimit = createLimiter({ windowMs: 86400_000, max: PARTNER_MAIL_LIMITS.address });
  const partnerDomainLimit = createLimiter({ windowMs: 86400_000, max: PARTNER_MAIL_LIMITS.domain });
  const partnerGlobalLimit = createLimiter({ windowMs: 86400_000, max: PARTNER_MAIL_LIMITS.global });
  const pageLimit = createLimiter({ windowMs: 900_000, max: 60 });
  // 案例页与领取页的 GET 每个请求都是一次库查询。不限流就能拿它当探键器，
  // 按案例键一枚一枚试过去。只读页面放宽到每分钟 60 次，够正常刷新。
  const pageViewLimit = createLimiter({ windowMs: 60_000, max: 60 });
  // 子域查询是公开接口：给一个按 IP 的宽松上限，够一个人反复敲名字，
  // 又不足以把整个空间枚举一遍。
  const subdomainLimit = createLimiter({ windowMs: 60_000, max: 30 });
  // 登录：一个邮箱 10 分钟最多要 3 枚码，一个 IP 一小时最多 10 次；
  // 换码不等于换 IP，所以 IP 这层挡的是「拿字典刷不同邮箱」。
  const memberCodeLimit = createLimiter({ windowMs: 600_000, max: 3 });
  const memberCodeIpLimit = createLimiter({ windowMs: 3600_000, max: 10 });
  const memberLoginLimit = createLimiter({ windowMs: 900_000, max: 12 });
  const mailer = config.mailer || null;
  // 发信总闸：环境里配好了 SMTP 只是「能发」，控制台那一行才是「现在发不发」。
  // 读库而不是读一个常量：开关改完立刻对接口、CLI、worker 同时生效，不用重启。
  // 没有这一行时按「开」算——老部署升级上来行为不变。
  const mailSwitchOff = () => store.getSetting("mail")?.value === "off";
  const mailOpen = () => Boolean(mailer) && !mailSwitchOff();
  const mailRetryDelays = normalizeRetryDelays(config.mailRetryDelays);
  const adminEmail = String(config.adminEmail || "").trim();
  const origin = String(config.origin || "https://xknot.si").replace(/\/+$/, "");
  const supportUrl = String(config.supportUrl || "").trim();
  const replyTo = String(config.replyTo || "").trim();
  // 归属验证已随「只按子域走」取消：申请时站点还不存在，子域由中枢签发，
  // 没有需要申请人自证的东西。真正的验收在接通阶段（公网 /api/health）。

  // 委托发信：凭据绑定实例，额度按凭据算，另有进程内的分钟级与全站小时级护栏。
  // 清单可能被 `admin-cli publish` 或人工改动，发信时重新读取，避免暂停/新增要等进程重启。
  const staticInstances = Array.isArray(config.instances) ? config.instances : [];
  const readInstances =
    typeof config.instancesProvider === "function" ? config.instancesProvider : () => staticInstances;
  function findInstance(id) {
    const list = readInstances();
    if (!Array.isArray(list)) return null;
    return list.find((item) => item?.id === id) || null;
  }
  const relayMailer = mailer;
  // 环境开关是一道闸：配了 SMTP、且没被 XKNOT_RELAY_ENABLED=0 关掉。
  const relayConfigured = Boolean(config.relay?.enabled) && Boolean(relayMailer);
  // 「环境变量明确关了」与「压根没配这一项」要分开：只有前者会锁住控制台的开关。
  const relayEnvOff = config.relay?.enabled === false;
  // 实际放行还要过控制台那一行：停发信时委托发信一起停，端侧看到 503。
  const relayOpen = () => relayConfigured && mailOpen();
  const relayDefaultLimit = Math.min(Math.max(Number(config.relay?.dailyLimit) || 50, 1), 5000);
  const relayMinuteLimit = createLimiter({ windowMs: 60_000, max: RELAY_LIMITS.perMinute });
  const relayHourLimit = createLimiter({ windowMs: 3600_000, max: RELAY_LIMITS.perHour });
  const healthProvider = typeof config.healthProvider === "function" ? config.healthProvider : () => null;
  const locationsProvider =
    typeof config.locationsProvider === "function" ? config.locationsProvider : () => null;
  // 节点状态文档：ops/node-status.mjs 合成的健康 + 隧道 + 位置 + 流量。
  const statusProvider = typeof config.statusProvider === "function" ? config.statusProvider : () => null;
  // 单个实例近 30 天的入口流量：读 ops/traffic.mjs 写下的日聚合。
  // 与 status.json 里那一行不同，这里给的是每天的趋势与当日明细。
  const trafficProvider = typeof config.trafficProvider === "function" ? config.trafficProvider : () => null;
  const federationProvider =
    typeof config.federationProvider === "function" ? config.federationProvider : () => null;
  const settings = {
    instancesFile: typeof config.instancesFile === "string" ? config.instancesFile : null,
    federationFile: typeof config.federationFile === "string" ? config.federationFile : null,
    profilesDir: typeof config.profilesDir === "string" ? config.profilesDir : null,
    statsDir: typeof config.statsDir === "string" ? config.statsDir : null,
    cardsDir: typeof config.cardsDir === "string" ? config.cardsDir : null,
    locationsFile: typeof config.locationsFile === "string" ? config.locationsFile : null,
  };
  const startedAt = Date.now();

  function readHealth() {
    try {
      const value = healthProvider();
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  // 门户的探测结果：只给状态这一层，不给 checks / notified 这类运营字段。
  //
  // `data/hub.json` 是构建那一刻的采样，重新构建才会更新；这个接口读的是
  // `var/health.json`，每 15 分钟一轮，门户拿它把状态换成当前值。
  function readProbes() {
    const health = readHealth();
    const states = health.instances && typeof health.instances === "object" ? health.instances : {};
    const probes = {};
    for (const [id, state] of Object.entries(states)) {
      if (!state || typeof state !== "object") continue;
      probes[id] = {
        status: typeof state.status === "string" ? state.status : "unknown",
        latencyMs: Number.isFinite(state.latencyMs) ? state.latencyMs : null,
        version: typeof state.version === "string" ? state.version : null,
        lastOkAt: state.lastOkAt || null,
        downSince: state.downSince || null,
        hidden: Boolean(state.hiddenAt),
      };
    }
    return { checkedAt: health.checkedAt || null, probes };
  }

  // 站点位置由 provision worker 按隧道对端写进 var/geoip/locations.json。
  // 读不到就是空表：门户回落到自述区的 region，不编一个位置出来。
  function readLocations() {
    try {
      const value = locationsProvider();
      const locations = value && typeof value.locations === "object" ? value.locations : {};
      return { generatedAt: value?.generatedAt || null, locations };
    } catch {
      return { generatedAt: null, locations: {} };
    }
  }

  // 节点状态：健康、隧道、位置、流量已经由 ops/node-status.mjs 合成一份。
  // 文件不在时返回空表，总览回落到 health/locations 各自的源，不编一个状态出来。
  function readStatus() {
    try {
      const value = statusProvider();
      return value && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  }

  // 入口流量的日聚合。读不到就是没采过：接口回一个没有天的结构，控制台显示提示，
  // 不用 0 冒充「今天没人访问」。
  function readTraffic(id) {
    try {
      const value = trafficProvider(id);
      return value && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  }

  // 联邦名册只给控制台看：账号身份、接入模式、隧道账号与端口。
  function readFederation() {    try {
      const value = federationProvider();
      return value && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  }

  // 站点自述的副本，由 ops/fetch-profile.mjs 写在 var/profiles/{id}.json。
  // 控制台只读它来显示名字；写内容要去实例自己的 /admin。
  function readCachedProfile(id) {
    if (!settings.profilesDir || !id) return null;
    try {
      const payload = JSON.parse(readFileSync(path.join(settings.profilesDir, `${id}.json`), "utf8"));
      return payload && typeof payload === "object" ? payload : null;
    } catch {
      return null;
    }
  }

  function cachedText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  // 委托发信要用实例的公开联系邮箱做默认回信地址。联系方式属于自述区，
  // 清单里只有签发区，所以取回副本时把它拼进判断用的那份实例上。
  function withSite(instance) {
    const site = readCachedProfile(instance?.id)?.site;
    if (!site || typeof site !== "object") return instance;
    return { ...instance, contact: site.contact || null, name: site.name || null };
  }

  function readCachedJson(dir, id) {
    if (!dir || !id) return null;
    try {
      const payload = JSON.parse(readFileSync(path.join(dir, `${id}.json`), "utf8"));
      return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
    } catch {
      return null;
    }
  }

  // 一个标签只要签发过、或正在审核里，就不能再给别人。
  // 拒绝与撤回的单子释放标签：那两个状态下中枢不会去配 DNS。
  function takenLabels() {
    const taken = new Set();
    for (const instance of Array.isArray(readInstances()) ? readInstances() : []) {
      const host = hostOf(instance?.url);
      if (host.endsWith(".xknot.si")) taken.add(host.slice(0, -".xknot.si".length));
    }
    for (const label of store.takenSubdomains()) taken.add(label);
    return taken;
  }

  function instanceOfApplication(application) {
    const list = Array.isArray(readInstances()) ? readInstances() : [];
    const target = String(application?.url || "").replace(/\/+$/, "");
    if (target) {
      const byUrl = list.find((item) => String(item?.url || "").replace(/\/+$/, "") === target);
      if (byUrl) return byUrl;
    }
    const label = String(application?.subdomain || "").trim();
    if (!label) return null;
    return list.find((item) => hostOf(item?.url) === `${label}.xknot.si`) || null;
  }

  // 成员身份只认已通过的申请单：那是站点对外的正式联系地址。
  // 一个邮箱可能交过几张单（换地址、补服务），取第一张还在册的。
  function memberOf(email) {
    for (const application of store.memberApplications(email)) {
      const instance = instanceOfApplication(application);
      if (instance) return { application, instance };
    }
    return null;
  }

  // 邮箱只认一个清洗规则：server/validate.mjs 的 validEmail。
  // 曾经这里复制过同一条正则，改一边忘一边就会漂移。
  function normalizeEmail(value) {
    return validEmail(value);
  }

  // 登录后看到的东西：本站的公开状态、自报的活动计数与橱窗条数。
  // 全部来自中枢已经取回的副本，不再反向请求实例——门户不能借登录拿一份新的探测权。
  function memberOverview({ email, instanceId }) {
    const instance = findInstance(instanceId);
    if (!instance) return null;
    const site = readCachedProfile(instance.id)?.site || {};
    const health = readHealth();
    const probe =
      health?.instances && typeof health.instances[instance.id] === "object" ? health.instances[instance.id] : null;
    const stats = readCachedJson(settings.statsDir, instance.id);
    const cards = readCachedJson(settings.cardsDir, instance.id);
    // 中枢的运营决定：清单里有就有，没有就是没有。这里不补一个默认状态。
    const status = instance.status ?? "";

    return {
      member: {
        email,
        instanceId: instance.id,
        since: instance.since || null,
        tier: instance.tier ?? null,
        status,
      },
      site: {
        name: cachedText(site.name) || instance.id,
        tagline: cachedText(site.tagline) || null,
        intro: cachedText(site.intro) || null,
        logo: cachedText(site.logo) || null,
        url: instance.url || "",
        region: cachedText(site.region) || null,
        timezone: cachedText(site.timezone) || null,
        tags: Array.isArray(site.tags) ? site.tags : [],
      },
      // pending 还没验收，没有任何探测结果可看；suspended / retired 由运营方决定，不展示在线态。
      // 清单缺这一项时按「未知」显示，不要留一个空白徽章。
      health: {
        status:
          status === "pending"
            ? "pending"
            : status !== "active"
              ? status || "unknown"
              : probe?.status || "unknown",
        latencyMs: status === "active" ? probe?.latencyMs ?? null : null,
        lastOkAt: status === "active" ? probe?.lastOkAt ?? null : null,
        version: status === "active" ? probe?.version ?? null : null,
        checkedAt: health?.checkedAt ?? null,
      },
      stats: stats
        ? {
            posts: stats.posts || null,
            accounts: stats.accounts || null,
            authors: stats.authors || null,
            fetchedAt: stats.fetchedAt || null,
          }
        : null,
      cards: Array.isArray(cards?.cards) ? cards.cards.length : 0,
      listed: status === "active",
    };
  }

  // 一个实例的运营配置：名册里的账号信息 + 清单里的签发区与拉取入口。  // 名称、介绍、联系方式不在这里：那是主理人的自述区，中枢只存取回的副本。
  function instanceConfig(instance, member) {
    const tunnel = member?.tunnel && typeof member.tunnel === "object" ? member.tunnel : null;
    const cached = readCachedProfile(instance.id);
    return {
      name: cachedText(cached?.site?.name) || instance.id || "",
      // 签发区照抄清单。清单缺项时留空，控制台显示「—」：那表示中枢还没决定，
      // 不是「免费」或「在线」。
      tier: instance.tier ?? "",
      status: instance.status ?? "",
      host: member?.host || hostOf(instance.url) || "",
      account: member?.id || instance.id || "",
      role: member?.role || null,
      standing: member?.standing || null,
      mode: member?.mode || null,
      tunnel: tunnel
        ? { account: tunnel.account || "", port: Number.isInteger(tunnel.port) ? tunnel.port : null }
        : null,
      listed: member ? Boolean(member.listed) : null,
      since: member?.since || instance.since || null,
      note: member?.note || "",
      // 只读：探测地址由 url 推出，不用手填。编辑表单不提供这一项。
      probeUrl: probeTargetOf(instance, member).url,
      // 只读：自述区的取回入口。内容在实例自己的 /admin 里改。
      profileUrl: instance.url ? `${String(instance.url).replace(/\/$/, "")}/api/federation/profile` : "",
      // 自述区最近一次取回的时刻；null 表示还没收到过。
      profileFetchedAt: cached?.fetchedAt || null,
      statsUrl: instance.statsUrl || null,
      cardsUrl: instance.cardsUrl || null,
    };
  }

  // 总览：一次请求把运营最常看的几组数字拼好，页面不再逐个接口取。
  // 只读清单、探测结果、申请库与发信记录，不碰实例自己的数据。
  function buildOverview() {
    const list = Array.isArray(readInstances()) ? readInstances() : [];
    const health = readHealth();
    const checks = health.instances && typeof health.instances === "object" ? health.instances : {};
    const observed = readLocations().locations;
    // 健康、隧道、位置、流量由 ops/node-status.mjs 合成一份；没有这份文件就回落到各自的源。
    const status = readStatus();
    const statusNodes = status?.nodes && typeof status.nodes === "object" ? status.nodes : {};
    const federation = readFederation();
    const members = Array.isArray(federation?.members) ? federation.members : [];
    const memberById = new Map(members.map((member) => [String(member?.id || ""), member]));
    const memberByHost = new Map(
      members
        .map((member) => [String(member?.host || "").toLowerCase(), member])
        .filter(([host]) => host)
    );

    const rows = list.map((instance) => {
      const probe =
        checks[instance.id] && typeof checks[instance.id] === "object" ? checks[instance.id] : null;
      const node = statusNodes[instance.id] && typeof statusNodes[instance.id] === "object" ? statusNodes[instance.id] : null;
      const pending = instance.status === "pending";
      const paused = instance.status !== "active" && !pending;
      const member =
        memberById.get(String(instance.id)) || memberByHost.get(hostOf(instance.url)) || null;
      // 清单里还是 pending 就是「已收录、未验收」，不拿探测结果说话。
      // 名册里没有这个账号（校验本应拦住）也按未接通展示，避免把脱钩当成在线。
      const probed = Boolean(member) && probeEnabled(instance);
      // 控制台徽章：把「中枢的决定」（status）与「中枢的观测」（探测结果）压成一个
      // 可直接显示的标签，省掉每处界面各判一次。原始两轴仍是 row.status 与
      // row.health，接口不拿这个标签当契约。
      const probeStatus = pending
        ? "pending"
        : paused
          ? "paused"
          : probed
            ? node?.probe?.status || probe?.status || "unknown"
            : "unprobed";
      const location = node?.location || observed[instance.id] || null;
      const cached = readCachedProfile(instance.id);
      return {
        id: instance.id,
        // 名字来自实例自述的副本；还没取回时显示 id。
        name: cachedText(cached?.site?.name) || instanceName(instance),
        url: instance.url || "",
        tier: instance.tier ?? "",
        status: instance.status ?? "",
        regions: cachedText(cached?.site?.region) ? [cachedText(cached.site.region)] : [],
        // 中枢看到的位置：与门户用的是同一份判定（隧道对端 → 出口 IP → 国家）。
        // 控制台把它和自述的 region 并排放，方便看出「档案写的」和「实际在」差在哪。
        location: location?.country
          ? {
              country: location.country,
              at: location.at || null,
              source: location.source || "tunnel",
            }
          : null,
        profileFetchedAt: cached?.fetchedAt || null,
        services: {
          cards: Boolean(instance.cardsUrl),
          stats: Boolean(instance.statsUrl),
        },
        config: instanceConfig(instance, member),
        // 隧道在不在是独立的事实：连着但 /api/health 不通，问题在实例一侧；
        // 隧道本身没连，问题在实例的出口或 sshd 一侧。
        tunnel: node?.tunnel
          ? {
              connected: Boolean(node.tunnel.connected),
              account: node.tunnel.account || null,
              port: Number.isInteger(node.tunnel.port) ? node.tunnel.port : null,
              checkedAt: node.tunnel.checkedAt || null,
            }
          : null,
        // 入口 nginx 观测到的昨日流量；没有采集过就是 null，页面不写 0。
        traffic: node?.traffic
          ? {
              date: node.traffic.date || null,
              requests: Number(node.traffic.requests) || 0,
              bytes: Number(node.traffic.bytes) || 0,
              updatedAt: node.traffic.updatedAt || null,
            }
          : null,
        health: {
          status: probeStatus,
          latencyMs: node?.probe?.latencyMs ?? probe?.latencyMs ?? null,
          lastOkAt: node?.probe?.lastOkAt || probe?.lastOkAt || null,
          error: node?.probe?.error || probe?.error || null,
          downSince: node?.probe?.downSince || probe?.downSince || null,
          hidden: node?.probe ? Boolean(node.probe.hidden) : Boolean(probe?.hiddenAt),
          checkedAt: node?.probe?.checkedAt || health.checkedAt || null,
        },
      };
    });

    const countBy = (status) => rows.filter((row) => row.health.status === status).length;
    const instances = {
      total: rows.length,
      active: rows.filter((row) => row.status === "active").length,
      pending: rows.filter((row) => row.status === "pending").length,
      paused: rows.filter((row) => row.status !== "active" && row.status !== "pending").length,
      up: countBy("up"),
      degraded: countBy("degraded"),
      down: countBy("down"),
      unknown: countBy("unknown"),
      unprobed: countBy("unprobed"),
      hidden: rows.filter((row) => row.health.hidden).length,
      cards: rows.filter((row) => row.services.cards).length,
      stats: rows.filter((row) => row.services.stats).length,
      // 有流量数据的实例、昨天合计的请求与字节。没有采集过就是 0，但 rows 里各自是 null。
      trafficNodes: rows.filter((row) => row.traffic).length,
      trafficRequests: rows.reduce((sum, row) => sum + (row.traffic?.requests || 0), 0),
      trafficBytes: rows.reduce((sum, row) => sum + (row.traffic?.bytes || 0), 0),
      // 只统计采集过的：peers.json 还没生成时不能把每个节点都报成隧道断开。
      tunnelsDown: rows.filter((row) => row.tunnel?.checkedAt && !row.tunnel.connected && row.status === "active").length,
      checkedAt: health.checkedAt || null,
      rows,
    };

    const counts = store.countsByStatus();
    // 已通过但还没写进清单的申请：审核完最容易漏掉的一步。
    const listedHosts = new Set(rows.map((row) => hostOf(row.url)).filter(Boolean));
    const listedIds = new Set(rows.map((row) => String(row.id)));
    const approvedNotListed = store
      .listApplications({ status: "approved", limit: 500 })
      .filter((application) => {
        const host = hostOf(application.url);
        return !(host && listedHosts.has(host)) && !listedIds.has(String(application.subdomain || ""));
      })
      .map((application) => ({
        id: application.id,
        name: application.name,
        address: application.url,
      }));

    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const tokens = store.listRelayTokens();

    return {
      at: new Date().toISOString(),
      runtime: {
        version: VERSION,
        uptimeSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
        dbBytes: statSize(store.file),
      },
      instances,
      federation: {
        hub: federation?.hub || null,
        updatedAt: federation?.updatedAt || null,
        members: members.length,
      },
      applications: {
        counts,
        total: Object.values(counts).reduce((sum, value) => sum + value, 0),
        approvedNotListed,
      },
      mail: {
        // enabled 是「现在发不发」，configured 是「有没有配 SMTP」。两者分开报：
        // 只给一个布尔，控制台分不清「没配 SMTP」与「被总闸关了」。
        enabled: mailOpen(),
        configured: Boolean(mailer),
        switch: mailSwitchOff() ? "off" : "on",
        windowHours: 24,
        ...store.notifyStats(since),
      },
      relay: {
        enabled: relayOpen(),
        configured: relayConfigured,
        // 环境变量单独关掉了代发（XKNOT_RELAY_ENABLED=0）：控制台的开关没关，
        // 但节点侧已经撞墙。面板要把这句说出来，别让人以为代发是好的。
        envOff: relayEnvOff,
        windowHours: 24,
        tokens: tokens.length,
        activeTokens: tokens.filter((token) => !token.revokedAt).length,
        // 每实例开关关掉的那些：凭据还在，只是暂停受理。
        disabled: store.listRelaySwitches().map((row) => row.instanceId),
        ...store.relayStats(since),
      },
      events: store.events(12),
    };
  }

  // 发一封伙伴信或内部信：去重 → 限流 → 发送 → 记日志。
  // 状态迁移类事件靠 (event, case_id, state_version) 唯一索引去重；
  // 运营类事件（签发、交付、上线）不传版本号，允许补发。
  //
  // extra 来自管理员请求（补信的模板变量），必须展开在配置项之前：
  // 反过来就等于让请求体覆盖 origin / replyTo，一封信里的所有链接
  // 可以被指到任意域，回信地址也能被换掉。
  function dispatchMail(eventName, application, extra = {}, { dedupeVersion = null } = {}) {
    // 总闸关着就不排队、不占去重位：打开之后同一件事还能补发一次。
    // 这里不写 notify_log，否则「停发期间的那封信」会变成一个永远 sent 不了的占位。
    if (!mailOpen()) return null;
    let message = null;
    let reserved = null;
    try {
      message = buildMail(eventName, application, {
        ...extra,
        origin,
        adminEmail,
        supportUrl,
        replyTo,
      });
      if (!message || !message.to) return null;
      // Message-ID 先定下来再占位：它要进 notify_log，退信才能对回这一件事。
      // 之后的每次重试都用这一个（收信端按它去重，换一个就等于另一封信）。
      message.messageId = randomBytes(12).toString("hex");
      reserved = store.beginNotify({
        event: eventName,
        caseId: application?.id || null,
        stateVersion: dedupeVersion,
        locale: message.locale,
        toDomain: domainOf(message.to),
        toHash: createHash("sha256").update(message.to.toLowerCase()).digest("hex").slice(0, 16),
        templateVersion: message.templateVersion || TEMPLATE_VERSION,
        messageId: message.messageId,
      });
    } catch (error) {
      // beginNotify 也会抛（锁、磁盘）。它在申请单落库之后才跑，抛出去就是 500，
      // 而客户端重试只会拿到 409 duplicate，永远拿不到案例链接。
      console.error("mail dispatch failed:", eventName, error.message);
      return null;
    }
    if (reserved.duplicate) return { duplicate: true };
    const recipientDomain = domainOf(message.to);
    const recipientHash = createHash("sha256").update(message.to.toLowerCase()).digest("hex").slice(0, 16);

    const isPartner = message.audience === "partner";
    if (isPartner) {
      const addressHit = partnerAddressLimit(recipientHash);
      const domainHit = partnerDomainLimit(recipientDomain);
      const globalHit = partnerGlobalLimit("all");
      if (!addressHit.allowed || !domainHit.allowed || !globalHit.allowed) {
        store.finishNotify(reserved.id, { status: "throttled" });
        return { throttled: true };
      }
    }

    // 同一封信的所有重试用同一个 Message-ID：收信端按它去重。重试时换一个
    // 新 ID，等于告诉对方这是另一封信，同一条通知会真的投两遍。
    deliverWithRetry(message, reserved, eventName);
    return { id: reserved.id, message };
  }

  // 发一封信并在瞬时失败时退避重试。
  //
  // 重试期间那一行 notify_log 一直是 pending：幂等键继续占着，同一事件不会被
  // 另一个触发路径当成「可以再发」而寄出第二封。收尾只有三种结果——sent、
  // failed、skipped；pending 不许留到最后，进程中途退出留下的那些由
  // store.pruneStaleNotifyPending 收回。
  function deliverWithRetry(message, reserved, eventName) {
    let settled = false;
    function settle(status, error = null) {
      if (settled) return;
      settled = true;
      try {
        store.finishNotify(reserved.id, { status, error });
      } catch (failure) {
        // 库已经关了（进程退出或测试收尾）：重试链没必要继续，也改不动这条记录。
        console.error("notify log update failed:", failure.message);
      }
    }

    function attempt(index) {
      // 重试途中总闸被关掉：停在这里，别把一封信送出去。
      if (!mailOpen()) {
        settle("skipped", "mail_switch_off");
        return Promise.resolve();
      }
      return Promise.resolve()
        .then(() => mailer.send(message))
        .then(() => settle("sent"))
        .catch((error) => {
          const wait = mailRetryDelays[index];
          if (isTransientMailError(error) && wait !== undefined) {
            // 只记码与原因：收件地址和正文都不进日志。
            console.warn(
              `mail retry in ${Math.round(wait / 1000)}s:`,
              eventName,
              error.message,
              mailErrorCode(error),
              error.replyText || ""
            );
            const timer = setTimeout(() => {
              attempt(index + 1).catch(() => {});
            }, wait);
            timer.unref?.();
            return;
          }
          settle("failed", mailErrorCode(error));
          console.error("mail failed:", eventName, error.message, mailErrorCode(error), error.replyText || "");
        });
    }

    return attempt(0);
  }

  // 提交即通过：一封信把回执与结果一起说清，另发一封给运营方。
  // 幂等键取申请单的状态版本；想要「显式重发」时走管理员补信接口，
  // 那条路径不传版本号（state_version 为 NULL，唯一索引视作互不相等）。
  function mailApplicationReceived(application) {
    if (!application) return;
    const version = application.stateVersion;
    dispatchMail("partner.approved", application, {}, { dedupeVersion: version });
    // 全站每小时最多 30 封内部告警，防止有人靠刷申请把管理员信箱打爆。
    if (noticeLimit("admin").allowed) {
      dispatchMail("internal.application_new", application, {}, { dedupeVersion: version });
    }
  }

  function currentAdmin(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const admin = store.sessionAdmin(token);
    return admin ? { ...admin, token } : null;
  }

  function currentMember(req) {
    const token = parseCookies(req.headers.cookie)[MEMBER_COOKIE];
    if (!token) return null;
    const session = store.memberSession(token);
    return session ? { ...session, token } : null;
  }

  async function serveAdminFile(req, res, name) {
    if (!adminDir) return send(res, 404, { error: "not_found" });
    const file = name === "" || name === "/" ? "index.html" : name.replace(/^\//, "");
    const type = ADMIN_ASSETS[file];
    if (!type) return send(res, 404, { error: "not_found" });
    try {
      const body = await readFile(path.join(adminDir, file));
      res.writeHead(200, {
        "content-type": type,
        "content-length": body.length,
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
        "referrer-policy": "same-origin",
        "x-frame-options": "DENY",
        "content-security-policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      res.end(body);
    } catch {
      send(res, 404, { error: "not_found" });
    }
  }

  // ---- 委托发信：POST 送一封，GET 查额度 ----
  async function handleRelay(req, res) {
    if (!relayOpen()) return send(res, 503, { error: "relay_unavailable" });

    const token = bearerToken(req);
    if (!token) return send(res, 401, { error: "missing_token" });
    const grant = store.verifyRelayToken(token);
    if (grant.error === "revoked") return send(res, 401, { error: "token_revoked" });
    if (!grant.token) return send(res, 401, { error: "invalid_token" });

    const listed = findInstance(grant.token.instanceId);
    if (!listed) return send(res, 403, { error: "instance_not_listed" });
    if (listed.status !== "active") return send(res, 403, { error: "instance_inactive" });
    // 每实例开关：关掉就只是暂停受理，凭据与额度都还在，打开即恢复。
    // 与 401 token_revoked 分开报，实例侧从状态码就能看出「还该不该等」。
    const gate = store.relaySwitch(grant.token.instanceId);
    if (gate.disabled) return send(res, 403, { error: "relay_disabled" });
    const instance = withSite(listed);

    const limit = Math.min(grant.token.dailyLimit || relayDefaultLimit, relayDefaultLimit);
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();

    if (req.method === "GET") {
      const used = store.relayUsage(grant.token.id, since);
      return send(res, 200, {
        instance: instance.id,
        token: { label: grant.token.label, dailyLimit: limit },
        quota: { windowHours: 24, used, limit, remaining: Math.max(0, limit - used) },
      });
    }

    const burst = relayMinuteLimit(grant.token.id);
    if (!burst.allowed) {
      return send(res, 429, { error: "rate_limited", retryAfter: burst.retryAfter }, {
        "retry-after": String(burst.retryAfter),
      });
    }
    const hourly = relayHourLimit("all");
    if (!hourly.allowed) {
      return send(res, 429, { error: "rate_limited", scope: "hub", retryAfter: hourly.retryAfter }, {
        "retry-after": String(hourly.retryAfter),
      });
    }

    const body = await readJsonBody(req, res);
    if (!body) return;

    const checked = validateRelayRequest(body, { instance, from: relayMailer.from });
    if (!checked.ok) return send(res, 400, { error: "invalid", fields: checked.errors });
    const value = checked.value;

    const meta = {
      instanceId: instance.id,
      tokenId: grant.token.id,
      toDomain: domainOf(value.to),
      toHash: createHash("sha256").update(value.to.toLowerCase()).digest("hex").slice(0, 16),
      subjectLength: [...value.subject].length,
      idemKey: value.idempotencyKey,
      // 退信之后要对回是哪一封：实例只交主题与正文，Message-ID 由这里生成。
      messageId: randomBytes(12).toString("hex"),
    };

    // 先在同一事务里占额度/占幂等键，再 await 发信。检查和写入之间不能有
    // await，否则并发请求会同时通过额度检查，同一幂等键也会寄两次。
    const reserved = store.reserveRelay({ ...meta, sinceIso: since, limit });

    if (reserved.duplicate) {
      return send(res, 200, {
        ok: true,
        duplicate: true,
        pending: reserved.duplicate.pending || undefined,
        delivery: reserved.duplicate,
      });
    }

    if (reserved.error === "quota_exceeded") {
      return send(
        res,
        429,
        {
          error: "quota_exceeded",
          quota: { windowHours: 24, used: reserved.used, limit: reserved.limit, remaining: 0 },
        },
        { "retry-after": "3600" }
      );
    }

    try {
      await relayMailer.send(relayMessage(value, { instance, messageId: meta.messageId }));
    } catch (error) {
      const smtp = mailErrorCode(error);
      store.finishRelay(reserved.id, { status: "failed", error: smtp });
      console.error("relay failed:", instance.id, error.message, smtp, error.replyText || "");
      // 4xx 是收信端说「慢一点」。实例拿这个头决定等多久，别立刻用同一个
      // 幂等键撞回来——那只会让流控一直续着。
      if (isTransientMailError(error)) {
        return send(
          res,
          502,
          { error: "smtp_failed", transient: true, smtp },
          { "retry-after": String(RELAY_TRANSIENT_RETRY_SECONDS) }
        );
      }
      return send(res, 502, { error: "smtp_failed", smtp });
    }

    store.finishRelay(reserved.id, { status: "accepted" });
    return send(res, 200, {
      ok: true,
      delivery: { id: reserved.id, at: reserved.at, toDomain: meta.toDomain },
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const route = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method;

    // ---- 伙伴页面：只读渲染，不消费令牌 ----

    const casePage = /^\/case\/([A-Za-z0-9_-]{6,64})$/.exec(route);
    if (casePage && (method === "GET" || method === "HEAD")) {
      if (!pageViewLimit(ipHash(clientIp(req, trustProxy), secret)).allowed) {
        return sendHtml(res, 429, renderCasePage(null, { rateLimited: true }));
      }
      const application = store.findByCaseKey(casePage[1]);
      const keyState = url.searchParams.get("key");
      const result = {
        publicKey: keyState === "1" ? "saved" : keyState || undefined,
        withdrawn: url.searchParams.get("withdrawn") === "1" ? 1 : undefined,
      };
      return sendHtml(res, application ? 200 : 404, renderCasePage(application, result));
    }

    const claimPage = /^\/claim\/([A-Za-z0-9_-]{8,128})$/.exec(route);
    if (claimPage && (method === "GET" || method === "HEAD")) {
      if (!pageViewLimit(ipHash(clientIp(req, trustProxy), secret)).allowed) {
        return sendHtml(res, 429, renderClaimResult("rate_limited", null, "zh-CN"));
      }
      return sendHtml(res, 200, renderClaimPage(claimPage[1], null, "zh-CN"));
    }

    if (route.startsWith("/admin")) {
      if (method !== "GET" && method !== "HEAD") {
        return send(res, 405, { error: "method_not_allowed" });
      }
      return serveAdminFile(req, res, route.slice("/admin".length) || "/");
    }

    // 只回 GET/HEAD：/api/ 下其余端点在非 GET/POST 时一律 405，
    // 健康检查不能因为落在方法检查之前就成了「什么方法都 200」。
    if (route === "/api/health" && (method === "GET" || method === "HEAD")) {
      return send(res, 200, {
        ok: true,
        service: "xknot-hub",
        version: VERSION,
        at: new Date().toISOString(),
      });
    }

    // 路径在、方法不对，就是 405。不接这一段的话 POST /api/health 会一路落到
    // 下面的「要管理员会话」，回 401——把方法错误说成没登录，调用方会去修凭据。
    if (route === "/api/health") return send(res, 405, { error: "method_not_allowed" });

    if (!route.startsWith("/api/")) return send(res, 404, { error: "not_found" });

    if (method !== "GET" && method !== "POST") {
      return send(res, 405, { error: "method_not_allowed" });
    }

    // ---- 公开：每个实例现在在哪（观测值，不是自述） ----
    //
    // 位置取隧道对端的出口 IP，由 provision worker 判定后写进 var/geoip。只给
    // 国家码，不给 IP：门户要的是区域，不是把谁的宽带地址挂到公网上。
    // 没有这条数据时返回空表，页面回落到实例自己写的 region。

    if (route === "/api/locations" && method === "GET") {
      return send(res, 200, readLocations(), { "cache-control": "no-store" });
    }

    // ---- 公开：每个实例现在的探测结果 ----
    //
    // 快照里的 health 是构建那一刻的采样：一次短暂掉线如果正好碰上部署，
    // 会一直挂在门户上直到下一次构建。页面另取这一份覆盖状态，位置同理。

    if (route === "/api/probes" && method === "GET") {
      return send(res, 200, readProbes(), { "cache-control": "no-store" });
    }

    // 同源检查放在最前：跨站表单、跨站脚本都进不来。
    if (method === "POST" && !sameOrigin(req)) {
      return send(res, 403, { error: "cross_origin" });
    }

    // ---- 联邦：实例委托发信（Bearer 鉴权，不看 Cookie）----

    if (route === "/api/federation/mail") return handleRelay(req, res);

    // ---- 公开：一个子域标签能不能签 ----
    //
    // 端侧只展示这个结论。查重把清单与未结案的申请单一起算：审核中的标签
    // 如果显示「可用」，用户会以为还有机会，提交后却被拒。

    if (route === "/api/subdomains/check" && method === "GET") {
      const hit = subdomainLimit(ipHash(clientIp(req, trustProxy), secret));
      if (!hit.allowed) {
        return send(
          res,
          429,
          { error: "rate_limited", retryAfter: hit.retryAfter },
          { "retry-after": String(hit.retryAfter) }
        );
      }
      const input = url.searchParams.get("label") || "";
      const taken = takenLabels();
      const result = checkLabel(input, { taken });
      return send(res, 200, {
        label: result.label,
        available: result.available,
        reason: result.reason,
        min: SUBDOMAIN_MIN,
        suggestions: result.available ? [] : suggestLabels(input, { taken }),
      });
    }

    // ---- 成员入口：邮箱 + 一次性授权码 ----

    if (route === "/api/member/code" && method === "POST") {
      // 没有发信能力时明确说一句：否则用户会一直等一封不会来的信。
      if (!mailOpen()) return send(res, 503, { error: "mail_unavailable" });

      const ip = clientIp(req, trustProxy);
      const ipHit = memberCodeIpLimit(ipHash(ip, secret));
      if (!ipHit.allowed) {
        return send(
          res,
          429,
          { error: "rate_limited", retryAfter: ipHit.retryAfter },
          { "retry-after": String(ipHit.retryAfter) }
        );
      }

      const body = await readJsonBody(req, res);
      if (!body) return;

      const email = normalizeEmail(body.email);
      if (!email) return send(res, 400, { error: "invalid_email" });

      const emailHit = memberCodeLimit(ipHash(`email:${email}`, secret));
      if (!emailHit.allowed) {
        return send(
          res,
          429,
          { error: "rate_limited", retryAfter: emailHit.retryAfter },
          { "retry-after": String(emailHit.retryAfter) }
        );
      }

      // 不是成员也回同一句话：这个接口不能变成「某某邮箱是不是成员」的探测器。
      const match = memberOf(email);
      if (match) {
        const issued = store.issueMemberCode({
          email,
          instanceId: match.instance.id,
          ttlMinutes: MEMBER_CODE_TTL,
        });
        if (!issued.error) {
          const message = memberCodeMail({
            email,
            code: issued.code,
            ttlMinutes: MEMBER_CODE_TTL,
            locale: body.locale || match.application.locale || "zh-CN",
          });
          Promise.resolve()
            .then(() => mailer.send(message))
            .catch((error) => console.error("member code mail failed:", error.message));
        }
      }

      return send(res, 202, { status: "sent", ttlMinutes: MEMBER_CODE_TTL });
    }

    if (route === "/api/member/session" && method === "POST") {
      const ip = clientIp(req, trustProxy);
      const hit = memberLoginLimit(ipHash(ip, secret));
      if (!hit.allowed) {
        return send(
          res,
          429,
          { error: "rate_limited", retryAfter: hit.retryAfter },
          { "retry-after": String(hit.retryAfter) }
        );
      }

      const body = await readJsonBody(req, res);
      if (!body) return;

      const email = normalizeEmail(body.email);
      const code = String(body.code || "").replace(/\s+/g, "");
      if (!email || !/^[0-9]{6}$/.test(code)) return send(res, 400, { error: "invalid_code" });

      const result = store.consumeMemberCode({ email, code });
      if (result.error === "expired") return send(res, 401, { error: "invalid_code", reason: "expired" });
      if (result.error === "too_many_attempts") {
        return send(res, 429, { error: "invalid_code", reason: "too_many_attempts" });
      }
      if (result.error) return send(res, 401, { error: "invalid_code", reason: "mismatch" });

      const overview = memberOverview(result);
      if (!overview) return send(res, 403, { error: "not_member" });

      store.pruneMemberSessions();
      const session = store.createMemberSession({
        email: result.email,
        instanceId: result.instanceId,
        days: MEMBER_SESSION_DAYS,
      });
      return send(
        res,
        200,
        {
          session: { email: result.email, instanceId: result.instanceId, expiresAt: session.expiresAt },
          overview,
        },
        {
          "set-cookie": cookieHeader(session.token, {
            secure: secureCookies,
            maxAge: MEMBER_SESSION_DAYS * 86400,
            name: MEMBER_COOKIE,
          }),
        }
      );
    }

    if (route === "/api/member/session" && method === "GET") {
      const member = currentMember(req);
      if (!member) return send(res, 401, { error: "unauthenticated" });
      const overview = memberOverview(member);
      if (!overview) {
        // 站点被移出名册后，旧会话不该继续显示一份冻结的数据。
        store.deleteMemberSession(member.token);
        return send(res, 401, { error: "unauthenticated" });
      }
      return send(res, 200, {
        session: { email: member.email, instanceId: member.instanceId, expiresAt: member.expiresAt },
        overview,
      });
    }

    if (route === "/api/member/logout" && method === "POST") {
      const member = currentMember(req);
      if (member) store.deleteMemberSession(member.token);
      return send(
        res,
        200,
        { ok: true },
        {
          "set-cookie": cookieHeader("", {
            secure: secureCookies,
            maxAge: 0,
            name: MEMBER_COOKIE,
          }),
        }
      );
    }

    // ---- 伙伴：案例页上的动作 ----

    const caseAction = /^\/api\/case\/([A-Za-z0-9_-]{6,64})\/(withdraw|public-key)$/.exec(route);
    if (caseAction && method === "POST") {
      const [, key, action] = caseAction;
      const application = store.findByCaseKey(key);
      if (!application) return sendHtml(res, 404, renderCasePage(null));
      const limited = pageLimit(ipHash(`${clientIp(req, trustProxy)}|${key}`, secret));
      if (!limited.allowed) return sendHtml(res, 429, renderCasePage(application));

      if (action === "withdraw") {
        const result = store.withdrawApplication(application.id);
        if (result.error) return sendHtml(res, 409, renderCasePage(application));
        res.writeHead(303, { location: `/case/${key}?withdrawn=1`, "cache-control": "no-store" });
        return res.end();
      }

      if (action === "public-key") {
        // 这两条路径回的是 HTML 页面，不是 JSON，所以不走 readJsonBody：
        // 超限与坏 JSON 都落到同一个「这不是一份可用的公钥」结果上（页面上是 key=invalid），
        // 不为了 413 再多一种页面状态。
        const body = await readBody(req);
        // 校验只在 validate.mjs 一处：这里、store.setPublicKey、provision 写
        // authorized_keys 之前都过同一个函数，不再各写一条正则。
        // 失败不能静默 303 回一个「什么都没发生」的页面：改前改后长得一样，
        // 用户只会以为存上了。三种失败分别带一个标记回案例页。
        const text = body.error ? "" : normalizePublicKey(body.publicKey);
        if (!text) {
          res.writeHead(303, { location: `/case/${key}?key=invalid`, "cache-control": "no-store" });
          return res.end();
        }
        const saved = store.setPublicKey({ id: application.id, publicKey: text });
        const state = saved.error ? (saved.error === "not_approved" ? "closed" : "invalid") : "1";
        res.writeHead(303, { location: `/case/${key}?key=${state}`, "cache-control": "no-store" });
        return res.end();
      }
    }

    // ---- 伙伴：接通进度 ----
    //
    // 实例在 NAT 后，中枢拨不进去；它按案例键来读这份进度，顺带取回交接参数。
    // 案例键本身就是能力凭据（和案例页同一个），所以不再另发令牌。
    // 只读，不含公钥与邮箱。
    const progress = /^\/api\/case\/([A-Za-z0-9_-]{6,64})\/progress$/.exec(route);
    if (progress && method === "GET") {
      const limited = progressLimit(ipHash(clientIp(req, trustProxy), secret));
      if (!limited.allowed) return send(res, 429, { error: "rate_limited", retryAfter: limited.retryAfter });
      const application = store.findByCaseKey(progress[1]);
      if (!application) return send(res, 404, { error: "not_found" });

      const run = store.getProvisionRun(application.id);
      const ready = run && (run.state === "awaiting_tunnel" || run.state === "active");
      // 接入件要的三样事实（id、地址、档位）在这里给全，实例就不必自己猜。
      // 认实例要和别处同一个口径（url 主机优先），不能用子域标签当 id：
      // 清单的 id 是签发时按主机名推的，edit.mjs 又允许改 url，两者会分叉。
      const listed = instanceOfApplication(application);
      return send(res, 200, {
        application: {
          id: application.id,
          name: application.name,
          status: application.status,
          subdomain: application.subdomain,
          url: application.url,
        },
        issued: {
          id: application.subdomain || "",
          url: application.url || "",
          // 签发区只从清单取。清单里还没有这一条时就留空：这一份是回执，
          // 不是中枢重新做一次决定的地方。
          tier: listed?.tier ?? "",
          since: listed?.since ?? "",
          status: listed?.status ?? "",
        },
        run: run
          ? {
              state: run.state,
              steps: run.steps,
              lastError: run.lastError,
              updatedAt: run.updatedAt,
            }
          : null,
        // 账号与端口只在该节点资料都就绪后给出；隧道要用的就是这三样。
        handoff: ready
          ? { host: run.entryHost, account: run.account, port: run.port }
          : null,
      });
    }

    // ---- 伙伴：一次性领取 ----

    if (route === "/api/claim" && method === "POST") {
      // 限流放在读体之前：先按体大小做一次内存分配再判限流，等于把限流器
      // 挡不住的那部分成本照单全收。
      const limited = pageLimit(ipHash(clientIp(req, trustProxy), secret));
      if (!limited.allowed) return sendHtml(res, 429, renderClaimResult("rate_limited", null, "zh-CN"));
      const body = await readBody(req);
      // 回的是领取结果页，不是 JSON，所以不走 readJsonBody。任何读体的失败
      // 都按「这个令牌用不了」处理：它是能力凭据，页面不该因为 413 而透露
      // 「令牌本身可能有效、只是体太大」。
      const result = body.error
        ? { error: "missing" }
        : store.consumeClaimToken(body.token);
      if (result.error === "missing") return sendHtml(res, 404, renderClaimResult("missing", null, "zh-CN"));
      if (result.error === "not_found") return sendHtml(res, 404, renderClaimResult("missing", null, "zh-CN"));
      if (result.error === "expired") return sendHtml(res, 410, renderClaimResult("expired", null, "zh-CN"));
      // 作废是运营方收回的：说清楚去要最新一封交付信，别让伙伴以为资料被自己弄丢了。
      if (result.error === "revoked") return sendHtml(res, 410, renderClaimResult("revoked", null, "zh-CN"));
      if (result.error === "already_used") return sendHtml(res, 409, renderClaimResult("used", null, "zh-CN"));
      // 申请撤回后令牌一并失效：这份链接对应的单已经不在办了，按「找不到」回。
      if (result.error === "application_closed") {
        return sendHtml(res, 404, renderClaimResult("missing", null, "zh-CN"));
      }
      return sendHtml(res, 200, renderClaimResult("ok", result.payload, "zh-CN"));
    }

    // ---- 公开：提交申请 ----

    if (route === "/api/applications" && method === "POST") {
      const ip = clientIp(req, trustProxy);
      const limit = submitLimit(ipHash(ip, secret));
      if (!limit.allowed) {
        return send(res, 429, { error: "rate_limited", retryAfter: limit.retryAfter }, {
          "retry-after": String(limit.retryAfter),
        });
      }

      const body = await readJsonBody(req, res);
      if (!body) return;

      // 表单里藏了一个正常用户看不见的字段，填了就当机器人，直接回成功。
      if (typeof body.website === "string" && body.website.trim() !== "") {
        return send(res, 201, { application: { id: "XK-DISCARDED", status: "approved" } });
      }

      const checked = validateApplication(body);
      if (!checked.ok) return send(res, 400, { error: "invalid", fields: checked.errors });

      // 同一个子域只留一条有效申请；撤回之后可以重新提交。
      // 预检只是提前给个准话，真正的裁决是库里的唯一索引——预检与插入之间
      // 没有锁，另一个进程可以先插进来。
      const duplicate = store.findOpenBySubdomain(checked.value.subdomain);
      if (duplicate) return send(res, 409, { error: "duplicate" });

      const services = tokensFrom(body.services).filter((item) =>
        ["relay", "cards", "stats"].includes(item)
      );
      const application = store.createApplication({
        ...checked.value,
        locale: typeof body.locale === "string" ? body.locale.slice(0, 12) : null,
        ipHash: ipHash(ip, secret),
        requestServices: services,
      });
      if (application.error === "duplicate") return send(res, 409, { error: "duplicate" });
      if (application.error) return send(res, 500, { error: "apply_failed" });

      // 提交即通过；没有 SMTP 时只是入队，申请本身已经结案。
      mailApplicationReceived(application);

      return send(res, 201, {
        application: {
          id: application.id,
          status: application.status,
          createdAt: application.createdAt,
          caseUrl: application.caseKey ? `${origin}/case/${application.caseKey}` : undefined,
        },
      });
    }

    // ---- 管理：登录 ----

    if (route === "/api/admin/login" && method === "POST") {
      const ip = clientIp(req, trustProxy);
      const limit = loginLimit(ipHash(ip, secret));
      if (!limit.allowed) {
        return send(res, 429, { error: "rate_limited", retryAfter: limit.retryAfter }, {
          "retry-after": String(limit.retryAfter),
        });
      }

      const body = await readJsonBody(req, res);
      if (!body) return;
      if (typeof body.username !== "string" || typeof body.password !== "string") {
        return send(res, 400, { error: "invalid" });
      }
      // 限流桶的键必须与查库用的账号同一个归一化：用 body.username 原样小写的话，
      // 「admin 」和「admin」是两个桶，同一个账号的每账号 12 次就形同虚设。
      const usernameKey = createHash("sha256").update(normalizeUsername(body.username)).digest("hex");
      if (!loginLimit(`user:${usernameKey}`).allowed) {
        return send(res, 429, { error: "rate_limited", retryAfter: 900 });
      }

      const admin = store.verifyAdmin({ username: body.username, password: body.password });
      if (!admin) return send(res, 401, { error: "bad_credentials" });

      store.pruneSessions();
      const session = store.createSession(admin.id, sessionDays);
      return send(
        res,
        200,
        { admin: { username: admin.username } },
        {
          "set-cookie": cookieHeader(session.token, { secure: secureCookies, maxAge: sessionDays * 86400 }),
        }
      );
    }

    if (route === "/api/admin/logout" && method === "POST") {
      const admin = currentAdmin(req);
      if (admin) store.deleteSession(admin.token);
      return send(res, 200, { ok: true }, { "set-cookie": cookieHeader("", { secure: secureCookies, maxAge: 0 }) });
    }

    if (route === "/api/admin/session" && method === "GET") {
      const admin = currentAdmin(req);
      if (!admin) return send(res, 401, { error: "unauthenticated" });
      return send(res, 200, { admin: { username: admin.username } });
    }

    // 以下都要管理员。

    const admin = currentAdmin(req);
    if (!admin) return send(res, 401, { error: "unauthenticated" });

    // 控制台首页用的汇总：实例与探测、申请记录、发信与最近事件。
    if (route === "/api/admin/overview" && method === "GET") {
      return send(res, 200, buildOverview());
    }

    // 发信总闸。只有两个取值，落库而不是改配置：改完立刻生效，不用登机器、
    // 不用改 env、不用重启。要回到「按环境变量的默认值」，清掉这一行即可。
    if (route === "/api/admin/mail" && method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      if (typeof body.enabled !== "boolean") return send(res, 400, { error: "invalid" });
      const result = store.setSetting("mail", body.enabled ? "on" : "off", admin.username);
      if (result.error) return send(res, 500, { error: result.error });
      return send(res, 200, { ok: true, mail: { enabled: mailOpen(), switch: body.enabled ? "on" : "off" } });
    }

    // 改实例配置：清单字段与名册字段一起提交，先校验整份文件再原子写回。
    const instanceConfig = /^\/api\/admin\/instances\/([a-z0-9][a-z0-9-]{0,30}[a-z0-9])\/config$/.exec(route);
    if (instanceConfig && method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;

      const result = await updateInstanceConfig({
        instancesFile: settings.instancesFile,
        federationFile: settings.federationFile,
        id: instanceConfig[1],
        instance: body.instance,
        member: body.member,
      });
      if (result.error === "editing_unavailable") {
        return send(res, 503, { error: "editing_unavailable" });
      }
      if (result.error === "manifest_unreadable" || result.error === "roster_unreadable") {
        return send(res, 500, { error: result.error });
      }
      if (result.error === "not_found") return send(res, 404, { error: "not_found" });
      if (result.error === "invalid") return send(res, 400, { error: "invalid", fields: result.fields });

      store.recordEvent("instance.updated", instanceConfig[1], admin.username);
      return send(res, 200, { ok: true });
    }

    // 展开实例时看入口流量：近 30 天的日聚合，加上每天的状态码、缓存、延迟与 Top 列表。
    // 只读；清单里没有的 id 回 404，不拿文件名去拼任意路径。
    const instanceTraffic = /^\/api\/admin\/instances\/([a-z0-9][a-z0-9-]{0,30}[a-z0-9])\/traffic$/.exec(route);
    if (instanceTraffic && method === "GET") {
      const id = instanceTraffic[1];
      const instance = findInstance(id);
      if (!instance) return send(res, 404, { error: "not_found" });
      const view = summarizeTraffic(readTraffic(id));
      return send(res, 200, {
        id,
        // 以日志里记录的 host 为准：它才是流量真正落在哪个子域上，
        // 清单地址变了（或带端口）也不至于对不上聚合文件。
        host: view?.host || hostOf(instance.url) || "",
        updatedAt: view?.updatedAt || null,
        days: view?.days || [],
        totals: view?.totals || null,
      });
    }

    if (route === "/api/admin/applications" && method === "GET") {
      const status = url.searchParams.get("status");
      const wanted = status && status !== "all" ? status : null;
      if (wanted && !["approved", "withdrawn", "rejected", "expired"].includes(wanted)) {
        return send(res, 400, { error: "invalid_status" });
      }
      return send(res, 200, {
        applications: store.listApplications({ status: wanted }),
        counts: store.countsByStatus(),
      });
    }

    const adminCase = /^\/api\/admin\/applications\/([A-Za-z0-9-]+)$/.exec(route);
    if (adminCase && method === "GET") {
      const application = store.getApplication(adminCase[1]);
      if (!application) return send(res, 404, { error: "not_found" });
      return send(res, 200, { application });
    }

    if (route === "/api/admin/notify-log" && method === "GET") {
      const limit = Number(url.searchParams.get("limit")) || 50;
      return send(res, 200, { entries: store.listNotifyLog(limit, url.searchParams.get("case") || null) });
    }

    // 自动接通的进度：控制台只读。真正的推进在 xknot-provision 常驻进程里。
    if (route === "/api/admin/provision" && method === "GET") {
      return send(res, 200, { runs: store.listProvisionRuns(50) });
    }

    // 补发/重发伙伴信。运营类事件不传版本号，允许人工补寄。
    const notifyRoute = /^\/api\/admin\/applications\/([A-Za-z0-9-]+)\/notify$/.exec(route);
    if (notifyRoute && method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const application = store.getApplication(notifyRoute[1]);
      if (!application) return send(res, 404, { error: "not_found" });
      const event = String(body.event || "");
      if (!ALL_EVENTS.includes(event)) return send(res, 400, { error: "unknown_event" });
      // 交付信的全部作用是那条一次性链接；补发时手上没有链接，寄出去的就是
      // 一封让伙伴点空的信。交付走 handoff：它重签链接并作废旧链接。
      if (event === "partner.handoff") return send(res, 409, { error: "use_handoff" });

      const result = dispatchMail(event, application, { ...body.context }, {});
      if (!result) return send(res, 503, { error: "mail_unavailable" });
      if (result.duplicate) return send(res, 200, { ok: true, duplicate: true });
      if (result.throttled) return send(res, 429, { error: "throttled" });
      return send(res, 200, {
        ok: true,
        event,
        to: result.message?.to,
      });
    }

    // 交付：把接入资料写进一次性领取令牌，再把链接寄给主理人。
    const handoff = /^\/api\/admin\/applications\/([A-Za-z0-9-]+)\/handoff$/.exec(route);
    if (handoff && method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const application = store.getApplication(handoff[1]);
      if (!application) return send(res, 404, { error: "not_found" });
      if (application.status !== "approved") return send(res, 409, { error: "not_approved" });

      const payload = String(body.payload || "").trim();
      if (!payload) return send(res, 400, { error: "invalid", fields: { payload: "required" } });
      if (payload.length > 8000) return send(res, 413, { error: "too_large" });
      // 信发不出去时别先把领取令牌造出来：链接只存在于库里，谁也拿不到，
      // 还占着一份已经轮换过的资料。
      if (!mailOpen()) return send(res, 503, { error: "mail_unavailable" });

      const ttlHours = Math.min(Math.max(Number(body.ttlHours) || 72, 1), 168);
      // 重发即作废：上一封信里的链接不该还能换出资料。新签与作废在同一个事务里。
      const claim = store.rotateClaimToken({
        applicationId: application.id,
        payload,
        ttlHours,
        createdBy: admin.username,
      });
      if (claim.error) return send(res, 400, { error: claim.error });

      const links = { claimUrl: `${origin}/claim/${claim.token}` };
      const result = dispatchMail(
        "partner.handoff",
        application,
        { ...body.context, links, claimTtlHours: ttlHours },
        {}
      );
      if (!result) {
        store.revokeClaimTokens(claim.id);
        return send(res, 503, { error: "mail_unavailable" });
      }
      if (result.throttled) {
        store.revokeClaimTokens(claim.id);
        return send(res, 429, { error: "throttled" });
      }

      return send(res, 200, {
        ok: true,
        claim: { id: claim.id, expiresAt: claim.expiresAt, revoked: claim.revoked.length },
        claimUrl: links.claimUrl,
      });
    }

    const manifest = /^\/api\/admin\/applications\/([A-Za-z0-9-]+)\/manifest$/.exec(route);
    if (manifest && method === "GET") {
      const application = store.getApplication(manifest[1]);
      if (!application) return send(res, 404, { error: "not_found" });
      const entry = toManifestEntry(application);
      const problems = checkManifestEntry(entry);
      if (problems.length) return send(res, 422, { error: "manifest_invalid", problems });
      return send(res, 200, { entry });
    }

    return send(res, 404, { error: "not_found" });
  }

  return { handle, COOKIE, ipHash: (ip) => ipHash(ip, secret) };
}

export { LIMITS, normalizeLocale };

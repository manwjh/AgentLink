// 签发之后的自动接通：中枢在入口主机上把前置一次做完。
//
// 这里只做三件事：算出这一步要做什么、把它渲染成确定的文本、执行一步。
// 不做 HTTP、不读时钟、不碰数据库；worker 负责轮询与记录，CLI 负责手动补跑。
//
// 每一步都必须是幂等的：重跑一次的结果与第一次相同，已有的账号、目录、配置不重建。
// 所以所有写入都用「先看再写」，所有系统命令都用参数数组，不拼 shell 字符串。
//
// 顺序是按依赖排的，不是按时间：
//   allocate → publish → account → sshd → static → dns → vhost → tls
// 收尾的 two 步（探测 / 改 active）在 worker 里，因为它们要等伙伴起隧道。

import { createHash } from "node:crypto";
import { isIP } from "node:net";

import { normalizePublicKey } from "./validate.mjs";

/**
 * 步骤表：顺序、失败上限、执行函数写在同一条里。
 *
 * 这三件事以前分在三处：顺序一个数组、上限另一个 Map、实现在 runStep 里一段没有
 * 名字的 if 链。加一步要同时改三处，漏掉任何一处都不报错：只是那一步永远不重试，
 * 或者表里有名字却没人执行。现在加一步就是加一条，顺序、上限、实现同时到位，
 * `STEP_ORDER` 与 `attemptCapOf` 都从这一份推出来。
 *
 *   attemptCap  连续失败几次就不再自动重试（0 = 一直重试）。
 *               只有会在外部系统留下配额痕迹的步骤才设上限，理由见 RETRY_BACKOFF_MS。
 *
 * 执行函数声明在文件下半部分（函数声明会提升，所以这里能先引用）。
 */
const STEPS = [
  { id: "allocate", attemptCap: 0, run: runAllocate },
  { id: "publish", attemptCap: 0, run: runPublish },
  { id: "account", attemptCap: 0, run: runAccount },
  { id: "sshd", attemptCap: 0, run: runSshd },
  { id: "static", attemptCap: 0, run: runStatic },
  { id: "dns", attemptCap: 0, run: runDns },
  { id: "vhost", attemptCap: 0, run: runVhost },
  // 证书：Let's Encrypt 对同一主机名的失败授权限制是每小时 5 次。
  { id: "tls", attemptCap: 5, run: runTls },
];

const STEP_BY_ID = new Map(STEPS.map((step) => [step.id, step]));

export const STEP_ORDER = STEPS.map((step) => step.id);

/** 未知 id 按 0 处理：老 run 里可能留着已删掉的步骤，重试节拍不该因此炸掉。 */
const attemptCapOf = (id) => STEP_BY_ID.get(id)?.attemptCap || 0;

const FIRST_PORT = 18090;
const LAST_PORT = 18190;

// 失败后的重试节拍（毫秒）。按步独立计数，成功即清零。
//
// 不这么做的话，20 秒的轮询间隔会变成「每 20 秒重跑一次失败的那一步」：本机步骤
// 只是白跑，证书那一步会真的把自己锁死——Let's Encrypt 对同一主机名的失败授权
// 限制是每小时 5 次，持续失败半小时就要等几个小时才能再签，而面板上始终只有一个
// tls_failed，看不出是被限流还是配置错了。起步比通知链（1 / 5 / 30 分钟）紧一档：
// 刚签发时的失败多是等 DNS 生效，等一小时太长。
export const RETRY_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

// 入口侧做完之后等隧道的默认上限。超过这个时长只记一次事件，不反复喊。
export const AWAITING_TIMEOUT_MS = 30 * 60_000;

export class ProvisionError extends Error {
  constructor(code, detail = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

export function freshSteps() {
  return STEP_ORDER.map((id) => ({
    id,
    state: "pending",
    at: null,
    error: null,
    note: null,
    // 这一步连续失败了几次、下一次最早什么时候再试。节拍见 RETRY_BACKOFF_MS。
    attempts: 0,
    nextAt: null,
  }));
}

/** 公钥换了就要重装。只存短指纹：够判等，不需要在 run 里留一份公钥。 */
export function keyFingerprint(publicKey) {
  const value = String(publicKey || "").trim();
  if (!value) return null;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function createRun({ application, tunnel, entryHost, now = new Date() }) {
  const host = new URL(application.url).hostname;
  const stamp = now.toISOString();
  return {
    applicationId: application.id,
    instanceId: application.subdomain || host.split(".")[0],
    host,
    account: tunnel.account,
    port: tunnel.port,
    entryHost,
    publicKeyHash: keyFingerprint(application.publicKey),
    state: "provisioning",
    steps: freshSteps(),
    attempts: 0,
    lastError: null,
    tunnelConfirmedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/** 伙伴在案例页重新贴了公钥：账号里那份旧的就作废了，从 account 起重跑。 */
export function refreshKeySteps(run, application, now = new Date()) {
  const from = STEP_ORDER.indexOf("account");
  return {
    ...run,
    publicKeyHash: keyFingerprint(application.publicKey),
    state: "provisioning",
    steps: run.steps.map((step, index) =>
      index >= from
        ? { ...step, state: "pending", at: null, error: null, note: null, attempts: 0, nextAt: null }
        : step
    ),
    updatedAt: now.toISOString(),
  };
}

export function keyChanged(run, application) {
  const next = keyFingerprint(application.publicKey);
  return Boolean(next) && next !== run.publicKeyHash;
}

/** 下一个还没完成的步骤；全部完成时返回 null。 */
export function pendingStep(run) {
  return (run.steps || []).find((step) => step.state !== "done" && step.state !== "skipped") || null;
}

/**
 * 下一个「现在可以执行」的步骤：还没完成的、且不在退避窗口里的。
 *
 * 与 pendingStep 的分工要分清：pendingStep 回答「还有没有活」，dueStep 回答
 * 「现在该不该干」。worker 用后者推进，用前者判断是不是真的全做完了——
 * 只剩退避中的步骤时，两者一个给 null 一个给非 null，正是「等一会儿再试」
 * 与「可以去等隧道了」的差别。
 */
export function dueStep(run, now = new Date()) {
  const step = pendingStep(run);
  if (!step) return null;
  const at = Date.parse(step.nextAt || "");
  if (Number.isFinite(at) && at > now.getTime()) return null;
  return step;
}

/**
 * 入口侧做完之后，等隧道等过头了没有。
 *
 * 只看「上一次推进」到现在过了多久：隧道通了会进 active，所以这个状态本身
 * 就说明对方没来拉参数（或拉了没连上）。stallNotifiedAt 保证一个停滞只喊一次。
 */
export function isStalled(run, { now = new Date(), timeoutMs = AWAITING_TIMEOUT_MS } = {}) {
  if (run?.state !== "awaiting_tunnel") return false;
  if (run.stallNotifiedAt) return false;
  const since = Date.parse(run.updatedAt || "");
  if (!Number.isFinite(since)) return false;
  return now.getTime() - since >= timeoutMs;
}

export function stepDone(run, id, note = null, now = new Date()) {
  const step = run.steps.find((item) => item.id === id);
  if (!step) return run;
  return {
    ...run,
    steps: run.steps.map((item) =>
      item.id === id
        ? { ...item, state: "done", at: now.toISOString(), error: null, note, attempts: 0, nextAt: null }
        : item
    ),
    // 这一步成功了，上一次的错误码就不该继续挂在 run 上：
    // 否则面板会把「已进入下一步」也标成红的。
    lastError: null,
    updatedAt: now.toISOString(),
  };
}

export function stepFailed(run, id, code, now = new Date()) {
  return {
    ...run,
    steps: run.steps.map((item) =>
      item.id === id ? { ...item, state: "failed", at: now.toISOString(), error: code, nextAt: null } : item
    ),
    lastError: code,
    updatedAt: now.toISOString(),
  };
}

/**
 * 失败的一步回到待办：面板上保留错误码，但下一次要等退避窗口过去。
 *
 * 有配额的步骤（证书）连续失败到上限就转终态：继续自动重试只会把限流窗口
 * 越拉越长，而且错误码永远是同一个，人看不出「等一等就好」还是「配置错了」。
 */
export function stepRetry(run, id, code, now = new Date()) {
  const current = run.steps.find((item) => item.id === id);
  const attempts = (current?.attempts || 0) + 1;
  const cap = attemptCapOf(id);
  const exhausted = cap > 0 && attempts >= cap;
  const wait = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)];
  return {
    ...run,
    // 到上限就不再是「进行中」，让 worker 停手，等人看完日志把它重新推进。
    state: exhausted ? "failed" : run.state,
    steps: run.steps.map((item) =>
      item.id === id
        ? {
            ...item,
            state: exhausted ? "failed" : "pending",
            attempts,
            nextAt: exhausted ? null : new Date(now.getTime() + wait).toISOString(),
            error: code,
          }
        : item
    ),
    lastError: code,
    updatedAt: now.toISOString(),
  };
}

/**
 * 人工放行：把停住的 run 推回 provisioning，其余原样保留。
 *
 * 只清「为什么停下」——失败标记、退避、停滞回执；已完成与已跳过的步骤一个都不动，
 * 重跑它们虽然幂等，但证书那一步重跑是要再签一次的。用它的场合：`tls` 到了上限、
 * 或一张单在 awaiting_tunnel 停太久原因已排除、或上次是 application_closed。
 */
export function reopenRun(run, now = new Date()) {
  return {
    ...run,
    state: "provisioning",
    steps: (run.steps || []).map((step) =>
      step.state === "done" || step.state === "skipped"
        ? step
        : { ...step, state: "pending", error: null, attempts: 0, nextAt: null }
    ),
    lastError: null,
    // 重新计时：不然刚放行就又被当成停滞，人看不到下一轮的结果。
    stallNotifiedAt: null,
    updatedAt: now.toISOString(),
  };
}

export function nextPort(members = [], reserved = []) {
  const used = new Set(
    members.map((member) => Number(member?.tunnel?.port)).filter((port) => Number.isInteger(port))
  );
  // 名册是一份磁盘快照：同一轮里刚分给前一个申请的端口还没落盘。
  // 调用方把本轮已经分出去的端口放进 reserved，两条新申请才不会拿到同一个。
  for (const port of reserved) used.add(Number(port));
  for (let port = FIRST_PORT; port <= LAST_PORT; port += 1) {
    if (!used.has(port)) return port;
  }
  throw new ProvisionError("port_exhausted", `${FIRST_PORT}-${LAST_PORT} 已用满`);
}

export function accountOf(instanceId) {
  return `knot-tunnel-${instanceId}`;
}

/** 名册里已有这个实例就沿用它的账号与端口，避免重试时换掉正在用的隧道。 */
export function tunnelFor({ instanceId, members = [], reserved = [] }) {
  const member = members.find((item) => item.id === instanceId);
  const port = Number(member?.tunnel?.port);
  const account = String(member?.tunnel?.account || "").trim();
  if (account && Number.isInteger(port) && port >= 1024 && port <= 65535) return { account, port };
  return { account: accountOf(instanceId), port: nextPort(members, reserved) };
}

/**
 * 每轮按当前名册重算隧道参数。
 *
 * run 里的账号与端口只是上一次分配的结果，名册才是权威。同一轮里两个新申请
 * 都从同一份快照算端口，先落盘的那个占住它；后者若继续信 run 里的旧值，
 * 每次发布都会被判重复，永远停在 roster_invalid。按名册重算一次就换到空闲端口。
 */
export function reconcileTunnel({ run, members = [], now = new Date() }) {
  const tunnel = tunnelFor({ instanceId: run.instanceId, members });
  if (tunnel.account === run.account && tunnel.port === run.port) return run;
  return { ...run, account: tunnel.account, port: tunnel.port, updatedAt: now.toISOString() };
}

// ---- 渲染：入口主机上要落的那几份文件 ----

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function renderPlaceholder({ instanceId, name }) {
  const title = escapeHtml(name || instanceId);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f0f2f5; color: #050505;
         font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 36rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { color: #65676b; margin: .25rem 0; }
  code { font-size: .9em; }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <p>子域已签发，入口正在接通。</p>
  <p>This subdomain is issued; the entry is being connected.</p>
  <p><code>${escapeHtml(instanceId)}.xknot.si</code></p>
</main>
</body>
</html>
`;
}

/**
 * 站点给自己声明的两条爬虫入口。
 *
 * 为什么由入口来生成、而不是等实例发：整站反代的子域里，`/robots.txt` 与
 * `/sitemap.xml` 会落进实例 WebUI 的 SPA 兜底，回一张 200 的 index.html。Google 把
 * 前者当成空规则（全站放开、也没有 Sitemap 指引），把后者当成无效站点地图。这两条
 * 都不报错，只是安静地什么都没起作用。
 *
 * 生成规则必须与实例自己发的那两条**逐字一致**：同一台机器上还有走静态投放的子域，
 * 它们的这两份文件由实例侧写入。两边内容不同，同一个联盟的站点地图就会分成两种格式。
 * 这是刻意保留的重复——两个项目不互相 import，只靠实现对齐。
 *
 * 只有 `/` 与 `/discover` 是真正的静态页：其余路由要么回源 `/api`，要么是账户态页面。
 * 不写 lastmod：档案的更新时间是「站点介绍改于何时」，拿它当页面更新时间是假的。
 */
export function renderRobotsTxt(origin) {
  const base = String(origin || "").replace(/\/+$/, "");
  return ["User-agent: *", "Allow: /", "Disallow: /api/", "Disallow: /admin", "", `Sitemap: ${base}/sitemap.xml`, ""].join("\n");
}

export function renderSitemapXml(origin) {
  const base = String(origin || "").replace(/\/+$/, "");
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

/** 只有 80：够 certbot 做 HTTP-01，证书拿到之前不写 443，免得 nginx -t 失败。 */
export function renderHttpVhost({ domain, root }) {
  return `# ${domain}：签发阶段的 HTTP 入口，${MANAGED_MARK}。
# 证书签发成功后会被同一份生成器改写成 443 + /api 反代的完整版本。

server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location /.well-known/acme-challenge/ {
        root ${root};
    }

    location / {
        root ${root};
        index index.html;
        try_files $uri $uri/ /index.html;
    }
}
`;
}

export const ENTRY_PROXIED_MARK = "# 入口已接通：整站反代到隧道";

/**
 * 「这份 conf 由中枢生成」的唯一标记。
 *
 * 入口的 vhost 有两个来源：中枢自动接通（两份都带这一行），以及伙伴自己
 * 跑 `push-entry.sh` 推上来的静态投放（带 `由 ops/scripts/render-config.mjs`）。
 * 中枢只能改自己生成的那种：否则它每 20 秒核对一次，会把伙伴刚推上来的
 * 静态 conf 改回整站反代，两边互相覆盖，谁也不知道最后是谁的配置。
 *
 * 判定用「有没有这一行」，不是「内容像不像」：外部 conf 的版式随时会变，
 * 而这一行是我们自己写的，改版式时也不会丢。
 */
export const MANAGED_MARK = "由 auto-connect 生成，请勿手改";

/** 当前 conf 是不是中枢生成的。null（文件不存在）按「可以创建」处理。 */
export function isManagedEntryConf(text) {
  if (text == null) return true;
  return String(text).includes(MANAGED_MARK);
}

// 入口访问日志：聚合端是 ops/traffic.mjs，按这些键读（见 docs/HUB.md）。
//
// 格式声明写在**每份 vhost 自己**的文件里，名字按子域唯一。两个原因：
//   1. log_format 只能声明一次，不能每份 conf 都叫 knot_json；
//   2. conf.d/*.conf 按文件名排序 include，共享的 knot-log.conf 排不到最前，
//      cpswang 这种域名排在它前面的子域会报 "unknown log format"。
// 自己声明就不依赖任何文件先被加载。字段与 knot-platform/ops/entry/log.conf.template
// 必须一致——少一个键，traffic.mjs 就少一列。
export const ENTRY_ACCESS_LOG = "/var/log/nginx/knot-access.log";

// reload 之后唯一的失败证据。见 reloadNginx() 上面那段。
export const NGINX_ERROR_LOG = "/var/log/nginx/error.log";
const LOG_FORMAT_BODY = `'{"at":"$time_iso8601","host":"$host","status":$status,"method":"$request_method",'
  '"uri":"$uri","bytes":$body_bytes_sent,"requestTime":$request_time,'
  '"upstreamTime":"$upstream_response_time","cache":"$upstream_cache_status",'
  '"ip":"$remote_addr","ua":"$http_user_agent","ref":"$http_referer"}'`;

/** 每个子域一个格式名：log_format 的名字只能是字母、数字与下划线。 */
export function logFormatName(domain) {
  return `knot_json_${String(domain).replace(/[^a-zA-Z0-9]/g, "_")}`;
}

// 入口这一层不做压缩，JS/CSS/JSON 就按原文发出去：WebUI 主包 109KB，压完约 68KB。
// 同一个 http 块里别的 vhost 各写各的，所以只能写在这份 conf 的 server 里。
// gzip_proxied any 让穿过隧道的 /api 响应也压——JSON 收益最大。
// 不放图片/字体：jpeg、png、woff2 本来就压过了；不放 markdown：入口只出 WebUI 与快照。
const GZIP_BLOCK = `    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_comp_level 5;
    gzip_proxied any;
    gzip_types text/plain text/css text/javascript application/javascript application/json application/manifest+json image/svg+xml application/xml text/xml;
`;

/**
 * 反代到隧道的一组公共指令。
 *
 * 入口上每一个回源 location 都必须带这一整组：少了 `Connection ""`，nginx 给上游
 * 发 close，upstream 的 keepalive 形同虚设（每个请求重开一条穿隧道的 TCP）；
 * 少了 `proxy_send_timeout`，在慢上行发大文件会按默认 60 秒被掐断。
 * 所以每个回源 location 都从这里取，不各写一份。上传端点要更长的超时：
 * 请求体本身可能传几分钟，120 秒会把一个 2MB 以上的附件判成 504。
 */
function proxyDirectives(indent, upstream, { timeout = "120s" } = {}) {
  const pad = " ".repeat(indent);
  return [
    `proxy_pass http://${upstream};`,
    "proxy_http_version 1.1;",
    'proxy_set_header Connection "";',
    "proxy_set_header Host $host;",
    "proxy_set_header X-Real-IP $remote_addr;",
    "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "proxy_set_header X-Forwarded-Proto $scheme;",
    `proxy_read_timeout ${timeout};`,
    `proxy_send_timeout ${timeout};`,
  ]
    .map((line) => `${pad}${line}`)
    .join("\n");
}

/**
 * 443 的完整入口 conf。
 *
 * 两个阶段：
 *   entry: false —— 隧道还没通。`/` 发静态占位页（"子域已签发，入口正在接通"），
 *                   只有 /api 预先接到回环端口上，用来做健康探测。
 *   entry: true  —— 探测通过，整站反代：`/` 也走隧道，访客看到的是实例自己的 WebUI。
 *                   占位页不再有人访问，静态 root 只剩 ACME 校验在用。
 *
 * 同一条腿只认一个事实：隧道没通就发占位页，通了就整站过隧道。不做「/ 看静态、
 * 其他看隧道」那种混合，否则首页永远停在占位页（0.1 的真实事故就是这一条）。
 * 唯一的例外是 `/discover.json`：它是公开快照，中枢会取回到入口磁盘上，有就用磁盘
 * 那份、没有就回落到隧道。它不是页面，所以不存在「两个来源看到两个站」的问题。
 *
 * 整站反代也要拿到和 static 投放同档的传输层：HTTP/2、gzip、隧道连接复用。
 * 这三项与「页面从磁盘出还是从隧道回」无关；少了它们，每个静态文件都要多穿一次
 * 跨境往返、按原文传，109KB 的主包会当 109KB 发出去。
 */
export function renderVhost({ domain, root, port, entry = false }) {
  const proxied = Boolean(entry);
  const upstream = `knot_entry_${port}`;
  const header = proxied
    ? `# ${domain}：入口 conf，${MANAGED_MARK}。\n${ENTRY_PROXIED_MARK}\n# 整站经本机回环端口 ${port} 回到实例（SSH 反向隧道）。`
    : `# ${domain}：入口 conf，${MANAGED_MARK}。\n# 静态页落在 ${root}；/api 经本机回环端口 ${port} 回到实例（SSH 反向隧道）。`;

  // 回源统一走 upstream 才能复用连接：一条新 TCP 要穿隧道重建一次 channel，
  // 跨境多一个 RTT。keepalive_timeout 压在 Backend 的 keepAliveTimeout（Node 默认 5s）之下。
  const upstreamBlock = `upstream ${upstream} {
    server 127.0.0.1:${port};
    keepalive 16;
    keepalive_timeout 4s;
}
`;

  // 访问日志：格式声明与用户都写在这一份 conf 里，名字按子域唯一。
  // conf.d 是按文件名顺序 include 的，共享的 knot-log.conf 可能排在后面，
  // 那时 nginx -t 会报 unknown log format，整棵配置树都过不了。
  const formatName = logFormatName(domain);
  const logDirective = `# 访问日志格式（每个子域一份，名字唯一）。聚合端：ops/traffic.mjs。
log_format ${formatName} escape=json
  ${LOG_FORMAT_BODY};

`;

  // 伙伴节点在境外：整站反代之后，`/assets/` 里的每个 JS/CSS 都要穿一次隧道回源，
  // 一页 4–6 个资源就是 4–6 次跨境往返。这些文件名带内容哈希（Vite 产物），
  // 内容变了名就变了，所以可以在入口长期缓存：第二次访问起直接由新加坡的磁盘出。
  // proxy_cache_use_stale 让隧道抖动时还能发已缓存的资源——这正是「二级域名打不开」
  // 最常见的时刻：隧道断了，页面骨架还在，主包发不出去。
  //
  // 页面骨架（`/`，SPA 兜底回 index.html）也进同一个 zone，但只留 10 秒：
  //   - 上游对 index.html 发的是 no-cache，不加 proxy_ignore_headers 就一条都存不下；
  //   - 10 秒内的重复导航不必再穿一次隧道；日志里 cache 列能看出命中；
  //   - 隧道断时 use_stale 还能发上一次的壳（静态投放的同档能力），
  //     访客看到的是页面打开、数据处报错，而不是白屏；
  //   - 代价：发版后 ≤10 秒内可能有访客拿到旧壳，指向已改名的旧资源。
  //     旧资源在缓存里留 30 天，只有「那个旧资源此前从没被谁取过」才会 404，窗口很小。
  const cacheName = `knot_cache_${String(domain).replace(/[^a-zA-Z0-9]/g, "_")}`;
  const cacheBlock = proxied
    ? `# 入口缓存：/assets/ 按哈希名长期留，页面骨架只留 10 秒。目录与 zone 名按子域唯一。
# 512m 是给上传图留的：个人站一天 20–100 条、每条几张图，图片在缓存里转一天约 90MB，
# 留一倍余量。资产按需才进缓存，旧构建的分片没人请求就不占地方。
proxy_cache_path /var/cache/nginx/${cacheName} levels=1:2 keys_zone=${cacheName}:10m
  max_size=512m inactive=30d use_temp_path=off;

`
    : "";

  const rootLocation = proxied
    ? `    # 上传文件（信息流图片 /display、头像、赞助图）：入口缓存，避免每张图都穿隧道回平台。
    # 与静态投放的入口同一套语义：缓存键只有 $uri、不含会话，「能不能进共享缓存」
    # 完全交给后端的 Cache-Control（公开内容 public，只有当事人能读的 private，
    # 生成失败回退原件 no-store）。所以这里不 ignore 任何头——后端说了算。
    # 不带尾斜杠：带上之后 nginx 把 /api/web/uploads 当成目录，对 POST 回 301 补斜杠；
    # 浏览器跟随时按 GET 重发、请求体丢掉，选好的图传上去就是 404。
    location ^~ /api/web/uploads {
${proxyDirectives(8, upstream, { timeout: "900s" })}
        client_body_timeout 300s;
        proxy_request_buffering on;
        proxy_cache ${cacheName};
        proxy_cache_key "$uri";
        proxy_cache_valid 200 1d;
        proxy_cache_lock on;
        proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
        add_header X-Knot-Cache $upstream_cache_status;
    }

    # 附件、音频与 Agent 的上传入口：都是慢链路上的大请求体，与图片上传同一档超时。
    # 图片的 /api/web/uploads 由上面的 ^~ 前缀命中，这里补其余四个端点。
    location ~ ^/api/(web/files|agent/(files|audio|uploads))$ {
${proxyDirectives(8, upstream, { timeout: "900s" })}
        client_body_timeout 300s;
        proxy_request_buffering on;
    }

    location ^~ /assets/ {
${proxyDirectives(8, upstream)}
        proxy_cache ${cacheName};
        proxy_cache_valid 200 30d;
        proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
        proxy_cache_lock on;
        # 上游对 /assets/ 发的是 no-cache 语义（资源要能立刻换），入口按哈希名缓存。
        proxy_ignore_headers Cache-Control Expires Set-Cookie;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    # 爬虫入口放在入口磁盘上。整站反代时这两条会落进实例 WebUI 的 SPA 兜底，
    # 回一张 200 的 index.html：Google 把 robots 读成空规则（全站放开、没有 Sitemap
    # 指引），把站点地图读成无效文件。两件事都不报错，只是安静地什么都没起作用。
    # 文件由签发时写进 root，内容与实例自己发的逐字一致。
    # 磁盘上没有文件时回落到隧道：伙伴升级到自带这两条的版本后入口不再挡路。
    location = /robots.txt {
        root ${root};
        try_files /robots.txt @knot_origin;
        add_header Cache-Control "public, max-age=300" always;
        add_header X-Content-Type-Options nosniff always;
    }

    location = /sitemap.xml {
        root ${root};
        try_files /sitemap.xml @knot_origin;
        add_header Cache-Control "public, max-age=300" always;
        add_header X-Content-Type-Options nosniff always;
    }

    # 公开快照放在入口磁盘上：首屏数据不必由每个访客穿一次隧道去确认有没有新内容。
    # 文件由中枢按固定间隔从实例取回（ops/snapshots.mjs），内容没变就不动它。
    # 磁盘上没有文件时回落到隧道，因此这层缓存不会制造「文件没了就白屏」。
    # 缓存头与实例自己的 /discover.json 一致：浏览器 30 秒内直接用，不必回来校验。
    # 从磁盘出这一条没有 Backend 参与，安全头只能在这里发；回落到隧道时由 Backend 发，
    # 这两行安全头不生效（内部跳转后按目标 location 的配置走），不会出现重复头。
    location = /discover.json {
        root ${root};
        try_files /discover.json @knot_origin;
        add_header Cache-Control "public, max-age=30, stale-while-revalidate=300" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
    }

    location @knot_origin {
${proxyDirectives(8, upstream)}
    }

    location / {
${proxyDirectives(8, upstream)}
        proxy_request_buffering off;
        proxy_cache ${cacheName};
        proxy_cache_valid 200 10s;
        # 404 也留 10 秒：没有这一行，一条曾经 200 的地址会永远发旧壳。
        # 后台刷新拿到 404 却存不下任何东西，旧条目就一直有效；软 404 下线之后，
        # 拼错的地址、/help 这类路径在入口这一层继续是 200，改等于没改。
        # 负缓存只留 10 秒，和正缓存同档：路径恢复时最多多看十秒的 404。
        proxy_cache_valid 404 10s;
        # 301 同理：地址换了位置（/discover.html → /discover）也是从 200 变更来的，
        # 不缓存跳转就换不掉旧壳，两个地址会一直都能打开。
        proxy_cache_valid 301 10s;
        # 过期后先把旧的发出去，刷新在后台做：过期那一下也不让访客等隧道。
        proxy_cache_background_update on;
        # 隧道断了、后端 5xx 了，发上一次的壳。这是静态投放那一档能力，
        # 没有它，隧道一抖整页就打不开。
        proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
        proxy_cache_lock on;
        # 上游对 index.html 发 no-cache，不忽略就存不下。只忽略这两头，
        # 带 Set-Cookie 的响应仍然不进缓存——宁可不缓存，也不把别人的会话发出去。
        proxy_ignore_headers Cache-Control Expires;
    }`
    : `    location = /index.html {
        root ${root};
        add_header Cache-Control "no-cache";
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
    }

    location / {
        root ${root};
        index index.html;
        try_files $uri $uri/ /index.html;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
    }`;

  return `${header}
${cacheBlock}
${upstreamBlock}${logDirective}
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location /.well-known/acme-challenge/ {
        root ${root};
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${domain};

    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # 每个子域一行，格式名就是上面那份唯一声明。
    # 少了这一行，控制台里这个节点的「入口流量」永远是「未采集」。
    access_log ${ENTRY_ACCESS_LOG} ${logFormatName(domain)};

    client_max_body_size 52m;

${GZIP_BLOCK}
    location /.well-known/acme-challenge/ {
        root ${root};
    }

    # 管理面只在实例自己的机器与内网开：整站反代之后，隧道的对端是实例上的回环，
    # Backend 分不出「本机来的」和「经隧道从公网来的」，所以必须在入口先挡住。
    location ^~ /api/admin {
        default_type application/json;
        return 404 '{"error":"not_found"}';
    }

    location ^~ /admin {
        default_type application/json;
        return 404 '{"error":"not_found"}';
    }

    # 普通接口的请求体都很小，先收完再回源；不把请求体边收边转，避免一个慢上传
    # 让 120 秒的读超时在请求体还没传完时就到期（上传端点已在上面的 location 放宽）。
    location /api/ {
${proxyDirectives(8, upstream)}
    }

${rootLocation}
}
`;
}

/** 每个成员一段 Match：只允许把入口的回环端口转到实例，不给 shell、不许开别的端口。 */
export function renderSshdMatch({ members = [] }) {
  const rows = members.filter((member) => member?.tunnel?.account);
  // 名册是外部输入（清单、控制台、CLI 都写过它）。这里逐条复校账号名与端口：
  // 一行 `Match User` 里出现空格或换行，整份 sshd_config 就不再是它看起来的样子。
  for (const member of rows) {
    const account = String(member.tunnel.account);
    if (!ACCOUNT_RE.test(account)) throw new ProvisionError("invalid_account", account);
    const port = Number(member.tunnel.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new ProvisionError("invalid_port", `${account}: ${member.tunnel.port}`);
    }
  }
  const blocks = rows
    .map(
      (member) => `Match User ${member.tunnel.account}
    AllowTcpForwarding remote
    PermitListen 127.0.0.1:${member.tunnel.port}
    PermitOpen none
    X11Forwarding no
    AllowAgentForwarding no
    PermitTTY no
    GatewayPorts no
    ClientAliveInterval 30
    ClientAliveCountMax 3
    ForceCommand /usr/bin/sleep infinity`
    );
  return `# 入口主机上的回源隧道账号，由 auto-connect 按名册整份生成，请勿手改。
# 名册是唯一事实来源：成员增减后重跑签发步骤即可。
${blocks.join("\n\n")}
`;
}

// 签发出来的地址只有一种形状：<标签>.xknot.si，标签是 LABEL_RE 认的那一套。
// 这里不复用 checkLabel：已签发的短号（如 wang）照样要能接通，长度不重判。
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.xknot\.si$/;
// useradd 的账号名：小写字母或下划线开头，其余字母数字与 - _，≤32。
const ACCOUNT_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

function assertSafeDomain(run) {
  const domain = String(run?.host || "");
  if (!DOMAIN_RE.test(domain) || domain.slice(0, -".xknot.si".length).length > 63) {
    throw new ProvisionError("invalid_domain", domain || "(空)");
  }
  const port = Number(run?.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new ProvisionError("invalid_port", String(run?.port ?? ""));
  }
}

function assertSafeRun(run) {
  assertSafeDomain(run);
  const account = String(run?.account || "");
  if (!ACCOUNT_RE.test(account)) throw new ProvisionError("invalid_account", account || "(空)");
}

// 入口主机可以配成地址（XKNOT_ENTRY_HOST=54.169.33.64），也可以配成主机名。
// 两种都要能比：地址直接拿来比，主机名先解析。
async function entryAddresses(host, entryHost) {
  const value = String(entryHost || "").trim();
  if (!value) return [];
  if (isIP(value)) return [value];
  return host.resolve4(value);
}

// ---- 执行一步 ----
//
// 每个执行函数拿到同一份上下文：
//   run / application / host / entry / roster / publish  与 runStep 收到的参数同名同值
//   domain = run.host，root = /var/www/<instanceId>
//
// 两条约定：
//   1. 幂等——重跑一次的结果与第一次相同，已有的账号、目录、配置不重建；
//   2. 只执行、不判断该不该执行——那是 dueStep 的事，这里拿到的就是该干的活。

/** 端口与账号在 createRun 里就定了，这一步只把结果记进 run 的历史。 */
async function runAllocate({ run }) {
  return { note: `${run.account} / ${run.port}` };
}

/** 写清单与名册。清单是公开快照的来源，名册是 sshd 与端口分配的唯一事实。 */
async function runPublish({ application, run, publish }) {
  const result = await publish({
    application,
    tunnelAccount: run.account,
    tunnelPort: run.port,
  });
  if (result.error) throw new ProvisionError(result.error, JSON.stringify(result.details || null));
  return { note: result.skipped ? "已在清单与名册里" : "已写入清单与名册" };
}

/** 建隧道账号并装公钥。 */
async function runAccount({ run, application, host }) {
  const home = `/home/${run.account}`;
  const exists = await host.sudo(["id", "-u", run.account]);
  if (exists.code !== 0) {
    const created = await host.sudo([
      "useradd",
      "--create-home",
      "--home-dir",
      home,
      "--shell",
      "/bin/bash",
      run.account,
    ]);
    if (created.code !== 0) throw new ProvisionError("account_failed", created.stderr);
  }
  // 最后一道：这里是要写进 root 属主文件的文本。库里存的历史值可能是
  // 收紧校验之前写进去的，所以到了这一层仍要再验一次——一行公钥变两行，
  // 等于给入口主机加了第二把钥匙。
  //
  // 两种失败分开报：没填是用户还没做这一步（可重试），填错说明库里是脏值
  // （要人工看），让面板能说清是哪一种。
  if (!String(application.publicKey || "").trim()) throw new ProvisionError("public_key_missing");
  const key = normalizePublicKey(application.publicKey);
  if (!key) throw new ProvisionError("public_key_invalid");
  await host.sudo(["install", "-d", "-m", "700", "-o", run.account, "-g", run.account, `${home}/.ssh`]);
  await host.writeRootFile(`${home}/.ssh/authorized_keys`, `${key}\n`, "600", {
    owner: `${run.account}:${run.account}`,
  });
  return { note: "公钥已装" };
}

/** 按名册整份重写 sshd 的 Match 段，再让 sshd 自己确认这份配置能用。 */
async function runSshd({ host, roster }) {
  const includeLine = "Include /etc/ssh/sshd_config.d/*.conf";
  const main = (await host.readRootFile("/etc/ssh/sshd_config")) || "";
  if (!main.includes(includeLine)) {
    await host.writeRootFile("/etc/ssh/sshd_config", `${main.trimEnd()}\n\n${includeLine}\n`, "600");
  }
  await host.writeRootFile("/etc/ssh/sshd_config.d/knot-tunnels.conf", renderSshdMatch({ members: roster.members || [] }), "644");
  const tested = await host.sudo(["/usr/sbin/sshd", "-t"]);
  if (tested.code !== 0) throw new ProvisionError("sshd_config_invalid", tested.stderr);
  const reloaded = await host.sudo(["systemctl", "reload", "sshd"]);
  if (reloaded.code !== 0) await host.sudo(["systemctl", "reload", "ssh"]);
  return { note: "sshd 已按名册重载" };
}

/** 静态 root：证书签发前的 ACME 校验目录、隧道接通前的占位页，以及两条爬虫入口。 */
async function runStatic({ run, application, host, domain, root }) {
  await host.sudo(["install", "-d", "-m", "755", root]);
  await host.writeRootFile(`${root}/index.html`, renderPlaceholder({ instanceId: run.instanceId, name: application.name }), "644");
  // 整站反代时 nginx 从这两份文件直接出，不穿隧道（见 renderVhost 里那两条 location）。
  // 写在这里是因为这一步本来就在铺磁盘：签发、DNS、证书都对之前，文件已经在位。
  await writeCrawlerEntry({ host, domain, root });
  return { note: root };
}

/**
 * 把 robots.txt 与 sitemap.xml 写到入口磁盘上，内容没变就不动。
 *
 * 除了签发那一步，每轮核对也要调用一次（见 switchEntry）：已经开通的子域不会再走
 * 一遍签发流程，缺了这一层，修好的 conf 照样回落到 SPA 兜底，等于没修。
 * 走 writeEntryFile（先写临时文件再 rename），nginx 随时可能正在读这两个路径。
 */
async function writeCrawlerEntry({ host, domain, root }) {
  const origin = `https://${domain}`;
  for (const [name, text] of [
    ["robots.txt", renderRobotsTxt(origin)],
    ["sitemap.xml", renderSitemapXml(origin)],
  ]) {
    const file = `${root}/${name}`;
    if ((await host.readRootFile(file)) !== text) await host.writeEntryFile(file, text);
  }
}

/** 解析得到的地址必须命中入口主机：一条指向别人的 A 记录也能过解析，而 certbot 会替它签证书。 */
async function runDns({ run, host, domain }) {
  const addresses = await host.resolve4(domain);
  if (!addresses.length) {
    throw new ProvisionError(
      "dns_missing",
      `解析不到 ${domain}；入口域名需要一条泛解析 *.xknot.si → ${run.entryHost}`
    );
  }
  const expected = await entryAddresses(host, run.entryHost);
  if (!expected.length) {
    throw new ProvisionError("entry_unresolved", `解析不到入口主机 ${run.entryHost || "(未配置)"}`);
  }
  if (!addresses.some((address) => expected.includes(address))) {
    throw new ProvisionError(
      "dns_mismatch",
      `${domain} → ${addresses.join(", ")}；入口是 ${run.entryHost}（${expected.join(", ")}）`
    );
  }
  return { note: addresses.join(", ") };
}

/** 只有 80 的入口 conf：够 certbot 做 HTTP-01，证书到手前不写 443。 */
async function runVhost({ run, host, domain, root }) {
  // 只写中枢自己的 conf：伙伴已经用 push-entry.sh 推过静态入口时，这一步不能盖掉它。
  // 首次开通时文件不存在，isManagedEntryConf(null) 为真，照常写。
  const file = `/etc/nginx/conf.d/${domain}.conf`;
  if (!isManagedEntryConf(await host.readRootFile(file))) {
    return { note: "入口 conf 由外部管理（静态投放），未覆盖", external: true };
  }
  await host.writeRootFile(file, renderHttpVhost({ domain, root }), "644");
  const tested = await host.sudo(["nginx", "-t"]);
  if (tested.code !== 0) throw new ProvisionError("nginx_config_invalid", tested.stderr);
  const applied = await reloadNginx({ host });
  return { note: applied.restarted ? "HTTP 入口已生效（master 重新读取配置）" : "HTTP 入口已生效" };
}

/** 签证书，然后把 conf 换成 443 + /api 反代的版本。 */
async function runTls({ run, host, entry, domain, root }) {
  const issued = await host.sudo(
    [
      "/usr/bin/certbot",
      "certonly",
      "--webroot",
      "-w",
      root,
      "-d",
      domain,
      "--cert-name",
      domain,
      "--non-interactive",
      "--agree-tos",
      "-m",
      entry.adminEmail,
      "--keep-until-expiring",
    ],
    { timeoutMs: 180_000 }
  );
  if (issued.code !== 0) throw new ProvisionError("tls_failed", tail(issued.stderr));
  // 证书照签（ACME 校验用的是静态 root，与 conf 归属无关），但 conf 依旧是
  // 谁写的归谁：外部管理的入口只把证书交给它，不覆盖它的反代/静态配置。
  const file = `/etc/nginx/conf.d/${domain}.conf`;
  if (!isManagedEntryConf(await host.readRootFile(file))) {
    return { note: "证书已签发；入口 conf 由外部管理，未覆盖", external: true };
  }
  await host.writeRootFile(file, renderVhost({ domain, root, port: run.port }), "644");
  const tested = await host.sudo(["nginx", "-t"]);
  if (tested.code !== 0) throw new ProvisionError("nginx_config_invalid", tested.stderr);
  const applied = await reloadNginx({ host });
  return {
    note: applied.restarted ? "证书已签发，/api 反代已接上（master 重新读取配置）" : "证书已签发，/api 反代已接上",
  };
}

/**
 * 执行一个步骤。host 是入口主机的能力接口，便于测试时替换：
 *   sudo(argv, { input })          → { code, stdout, stderr }
 *   writeRootFile(path, text, mode)
 *   resolve4(hostname)             → string[]
 *   readRootFile(path)             → string | null
 */
export async function runStep({ step, run, application, host, entry, roster, publish }) {
  // run.host 与 run.account 会被原样插进 nginx / sshd 的配置，写之前按签发
  // 规则复校一遍：清单里的 url 由别处校验，这里不能假定它一定干净。
  assertSafeRun(run);

  const definition = STEP_BY_ID.get(step);
  // 表里没有这个 id 就是调用方传错了（拼错，或留下了已删掉的步骤）。报错而不是
  // 静默返回：静默会让这条单停在 provisioning，而日志里一行痕迹都没有。
  if (!definition) throw new ProvisionError("unknown_step", step);

  return definition.run({
    run,
    application,
    host,
    entry,
    roster,
    publish,
    domain: run.host,
    root: `/var/www/${run.instanceId}`,
  });
}

/**
 * 把新配置交给 nginx，并确认它真的被接受了。
 *
 * reload 与 restart 的差别不在「会不会断连接」，而在「谁有权拒绝」：
 * reload 只是给 master 发 SIGHUP，它用新配置起新 worker。master 自己判断不了的
 * 改动——共享内存 zone 的 key 变了，比如 limit_req_zone 的 key 从 $binary_remote_addr
 * 换成 map 出来的变量——会被它整份拒掉，旧配置继续跑，而命令仍然返回 0。
 * 这种失败只在 error.log 里留一行 [emerg]，退出码看不出来。
 *
 * 所以 reload 之后要回头读一次日志：出现新的 [emerg] 就 restart，
 * 让 master 重新读盘。
 *
 * 日志读不到（没有权限、文件不在）时不猜：按 nginx -t 的结果放行，
 * 返回 confirmed:false 让调用方知道这一步没有证据。
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function logOffset(host, file) {
  const size = await host.sudo(["stat", "-c", "%s", file]);
  if (size.code !== 0) return null;
  const value = Number(String(size.stdout).trim());
  return Number.isFinite(value) ? value : null;
}

async function logSince(host, file, offset) {
  if (offset == null) return null;
  const read = await host.sudo(["tail", "-c", `+${offset + 1}`, file]);
  return read.code === 0 ? String(read.stdout) : null;
}

export async function reloadNginx({
  host,
  errorLog = NGINX_ERROR_LOG,
  attempts = 5,
  delayMs = 100,
} = {}) {
  const offset = await logOffset(host, errorLog);
  const reloaded = await host.sudo(["systemctl", "reload", "nginx"]);
  if (reloaded.code !== 0) throw new ProvisionError("nginx_reload_failed", tail(reloaded.stderr));

  // 没有日志可看：只能信 nginx -t 与退出码。
  if (offset == null) return { restarted: false, confirmed: false };

  let fresh = "";
  for (let i = 0; i < attempts; i += 1) {
    const read = await logSince(host, errorLog, offset);
    // 读到一半失败，或者日志根本没长：没有证据，不再等。
    if (read == null || (read === "" && i >= 1)) return { restarted: false, confirmed: false };
    fresh = read;
    // master 先打 notice 再决定收不收这份配置；[emerg] 一出现就是拒了。
    if (fresh.includes("[emerg]")) break;
    // 成功 reload 的标志：新 worker 起来了。看到就不必再等。
    if (fresh.includes("start worker process")) return { restarted: false, confirmed: true };
    await sleep(delayMs);
  }
  if (!fresh.includes("[emerg]")) return { restarted: false, confirmed: false };

  const reason = tail(
    fresh.split("\n").find((line) => line.includes("[emerg]")) || fresh,
    200
  );
  const restarted = await host.sudo(["systemctl", "restart", "nginx"]);
  const active = await host.sudo(["systemctl", "is-active", "nginx"]);
  if (restarted.code !== 0 || String(active.stdout).trim() !== "active") {
    throw new ProvisionError(
      "nginx_restart_failed",
      `${reason}；restart 之后 nginx 没在跑：${tail(restarted.stderr)}`
    );
  }
  return { restarted: true, confirmed: true, reason };
}

/**
 * 把入口在「占位页」与「整站反代」之间切换。
 *
 * 探测通过时切成反代，访客看到实例自己的 WebUI；之后再跑一次只是核对
 * （conf 一致就什么都不做），所以部署覆盖、conf 被删都能自愈。
 *
 * 先 nginx -t 再 reload；不通过就把旧内容写回去，不能让一次写坏的 conf
 * 把已经接通的站打掉。
 */
export async function switchEntry({ host, run, entry = true }) {
  assertSafeDomain(run);
  const domain = run.host;
  const root = `/var/www/${run.instanceId}`;
  const file = `/etc/nginx/conf.d/${domain}.conf`;
  const current = await host.readRootFile(file);
  // 伙伴自己跑 push-entry.sh 推上来的静态 conf 不归中枢管。中枢每 20 秒核对一次，
  // 若在这里覆盖，两边会互相改写：伙伴推静态、中枢改回反代、伙伴再推……
  // 认「谁写的」而不是「内容像不像」，见 MANAGED_MARK。连它目录里的文件也不碰：
  // 那份 robots.txt 由实例自己写，中枢插一份进去只会让两个来源互相打脸。
  if (!isManagedEntryConf(current)) return { changed: false, external: true };
  // 爬虫入口每轮核对一次，文件不在就补。签发那一步只跑一次，已经开通的子域不会再
  // 走一遍；少了这一层，新加的 location 也照样回落到 SPA 兜底，等于没修。
  if (entry) await writeCrawlerEntry({ host, domain, root });
  const conf = renderVhost({ domain, root, port: run.port, entry });
  if (current === conf) return { changed: false };

  await host.writeRootFile(file, conf, "644");
  const tested = await host.sudo(["nginx", "-t"]);
  if (tested.code !== 0) {
    if (current != null) await host.writeRootFile(file, current, "644");
    throw new ProvisionError("nginx_config_invalid", tail(tested.stderr));
  }
  let outcome;
  try {
    outcome = await reloadNginx({ host });
  } catch (error) {
    // reload 被拒、restart 又起不来：磁盘上这份 conf 不能留着——下一次 reload
    // 读到的还是它，连回滚的机会都没有。恢复旧内容再起一次。
    if (current != null) {
      await host.writeRootFile(file, current, "644");
      await host.sudo(["systemctl", "restart", "nginx"]);
    }
    throw error;
  }
  return { changed: true, restarted: outcome.restarted };
}

function tail(text, limit = 300) {
  const value = String(text || "").trim();
  return value.length > limit ? value.slice(-limit) : value;
}

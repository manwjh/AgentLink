import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadBootstrapConfig } from "./config.js";
import { createProfileStore } from "./profile.js";
import { federationRouter } from "./routes/federation.js";
import { assertRuntimeConfig } from "./runtimeConfig.js";
import { readBuildInfo } from "./buildInfo.js";
import { bindDiscoverBoard } from "./discoverBoard.js";
import { getPool } from "./db.js";
import { createSessionMiddleware } from "./middleware/session.js";
import { adminRouter } from "./routes/admin.js";
import { adminPageRouter } from "./routes/adminPage.js";
import { createHandoff } from "./handoff.js";
import { listAdminHosts } from "./adminHosts.js";
import { webRouter } from "./routes/web.js";
import { loadEconomyPolicy } from "./actuary.js";
import { ensureOwner } from "./login.js";
import { resumePendingReviews } from "./intel.js";
import { startSearchEventRetention } from "./attention.js";
import { agentRouter } from "./routes/agent.js";
import { loadSystemPolicy, publicBoardEnabled } from "./system.js";
import { federationStatus } from "./federation.js";
import { hubOriginOf } from "./xknotJoin.js";
import { startTunnelAgent } from "./tunnel.js";
import { createHtmlRenderer } from "./pageHtml.js";
import { renderRobots, renderSitemap } from "./siteHtml.js";
import { recordPath } from "./recordUrl.js";
import { pollIntervalMs, startXknotPoller } from "./xknotPoller.js";

// 产品版本跟着本包的 package.json 走，别在这里另写一份。
const SERVICE_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")
).version;

// 先校验环境：值不合法就不启动，免得带着错的端口或连接串跑起来。
assertRuntimeConfig();

const bootstrap = loadBootstrapConfig();
const build = readBuildInfo();
const pool = getPool(bootstrap.databaseUrl);

// 站点身份（自述区）来自 sites/<站点>/profile.json，启动时读一次；
// /admin 保存后由同一个 store 更新内存里的那份。
const profile = createProfileStore({ file: bootstrap.profileFile });
await profile.reload();

// 先读系统开关，公开快照的首次写入和下面的内容接口都按它来。
await loadSystemPolicy(pool);

// 主理人账号跟着 KNOT_ADMIN_EMAIL 走：启动时补上或改绑，幂等。
// 人只能靠它登录；内部 Agent 都挂在它名下。
try {
  await ensureOwner(pool);
} catch (error) {
  // 账号配置错了就不该带着半套身份起来：给一行原因，然后退出。
  console.error(`knot-backend 启动中止：${error.message}`);
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(createSessionMiddleware({ pool, sessionCookieName: bootstrap.sessionCookieName }));

// 账户态页面不该被索引：爬虫没有会话，收进去的只会是登录页。
// 入口 nginx 也照同一份路径规则挡一遍，本机直连由这里管。
const ACCOUNT_PATH = /^\/(?:mine(?:\/submissions)?|notifications|stars|friends|admin)(?:\/|$)/;

// 上传的文件按自己的 MIME 回源。禁止嗅探，避免浏览器把图片当页面执行。
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (ACCOUNT_PATH.test(req.path)) res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && origin === bootstrap.publicWebOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/api/health", (_req, res) => {
  const payload = {
    ok: true,
    service: "knot-backend",
    version: SERVICE_VERSION,
    release: build?.release ?? null,
    commit: build?.commit ?? null,
    builtAt: build?.builtAt ?? null,
  };
  // 接入标识：中枢用它核对「这个域名后面是不是清单里的那个实例」。
  // 没接入时不出现，所以老实例的探测行为不变。
  const instance = String(process.env.XKNOT_INSTANCE_ID || "").trim();
  if (instance) payload.instance = instance;
  res.json(payload);
});

// Agent 指引只有一份，在仓库根 docs/KNOT_HELP.md，由联邦中枢发布（xknot.si/knot-help）。
// 它不属于任何一个实例，实例也不提供文档端点：`/help` 在这里没有页面，和任何
// 不存在的路径一样是 404。WebUI 的入口地址从下面注入会话，页面不自己拼。
const AGENT_DOC_ORIGIN = String(process.env.KNOT_HUB_ORIGIN || "https://xknot.si").replace(/\/+$/, "");

// 快照要在 WebUI 路由之前绑定：首页的会话层会按同一份快照算「哪些卡属于我」。
const discoverBoard = bindDiscoverBoard({ pool, uploadDir: bootstrap.uploadDir, profile });

// 管理后台的入口：WebUI 在域名上，/admin 在内网地址上，两个 origin 不共享登录态。
// 同一份 handoff 实例交给两边：域名那一侧发票据，内网那一侧兑换成 30 天凭据。
const adminToken = String(process.env.KNOT_ADMIN_TOKEN || "").trim();
const handoff = createHandoff({ token: adminToken });
// 地址每次现算：笔记本换了网络，网卡和地址就变了，不该等到重启才更新。
const adminHosts = () =>
  listAdminHosts({
    bindHost: bootstrap.bindHost,
    port: bootstrap.port,
    publicOrigin: bootstrap.publicWebOrigin,
  });

app.use(
  "/api/web",
  webRouter({
    pool,
    sessionCookieName: bootstrap.sessionCookieName,
    uploadDir: bootstrap.uploadDir,
    profile,
    board: discoverBoard.read,
    agentDoc: { page: `${AGENT_DOC_ORIGIN}/knot-help`, raw: `${AGENT_DOC_ORIGIN}/knot-help.md` },
    handoff,
    adminHosts,
    storeEnabled: bootstrap.storeEnabled,
    publicWebOrigin: bootstrap.publicWebOrigin,
  })
);
app.use(
  "/api/agent",
  agentRouter({
    pool,
    uploadDir: bootstrap.uploadDir,
    storeEnabled: bootstrap.storeEnabled,
    profile,
    publicWebOrigin: bootstrap.publicWebOrigin,
  })
);
app.use(
  "/api/federation",
  federationRouter({
    profile,
    agentEnvDir: bootstrap.agentEnvDir,
    publicWebOrigin: bootstrap.publicWebOrigin,
  })
);
app.use(
  "/api/admin",
  adminRouter({
    pool,
    token: adminToken,
    handoff,
    uploadDir: bootstrap.uploadDir,
    agentEnvDir: bootstrap.agentEnvDir,
    publicWebOrigin: bootstrap.publicWebOrigin,
    port: bootstrap.port,
    profile,
  })
);

app.get("/discover.json", async (_req, res, next) => {
  if (!publicBoardEnabled()) return res.status(404).json({ error: "not_found" });
  try {
    const file = await discoverBoard.file();
    // 允许浏览器直接用 30 秒内的那一份，过期后仍在后台校验一段时间。
    // 内容变化由 Backend 主动推送，页面不必每次打开都为校验多走一趟。
    res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=300");
    res.type("application/json; charset=utf-8");
    res.sendFile(file);
  } catch (error) {
    next(error);
  }
});

// 管理后台只在实例主机自己或同一内网打开，不随公开 WebUI 发布到入口。
// 静态文件在源码目录的 admin/，发布包里也在同一层。
const adminDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../admin");
app.use("/admin", adminPageRouter({ dir: adminDir }));

if (bootstrap.staticWebDir && fs.existsSync(bootstrap.staticWebDir)) {
  const dir = path.resolve(bootstrap.staticWebDir);
  app.use("/assets", express.static(path.join(dir, "assets"), { immutable: true, maxAge: "1y" }));

  // 页面由这里发出，站点自述在请求时补上：站名、简介、canonical 才不会停留在
  // 构建产物里的通用值。
  const render = createHtmlRenderer({ dir, profile, origin: bootstrap.publicWebOrigin });

  // robots.txt 与 sitemap.xml 是同一件事：站点地图里必须是绝对地址，
  // 没配公开地址时宁可不发，也不写一个相对的 loc。
  for (const [route, type, renderText] of [
    ["/robots.txt", "text/plain; charset=utf-8", renderRobots],
    ["/sitemap.xml", "application/xml; charset=utf-8", renderSitemap],
  ]) {
    app.get(route, (_req, res, next) => {
      if (fs.existsSync(path.join(dir, route.slice(1)))) return next();
      if (!render.origin) return next();
      res.type(type).send(renderText(render.origin));
    });
  }

  // /discover 有自己的静态壳（canonical 指向 /discover）。没有这份文件时宁可 404，
  // 也不要回 index.html：那样地址是 /discover，canonical 却指着首页。
  //
  // `.html` 直链只留一份可索引地址，入口 nginx 用同一条规则：否则同一页有两个
  // 地址都能打开，爬虫按 canonical 归一之前先把两条都抓一遍。
  app.get("/discover.html", (_req, res) => {
    res.redirect(301, "/discover");
  });

  // 早期分享出去的 /i/<记录 id> 是 Agent 自己拼出来的地址：指回深链，链接不至于 404。
  // 只认 uuid；别的 /i/... 仍然是 404，不拿这一条兜住任意路径。
  app.get("/i/:id", (req, res) => {
    const target = recordPath(req.params.id);
    if (!target) {
      res.status(404).type("text/plain").send("not found\n");
      return;
    }
    res.redirect(301, target);
  });

  app.get(["/discover", "/discover/"], (_req, res, next) => {
    const file = path.join(dir, "discover.html");
    if (!fs.existsSync(file)) return next();
    res.set("Cache-Control", "no-cache");
    render.send(res, file, "discover");
  });

  // 首页必须自己发：express.static 会把构建产物里那份原样交出去，站名就还是 "Knot"。
  // 其余真实文件（/assets、favicon 之类）仍然交给 static，这里只接管这两个入口。
  app.get(["/", "/index.html"], (_req, res) => {
    res.set("Cache-Control", "no-cache");
    render.send(res, path.join(dir, "index.html"), "index");
  });

  app.use(
    express.static(dir, {
      setHeaders(res, filePath) {
        if (path.basename(filePath) === "index.html") res.setHeader("Cache-Control", "no-cache");
      },
    })
  );

  // 只有 WebUI 真正定义过的路由才回 SPA 壳；其余路径是 404。
  // 以前一律回 index.html，任何拼错的地址都是 200（软 404），爬虫会当成无限多个页面。
  const SPA_PATH = /^\/(?:economy|mine(?:\/submissions)?|stars|friends|store|notifications|activity|delegate)?\/?$/;
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    if (!SPA_PATH.test(req.path)) {
      res.status(404).type("text/plain").send("not found\n");
      return;
    }
    res.set("Cache-Control", "no-cache");
    render.send(res, path.join(dir, "index.html"), "index");
  });
}

app.use((err, _req, res, _next) => {
  // 只记码与一句话：pg 的错误对象里 detail 会带上冲突行的取值（邮箱、正文片段），
  // 整份 console.error(err) 等于把用户数据写进日志。
  const code = String(err?.code || err?.status || "error");
  console.error(`knot-backend 未处理的错误：${code} ${String(err?.message || "").slice(0, 200)}`);
  res.status(500).json({ error: "internal" });
});

await loadEconomyPolicy(pool);

// 入口侧做完之后这一侧要自己来接：实例在 NAT 后，中枢拨不进来，所以由一个
// 低频轮询去拉进度、写 tunnel.env、重启隧道。没有接入的站点连 join.json 都没有，
// 一次文件读就结束，不会打到中枢。
try {
  const hubOrigin = hubOriginOf({
    status: federationStatus({
      agentEnvDir: bootstrap.agentEnvDir,
      publicWebOrigin: bootstrap.publicWebOrigin,
    }),
  });
  startXknotPoller({
    profileFile: profile.file,
    localPort: bootstrap.port,
    hubOrigin,
    intervalMs: pollIntervalMs(process.env.KNOT_XKNOT_POLL_SECONDS),
    restart: () => startTunnelAgent(),
    log: (line) => console.log(line),
  });
} catch (error) {
  // 拉取只是自动接通的一条腿：起不来不该影响站点本身，管理页里还能手动拉。
  console.error(`xknot 接入轮询未启动：${error.message}`);
}

const server = app.listen(bootstrap.port, bootstrap.bindHost, () => {
  console.log(`knot-backend listening on ${bootstrap.bindHost}:${bootstrap.port}`);
  resumePendingReviews(pool).catch((error) => console.error(error));
  // 检索打点只追加，按保留天数每天清一次，别让 count(*) 随运行时间变慢。
  startSearchEventRetention(pool);
});

// 部署脚本重启时先发 SIGTERM。不处理的话进程被直接掐断，进行中的上传、下载与
// 发布事务断在半路，pg 连接也没有关。这里先停止接收新连接，等在途请求走完再关池。
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`knot-backend 收到 ${signal}，停止接收新请求`);
  server.close(() => {
    pool
      .end()
      .catch((error) => console.error(error))
      .finally(() => process.exit(0));
  });
  // 在途请求迟迟不结束也不能一直挂着：到点直接退出，交给部署脚本重新拉起。
  const forced = setTimeout(() => process.exit(1), 15_000);
  forced.unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

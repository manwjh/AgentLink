#!/usr/bin/env node
// 自动接通常驻进程：把「已通过、已交公钥」的申请一路做到 /api 可用。
//
// 中枢不能拨进成员实例（对方在 NAT 后），所以这里只做入口主机这一侧：
// 账号、公钥、sshd、静态页、DNS 检查、nginx、证书。做完之后等对方把隧道起来，
// 探测 https://<子域>/api/health 通过，再把清单里的 status 从 pending 改成 active。
//
// 两件事顺带做在这里，因为它们都要求「中枢与入口同机」且都要常驻节拍：
// 隧道对端的出口 IP 采集（ops/peers.mjs），以及把各实例的公开快照取回落到入口磁盘
// （ops/snapshots.mjs）——读者远多于作者，首屏数据不该由访客去触发回源。
//
// 每一步都幂等，失败只记错误码并按退避重试（见 server/provision.mjs 的 RETRY_BACKOFF_MS）。
// 配置（不写死在仓库里）：
//   XKNOT_ENTRY_HOST   入口主机的公网地址，写在 var/provision.env
//   XKNOT_ADMIN_EMAIL  证书登记邮箱，读 mail.env
//   XKNOT_PROVISION_INTERVAL_MS  轮询间隔，默认 20000
//   XKNOT_AWAITING_TIMEOUT_MS    等隧道多久算停滞并记事件，默认 1800000（30 分钟）
//   XKNOT_SNAPSHOT_INTERVAL_MS   公开快照取回间隔，默认 20000
//   XKNOT_AFTER_ACTIVATE  可选：改为 active 之后执行的脚本绝对路径（例如重建门户）
//
// 运行方式见 ops/xknot-provision.service。

import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as dns } from "node:dns";

import { markActive, markRosterLive, publishInstance } from "../server/publish.mjs";
import { openStore } from "../server/store.mjs";
import { collectPeers } from "./peers.mjs";
import { resolveLocations } from "./geoip.mjs";
import { refreshStatus } from "./node-status.mjs";
import { SNAPSHOT_STORE, collectSnapshots } from "./snapshots.mjs";
import { warmEntry } from "./warm-entry.mjs";
import { notifyLive } from "./notify-live.mjs";
import {
  AWAITING_TIMEOUT_MS,
  ProvisionError,
  createRun,
  dueStep,
  isStalled,
  keyChanged,
  pendingStep,
  reconcileTunnel,
  refreshKeySteps,
  runStep,
  stepDone,
  stepFailed,
  stepRetry,
  switchEntry,
  tunnelFor,
} from "../server/provision.mjs";
import { probe } from "./check-health.mjs";
import { invokedDirectly } from "./lib/main-module.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dataDir = process.env.XKNOT_DATA_DIR || path.join(root, "var");
const manifestFile = process.env.XKNOT_INSTANCES_FILE
  ? path.resolve(process.env.XKNOT_INSTANCES_FILE)
  : path.join(root, "instances.json");
const rosterFile = process.env.XKNOT_FEDERATION_FILE
  ? path.resolve(process.env.XKNOT_FEDERATION_FILE)
  : path.join(root, "federation.json");
const entryHost = String(process.env.XKNOT_ENTRY_HOST || "").trim();
const adminEmail = String(process.env.XKNOT_ADMIN_EMAIL || "").trim();
const intervalMs = Math.max(Number(process.env.XKNOT_PROVISION_INTERVAL_MS) || 20_000, 5_000);
// 入口侧做完之后等隧道的上限。超过就把「没人来拉参数」写成一条事件，
// 否则这张单会一直停在 awaiting_tunnel，日志里只剩「没有新日志」。
const awaitingTimeoutMs = Math.max(
  Number(process.env.XKNOT_AWAITING_TIMEOUT_MS) || AWAITING_TIMEOUT_MS,
  60_000
);
const probeTimeoutMs = 8000;
// 接通后的可选钩子。读一次就定下来，执行处只按参数数组跑（见 advance）。
const afterActivate = String(process.env.XKNOT_AFTER_ACTIVATE || "").trim();
// 位置采集比接通慢得多：机器搬家不是秒级事件，而 ss/ps 每次要起两个进程。
const peerIntervalMs = Math.max(Number(process.env.XKNOT_PEER_INTERVAL_MS) || 60_000, 10_000);
const peersFile = path.join(dataDir, "peers.json");
const geoDir = path.join(dataDir, "geoip");
// 快照按间隔取回：内容一天只变 20–100 次，而访客几乎每时每刻都在。取回这一层
// 把「谁来看一眼就穿一次隧道」换成「中枢定时问一次」，间隔可以比访客间隔长得多。
const snapshotIntervalMs = Math.max(Number(process.env.XKNOT_SNAPSHOT_INTERVAL_MS) || 20_000, 5_000);
const snapshotsFile = path.join(dataDir, SNAPSHOT_STORE);

const store = openStore(path.join(dataDir, "xknot.db"));

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// 门户是静态快照：把 status 改成 active 只是改了清单，卡片要等 data/hub.json 重算。
// 不在这里重算，节点就会一直「在线但首页没有它」，直到有人手工构建一次。
// 用子进程跑，不阻塞轮询；失败只留一行日志，xknot-republish.timer 会补。
let portalChild = null;
export function refreshPortal({ execPath = process.execPath, script = path.join(here, "republish.mjs") } = {}) {
  if (portalChild) return; // 同一轮里接通多个节点时，跑一次就够
  // 没给门户根目录时，republish 会退回 <仓库>/web/dist/data/hub.json——那不是
  // nginx 在发的文件，重算等于白做。worker 的 unit 里必须带 XKNOT_WEB_ROOT
  // （与 xknot-republish.service 同一份取值），缺了就说清楚，别静默。
  if (!process.env.XKNOT_WEB_ROOT) {
    log("门户快照未重算：XKNOT_WEB_ROOT 未设置，等定时任务补");
    return;
  }
  const child = spawn(execPath, [script, "--quiet"], { cwd: root, stdio: "inherit" });
  portalChild = child;
  child.on("close", (code) => {
    portalChild = null;
    log(code === 0 ? "门户快照已重算" : `门户快照重算失败（退出码 ${code}），等定时任务补`);
  });
  child.on("error", (error) => {
    portalChild = null;
    log(`门户快照重算无法启动：${error.message}`);
  });
}

// ---- 入口主机：只走参数数组，不经 shell ----

export function sudo(argv, { input = null, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("sudo", ["-n", ...argv], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

const host = {
  sudo,
  async readRootFile(file) {
    const result = await sudo(["cat", file]);
    return result.code === 0 ? result.stdout : null;
  },
  async writeRootFile(file, text, mode = "644", { owner = null } = {}) {
    // 先 tee 再 chmod 的话，600 的目标会有一小段时间按 tee 的 umask 落在 644，
    // 凭据文件在那个窗口里是他人可读的。让远端 shell 自己设 umask，文件从创建起就收紧；
    // 文件名作为位置参数传给 sh，不拼进命令串。
    const written = await sudo(["sh", "-c", 'umask 077; cat > "$0"', file], { input: text });
    if (written.code !== 0) throw new ProvisionError("write_failed", written.stderr);
    if (owner) await sudo(["chown", owner, file]);
    await sudo(["chmod", mode, file]);
  },
  // 公开文件：先写同目录的临时文件，再 rename 到位。nginx 随时可能在读这个路径，
  // 原地截断写会让它读到半份 JSON——一个访客的空白首屏，只在写入的那一瞬发生。
  async writeEntryFile(file, text) {
    const written = await sudo(
      ["sh", "-c", 'tmp="$1.tmp.$$"; umask 022; cat > "$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$1"', "sh", file],
      { input: text }
    );
    if (written.code !== 0) throw new Error(written.stderr.trim() || "write_failed");
  },
  // 实例不再提供快照时把磁盘上那份删掉，让 nginx 的 try_files 回落到隧道：
  // 留在那里的旧快照会一直发一份实例已经不再承认的内容。
  async removeEntryFile(file) {
    const removed = await sudo(["rm", "-f", file]);
    if (removed.code !== 0) throw new Error(removed.stderr.trim() || "remove_failed");
  },
  async resolve4(hostname) {
    try {
      return await dns.resolve4(hostname);
    } catch {
      return [];
    }
  },
  // 探测走 fetch-guard 时要一份「全部地址」：只查 A 记录会漏掉只有 AAAA 的实例，
  // 也会让地址校验拿不到完整的解析结果。
  async resolveAll(hostname) {
    const settled = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
    const addresses = [];
    for (const item of settled) {
      if (item.status === "fulfilled") addresses.push(...item.value);
    }
    return addresses;
  },
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

// ---- 站点位置：来自隧道对端，不看自述区 ----
//
// 实例在 NAT 后面，位置只能从「它连出来的那条连接」看出。入口主机与中枢是
// 同一台机器，所以这里直接读 sshd 的 socket 对端地址，再查一次 GeoIP。
// 见 ops/peers.mjs 与 ops/geoip.mjs。
//
// 读不到就保留上一份，不写空结果：一次 sudo 抖动不该把已知位置抹掉。
let peerAt = 0;
let peerError = "";
async function refreshPeers() {
  const now = Date.now();
  if (now - peerAt < peerIntervalMs) return;
  peerAt = now;

  const roster = await readJson(rosterFile, { members: [] });
  const result = await collectPeers({ members: roster.members || [] });
  if (result.error) {
    if (result.error !== peerError) {
      peerError = result.error;
      log(`位置采集跳过：${result.error} ${result.detail || ""}`.trim());
    }
    return;
  }
  peerError = "";
  await writeJson(peersFile, { collectedAt: new Date().toISOString(), peers: result.peers });
  try {
    const located = await resolveLocations({ dir: geoDir, peers: result.peers });
    if (located.error) log(`位置解析失败：${located.error}`);
    else if (located.resolved) log(`位置：新解析 ${located.resolved} 个地址`);
  } catch (error) {
    log(`位置写入失败：${error.message}`);
  }
  // 隧道与位置都是节点状态的一部分：采完就重算一次。
  try {
    await refreshStatus({ dataDir, instancesPath: manifestFile, federationPath: rosterFile });
  } catch (error) {
    log(`节点状态未更新：${error.message}`);
  }
}

// ---- 公开快照：把读者要的首屏数据放到入口磁盘 ----
//
// 见 ops/snapshots.mjs。这里只负责节拍与落盘：一个间隔问一遍名册里每个实例，
// 内容没变就什么都不做；失败保留上一份，下一轮接着比。
// 让一个实例挂住时只拖住它自己：8 秒超时 × 名册人数串起来会比轮询间隔还长，
// 那段时间里开通一步都推不动。同一时刻只跑一轮，避免两级写入交叉。
let snapshotBusy = false;
let snapshotAt = 0;
let snapshotError = "";
async function refreshSnapshots() {
  const now = Date.now();
  if (snapshotBusy || now - snapshotAt < snapshotIntervalMs) return;
  snapshotAt = now;
  snapshotBusy = true;
  try {
    const roster = await readJson(rosterFile, { members: [] });
    const store = await readJson(snapshotsFile, { entries: {} });
    const result = await collectSnapshots({ members: roster.members || [], host, store });

    // 同一类失败只喊一次，别每个间隔刷一行。
    const signature = result.errors.map((item) => `${item.id}:${item.error}`).join(",");
    if (signature !== snapshotError) {
      snapshotError = signature;
      if (signature) {
        log(`快照取回有失败：${result.errors.map((item) => `${item.id} ${item.error}`).join("，")}`);
      }
    }
    if (result.written.length) log(`快照已更新：${result.written.join("，")}`);
    if (result.removed.length) log(`快照已撤下：${result.removed.join("，")}`);
    if (result.dirty) await writeJson(snapshotsFile, result.store);
  } finally {
    snapshotBusy = false;
  }
}

// ---- 入口预热：接通那一刻先把首页与资产取一遍 ----
//
// 缓存是冷的时只有第一个访客在等，而个人站没有「很多人分摊第一次」。
// 按站点去重：同一个站不叠两次，不同站点各热各的（多个节点同时接通时都要热）。
const warming = new Set();
function warmEntryCache(run) {
  const origin = `https://${run.host}`;
  if (!run.host || warming.has(origin)) return;
  warming.add(origin);
  warmEntry({ origin })
    .then((result) => {
      if (result.error) log(`${run.instanceId}: 入口预热跳过（${result.error}）`);
      else log(`${run.instanceId}: 入口预热 ${result.warmed}/${result.assets} 个资产`);
    })
    .catch((error) => log(`${run.instanceId}: 入口预热失败 ${error.message}`))
    .finally(() => warming.delete(origin));
}

// 已验收节点每两分钟核对一次入口 conf 就够：部署覆盖的是清单文件，不是这份
// conf；20 秒一次对几十个节点就是一串白起的 sudo 子进程。
const ENTRY_CHECK_MS = 120_000;
const entryCheckedAt = new Map();
// 清单被运营改成 suspended / retired 时，worker 每轮都会撞上同一件事：
// 只在取值变化时记一行，不刷日志。
const refusedState = new Map();
const restoreErrorAt = new Map();

// 同一件事每 2 分钟才说一次：这些分支都是「等人处理」，每 20 秒喊一遍只会在
// journald 里刷屏，真正的新信息被埋掉。
function logThrottled(map, key, message, log) {
  if (Date.now() - (map.get(key) || 0) >= ENTRY_CHECK_MS) log(message);
  map.set(key, Date.now());
}

// 已验收节点的核对只依赖这一组东西，全部可替换：这段逻辑被两次「清理死代码」
// 误删过，没有测试盯着它，所以它得能脱离 sudo 与真实清单单独跑。
const activeDeps = {
  store,
  host,
  log,
  manifestFile,
  rosterFile,
  markActive,
  markRosterLive,
  publishInstance,
  switchEntry,
  refreshPortal,
  warmEntryCache,
  notifyLive,
};

/**
 * 已验收：清单仍是 active、名册备注已换、入口 conf 还是整站反代。
 * deploy-api.sh 会把仓库里的 instances.json 同步上来，那里可能还是 pending
 * 甚至没有这一条；接通是既成事实，以 provision_runs 为准，顺手改回来即可。
 */
export async function reconcileActive(run, deps = activeDeps) {
  let again = await deps.markActive({ manifestFile: deps.manifestFile, id: run.instanceId });
  if (again.changed) {
    deps.log(`${run.instanceId}: 清单被覆盖回 pending，已改回 active`);
    // 快照可能已经按 pending 重算过一遍（门户上少了一条），同样要补回来。
    deps.refreshPortal();
  }
  // 覆盖有时是整条消失（仓库那份清单里还没有这个节点）。接通记录还在，
  // 就按它把清单与名册补回去；否则下一次改清单的动作会把这个节点彻底弄丢。
  if (again.error === "not_listed") {
    const application = deps.store.getApplication(run.applicationId);
    if (!application) {
      logThrottled(restoreErrorAt, run.instanceId, `${run.instanceId}: 清单里没有这一条，接通记录也对不上申请，无法补回`, deps.log);
    } else if (application.status !== "approved") {
      // 撤回过的单不再补回：它从清单里消失是运营按撤回收尾的结果，
      // 自动补回去等于把一个已经离开的成员又挂上门户。
      logThrottled(
        restoreErrorAt,
        run.instanceId,
        `${run.instanceId}: 申请状态是 ${application.status}，不补回清单；需要下线请改 provision_runs`,
        deps.log
      );
    } else {
      const restored = await deps.publishInstance({
        application,
        tunnelAccount: run.account,
        tunnelPort: run.port,
        manifestFile: deps.manifestFile,
        rosterFile: deps.rosterFile,
      });
      if (restored.error || restored.entry == null) {
        // url_taken / id_taken 这类要靠人判断，重试也不会自己好：同一句话只喊一次。
        logThrottled(
          restoreErrorAt,
          run.instanceId,
          `${run.instanceId}: 清单条目已丢失，补回失败 ${restored.error || "unknown"}`,
          deps.log
        );
      } else {
        restoreErrorAt.delete(run.instanceId);
        again = await deps.markActive({ manifestFile: deps.manifestFile, id: run.instanceId });
        deps.log(
          `${run.instanceId}: 清单条目已丢失，按接通记录补回（${again.changed ? "active" : again.error || "未变更"}）`
        );
        // 补回来的条目只有申请里的字段：档位回落成默认、收录日期是今天。
        // 原来若不是免费收录，需要在清单里改回去——这句话就是要让人看见。
        deps.log(`${run.instanceId}: 补回的条目档位与收录日期按申请重建，如果原来是付费收录请手工改回`);
        deps.store.recordEvent("instance.manifest_restored", run.instanceId, null);
        await deps.markRosterLive({ manifestFile: deps.manifestFile, rosterFile: deps.rosterFile, id: run.instanceId });
        deps.refreshPortal();
      }
    }
  } else if (again.error === "not_pending") {
    // 运营在清单上做的暂停 / 下架不覆盖，但也不能静默：只在取值变化时记一次。
    if (refusedState.get(run.instanceId) !== again.status) {
      refusedState.set(run.instanceId, again.status);
      deps.log(`${run.instanceId}: 清单状态是 ${again.status || "unknown"}，不是 pending，不覆盖；等人处理`);
    }
  }

  const now = Date.now();
  if (now - (entryCheckedAt.get(run.instanceId) || 0) >= ENTRY_CHECK_MS) {
    entryCheckedAt.set(run.instanceId, now);
    try {
      // 名册里那句「等待接通验收」在节点通了之后就成假话。只换那句话，
      // 运营手写过的备注不动；顺手核对，靠这一轮把历史遗留的那几条也修掉。
      const note = await deps.markRosterLive({
        manifestFile: deps.manifestFile,
        rosterFile: deps.rosterFile,
        id: run.instanceId,
      });
      if (note.changed) deps.log(`${run.instanceId}: 名册备注已改为已接通`);
      else if (note.error && note.error !== "not_listed") {
        deps.log(`${run.instanceId}: 名册备注未更新 ${note.error}`);
      }
    } catch (error) {
      deps.log(`${run.instanceId}: 名册备注未更新 ${error.message}`);
    }
    try {
      const conf = await deps.switchEntry({ host: deps.host, run, entry: true });
      if (conf.changed) {
        deps.log(`${run.instanceId}: 入口已切回整站反代`);
        void deps.warmEntryCache(run);
      } else if (conf.external) {
        deps.log(`${run.instanceId}: 入口 conf 不是中枢生成的，保持现状不改写`);
      }
    } catch (error) {
      deps.log(`${run.instanceId}: 入口 conf 核对失败 ${error.code || error.message}`);
    }
  }
  return run;
}

/**
 * 验收通过的收尾：名册里那句话改成实情、门户快照重算、给伙伴寄上线信。
 * 三件事都不许把验收本身弄失败——各自吞掉错误，只留一行日志。
 */
export async function announceLive(run, deps = activeDeps) {
  // 名册里那句「等待接通验收」现在成了假话，顺手换掉；运营手写过的备注不动。
  try {
    const roster = await deps.markRosterLive({
      manifestFile: deps.manifestFile,
      rosterFile: deps.rosterFile,
      id: run.instanceId,
    });
    if (roster.changed) deps.log(`${run.instanceId}: 名册备注已改为已接通`);
    else if (roster.error) deps.log(`${run.instanceId}: 名册备注未更新 ${roster.error}`);
  } catch (error) {
    deps.log(`${run.instanceId}: 名册备注未更新 ${error.message}`);
  }
  // 清单变了，门户快照也得跟着变，否则节点「在线但首页没有卡片」。
  deps.refreshPortal();
  // 伙伴等的是「你的站已经通了」。只对新接通的节点发：notify_log 里已有
  // sent / pending 的同一个申请不会再发，运营手工补发过的也算。
  try {
    const sent = await deps.notifyLive({
      store: deps.store,
      application: deps.store.getApplication(run.applicationId),
    });
    if (sent.sent) deps.log(`${run.instanceId}: 已上线通知已发给伙伴`);
    else if (sent.skipped === "already_sent") deps.log(`${run.instanceId}: 已上线通知此前发过，不重发`);
    else if (sent.skipped === "no_smtp") deps.log(`${run.instanceId}: 没有 SMTP 配置，已上线通知未发（配置后手工补发）`);
    else deps.log(`${run.instanceId}: 已上线通知未发 ${sent.skipped || sent.failed}`);
  } catch (error) {
    deps.log(`${run.instanceId}: 已上线通知发送异常 ${error.message}`);
  }
}

/**
 * 这一轮要推的 run：最近 N 条 + 全部已验收的。
 * active 的 updated_at 停在激活那一刻，只按时间取会随节点增多沉出窗口，
 * 自愈就静默失效了；两条来源按申请号合并，同一份 run 只推一次。
 */
export function dueRuns(store, limit = 20) {
  const runs = new Map();
  for (const run of store.listProvisionRuns(limit)) runs.set(run.applicationId, run);
  for (const run of store.activeProvisionRuns()) runs.set(run.applicationId, run);
  return [...runs.values()];
}

export async function advance(run) {
  if (run.state === "active") return reconcileActive(run);
  if (run.state === "failed") return run;

  if (run.state === "provisioning") {
    const application = store.getApplication(run.applicationId);
    if (!application || application.status !== "approved") {
      const next = { ...run, state: "failed", lastError: "application_closed" };
      store.saveProvisionRun(next);
      return next;
    }

    // 端口按当前名册重算，而不是沿用 run 里上次分配的值：名册才是权威。
    // 同一轮里两条新申请会算进同一个最小空闲端口，先落盘的那个占住它；
    // 后者若继续信旧值，每轮发布都被判重复，永远停在 roster_invalid。
    const roster = await readJson(rosterFile, { members: [] });
    const current = reconcileTunnel({ run, members: roster.members || [] });
    if (current.account !== run.account || current.port !== run.port) {
      store.saveProvisionRun(current);
      log(`${run.instanceId}: 隧道参数按名册重算为 ${current.account} / ${current.port}`);
    }

    // 伙伴换了公钥：旧账号里的那份已经不匹配，从 account 起重跑一遍。
    if (keyChanged(current, application)) {
      const refreshed = refreshKeySteps(current, application);
      store.saveProvisionRun(refreshed);
      log(`${run.instanceId}: 公钥已更换，从 account 起重跑`);
      return refreshed;
    }

    // 取「现在该干的」而不是「还没完成的」：失败的那一步在退避窗口里时
    // 这里拿到 null，但 pendingStep 仍有值——那是等一会儿再试，不是做完了。
    const step = dueStep(current);
    if (!step) {
      if (pendingStep(current)) return current;
      const next = { ...current, state: "awaiting_tunnel", lastError: null, updatedAt: new Date().toISOString() };
      store.saveProvisionRun(next);
      log(`${run.instanceId}: 入口侧已完成，等待隧道与探测`);
      return next;
    }

    try {
      const result = await runStep({
        step: step.id,
        run: current,
        application,
        host,
        entry: { adminEmail, entryHost },
        roster,
        publish: ({ application: app, tunnelAccount, tunnelPort }) =>
          publishInstance({ application: app, tunnelAccount, tunnelPort, manifestFile, rosterFile }),
      });
      const done = stepDone({ ...current, attempts: (current.attempts || 0) + 1 }, step.id, result?.note ?? null);
      store.saveProvisionRun(done);
      log(`${run.instanceId}: ${step.id} 完成${result?.note ? `（${result.note}）` : ""}`);
      return done;
    } catch (error) {
      const code = error instanceof ProvisionError ? error.code : "internal";
      const detail = error instanceof ProvisionError ? error.detail : error.message;
      log(`${run.instanceId}: ${step.id} 失败 ${code}${detail ? ` — ${detail}` : ""}`);
      // 失败留在原地，按节拍重试；面板上同时保留错误码，不用等重试成功才知道卡在哪。
      const next = stepRetry({ ...current, attempts: (current.attempts || 0) + 1 }, step.id, code);
      store.saveProvisionRun(next);
      if (next.state === "failed") {
        // 有配额的步骤到上限了：再自动重试只会把限流窗口越拉越长。
        const stepState = next.steps.find((item) => item.id === step.id);
        log(`${run.instanceId}: ${step.id} 连续失败 ${stepState?.attempts || 0} 次，已停止自动重试，等人处理`);
      }
      return next;
    }
  }

  if (run.state === "awaiting_tunnel") {
    // 停了多久是这里唯一能发现的事：隧道一通就进 active，所以这个状态本身
    // 就说明对端还没来拉参数、或拉了没连上。只喊一次，不刷日志。
    if (isStalled(run, { timeoutMs: awaitingTimeoutMs })) {
      const next = { ...run, stallNotifiedAt: new Date().toISOString() };
      store.saveProvisionRun(next);
      store.recordEvent(
        "instance.awaiting_stalled",
        run.instanceId,
        `入口侧已完成，${Math.round(awaitingTimeoutMs / 60_000)} 分钟内没有等到隧道`
      );
      log(`${run.instanceId}: 等待隧道超过 ${Math.round(awaitingTimeoutMs / 60_000)} 分钟，已记事件`);
      return next;
    }
    const target = `https://${run.host}/api/health`;
    // 与健康巡检同一条守卫：不传 resolve 就只按主机名请求，私网/回环地址直接放过去。
    const result = await probe(target, { timeoutMs: probeTimeoutMs, resolve: host.resolveAll });
    if (result.status === "up" || result.status === "degraded") {
      // 先把首页从占位页切成整站反代，再对外报 active：
      // 顺序反过来会出现「清单是 active、打开还是占位页」。
      try {
        const conf = await switchEntry({ host, run, entry: true });
        if (conf.changed) {
          log(`${run.instanceId}: 隧道已通，首页改为整站反代`);
          // 缓存此刻是空的：先替第一个访客把首页和它的资产取一遍。
          void warmEntryCache(run);
        }
      } catch (error) {
        const code = error instanceof ProvisionError ? error.code : "entry_switch_failed";
        log(`${run.instanceId}: 切换整站反代失败 ${code}，下一轮重试`);
        // 不把 tls 标成 pending：证书那一步确实做完了，卡住的是切换。
        // 只留 lastError 让面板标红，下一轮自动重试。
        const next = { ...run, lastError: code, updatedAt: new Date().toISOString() };
        store.saveProvisionRun(next);
        return next;
      }
      const activated = await markActive({ manifestFile, id: run.instanceId });
      if (activated.error) {
        const next = { ...stepFailed(run, "activate", activated.error), state: "failed" };
        store.saveProvisionRun(next);
        // 清单被改成 suspended / retired 时不覆盖它：那是运营的决定，
        // 记一条事件让控制台看得到，而不是留一份「接通完成但没上架」的静默状态。
        store.recordEvent("instance.activate_refused", run.instanceId, activated.error);
        return next;
      }
      const next = {
        ...run,
        state: "active",
        tunnelConfirmedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.saveProvisionRun(next);
      store.recordEvent("instance.active", run.instanceId, null);
      log(`${run.instanceId}: /api/health 通过，清单已改为 active`);
      await announceLive(run, { store, log, manifestFile, rosterFile, markRosterLive, refreshPortal, notifyLive });
      if (afterActivate) {
        // 值来自 root 的 provision.env；交给 /bin/sh -c 就等于把那个文件的写权限
        // 变成 root 命令执行。只接受一个绝对路径，按参数数组执行，不经 shell 解析。
        if (!/^\/[A-Za-z0-9._/-]+$/.test(afterActivate)) {
          log("after-activate 跳过：只接受绝对路径，不能带空格或 shell 元字符");
        } else {
          const hook = spawn("/bin/sh", [afterActivate], { cwd: root, stdio: "inherit" });
          hook.on("close", (code) => log(`after-activate 退出码 ${code}`));
        }
      }
      return next;
    }
    return run;
  }

  return run;
}

async function tick() {
  // 位置采集与接通互不依赖：入口主机配置缺失时也要更新页面上的区域。
  await refreshPeers();
  // 快照取回不阻塞开通：某个实例挂住时，等它的 8 秒超时不该让别的单停在那儿。
  // 晚一轮取回没有任何后果——磁盘上那份旧快照仍然在发。
  refreshSnapshots().catch((error) => log(`快照取回失败：${error.message}`));

  if (!entryHost || !adminEmail) {
    log("缺少 XKNOT_ENTRY_HOST / XKNOT_ADMIN_EMAIL，自动接通不启动");
    return;
  }

  const roster = await readJson(rosterFile, { members: [] });
  // 同一轮里连续建几条 run 时，前一条的端口还没写进名册；本轮已分出去先记下，
  // 后一条才不会拿到同一个。
  const reserved = [];
  for (const application of store.applicationsAwaitingProvision()) {
    const instanceId = application.subdomain || "";
    if (!instanceId) continue;
    const tunnel = tunnelFor({ instanceId, members: roster.members || [], reserved });
    reserved.push(tunnel.port);
    const run = store.createProvisionRun(createRun({ application, tunnel, entryHost }));
    log(`${instanceId}: 新建接通任务 ${application.id}（${tunnel.account} / ${tunnel.port}）`);
    if (run) await advance(run);
  }

  // active 的 run 单独按状态取，见 dueRuns。
  for (const run of dueRuns(store)) {
    await advance(run);
  }
}

async function main() {
  log(`provision worker 启动：entry=${entryHost || "（未配置）"} 间隔 ${intervalMs}ms`);
  // 常驻循环；单轮异常不能把进程带走，否则一次 DNS 抖动要等 systemd 重启。
  for (;;) {
    try {
      await tick();
    } catch (error) {
      log(`轮询出错：${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// 直接运行时才进循环；被测试 import 时只提供 advance()。
if (invokedDirectly(import.meta.url)) {
  main();
}

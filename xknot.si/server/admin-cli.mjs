#!/usr/bin/env node
// 管理员与申请的命令行。
//
//   node server/admin-cli.mjs create-admin <username>      密码从 XKNOT_ADMIN_PASSWORD 读，或交互输入
//   node server/admin-cli.mjs list-admins
//   node server/admin-cli.mjs delete-admin <username>
//   node server/admin-cli.mjs reset-password <username>    密码同样从 XKNOT_ADMIN_PASSWORD 读，或交互输入
//   node server/admin-cli.mjs list [approved|withdrawn]
//   node server/admin-cli.mjs show <id>
//   node server/admin-cli.mjs manifest <id>                打印可直接粘贴的清单条目
//   node server/admin-cli.mjs publish <id> [--id slug] [--tunnel-account acct --tunnel-port port]
//                                                          写清单；给了隧道参数时同时写 federation.json
//   node server/admin-cli.mjs relay-token <instance> [--label text] [--daily 50]
//                                                          签一份委托发信凭据，明文只打印这一次
//   node server/admin-cli.mjs access <id> [--id slug] [--no-relay] [--daily 50] [--out 文件]
//                                                          生成实例的接入件（env 格式，见 docs/FEDERATION.md 7.4）
//                                                          默认签一份委托发信凭据；--no-relay 才不带
//   node server/admin-cli.mjs relay-tokens                 列出凭据（不含明文）
//   node server/admin-cli.mjs relay-revoke <tokenId|instance>
//                                                          吊销一份凭据，或整个实例的全部凭据
//   node server/admin-cli.mjs relay-disable <instance> [--note 原因]
//                                                          暂停该实例的委托发信：凭据与额度不动，可恢复
//   node server/admin-cli.mjs relay-enable <instance>      恢复该实例的委托发信
//   node server/admin-cli.mjs relay-log [n]                最近 n 条发信记录（只有域名，没有地址和正文）
//   node server/admin-cli.mjs notify <id> <event> [--url URL]
//                                                          补发/重发一封伙伴信；event 见 docs/PARTNER-MAIL.md
//                                                          partner.handoff 不能用它补发：交付走 handoff
//   node server/admin-cli.mjs handoff <id> --payload <file> [--ttl 72] [--offline]
//                                                          签一次性领取令牌并寄交付信；重发即作废旧链接
//                                                          --offline 不寄信，只打印领取地址
//   node server/admin-cli.mjs claims [<申请 id>]           列出领取记录及其状态（不含明文）
//   node server/admin-cli.mjs claim-revoke <领取记录 id|申请 id>
//                                                          作废一条领取链接，或这张单上全部未领取的
//   node server/admin-cli.mjs live <id> [--status up|down] 通知伙伴实例已上线
//   node server/admin-cli.mjs contact-revalidate <id>      发联系人复验信
//   node server/admin-cli.mjs suspend <id> [--condition 文案]
//                                                          发暂停收录信（清单状态仍需自己改）
//   node server/admin-cli.mjs retire <id> [--reclaim 日期] [--export 日期]
//                                                          发退出联邦信（清单状态仍需自己改）
//   node server/admin-cli.mjs notify-log [n] [--case id]   发信日志
//   node server/admin-cli.mjs provision-retry <申请 id>    放行停住的自动接通：清退避与失败标记，不动已完成的前置
//
// 发信命令需要 SMTP_HOST / MAIL_FROM，读法与接口进程一致（见 server/mail.mjs）。
// 两者没在环境里给出时，会自动读 `var/mail.env`（与 systemd 的 EnvironmentFile 同一份）。
//
// 示例：
//   XKNOT_ADMIN_PASSWORD='...' node server/admin-cli.mjs create-admin paul

import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { withFileLock } from "./file-lock.mjs";
import { loadEnvFile } from "./env-file.mjs";
import { createMailer, mailConfigFromEnv, isTransientMailError, mailErrorCode } from "./mail.mjs";
import { checkManifestEntry, toManifestEntry, toRosterMember } from "./manifest.mjs";
import { validateRoster } from "../ops/validate-federation.mjs";
import { TIERS } from "../ops/profile-schema.mjs";
import { ALL_EVENTS, TEMPLATE_VERSION, buildMail } from "./notify.mjs";
import { reopenRun } from "./provision.mjs";
import { openStore } from "./store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dataDir = process.env.XKNOT_DATA_DIR || path.join(root, "var");
// 发信取值在生产由 systemd 从 var/mail.env 读入。终端里没有 systemd，
// 就在进程启动时补同一份；已经显式给过的变量不覆盖。
loadEnvFile(path.join(dataDir, "mail.env"));
// 与接口共用同一个开关：本地联调/端到端可以指向一份测试清单，
// publish 也会写回那份文件，不动仓库里的实例表。
const manifestFile = process.env.XKNOT_INSTANCES_FILE
  ? path.resolve(process.env.XKNOT_INSTANCES_FILE)
  : path.join(root, "instances.json");
const rosterFile = process.env.XKNOT_FEDERATION_FILE
  ? path.resolve(process.env.XKNOT_FEDERATION_FILE)
  : path.join(root, "federation.json");
const store = openStore(path.join(dataDir, "xknot.db"));

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function askPassword() {
  if (process.env.XKNOT_ADMIN_PASSWORD) return process.env.XKNOT_ADMIN_PASSWORD;
  if (!stdin.isTTY) return "";
  const rl = createInterface({ input: stdin, output: stdout });
  const value = await rl.question("password (>= 10 chars): ");
  rl.close();
  return value;
}

async function readManifest() {
  return JSON.parse(await readFile(manifestFile, "utf8"));
}

async function readRoster() {
  return JSON.parse(await readFile(rosterFile, "utf8"));
}

// 先写临时文件再 rename：写到一半失败时，原来的 JSON 还是完整的。
// 临时名带 pid 与随机后缀：两个 CLI 同时 publish 时，固定叫 .tmp 的那一份
// 会互相覆盖，后 rename 的人把自己读到的旧内容写回去，前后两份更新一起丢。
async function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

function flag(rest, name, fallback = null) {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] ?? fallback : fallback;
}

function mailerFromEnv() {
  const config = mailConfigFromEnv();
  if (!config) return { error: "没有 SMTP 配置：需要 SMTP_HOST 与 MAIL_FROM（也可以写进 var/mail.env）" };
  return {
    config,
    mailer: createMailer(config),
    origin: config.origin,
    adminEmail: config.adminEmail,
    replyTo: String(process.env.XKNOT_MAIL_REPLY_TO || config.from).trim(),
    supportUrl: String(process.env.XKNOT_SUPPORT_URL || "").trim(),
  };
}

// 控制台上的发信总闸。库里没有这一行就是开着，所以老部署行为不变。
function mailSwitchError() {
  return store.getSetting("mail")?.value === "off"
    ? "发信总闸已关闭：打开 /admin 的「发信」面板，把它开回来再跑这条命令。"
    : null;
}

// 领取记录的状态由三个时间决定：被作废、被领走、到期。
// 先看作废：作废是运营方收回，和「伙伴领走了」是两件事，混成一句就分不清是谁关的。
function claimState(row, now = Date.now()) {
  if (row.revokedAt) return "已作废";
  if (row.usedAt) return "已领取";
  if (Date.parse(row.expiresAt) <= now) return "已过期";
  return "可领取";
}

// 命令行里只给到分钟：秒对运营判断没有用，反而把一行撑长。
function stamp(value) {
  return String(value || "").slice(0, 16).replace("T", " ");
}

// 命令行发信与接口走同一套模板和同一张日志表，区别只是同步等待结果。
async function sendEvent(eventName, application, extra = {}, { dedupeVersion = null } = {}) {
  if (!ALL_EVENTS.includes(eventName)) return fail(`未知事件：${eventName}`);
  // 发信总闸由 /admin 控制。关着的时候命令行也不许发，否则运维在终端绕一圈
  // 就能把「已经停掉的信」发出去，而界面上还显示着停。
  const closed = mailSwitchError();
  if (closed) return fail(closed);
  const env = mailerFromEnv();
  if (env.error) return fail(env.error);

  const message = buildMail(eventName, application, {
    origin: env.origin,
    adminEmail: env.adminEmail,
    replyTo: env.replyTo,
    supportUrl: env.supportUrl,
    ...extra,
  });
  if (!message) return fail("这封信没有收件人：检查 XKNOT_ADMIN_EMAIL 或申请单的邮箱");

  const reserved = store.beginNotify({
    event: eventName,
    caseId: application.id,
    stateVersion: dedupeVersion,
    locale: message.locale,
    toDomain: String(message.to).split("@").pop(),
    templateVersion: message.templateVersion || TEMPLATE_VERSION,
  });
  if (reserved.duplicate) {
    console.log(`同一版本已经发过 ${eventName}，跳过。`);
    return null;
  }

  try {
    await env.mailer.send(message);
    store.finishNotify(reserved.id, { status: "sent" });
    console.log(`已发送 ${eventName} → ${message.to}  《${message.subject}》`);
    return message;
  } catch (error) {
    // 记码不记原话：原话里可能带着收件地址，而这张表按约定不存完整地址。
    store.finishNotify(reserved.id, { status: "failed", error: mailErrorCode(error) });
    // 收信端的原话只有这里能看见，原样打给人看——这正是判断「等一会儿再来」
    // 还是「地址没了」的唯一依据。
    const reason = error.replyText ? `（${error.replyText}）` : "";
    const hint = isTransientMailError(error) ? "这是瞬时失败，过一阵重跑同一条命令即可。" : "";
    return fail(`发送失败：${mailErrorCode(error)} ${error.message}${reason}${hint ? `\n${hint}` : ""}`);
  }
}

async function main(argv) {
  const [command, ...rest] = argv;

  if (command === "create-admin") {
    const username = rest[0];
    if (!username) return fail("用法：create-admin <username>");
    const result = store.createAdmin({ username, password: await askPassword() });
    if (result.error) return fail(`建号失败：${result.error}`);
    console.log(`已创建管理员 ${result.admin.username}`);
    return;
  }

  if (command === "list-admins") {
    for (const admin of store.listAdmins()) {
      console.log(`${admin.username}\t创建 ${admin.createdAt}\t最近登录 ${admin.lastLoginAt || "—"}`);
    }
    return;
  }

  if (command === "delete-admin") {
    const result = store.deleteAdmin(rest[0]);
    if (result.error) return fail(`删除失败：${result.error}`);
    console.log(`已删除 ${rest[0]}`);
    return;
  }

  if (command === "reset-password") {
    const username = rest[0];
    if (!username) return fail("用法：reset-password <username>");
    const result = store.setPassword(username, await askPassword());
    if (result.error) return fail(`重设失败：${result.error}`);
    console.log(`已重设 ${result.admin.username} 的密码，旧会话已作废`);
    return;
  }

  if (command === "list") {
    const applications = store.listApplications({ status: rest[0] || null });
    if (!applications.length) {
      console.log("没有申请。");
      return;
    }
    for (const item of applications) {
      console.log(
        `${item.id}  ${item.status.padEnd(9)} ${item.createdAt.slice(0, 10)}  ${item.name}  <${item.url}>  ${item.email}`
      );
    }
    const counts = store.countsByStatus();
    console.log(
      `\n已通过 ${counts.approved || 0} · 已撤回 ${counts.withdrawn || 0} · 历史（拒绝/过期）${(counts.rejected || 0) + (counts.expired || 0)}`
    );
    return;
  }

  if (command === "show") {
    const application = store.getApplication(rest[0]);
    if (!application) return fail("没有这条申请");
    console.log(JSON.stringify(application, null, 2));
    return;
  }

  if (command === "manifest") {
    const application = store.getApplication(rest[0]);
    if (!application) return fail("没有这条申请");
    const entry = toManifestEntry(application);
    const problems = checkManifestEntry(entry);
    if (problems.length) {
      for (const problem of problems) console.error(`- ${problem}`);
      return fail("生成的条目过不了清单校验");
    }
    console.log(JSON.stringify(entry, null, 2));
    return;
  }

  if (command === "publish") {
    const application = store.getApplication(rest[0]);
    if (!application) return fail("没有这条申请");
    if (application.status !== "approved") return fail("只有已通过的申请才能写进清单");

    const idFlag = rest.indexOf("--id");
    const wantedId = idFlag >= 0 ? rest[idFlag + 1] : undefined;
    // 档位是中枢的决定，这里能直接给，不必写进清单后再手改。
    // 状态不给旗标：新条目恒为 pending，active 只由验收改。
    const wantedTier = flag(rest, "tier");
    if (wantedTier != null && !TIERS.includes(wantedTier)) {
      return fail(`--tier 只能是 ${TIERS.join(" / ")}，现在是 "${wantedTier}"。`);
    }

    const entry = toManifestEntry(application, { id: wantedId, tier: wantedTier || undefined });
    const problems = checkManifestEntry(entry);
    if (problems.length) {
      for (const problem of problems) console.error(`- ${problem}`);
      return fail("生成的条目过不了清单校验");
    }

    // 名册与清单一一对应：只写清单一半，npm run validate:federation 会立刻报错。
    // 给了隧道账号与端口就两份一起写，校验通过才落盘。
    const tunnelAccount = flag(rest, "tunnel-account");
    const tunnelPort = Number(flag(rest, "tunnel-port") || 0);
    // 旗标出现就要按名册走，不要因为端口写成非数字而静默退成只写清单。
    const withRoster = rest.includes("--tunnel-account") || rest.includes("--tunnel-port");
    if (withRoster) {
      if (!tunnelAccount) return fail("要写名册就得同时给 --tunnel-account 与 --tunnel-port。");
      if (!Number.isInteger(tunnelPort) || tunnelPort < 1024 || tunnelPort > 65535) {
        return fail("--tunnel-port 是 1024–65535 的整数。");
      }
    }

    // 查重、校验、落盘整段在锁内：接口进程与控制台的保存也在改同一份清单，
    // 「先读后写」中间被别人插进来，两边就会各写一份，前一个的条目消失。
    const outcome = await withFileLock(manifestFile, async () => {
      const manifest = await readManifest();
      if (manifest.instances.some((item) => item.url === entry.url)) {
        return { error: "清单里已有同一个站点地址" };
      }
      if (manifest.instances.some((item) => item.id === entry.id)) {
        return { error: `id "${entry.id}" 已被占用，用 --id 指定另一个` };
      }
      const roster = withRoster ? await readRoster() : null;
      if (roster && roster.members.some((member) => member.id === entry.id)) {
        return { error: `名册里已有 "${entry.id}"，不要重复写。` };
      }

      const nextRoster = roster
        ? {
            ...roster,
            updatedAt: new Date().toISOString().slice(0, 10),
            members: [
              ...roster.members,
              toRosterMember(entry, {
                tunnelAccount,
                tunnelPort,
                role: flag(rest, "role", "partner"),
                standing: flag(rest, "standing") || undefined,
                note: flag(rest, "note") || undefined,
              }),
            ],
          }
        : null;

      if (nextRoster) {
        const rosterProblems = validateRoster(nextRoster, {
          ...manifest,
          instances: [...manifest.instances, entry],
        });
        if (rosterProblems.length) return { error: "名册校验不过，两份文件都没有改动。", problems: rosterProblems };
      }

      const nextManifest = {
        ...manifest,
        updatedAt: new Date().toISOString().slice(0, 10),
        instances: [...manifest.instances, entry],
      };
      // 名册先写、清单后写，与 publish.mjs 同一个顺序：中途失败最多多一条
      // 待接通的名册成员，不会留下「清单里有、名册里没有」这种悬挂状态。
      if (nextRoster) await writeJsonAtomic(rosterFile, nextRoster);
      try {
        await writeJsonAtomic(manifestFile, nextManifest);
      } catch (error) {
        // 清单是「对外可见」那一份，写失败时把名册回滚到原值，两边一起回到改动前，
        // 不留下「名册有、清单无」。回滚本身失败也只能让它跟着抛，主流程照常报错。
        if (nextRoster) await writeJsonAtomic(rosterFile, roster);
        throw error;
      }
      return { ok: true, roster: Boolean(nextRoster) };
    });

    if (outcome.error) {
      for (const [label, errors] of outcome.problems || []) {
        for (const error of errors) console.error(`- ${label || "名册"}: ${error}`);
      }
      return fail(outcome.error);
    }

    console.log(`已写入 instances.json：${entry.id} → ${entry.url}`);
    if (outcome.roster) console.log(`已写入 federation.json：${entry.id}（${tunnelAccount} / ${tunnelPort}）`);
    else console.log("名册还没写：补 --tunnel-account 与 --tunnel-port，或在 federation.json 手工加同名成员。");
    console.log("下一步：npm run build，重新构建后再部署。");
    return;
  }

  if (command === "access") {
    // 生成伙伴实例要的接入件：只有中枢签发的东西，不含部署拓扑。
    // 格式是 env 文件，键名与语义见 docs/FEDERATION.md 第 7.4 节；
    // 实例把它存进自己的配置即可，用什么文件名、放哪个目录是它自己的事。
    const id = rest[0];
    if (!id || id === "--help" || id === "-h") {
      return fail("用法：access <申请编号> [--id 实例 id] [--no-relay] [--daily 50] [--out 文件]");
    }
    const application = store.getApplication(id);
    if (!application) return fail("没有这条申请");
    if (application.status !== "approved") {
      return fail(`申请当前是 ${application.status}；接入件只发给已通过的申请。`);
    }

    const instanceId = flag(rest, "id", application.subdomain);
    if (!instanceId) return fail("这条申请没有子域标签，清单里认不出实例；先补标签再发接入件。");
    const manifest = await readManifest();
    const instance = manifest.instances.find((item) => item.id === instanceId);
    if (!instance) return fail(`清单里没有实例 "${instanceId}"。先 publish，再发接入件。`);
    // 收录时是 pending，接通验收后才 active：接入件必须在 pending 阶段就能发，
    // 否则伙伴拿不到隧道凭据，永远等不到 active。挂起与退出之后不再签。
    if (!["pending", "active"].includes(instance.status)) {
      return fail(`实例 "${instanceId}" 当前是 ${instance.status}，不再发接入件。`);
    }

    const origin = String(process.env.XKNOT_PUBLIC_ORIGIN || "https://xknot.si").replace(/\/+$/, "");
    const today = new Date().toISOString().slice(0, 10);
    // 签发区一项一个键，键名与 instances.json 的字段一一对应，没有第二份同义键。
    // 值一律照抄清单：清单里没有的就留空，签发件不替中枢补一个档位或状态。
    const lines = [
      "# XKnot 接入件。键名与语义见 FEDERATION.md 第 7.4 节；由实例存进自己的配置。",
      `# 实例 ${instanceId} · 申请 ${application.id} · ${today}`,
      `XKNOT_INSTANCE_ID=${instanceId}`,
      `XKNOT_ISSUED_URL=${instance.url}`,
      `XKNOT_ISSUED_AT=${instance.since || ""}`,
      `XKNOT_ISSUED_TIER=${instance.tier || ""}`,
      `XKNOT_ISSUED_STATUS=${instance.status || ""}`,
      `XKNOT_HUB_ORIGIN=${origin}`,
    ];

    // 委托发信默认开通：联邦只有一张已验证的发信地址，实例自己配 SMTP 送达不稳。
    // 运营方要留一份纯 SMTP 的接入件时才写 --no-relay。
    if (!rest.includes("--no-relay")) {
      const daily = Number(flag(rest, "daily", 50)) || 50;
      // 重签即作废：每跑一次 access 都会发出去一份新件，旧件留着就是一把没人回收的钥匙。
      // 作废与新签在同一个事务里，见 store.rotateRelayToken。
      const issued = store.rotateRelayToken({
        instanceId,
        label: flag(rest, "label", `partner ${application.id}`),
        dailyLimit: daily,
        createdBy: process.env.XKNOT_ADMIN_USER || null,
      });
      if (issued.error) return fail(`签发委托发信凭据失败：${issued.error}`);
      if (issued.revoked.length) console.error(`已作废旧委托发信凭据 ${issued.revoked.join("、")}。`);
      // 发信地址按契约从中枢地址推导，不写进来：少一项就少一处对不上。
      lines.push(`XKNOT_HUB_RELAY_TOKEN=${issued.token}`);
      console.error(`已签委托发信凭据 ${issued.record.id}，每日上限 ${issued.record.dailyLimit}。`);
    } else {
      // 生成一份不带发信凭据的接入件，等于让这个实例回到纯 SMTP：
      // 库里还留着的旧凭据也要一起收掉，否则旧件仍能按中枢的发信地址发信。
      const revoked = store.revokeRelayToken(instanceId);
      if (revoked.revoked) {
        console.error(`按 --no-relay 已吊销该实例的 ${revoked.revoked} 份委托发信凭据。`);
      }
      lines.push("# 按 --no-relay 不带发信凭据；实例需要自己配 SMTP。", "# XKNOT_HUB_RELAY_TOKEN=");
    }

    const out = flag(rest, "out");
    const text = `${lines.join("\n")}\n`;
    if (out) {
      const target = path.resolve(out);
      await writeFile(target, text, { mode: 0o600 });
      // mode 只在新建文件时生效：覆盖一份本来就存在的 0644 文件，权限原样留着，
      // 里面却是刚签的发信凭据。所以写完再收一次。
      await chmod(target, 0o600);
      console.log(`写入 ${target}（权限 600）。用一次性领取交给伙伴，不要贴进聊天或邮件。`);
    } else {
      console.log(text.trimEnd());
    }
    return;
  }

  if (command === "relay-token") {
    const instanceId = rest[0];
    if (!instanceId) return fail("用法：relay-token <instance> [--label text] [--daily 50]");
    const manifest = await readManifest();
    const instance = manifest.instances.find((item) => item.id === instanceId);
    if (!instance) return fail(`清单里没有实例 "${instanceId}"`);
    if (instance.status !== "active") return fail(`实例 "${instanceId}" 不是 active，先改清单状态`);

    const labelIndex = rest.indexOf("--label");
    const dailyIndex = rest.indexOf("--daily");
    const result = store.createRelayToken({
      instanceId,
      label: labelIndex >= 0 ? rest[labelIndex + 1] : "",
      dailyLimit: dailyIndex >= 0 ? Number(rest[dailyIndex + 1]) : 50,
      createdBy: process.env.XKNOT_ADMIN_USER || null,
    });
    if (result.error) return fail(`签发失败：${result.error}`);
    console.log(`凭据 ${result.record.id} 已签给 ${instanceId}，每日上限 ${result.record.dailyLimit}`);
    console.log("明文只显示这一次，请直接写进实例的 XKNOT_HUB_RELAY_TOKEN：");
    console.log(result.token);
    console.log("\n吊销：node server/admin-cli.mjs relay-revoke " + result.record.id);
    return;
  }

  if (command === "relay-tokens") {
    const tokens = store.listRelayTokens();
    const off = new Set(store.listRelaySwitches().map((row) => row.instanceId));
    if (!tokens.length) {
      console.log("还没有委托发信凭据。");
      return;
    }
    for (const token of tokens) {
      const state = token.revokedAt
        ? `已吊销 ${token.revokedAt.slice(0, 10)}`
        : off.has(token.instanceId)
          ? "已关闭（可恢复）"
          : "有效";
      console.log(
        `${token.id}  ${token.instanceId.padEnd(16)} ${state.padEnd(16)} 每日 ${token.dailyLimit}  最近使用 ${token.lastUsedAt || "—"}  ${token.label || ""}`
      );
    }
    return;
  }

  // 暂停受理：凭据与额度都留着，实例侧不需要改任何东西。与吊销分开报，
  // 因为吊销是不可逆的——实例得换一份文件才能再发信。
  if (command === "relay-disable") {
    const instanceId = rest[0];
    if (!instanceId) return fail("用法：relay-disable <instance> [--note 原因]");
    const manifest = await readManifest();
    if (!manifest.instances.some((item) => item.id === instanceId)) {
      return fail(`清单里没有实例 "${instanceId}"`);
    }
    const result = store.setRelaySwitch(instanceId, {
      disabled: true,
      note: flag(rest, "note", ""),
      by: process.env.XKNOT_ADMIN_USER || "cli",
    });
    if (result.error) return fail(`关闭失败：${result.error}`);
    console.log(`已暂停 ${instanceId} 的委托发信。凭据仍在，实例会收到 403 relay_disabled；relay-enable 可恢复。`);
    return;
  }

  if (command === "relay-enable") {
    const instanceId = rest[0];
    if (!instanceId) return fail("用法：relay-enable <instance>");
    const result = store.setRelaySwitch(instanceId, { disabled: false });
    if (result.error) return fail(`恢复失败：${result.error}`);
    console.log(`${instanceId} 的委托发信已恢复。`);
    return;
  }

  if (command === "relay-revoke") {
    const result = store.revokeRelayToken(rest[0]);
    if (result.error) return fail(`吊销失败：${result.error}`);
    console.log(`已吊销 ${result.revoked} 份凭据（${result.instanceId}）`);
    return;
  }

  if (command === "relay-log") {
    const rows = store.listRelayLog(Number(rest[0]) || 50);
    if (!rows.length) {
      console.log("还没有发信记录。");
      return;
    }
    for (const row of rows) {
      console.log(
        `#${String(row.seq).padEnd(6)} ${row.at.slice(0, 19)}  ${row.instanceId.padEnd(16)} ${row.status.padEnd(9)} ${row.toDomain || "—"}${row.error ? `  ${row.error}` : ""}`
      );
    }
    return;
  }

  if (command === "notify") {
    const application = store.getApplication(rest[0]);
    if (!application) return fail("没有这条申请");
    const eventName = rest[1];
    if (!eventName) return fail(`用法：notify <id> <event>，可选 ${ALL_EVENTS.join(" / ")}`);
    // 交付信的全部作用是那条一次性领取链接；补发时手上没有链接，寄出去就是
    // 一封让伙伴点空的信。交付走 handoff：它会重签链接并作废旧链接。
    if (eventName === "partner.handoff") {
      return fail("交付信用 notify 补不了：跑 handoff <申请编号> --payload <文件>，它会重签链接并作废旧链接。");
    }

    const links = {};
    if (eventName === "partner.contact_revalidate") {
      const env = mailerFromEnv();
      links.confirmUrl = `${env.origin}/case/${application.caseKey}`;
    }
    await sendEvent(eventName, application, { links }, {});
    return;
  }

  if (command === "handoff") {
    const application = store.getApplication(rest[0]);
    if (!application) return fail("没有这条申请");
    if (application.status !== "approved") return fail("只有已通过的申请才能交付");
    const file = flag(rest, "payload");
    if (!file) return fail("用法：handoff <id> --payload <file> [--ttl 72] [--offline]");
    const payload = (await readFile(path.resolve(file), "utf8")).trim();
    if (!payload) return fail("payload 文件是空的");
    if (payload.length > 8000) return fail("payload 超过 8000 字，请精简后再交付");
    // 不寄信时只打印链接，由运营方线下转交；这也是邮件系统坏掉时唯一的路。
    const offline = rest.includes("--offline");

    // 先确认信能发出去，再动库：没有 SMTP 时造出领取令牌，链接只存在库里，
    // 谁也拿不到，还占着一份已经轮换过的资料。
    if (!offline) {
      const closed = mailSwitchError();
      if (closed) return fail(`${closed}（只想拿链接不寄信，加 --offline）`);
      const preflight = mailerFromEnv();
      if (preflight.error) return fail(`${preflight.error}（只想拿链接不寄信，加 --offline）`);
    }

    // ttl 可传 1–168：交付信与终端提示都要读这个值，写死 72 小时就是在
    // 告诉伙伴一个比真实过期时间更长的期限。
    const ttlHours = Math.min(Math.max(Number(flag(rest, "ttl", 72)) || 72, 1), 168);
    // 重发即作废：上一封信里的链接不该还能换出资料。新签与作废是同一个事务。
    const claim = store.rotateClaimToken({
      applicationId: application.id,
      payload,
      ttlHours,
      createdBy: process.env.XKNOT_ADMIN_USER || null,
    });
    if (claim.error) return fail(`生成领取令牌失败：${claim.error}`);
    if (claim.revoked.length) {
      console.log(`已作废 ${claim.revoked.length} 条旧领取链接：${claim.revoked.map((row) => row.id).join("、")}`);
    }

    const origin = String(process.env.XKNOT_PUBLIC_ORIGIN || "https://xknot.si").replace(/\/+$/, "");
    const claimUrl = `${origin}/claim/${claim.token}`;
    if (offline) {
      console.log(`领取地址（只显示这一次，链接 ${ttlHours} 小时后失效；未寄信）：\n${claimUrl}`);
      console.log(`领取记录 ${claim.id}，过期于 ${claim.expiresAt}`);
      return;
    }

    const message = await sendEvent(
      "partner.handoff",
      application,
      { links: { claimUrl }, claimTtlHours: ttlHours },
      {}
    );
    if (!message) {
      // 信没出去，这条链接没有任何人拿到。留着只是一把没人认领的钥匙，
      // 还会挡住下一次 handoff 的「唯一可领取」判断，于是当场收掉。
      const undone = store.revokeClaimTokens(claim.id);
      if (undone.revoked.length) {
        console.error(`交付信未寄出，已作废本次领取链接 ${claim.id}；重跑 handoff 会重新签发。`);
      }
      return;
    }
    console.log(`领取地址（只显示这一次，链接 ${ttlHours} 小时后失效）：\n${claimUrl}`);
    console.log(`领取记录 ${claim.id}，过期于 ${claim.expiresAt}`);
    return;
  }

  if (command === "claims") {
    const scope = rest[0] || null;
    const rows = store.listClaimTokens({ applicationId: scope });
    if (!rows.length) {
      console.log(scope ? `${scope} 没有领取记录。` : "还没有领取记录。");
      return;
    }
    for (const row of rows) {
      const state = claimState(row);
      const when = row.revokedAt
        ? `作废 ${stamp(row.revokedAt)}`
        : row.usedAt
          ? `领取 ${stamp(row.usedAt)}`
          : `过期 ${stamp(row.expiresAt)}`;
      console.log(
        `${row.id}  ${row.applicationId.padEnd(16)} ${state}  ${when}  签发 ${stamp(row.createdAt)}  ${row.payloadLength} 字节  ${row.createdBy || ""}`
      );
    }
    return;
  }

  if (command === "claim-revoke") {
    const key = rest[0];
    if (!key) return fail("用法：claim-revoke <领取记录 id|申请 id>");
    const result = store.revokeClaimTokens(key);
    if (!result.revoked.length) {
      return fail(
        `没有可作废的领取记录：${key} 不存在，或者这张单上的链接都已经领取 / 作废 / 过期。`
      );
    }
    for (const row of result.revoked) {
      console.log(`已作废领取链接 ${row.id}（申请 ${row.applicationId}）`);
    }
    return;
  }

  if (command === "live") {
    const application = store.getApplication(rest[0]);
    if (!application) return fail("没有这条申请");
    await sendEvent(
      "partner.live",
      application,
      { statusLabel: flag(rest, "status", "up") },
      {}
    );
    return;
  }

  if (command === "contact-revalidate") {
    const application = store.getApplication(rest[0]);
    if (!application) return fail("没有这条申请");
    const env = mailerFromEnv();
    await sendEvent(
      "partner.contact_revalidate",
      application,
      { links: { confirmUrl: `${env.origin}/case/${application.caseKey}` } },
      {}
    );
    return;
  }

  if (command === "suspend") {
    const application = store.getApplication(rest[0]);
    if (!application) return fail("没有这条申请");
    await sendEvent(
      "partner.suspended",
      application,
      {
        resumeCondition:
          flag(rest, "condition", "按暂停通知里列出的条件整改后，回复复验申请") ||
          "按暂停通知里列出的条件整改后，回复复验申请",
      },
      {}
    );
    console.log("提醒：instances.json 的状态与隧道账号不会自动改，按 ops 的暂停步骤处理。");
    return;
  }

  if (command === "retire") {
    const application = store.getApplication(rest[0]);
    if (!application) return fail("没有这条申请");
    const today = new Date();
    const plus = (days) => new Date(today.getTime() + days * 86400000).toISOString().slice(0, 10);
    await sendEvent(
      "partner.retired",
      application,
      { reclaimAt: flag(rest, "reclaim", plus(30)), exportUntil: flag(rest, "export", plus(30)) },
      {}
    );
    console.log("提醒：instances.json 的状态、DNS 记录与证书要按退役清单另行处理。");
    return;
  }

  if (command === "provision-retry") {
    // 有配额的步骤（证书）失败到上限会停手等人；等人把原因处理完，用这一条放行。
    // 规则在 server/provision.mjs 的 reopenRun：只清失败标记与退避，完成的不重跑。
    const run = store.getProvisionRun(rest[0]);
    if (!run) return fail("没有这条接通记录");
    if (run.corrupt) return fail("这条接通记录坏了：先看 provision_runs 里那一行");
    store.saveProvisionRun(reopenRun(run));
    store.recordEvent("instance.provision_retry", run.instanceId, "人工放行：清掉退避与失败标记");
    console.log(`${run.instanceId}: 已放行，worker 下一轮（不超过 20 秒）继续推进`);
    return;
  }

  if (command === "notify-log") {
    const rows = store.listNotifyLog(Number(rest[0]) || 50, flag(rest, "case"));
    if (!rows.length) {
      console.log("还没有发信记录。");
      return;
    }
    for (const row of rows) {
      // Message-ID 摆在最后：它是退信对账时唯一要抄回去的东西。
      console.log(
        `#${String(row.seq).padEnd(6)} ${row.at.slice(0, 19)}  ${(row.caseId || "—").padEnd(14)} ${row.event.padEnd(
          30
        )} ${row.status.padEnd(9)} ${row.toDomain || "—"}${row.error ? `  ${row.error}` : ""}${
          row.messageId ? `  id=${row.messageId}` : ""
        }`
      );
    }
    console.log("");
    console.log("补发退信：bounce <Message-ID> [--note 原因]");
    return;
  }

  if (command === "bounce") {
    // 退信只在阿里云邮件推送控制台的退信记录里看得到，中枢收不到：xknot.si 的 MX
    // 指向阿里云，这个域不设收款箱。所以闭环靠人把那一行的 Message-ID 抄回来。
    //
    // 只改 sent / accepted 的行。对不上号就明确说「没找到」，不猜：
    // 猜错等于把一封送到了的信标成退回，运营会照着它去重发第二封。
    const raw = rest[0];
    if (!raw) return fail("用法：bounce <Message-ID> [--note 原因]");
    // 退信报告里是 `<id@domain>` 整段；库里有 @ 前面那一段，两种写法都收。
    const messageId = String(raw).trim().replace(/^<|>$/g, "").split("@")[0];
    if (!messageId) return fail("这不是一个 Message-ID。");

    const known = store.findNotifyByMessageId(messageId);
    const result = store.recordBounce(messageId, { detail: flag(rest, "note") });
    if (!result.notified && !result.relayed) {
      return fail(
        known
          ? `这条 Message-ID 对应的记录状态是 ${known.status}，不是已发送，没有改。`
          : `库里没有这个 Message-ID（${messageId}）：要么是 2026-10-27 之前发的老信，` +
            `要么这个号抄错了。先在阿里云控制台核对退信记录里的 Message-ID 整段。`
      );
    }
    console.log(
      `已标记退回：伙伴/内部信 ${result.notified} 条，委托发信 ${result.relayed} 条` +
        (known ? `（${known.event} ${known.caseId || "—"}）` : "")
    );
    return;
  }

  fail(`未知命令：${command ?? "(空)"}`);
}

main(process.argv.slice(2))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => store.close());

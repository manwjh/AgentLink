// 运行状态巡检：探一次，按连续时长发信，并写回 var/health.json。
//
// 规则见 docs/HUB.md 第 5.1 节与 docs/JOIN.md：
//   - 连续 24 小时不可达 → 提醒伙伴（抄送内容不重复，只发一封给伙伴）
//   - 连续 7 天不可达   → 通知伙伴，条目从门户暂时隐藏（清单不动）
//   - 收录后 14 天仍未接通 → 提醒运营方
//   - 收录后 30 天仍未接通 → 从门户暂时隐藏
// 恢复探测后自动回到列表，不需要重新申请。
//
// 用法：
//   node ops/watch-health.mjs              # 探测、发信、写状态
//   node ops/watch-health.mjs --dry-run    # 只打印，不发信，也不写状态
//   node ops/watch-health.mjs --no-mail    # 探测并写状态，但不发信
//
// 定时：systemd timer 每 15 分钟一次，见 ops/xknot-health.service 与 ops/xknot-health.timer。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "./check-health.mjs";
import { refreshStatus } from "./node-status.mjs";
import { readProfiles } from "./profiles.mjs";
import { mailConfigFromEnv, mailErrorCode, sendMail } from "../server/mail.mjs";
import { ALERT_LABELS, buildMail } from "../server/notify.mjs";
import { invokedDirectly } from "./lib/main-module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

// 清单一律是本地化的名字；信里取英文，没有就用 id。
// 收件人与语种取自两处：实例自报的档案副本（var/profiles/<id>.json）和申请单。
// 清单 instances.json 只有签发区，不能往那里塞联系方式。
function siteOf(profiles, id) {
  return profiles?.[id]?.site || {};
}

function applicationOf(applications, instance) {
  if (!Array.isArray(applications)) return null;
  const url = String(instance?.url || "").replace(/\/$/, "");
  return (
    applications.find((item) => item?.subdomain && item.subdomain === instance?.id) ||
    applications.find((item) => item?.url && String(item.url).replace(/\/$/, "") === url) ||
    null
  );
}

// buildMail 要一份「申请单形状」的对象；档案副本与申请单补齐所需字段。
function asApplication(instance, { profiles = {}, applications = null } = {}) {
  const site = siteOf(profiles, instance.id);
  const application = applicationOf(applications, instance);
  return {
    id: instance.id,
    name: site.name || instance.id,
    url: instance.url,
    operator: site.owner || site.name || instance.id,
    // 优先用申请单里的邮箱：那是申请人自己填的、经过验证的渠道。
    email: application?.email || site.contact || "",
    region: site.region || "GLOBAL",
    timezone: site.timezone || "UTC",
    intro: site.intro || "",
    tags: Array.isArray(site.tags) ? site.tags : [],
    // 申请单上申请人选的语种；没有就用站点自己的默认语种，最后才按门户默认的英文发。
    locale: application?.locale || site.locale || "en",
    since: instance.since,
  };
}

// 事件 → 模板与收件人。伙伴收自己的提醒；平台清理只发运营方。
const ROUTES = {
  down_24h: { event: "partner.unreachable_24h", audience: "partner" },
  down_7d: { event: "partner.hidden_7d", audience: "partner" },
  never_14d: { event: "internal.instance_alert", audience: "operator" },
  never_30d: { event: "internal.instance_alert", audience: "operator" },
};

export async function watch(options = {}) {
  const {
    instancesPath = path.join(ROOT, "instances.json"),
    profilesDir = path.join(ROOT, "var", "profiles"),
    applications = null,
    healthPath = path.join(ROOT, "var", "health.json"),
    dryRun = false,
    mail = true,
    env = process.env,
    log = (line) => console.log(line),
    check = run,
    deliver = sendMail,
  } = options;

  const manifest = await readJson(instancesPath, null);
  if (!manifest || !Array.isArray(manifest.instances)) {
    throw new Error(`cannot read instances: ${instancesPath}`);
  }

  const profiles = await readProfiles(profilesDir);
  // --dry-run 不写状态：否则一次预览就会把 notified 标记吃掉，真正的那封信再也发不出去。
  const result = await check({
    instancesPath,
    outPath: healthPath,
    write: !dryRun,
    log: (line) => log(`  ${line}`),
    ...(options.checkOptions || {}),
  });

  const byId = new Map(manifest.instances.map((item) => [item?.id, item]));
  const config = mailConfigFromEnv(env);
  const sent = [];

  for (const notice of result.notices) {
    const instance = byId.get(notice.id);
    const route = ROUTES[notice.kind];
    if (!instance || !route) continue;

    const state = result.instances?.[notice.id] || {};
    const application = asApplication(instance, { profiles, applications });
    // 伙伴信按申请人填的语种发；给运营自己的提醒固定用中文，免得运营收到英文。
    if (route.audience !== "partner") application.locale = "zh-CN";
    const vars = {
      origin: config?.origin || "https://xknot.si",
      adminEmail: config?.adminEmail || "",
      outbox: config?.adminEmail || "",
      firstSeenAt: state.downSince || instance.since || "",
      checkedAt: result.checkedAt,
      httpStatus: state.httpStatus ?? "",
      latencyMs: state.latencyMs ?? "",
      alertLabel: ALERT_LABELS[notice.kind]?.[application.locale] || ALERT_LABELS[notice.kind]?.en || notice.kind,
    };

    const message = buildMail(route.event, application, vars);
    if (!message) {
      log(`! ${notice.id} ${notice.kind}: 没有收件人（模板 ${route.event}）`);
      continue;
    }

    if (dryRun || !mail) {
      log(`· ${notice.id} ${notice.kind} → ${message.to}（${route.event}）`);
      sent.push({ id: notice.id, kind: notice.kind, to: message.to, event: route.event, dryRun: true });
      continue;
    }

    if (!config) {
      log(`! ${notice.id} ${notice.kind}: 没有 SMTP 配置，信没有发出去（状态已记录，不会重发）`);
      continue;
    }

    try {
      await deliver(config, {
        to: message.to,
        subject: message.subject,
        text: message.text,
        replyTo: message.replyTo,
      });
      log(`✓ ${notice.id} ${notice.kind} → ${message.to}（${route.event}）`);
      sent.push({ id: notice.id, kind: notice.kind, to: message.to, event: route.event });
    } catch (error) {
      // 状态已经写下，这一封不会重发；下一档（7 天 / 30 天）仍会照常提醒。
      // 收信端的原话要打出来：`421 4.7.28 ... Bulk Email Senders Guidelines`
      // 与「地址不存在」是两种完全不同的处置。
      const reason = [mailErrorCode(error), error.replyText].filter(Boolean).join(" ");
      log(`! ${notice.id} ${notice.kind}: 发信失败 - ${error.message}${reason ? `（${reason}）` : ""}`);
    }
  }

  if (!result.notices.length) log("没有需要通知的状态变化。");

  // 健康是节点状态的一部分：写完 health.json 就重算一次，
  // 控制台与构建读到的始终是一份 status.json，而不是各读各的文件。
  if (!dryRun) {
    try {
      await refreshStatus({ dataDir: path.dirname(healthPath), instancesPath });
      log("节点状态已更新。");
    } catch (error) {
      log(`! 节点状态未更新：${error.message}`);
    }
  }

  return { ...result, sent };
}

function parseArgs(argv) {
  const args = { dryRun: false, mail: true };
  for (const item of argv) {
    if (item === "--dry-run") args.dryRun = true;
    else if (item === "--no-mail") args.mail = false;
  }
  return args;
}

const isMain = invokedDirectly(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  // 收件人优先取申请单（申请人自己填的邮箱与语种），读不到就只用档案副本里的联系方式。
  let applications = null;
  try {
    const { openStore } = await import("../server/store.mjs");
    applications = openStore(path.join(ROOT, "var", "xknot.db")).listApplications({ limit: 500 });
  } catch (error) {
    console.log(`读不到申请单（${error.code || error.message}），收件人只看站点档案。`);
  }
  watch({ ...args, applications, log: (line) => console.log(line) })
    .then((result) => {
      const states = Object.values(result.instances || {});
      const hidden = states.filter((state) => state.hiddenAt).length;
      console.log(
        `巡检完成：${states.length} 个实例，${hidden} 个暂时隐藏，${result.sent.length} 封信。`
      );
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

export { mailConfigFromEnv, sendMail };

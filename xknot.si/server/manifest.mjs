// 已通过的申请 → instances.json 的一条实例。
//
// 申请通过不等于自动上线：这里只生成一条能过校验的条目，
// 由人执行 admin-cli 写进清单，再重新构建门户。清单是版本库里的文件，
// 不让网页请求直接改它。
//
// 清单只装签发区（id、url、since、tier、status）和中枢自己要拉的地址。
// 站点的名称、介绍、联系方式由主理人在实例的 /admin 里写，中枢按
// GET /api/federation/profile 取回 —— 所以这里不再从申请里抄名字。
//
// url 只有一种来源：中枢签发的 https://<标签>.xknot.si。

import { validateInstance } from "../ops/validate-instances.mjs";
import { DEFAULT_TIER } from "../ops/profile-schema.mjs";
import { subdomainUrl } from "./validate.mjs";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

// 用地址的主机名当 id 的底子：伙伴换中文名时 id 也不会变成乱码。
export function suggestId(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  const label = host.split(".")[0] || "";
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  // 中文域名会被转成 xn--… 的 punycode，当 id 不好读，退回站点摘要。
  if (!slug.startsWith("xn--") && ID_RE.test(slug)) return slug;
  return `node-${host.replace(/[^a-z0-9]/g, "").slice(0, 12) || "partner"}`;
}

/**
 * @param {object} application 审核记录
 * @param {{ id?: string, since?: string, tier?: string }} options
 */
export function toManifestEntry(application, options = {}) {
  // 地址由标签拼成；标签就是实例 id，签发后不再变。
  const subdomain = String(application.subdomain || "").trim();
  const url = subdomain ? subdomainUrl(subdomain) : "";

  return {
    id: options.id || (ID_RE.test(subdomain) ? subdomain : suggestId(url)),
    url,
    since: options.since || new Date().toISOString().slice(0, 10),
    // 收录这一下就定了档位；不传按免费收录，之后在清单里改。
    tier: options.tier || DEFAULT_TIER,
    // 写进清单只是“已收录”。探测通过前保持 pending：不探、不上门户，
    // 验收后再把 status 改成 active。见 docs/HANDOFF.md。
    status: "pending",
  };
}

// 生成后立刻用发布前的同一套规则自检，避免审核员手工补字段。
export function checkManifestEntry(entry, seen = new Set()) {
  return validateInstance(entry, seen);
}

/**
 * 清单头里的 version 记的是「这份清单被改过几次」。
 * 校验器要求它是正整数，所以文件缺字段或写坏了都从 1 重新起算，
 * 不把后面的写入卡住。
 *
 * @param {unknown} current
 */
export function nextVersion(current) {
  return Number.isInteger(current) && current > 0 ? current + 1 : 1;
}

/**
 * 清单条目 + 分配的隧道 → 名册成员。名册与清单靠 id 双向对齐，
 * 所以 host 直接从条目的 url 取，不另设字段。
 *
 * @param {{ id: string, url: string, since?: string }} entry
 * @param {{ tunnelAccount: string, tunnelPort: number, role?: string, standing?: string, note?: string }} options
 */
export function toRosterMember(entry, options = {}) {
  const role = options.role || "partner";
  return {
    id: entry.id,
    host: new URL(entry.url).host,
    role,
    standing: options.standing || (role === "founder" ? "permanent" : "regular"),
    tunnel: { account: options.tunnelAccount, port: options.tunnelPort },
    listed: true,
    since: entry.since,
    note: options.note || "子域与隧道已登记，等待接通验收。",
    mode: "subdomain",
  };
}

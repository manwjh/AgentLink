// 联邦名册校验。名册不过就不发布。
//
// 名册（federation.json）记网络本身的成员事实：谁在、什么身份、
// 以及入口隧道的账号与端口。门户对外展示用的字段（名称、简介、标签）
// 不在这里，那些仍在 instances.json。两者必须对得上，否则就是脱钩。
//
// 接入只有一种：中枢签发 <标签>.xknot.si，静态页在入口主机，/api 走反向隧道。
//
// 用法：
//   node xknot.si/ops/validate-federation.mjs
//   node xknot.si/ops/validate-federation.mjs --roster ./federation.json --instances ./instances.json

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invokedDirectly } from "./lib/main-module.mjs";

export const ROLES = ["founder", "partner"];
export const STANDINGS = ["permanent", "regular"];
// 接入只有一个取值。字段留着，是因为名册结构与文档已经按它写了。
export const MODES = ["subdomain"];

const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 隧道账号会被拿去在入口主机上建系统账号：字符集够干净不代表名字安全，
// root、ec2-user、nginx 都能通过一条纯字符集的正则。只放行本流程自己的命名。
const ACCOUNT_RE = /^knot-tunnel(?:-[a-z0-9][a-z0-9-]{0,20})?$/;
// 就算将来改了前缀，这些名字也不许当隧道账号：它们已经属于系统或别的服务。
const RESERVED_ACCOUNTS = new Set([
  "root",
  "ec2-user",
  "nginx",
  "adm",
  "sshd",
  "www-data",
  "postgres",
  "ubuntu",
  "admin",
  "daemon",
  "nobody",
]);

/** 名册里的隧道账号能不能拿来建号。写名册与用名册的两侧共用这一条。 */
export function isTunnelAccount(value) {
  return typeof value === "string" && ACCOUNT_RE.test(value) && !RESERVED_ACCOUNTS.has(value);
}

function hostOf(value) {
  try {
    return new URL(String(value || "")).host.toLowerCase();
  } catch {
    return "";
  }
}

function checkDate(field, value, errors, { required } = {}) {
  if (value == null) {
    if (required) errors.push(`${field}: required`);
    return;
  }
  if (typeof value !== "string" || !DATE_RE.test(value)) errors.push(`${field}: must be YYYY-MM-DD`);
}

function validateMember(member, index, errors, seen) {
  const label = member?.id || `#${index}`;
  const id = member?.id;

  if (typeof id !== "string" || !ID_RE.test(id)) {
    errors.push("id: must be 2-32 chars, lowercase letters, digits, hyphens");
  } else if (seen.ids.has(id)) {
    errors.push(`id: duplicate "${id}"`);
  } else {
    seen.ids.add(id);
  }

  const host = member?.host;
  if (typeof host !== "string" || !HOST_RE.test(host)) {
    errors.push("host: must be a lowercase fully-qualified host name");
  } else if (seen.hosts.has(host)) {
    errors.push(`host: duplicate "${host}"`);
  } else {
    seen.hosts.add(host);
  }

  if (!ROLES.includes(member?.role)) errors.push(`role: must be one of ${ROLES.join(", ")}`);
  if (!STANDINGS.includes(member?.standing)) errors.push(`standing: must be one of ${STANDINGS.join(", ")}`);
  if (!MODES.includes(member?.mode)) errors.push(`mode: must be one of ${MODES.join(", ")}`);

  if (typeof member?.listed !== "boolean") errors.push("listed: must be true or false");
  checkDate("since", member?.since, errors, { required: member?.listed === true });

  if (member?.note != null) {
    if (typeof member.note !== "string" || member.note.trim() === "") errors.push("note: must be a non-empty string");
    else if ([...member.note].length > 200) errors.push("note: longer than 200");
  }

  const tunnel = member?.tunnel;
  if (tunnel == null) {
    errors.push("tunnel: required — every member is served through the entry tunnel");
  } else {
    if (typeof tunnel !== "object" || Array.isArray(tunnel)) {
      errors.push("tunnel: must be null or an object");
    } else {
      if (!isTunnelAccount(tunnel.account)) {
        errors.push("tunnel.account: must be knot-tunnel or knot-tunnel-<label>; system accounts are refused");
      } else if (seen.accounts.has(tunnel.account)) {
        errors.push(`tunnel.account: duplicate "${tunnel.account}"`);
      } else {
        seen.accounts.add(tunnel.account);
      }

      const port = tunnel.port;
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        errors.push("tunnel.port: must be an integer between 1024 and 65535");
      } else if (seen.ports.has(port)) {
        errors.push(`tunnel.port: duplicate ${port}`);
      } else {
        seen.ports.add(port);
      }
    }
  }

  return label;
}

export function validateMemberRecord(member, index = 0, seen = { ids: new Set(), hosts: new Set(), accounts: new Set(), ports: new Set() }) {
  const errors = [];
  validateMember(member, index, errors, seen);
  return errors;
}

export function validateRoster(roster, manifest) {
  const problems = [];
  if (!roster || typeof roster !== "object") return [["", ["roster: must be an object"]]];
  if (!Number.isInteger(roster.version) || roster.version < 1) problems.push(["", ["version: must be an integer >= 1"]]);
  if (typeof roster.updatedAt !== "string" || !DATE_RE.test(roster.updatedAt)) {
    problems.push(["", ["updatedAt: must be YYYY-MM-DD"]]);
  }
  if (typeof roster.hub !== "string" || !HOST_RE.test(roster.hub)) problems.push(["", ["hub: must be a host name"]]);
  if (!Array.isArray(roster.members)) return [...problems, ["", ["members: must be an array"]]];

  const seen = { ids: new Set(), hosts: new Set(), accounts: new Set(), ports: new Set() };
  for (const [index, member] of roster.members.entries()) {
    const errors = [];
    const label = validateMember(member, index, errors, seen);
    if (errors.length) problems.push([label, errors]);
  }

  // 创始实例：至少一个，每个都是永久账号、必须已收录。
  //
  // 这里不管档位。名册记的是「谁在这个联邦里、担什么角色」，档位是清单里
  // 逐实例的展示分级，两件事各有各的真源；名册去约束清单的档位，等于让一份
  // 文件替另一份做决定，两边一改就要互相对齐。
  const founders = roster.members.filter((member) => member?.role === "founder");
  if (!founders.length) {
    problems.push(["—", ['founder: at least one member must have role "founder"']]);
  } else {
    for (const founder of founders) {
      if (founder.standing !== "permanent") problems.push([founder.id, ["standing: a founder must be permanent"]]);
      if (founder.listed !== true) problems.push([founder.id, ["listed: a founder cannot be unlisted"]]);
    }
  }

  // 名册与清单必须一一对应：名册里 listed 的成员要出现在清单里，清单里每个实例都要在名册里。
  if (!manifest || !Array.isArray(manifest.instances)) {
    problems.push(["—", ["instances: cannot cross-check without instances.json"]]);
    return problems;
  }

  const byId = new Map(manifest.instances.map((instance) => [instance?.id, instance]));
  for (const member of roster.members) {
    const id = member?.id;
    if (!id) continue;
    const instance = byId.get(id);

    if (member.listed === true && !instance) {
      problems.push([id, ["listed: true but the instance is missing from instances.json"]]);
      continue;
    }
    if (member.listed === false && instance) {
      problems.push([id, ["listed: false but the instance is present in instances.json"]]);
      continue;
    }
    if (!instance) continue;

    const instanceHost = hostOf(instance.url);
    if (instanceHost && instanceHost !== member.host) {
      problems.push([id, [`host: "${member.host}" does not match the instance url host "${instanceHost}"`]]);
    }
    // 地址必须挂在中枢名下：签发子域是唯一的接入形态。
    if (instanceHost) {
      const underHub = instanceHost.endsWith(`.${String(roster.hub || "xknot.si").toLowerCase()}`);
      if (!underHub) {
        problems.push([id, [`host: must be under ${roster.hub}, got "${instanceHost}"`]]);
      }
    }
  }

  const rosterIds = new Set(roster.members.map((member) => member?.id).filter(Boolean));
  for (const instance of manifest.instances) {
    if (!rosterIds.has(instance?.id)) {
      problems.push([instance?.id || "—", ["roster: the instance is not registered in federation.json"]]);
    }
  }

  return problems;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function main(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const arg = (name, fallback) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : fallback;
  };

  const rosterPath = arg("--roster", path.join(here, "..", "federation.json"));
  const instancesPath = arg("--instances", path.join(here, "..", "instances.json"));

  const [roster, manifest] = await Promise.all([readJson(rosterPath), readJson(instancesPath)]);
  const problems = validateRoster(roster, manifest);

  if (!problems.length) {
    const listed = roster.members.filter((member) => member.listed).length;
    console.log(`${rosterPath}: ${roster.members.length} member(s), ${listed} listed, ok`);
    return 0;
  }

  for (const [id, errors] of problems) {
    console.error(`${id}:`);
    for (const error of errors) console.error(`  - ${error}`);
  }
  return 1;
}

const isMain = invokedDirectly(import.meta.url);
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

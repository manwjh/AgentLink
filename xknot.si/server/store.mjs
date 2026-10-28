// 申请与管理员账号的存储。
//
// 用 Node 自带的 node:sqlite，不留外部依赖；库文件放在 var/，不入版本库。
// 这一层只做读写，不判断业务，也不碰 HTTP。

import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { normalizePublicKey, subdomainUrl } from "./validate.mjs";

const SCHEMA = `
create table if not exists applications (
  id           text primary key,
  name         text not null,
  -- 接入模式，只有 subdomain 一种。
  mode         text,
  -- 自有域名，恒为 NULL。
  domain       text,
  -- 中枢签发的子域标签，签发后就是实例 id。
  subdomain    text,
  -- 对外地址，创建时由模式推出，之后不再变。
  url          text not null,
  operator     text not null,
  email        text not null,
  region       text not null,
  timezone     text not null,
  intro        text not null,
  tags         text not null default '[]',
  locale       text,
  status       text not null default 'approved',
  created_at   text not null,
  reviewed_at  text,
  reviewed_by  text,
  ip_hash      text,
  -- 可选服务（委托发信、橱窗、统计）。不影响接入模式。
  request_services text,
  proof_method     text,
  proof_at         text,
  public_key       text,
  -- 案例页的能力键：明文存放，因为每次补信都要重新拼出同一个地址。
  -- 它只在一个申请单内有效，泄露等同于泄露该申请单的收件箱。
  case_key         text,
  -- 每次状态迁移 +1，和事件一起作为发信幂等键。
  state_version    integer not null default 0,
  closed_at        text
);

create index if not exists applications_status on applications(status, created_at);
create index if not exists applications_url on applications(url);

-- 一次性领取令牌：交付资料（委托发信凭据等）只在这里留一份，取一次即作废。
-- 领取与作废分开记：used_at 是伙伴真的领走了，revoked_at 是运营方收回了链接
-- （重发交付时旧链接自动作废）。两者都能挡住再次领取，但审计要分得清是谁关的。
create table if not exists claim_tokens (
  id             text primary key,
  token_hash     text not null unique,
  application_id text not null,
  payload        text not null,
  created_at     text not null,
  expires_at     text not null,
  used_at        text,
  revoked_at     text,
  created_by     text
);

create index if not exists claim_tokens_application on claim_tokens(application_id);

-- 发信日志：不存正文、不存完整地址。状态迁移类事件靠 (event, case_id, state_version)
-- 唯一索引去重；运营类事件 state_version 为 NULL，SQLite 视作互不相等，可以补发。
--
-- message_id 只存 @ 前面那一段（不含域名，因为域名恒为发信地址的域）。
-- 收信端之后退信时，退信报告里带的是完整 Message-ID；这是把一封退信对回
-- 是哪一件事的唯一依据——收件地址在这张表里只有哈希，对不上。
create table if not exists notify_log (
  seq          integer primary key autoincrement,
  at           text not null,
  event        text not null,
  case_id      text,
  state_version integer,
  locale       text,
  to_domain    text,
  to_hash      text,
  template_version text,
  message_id   text,
  status       text not null,
  error        text
);

create unique index if not exists notify_once
  on notify_log(event, case_id, state_version);
create index if not exists notify_case on notify_log(case_id, at);

create table if not exists admins (
  id            text primary key,
  username      text not null unique,
  password_hash text not null,
  created_at    text not null,
  last_login_at text
);

create table if not exists sessions (
  token_hash text primary key,
  admin_id   text not null,
  created_at text not null,
  expires_at text not null
);

create table if not exists events (
  seq    integer primary key autoincrement,
  at     text not null,
  kind   text not null,
  ref    text,
  detail text
);

-- 委托发信：一份凭据绑定一个实例，可单独吊销、单独定额度。
create table if not exists relay_tokens (
  id           text primary key,
  instance_id  text not null,
  label        text,
  token_hash   text not null unique,
  daily_limit  integer not null default 50,
  created_at   text not null,
  created_by   text,
  revoked_at   text,
  last_used_at text
);

create index if not exists relay_tokens_instance on relay_tokens(instance_id);

-- 每个实例的委托发信开关。可逆：关掉只是暂停受理，凭据与额度都原样留着，
-- 打开就恢复。吊销凭据是不可逆的（实例得换文件），所以临时停一个节点不能靠吊销。
create table if not exists relay_switches (
  instance_id text primary key,
  disabled_at text not null,
  note        text,
  by          text
);

-- 只记域名与结果，不存收件地址和正文；删掉日志不影响任何实例。
create table if not exists relay_log (
  seq          integer primary key autoincrement,
  at           text not null,
  instance_id  text not null,
  token_id     text,
  to_domain    text,
  to_hash      text,
  subject_len  integer,
  idem_key     text,
  message_id   text,
  status       text not null,
  error        text
);

create index if not exists relay_log_instance on relay_log(instance_id, at);
create index if not exists relay_log_token on relay_log(token_id, at);

-- 成员入口：邮箱收一次性授权码，10 分钟有效。库里只留哈希，明文只在信里。
-- 一个邮箱同时只有最新一枚有效码：重新发信会把上一枚作废。
create table if not exists member_codes (
  code_hash   text primary key,
  email       text not null,
  instance_id text not null,
  created_at  text not null,
  expires_at  text not null,
  attempts    integer not null default 0,
  used_at     text
);

create index if not exists member_codes_email on member_codes(email, created_at);

-- 成员会话与管理员会话分开：浏览器可能同时是访客和运营者，
-- 一个 Cookie 失效不该把另一个踢掉。
create table if not exists member_sessions (
  token_hash  text primary key,
  email       text not null,
  instance_id text not null,
  created_at  text not null,
  expires_at  text not null
);

create index if not exists member_sessions_email on member_sessions(email, created_at);

-- 自动接通：一个申请单一条 run，整份状态与步骤序列以 JSON 存放。
-- 申请单本身仍是权威记录；这里只记「接通做到哪一步」，删掉可以重跑。
create table if not exists provision_runs (
  application_id text primary key,
  run            text not null,
  created_at     text not null,
  updated_at     text not null
);

create index if not exists provision_runs_updated on provision_runs(updated_at);

-- 中枢自己的一点点运行期开关。放库里而不是配置文件：改完立刻生效，
-- 不用登机器、不用改 env、不用重启；多进程（接口、CLI、worker）读同一份。
-- 没有这一行就是「按环境变量的默认值走」，所以清空等于恢复出厂。
create table if not exists settings (
  key   text primary key,
  value text not null,
  at    text not null,
  by    text
);
`;

// 依赖迁移补出来的列的索引，必须在 migrate() 之后建：
// 先跑这一段会报 no such column: case_key，库就打不开了。
const INDEXES = `
create index if not exists applications_case on applications(case_key);
`;

// 子域的唯一性要落成数据库约束，不能只靠调用方「先查后插」：接口进程与
// admin-cli、provision worker 是几个独立进程，查与插之间没有锁。
// 撤回把标签交回中枢，所以唯一性只落在 approved 上（见 OCCUPIED_STATUS）。
const UNIQUE_INDEXES = `
create unique index if not exists applications_subdomain_open
  on applications(subdomain)
  where status = 'approved' and subdomain is not null and subdomain <> '';
`;

// 申请单的状态机。写入只发生在 createApplication（直接 approved）与撤回。
// 状态取值就是这张表的键：另抄一份列表出去，改的时候必然漏掉一边。
const TRANSITIONS = {
  approved: ["withdrawn"],
  withdrawn: [],
  rejected: [],
  expired: [],
};

const TERMINAL_STATUSES = new Set(["withdrawn"]);

// 占用子域的状态只有一个：approved。撤回、拒绝、过期都把标签交回中枢。
// 预检（takenSubdomains）、提交（findOpenBySubdomain）与库里的唯一索引必须
// 用同一个集合，否则会出现「预检说可用、提交拿 409」——正是要避免的那种反馈。
const OCCUPIED_STATUS_SQL = "status = 'approved'";

// 允许通过 transition() 一起写回的列。用映射表挡住任意列名拼接。
const APPLICATION_PATCH_COLUMNS = {
  reviewedAt: "reviewed_at",
  reviewedBy: "reviewed_by",
};

// 表是 create table if not exists 建出来的，后来加的列不会自己长出来。
// 这里只做加法：加列、补索引，不动已有数据。
const APPLICATION_COLUMNS = [
  ["mode", "text"],
  ["domain", "text"],
  ["subdomain", "text"],
  ["request_services", "text"],
  ["proof_method", "text"],
  ["proof_at", "text"],
  ["public_key", "text"],
  ["case_key", "text"],
  ["state_version", "integer not null default 0"],
  ["closed_at", "text"],
];

// 版本化迁移：每一步带一个 version 与 up()，openStore 只执行 user_version 之后的步骤，
// 每步一个事务，跑完把 user_version 记成这一版的版本号。加新迁移就往数组尾部 push，
// 不要改动已经发布的步骤：库已经在它们上面记了版本号，改旧步骤等于让分叉。
const MIGRATIONS = [
  {
    version: 1,
    name: "backfill applications missing case keys",
    up(db) {
      // 没有案例键的行补一个；否则案例页与补信都没有入口。
      const missing = db
        .prepare("select id from applications where case_key is null or case_key = ''")
        .all();
      const fill = db.prepare("update applications set case_key = ? where id = ?");
      for (const row of missing) fill.run(randomBytes(9).toString("base64url"), row.id);
      // state_version 是 NULL 时也给个 0，幂等键才稳定。
      db.exec("update applications set state_version = 0 where state_version is null");
      // 补 mode：有标签就是签发子域，否则留空由读时推断。
      db.exec(`
        update applications
           set mode = 'subdomain'
         where (mode is null or mode = '')
           and subdomain is not null
           and subdomain <> ''
      `);
      // 留在队列里的申请一起结到 approved：等待过的人不该再等下去。
      // 可能没有 reviewed_at / reviewed_by，先确认列存在再写。
      const columns = new Set(db.prepare("pragma table_info(applications)").all().map((row) => row.name));
      if (columns.has("reviewed_at") && columns.has("reviewed_by")) {
        db.prepare(
          `update applications
              set status = 'approved',
                  reviewed_at = coalesce(reviewed_at, ?),
                  reviewed_by = coalesce(nullif(reviewed_by, ''), 'auto')
            where status in ('pending', 'verified', 'hold')`
        ).run(nowIso());
      } else {
        db.exec("update applications set status = 'approved' where status in ('pending', 'verified', 'hold')");
      }
    },
  },
  {
    version: 2,
    name: "drop unused verify_tokens",
    up(db) {
      // 归属验证流程留下的表，代码里已无任何引用。迁移只加不删的话，
      // 这类死表会一直堆在库里，让结构偏离代码全貌。表里只有令牌哈希与申请单 id，
      // 没有要保留的数据；显式 drop，让库结构回到代码定义的那一份。
      db.exec("drop table if exists verify_tokens");
    },
  },
  {
    version: 3,
    name: "claim tokens record revocation separately",
    up(db) {
      // 早先没有 revoked_at，作废只能借用 used_at，审计上分不清「伙伴领走了」
      // 与「运营方收回了」。新列补上后，把借用的那批按事件表搬回来：
      // claim.revoked 记过 id 的才算作废，其余 used_at 保持原样。
      const columns = new Set(db.prepare("pragma table_info(claim_tokens)").all().map((row) => row.name));
      if (!columns.has("revoked_at")) db.exec("alter table claim_tokens add column revoked_at text");
      db.exec(`
        update claim_tokens
           set revoked_at = used_at, used_at = null
         where revoked_at is null
           and used_at is not null
           and id in (select detail from events where kind = 'claim.revoked')
      `);
    },
  },
  {
    version: 4,
    name: "record the message id of every delivery",
    up(db) {
      // 退信是异步的：SMTP 先回 250，收信端之后再退。要把那封退信对回是哪一件事，
      // 只能靠 Message-ID——收件地址在这两张表里都只有哈希，对不上。
      // 新列之前的记录留空，历史退信仍然只能靠时间与收件域名人工猜。
      for (const table of ["notify_log", "relay_log"]) {
        const columns = new Set(db.prepare(`pragma table_info(${table})`).all().map((row) => row.name));
        if (!columns.has("message_id")) db.exec(`alter table ${table} add column message_id text`);
      }
      // 索引必须在这里建，不能写进 SCHEMA：SCHEMA 在迁移之前执行，老库的
      // notify_log 还没有这一列，一条 create index 就会让整个库打不开。
      db.exec("create index if not exists notify_message on notify_log(message_id)");
      db.exec("create index if not exists relay_log_message on relay_log(message_id)");
    },
  },
];

// 幂等的结构性修补：加列。不进迁移版本门控——
// 表是 create table if not exists 建出来的，后来加的列不会自己长出来。
function ensureColumns(db) {
  const existing = new Set(db.prepare("pragma table_info(applications)").all().map((row) => row.name));
  for (const [name, type] of APPLICATION_COLUMNS) {
    if (existing.has(name)) continue;
    db.exec(`alter table applications add column ${name} ${type}`);
  }
}

// 按 user_version 顺序执行尚未跑过的迁移。每步一个事务：要么完整执行并记下版本号，
// 要么整个回滚——进程在中途被杀不会留下「数据修了一半、版本号没记」的半成品。
// 拿到写锁后重读一次版本号：几个进程同时打开同一个库时，先拿锁的那个跑完迁移，
// 后拿锁的只可能跳过，不会重复执行。
function migrate(db) {
  ensureColumns(db);
  let current = Number(db.prepare("pragma user_version").get()?.user_version) || 0;
  for (const step of MIGRATIONS) {
    if (step.version <= current) continue;
    db.exec("begin immediate");
    try {
      const fresh = Number(db.prepare("pragma user_version").get()?.user_version) || 0;
      if (step.version <= fresh) {
        db.exec("commit");
        current = fresh;
        continue;
      }
      step.up(db);
      db.exec(`pragma user_version = ${step.version}`);
      db.exec("commit");
      current = step.version;
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }
}

function nowIso() {
  return new Date().toISOString();
}

function jsonList(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

// 申请编号：给人念得出来的短号，不暴露序号。
export function newApplicationId(at = new Date()) {
  const alphabet = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 去掉 I O
  const bytes = randomBytes(6);
  let body = "";
  for (const byte of bytes) body += alphabet[byte % alphabet.length];
  return `XK-${at.getUTCFullYear()}-${body}`;
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltText, hashText] = String(stored).split("$");
  if (scheme !== "scrypt" || !saltText || !hashText) return false;
  const salt = Buffer.from(saltText, "base64");
  const expected = Buffer.from(hashText, "base64");
  const actual = scryptSync(String(password), salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// 来源地址只落哈希。secret 不给默认值：漏传宁可当场报错，也不要静默退化成
// 一份无盐哈希——IPv4 只有 2³² 个地址，落库的 ip_hash 可以被穷举回原地址。
export function ipHash(ip, secret) {
  if (typeof secret !== "string" || !secret) throw new Error("ipHash requires a secret");
  return sha256(`${secret}|${ip}`).slice(0, 16);
}

// 账号名在两处参与判断：登录限流桶与查库。归一化只留一份，
// 否则用户名前后加一个空格就换了一个限流桶，而查库仍然命中同一个账号。
export function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

// SQLite 的唯一约束冲突。message 形如
// `UNIQUE constraint failed: applications.subdomain`。
function uniqueViolation(error, column = null) {
  const message = String(error?.message || "");
  if (!/UNIQUE constraint failed/i.test(message)) return false;
  return column ? message.includes(column) : true;
}

function ensureUniqueIndexes(db) {
  try {
    db.exec(UNIQUE_INDEXES);
  } catch (error) {
    // 建约束之前可能已经有两条同子域的 approved 单。不能为了建索引
    // 让库打不开：留一条日志，等运营把重复的那张撤回，下次启动再建。
    console.error("applications_subdomain_open 未建立:", error.message);
  }
}

export function openStore(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // 目录通常已是 0700，库文件再收一道，避免备份或临时复制时被其他用户读到。
  if (file !== ":memory:") {
    try {
      chmodSync(file, 0o600);
    } catch {
      // 文件系统不支持时靠目录权限。
    }
  }
  db.exec("pragma journal_mode = wal");
  db.exec("pragma busy_timeout = 5000");
  db.exec("pragma foreign_keys = on");
  db.exec(SCHEMA);
  migrate(db);
  db.exec(INDEXES);
  ensureUniqueIndexes(db);

  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);

  function event(kind, ref, detail) {
    db.prepare("insert into events (at, kind, ref, detail) values (?, ?, ?, ?)").run(
      nowIso(),
      kind,
      ref ?? null,
      detail == null ? null : String(detail)
    );
  }

  function rowToApplication(row) {
    if (!row) return null;
    // 有标签时地址由标签重算；没有标签的行直接用它自己存的 url，只为还能打开案例页。
    const subdomain = row.subdomain || null;
    return {
      id: row.id,
      name: row.name,
      subdomain,
      url: subdomain ? subdomainUrl(subdomain) : row.url || null,
      operator: row.operator,
      email: row.email,
      region: row.region,
      timezone: row.timezone,
      intro: row.intro,
      tags: jsonList(row.tags),
      locale: row.locale || null,
      status: row.status,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
      reviewedBy: row.reviewed_by,
      // ---- 接入模式与状态机 ----
      requestServices: jsonList(row.request_services),
      publicKey: row.public_key || null,
      caseKey: row.case_key || null,
      stateVersion: Number(row.state_version) || 0,
      closedAt: row.closed_at || null,
    };
  }

  return {
    file,
    db,
    close() {
      db.close();
    },

    // ---- 申请 ----

    // 同一个子域只允许一条有效申请。撤回之后可以重新提交，
    // 因为地址已经交回中枢；已通过而没撤回的再交一张会撞上这一条。
    // 「占用」与 takenSubdomains、唯一索引用同一个状态集合。
    findOpenBySubdomain(subdomain) {
      const label = String(subdomain || "").trim();
      if (!label) return null;
      return rowToApplication(
        get(
          `select * from applications
            where (subdomain = ? or url = ?)
              and ${OCCUPIED_STATUS_SQL}
            order by created_at desc limit 1`,
          label,
          subdomainUrl(label)
        )
      );
    },

    findByCaseKey(caseKey) {
      const key = String(caseKey || "").trim();
      if (!key) return null;
      return rowToApplication(get("select * from applications where case_key = ?", key));
    },

    createApplication(input) {
      const createdAt = nowIso();
      const reviewedAt = String(input.reviewedAt || createdAt);
      const reviewedBy = String(input.reviewedBy || "auto");
      const caseKey = randomBytes(9).toString("base64url");
      // 只签发子域；domain 恒为 NULL。
      const mode = "subdomain";
      const subdomain = String(input.subdomain || "").trim() || null;
      const domain = null;
      const url = subdomain ? subdomainUrl(subdomain) : String(input.url || "").trim();

      // 编号有撞号概率；撞上是主键冲突，不该变成 500：换一个号再试一次即可。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const id = newApplicationId(new Date(createdAt));
        // 提交即通过：不排队、不等人点。reviewed_by 记 auto，谁都没审过也说得清。
        // 申请与事件同一事务：进程在两条语句之间被杀时，不会留下一条没有事件可追的单。
        db.exec("begin immediate");
        try {
          db.prepare(
            `insert into applications
            (id, name, mode, domain, subdomain, url, operator, email, region, timezone, intro, tags, locale, status, created_at,
             reviewed_at, reviewed_by, ip_hash, request_services, case_key, state_version)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, 0)`
          ).run(
            id,
            input.name,
            mode,
            domain,
            subdomain,
            url,
            input.operator,
            input.email,
            input.region,
            input.timezone,
            input.intro,
            JSON.stringify(input.tags || []),
            input.locale || null,
            createdAt,
            reviewedAt,
            reviewedBy,
            input.ipHash || null,
            JSON.stringify(input.requestServices || []),
            caseKey
          );
          event("application.submitted", id, input.locale || null);
          db.exec("commit");
          return this.getApplication(id);
        } catch (error) {
          db.exec("rollback");
          // 同子域已有 approved 单：唯一索引挡住的是重复提交，按 409 回，不是 500。
          if (uniqueViolation(error, "applications.subdomain")) return { error: "duplicate" };
          if (uniqueViolation(error, "applications.id")) continue;
          throw error;
        }
      }
      return { error: "id_collision" };
    },

    getApplication(id) {
      return rowToApplication(get("select * from applications where id = ?", String(id)));
    },

    listApplications({ status = null, limit = 200 } = {}) {
      const capped = Math.min(Math.max(Number(limit) || 200, 1), 500);
      const rows = status
        ? all(
            "select * from applications where status = ? order by created_at desc limit ?",
            status,
            capped
          )
        : all("select * from applications order by created_at desc limit ?", capped);
      return rows.map(rowToApplication);
    },

    countsByStatus() {
      const out = { approved: 0, withdrawn: 0 };
      for (const row of all("select status, count(*) as n from applications group by status")) {
        out[row.status] = row.n;
      }
      return out;
    },

    // 发信概况：只统计窗口内的事件，不返回收件地址与正文。
    notifyStats(sinceIso) {
      const row =
        get(
          `select count(*) as total,
             sum(case when status = 'sent' then 1 else 0 end) as sent,
             sum(case when status = 'failed' then 1 else 0 end) as failed,
             sum(case when status = 'throttled' then 1 else 0 end) as throttled,
             max(at) as last_at
           from notify_log where at >= ?`,
          String(sinceIso)
        ) || {};
      return {
        total: Number(row.total) || 0,
        sent: Number(row.sent) || 0,
        failed: Number(row.failed) || 0,
        throttled: Number(row.throttled) || 0,
        lastAt: row.last_at || null,
      };
    },

    relayStats(sinceIso) {
      const row =
        get(
          `select count(*) as total,
             sum(case when status = 'accepted' then 1 else 0 end) as accepted,
             sum(case when status = 'failed' then 1 else 0 end) as failed,
             max(at) as last_at
           from relay_log where at >= ?`,
          String(sinceIso)
        ) || {};
      return {
        total: Number(row.total) || 0,
        accepted: Number(row.accepted) || 0,
        failed: Number(row.failed) || 0,
        lastAt: row.last_at || null,
      };
    },

    // 状态迁移的唯一入口：版本号 +1，供发信幂等使用。
    // 允许的迁移集中在 TRANSITIONS，越界一律 invalid_transition。
    transition({ id, to, patch = {}, admin = null, eventKind = null }) {
      const current = this.getApplication(id);
      if (!current) return { error: "not_found" };
      const allowed = TRANSITIONS[current.status] || [];
      if (!allowed.includes(to)) {
        return { error: "invalid_transition", from: current.status, to };
      }
      const fields = ["status = ?", "state_version = state_version + 1"];
      const values = [to];
      for (const [key, column] of Object.entries(APPLICATION_PATCH_COLUMNS)) {
        if (!Object.hasOwn(patch, key)) continue;
        fields.push(`${column} = ?`);
        const value = patch[key];
        values.push(Array.isArray(value) ? JSON.stringify(value) : value ?? null);
      }
      if (TERMINAL_STATUSES.has(to)) {
        fields.push("closed_at = ?");
        values.push(nowIso());
      }
      // 前态写进 where：读与写之间，另一个进程（admin-cli、另一个 worker 轮次）
      // 可能已经先迁走了。只按 id 更新会让两次迁移都成功，版本号与事件各记一遍。
      values.push(current.id, current.status);
      db.exec("begin immediate");
      try {
        const result = db
          .prepare(`update applications set ${fields.join(", ")} where id = ? and status = ?`)
          .run(...values);
        if (Number(result.changes) !== 1) {
          db.exec("rollback");
          return { error: "invalid_transition", from: current.status, to };
        }
        // 事件与状态一起提交：进程被杀时不会留下「状态变了、事件没有」的半成品。
        event(eventKind || `application.${to}`, current.id, admin || null);
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
      return { application: this.getApplication(current.id) };
    },

    // 撤回：申请通过之后，伙伴仍然可以把这张单收回去。
    withdrawApplication(id) {
      return this.transition({
        id,
        to: "withdrawn",
        eventKind: "application.withdrawn",
      });
    },

    setPublicKey({ id, publicKey }) {
      const current = this.getApplication(id);
      if (!current) return { error: "not_found" };
      // 撤回之后的单不再接通，公钥写进去也没有下一手会读它；
      // 让它写成功只会把版本号推高、给界面一个「存上了」的假象。
      if (current.status !== "approved") return { error: "not_approved" };
      // 写入方必须自己也校验：这一列最后会被逐字写进入口主机的 authorized_keys，
      // 含换行就等于往 root 属主的文件里追加第二行。app.mjs 校验过不代表这里安全——
      // 其余调用方（接口、脚本、将来的迁移）都从这一层过。
      const key = normalizePublicKey(publicKey);
      if (!key) return { error: "bad_public_key" };
      db.prepare("update applications set public_key = ?, state_version = state_version + 1 where id = ?")
        .run(key, current.id);
      event("application.public_key", current.id, null);
      return { application: this.getApplication(current.id) };
    },

    // ---- 自动接通 ----

    // 同一个申请单只跑一条 run。重试由 worker 在同一行上推进，不新建。
    // 唯一例外是坏掉的那一行：JSON 解析不出来时它既不推进也不重来，
    // 只能整行覆盖成一份全新的 run，否则接通永远停在「有行、没人认」。
    createProvisionRun(run) {
      const stamp = nowIso();
      db.prepare(
        `insert into provision_runs (application_id, run, created_at, updated_at) values (?, ?, ?, ?)
         on conflict(application_id) do update set run = excluded.run, updated_at = excluded.updated_at
         where json_valid(provision_runs.run) = 0`
      ).run(String(run.applicationId), JSON.stringify(run), stamp, stamp);
      return this.getProvisionRun(run.applicationId);
    },

    getProvisionRun(applicationId) {
      const row = get("select * from provision_runs where application_id = ?", String(applicationId || ""));
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.run);
        return parsed && typeof parsed === "object" ? parsed : { applicationId: row.application_id, corrupt: true };
      } catch {
        // 不吞成 null：null 和「还没有 run」长得一样，案例页会显示 run: null，
        // 而 applicationsAwaitingProvision 的 left join 又不再选中它——静默停住。
        return { applicationId: row.application_id, corrupt: true };
      }
    },

    saveProvisionRun(run) {
      db.prepare("update provision_runs set run = ?, updated_at = ? where application_id = ?").run(
        JSON.stringify(run),
        nowIso(),
        String(run.applicationId)
      );
      return this.getProvisionRun(run.applicationId);
    },

    // 坏行不当成不存在：列表里保留一个占位，控制台才看得见「这条接通卡住了」。
    listProvisionRuns(limit = 50) {
      return all(
        "select application_id, run, updated_at from provision_runs order by updated_at desc limit ?",
        Math.min(Number(limit) || 50, 200)
      ).map((row) => {
        try {
          const parsed = JSON.parse(row.run);
          if (parsed && typeof parsed === "object") return parsed;
        } catch {
          // 落到下面的占位。
        }
        return {
          applicationId: row.application_id,
          state: "failed",
          lastError: "run_corrupt",
          steps: [],
          updatedAt: row.updated_at,
          corrupt: true,
        };
      });
    },

    // 已验收的 run：worker 每轮核对它们还在清单里、入口 conf 还是整站反代。
    // 不能靠 listProvisionRuns 的前 N 条：active 的 updated_at 停在激活那一刻，
    // 节点一多就沉出窗口，自愈会静默失效。按 state 取，条数按节点量给足。
    activeProvisionRuns(limit = 200) {
      return all(
        `select application_id, run from provision_runs
          where json_valid(run) and json_extract(run, '$.state') = 'active'
          order by updated_at desc limit ?`,
        Math.min(Number(limit) || 200, 500)
      ).flatMap((row) => {
        try {
          const parsed = JSON.parse(row.run);
          return parsed && typeof parsed === "object" ? [parsed] : [];
        } catch {
          // 坏行已经在 listProvisionRuns 里当占位出现，这里跳过就好。
          return [];
        }
      });
    },

    // 已通过、已交公钥、还没有 run 的单：worker 每一轮都用它来发现新活。
    // run 那一列的 JSON 坏掉时也重新选中：那一行不推进也不重来，等于永久停住。
    applicationsAwaitingProvision() {
      return all(
        `select a.* from applications a
          left join provision_runs r on r.application_id = a.id
         where a.status = 'approved'
           and a.public_key is not null and a.public_key <> ''
           and (r.application_id is null or json_valid(r.run) = 0)
         order by a.created_at asc
         limit 20`
      ).map(rowToApplication);
    },

    // ---- 一次性领取令牌 ----

    createClaimToken({ applicationId, payload, ttlHours = 72, createdBy = null }) {
      const current = this.getApplication(applicationId);
      if (!current) return { error: "not_found" };
      const token = randomBytes(32).toString("base64url");
      const id = `clm_${randomBytes(6).toString("hex")}`;
      const createdAt = nowIso();
      const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
      db.prepare(
        `insert into claim_tokens (id, token_hash, application_id, payload, created_at, expires_at, used_at, revoked_at, created_by)
         values (?, ?, ?, ?, ?, ?, null, null, ?)`
      ).run(id, sha256(token), current.id, String(payload), createdAt, expiresAt, createdBy);
      event("claim.issued", current.id, id);
      return { id, token, expiresAt, applicationId: current.id };
    },

    // 重发交付用：新件落库与旧件作废在同一个事务里。
    // 交付信里的链接是能力的全部凭据，重发往往意味着旧件不该再用（资料换了、
    // 凭据轮换了、上一封发错了人）。分两次写会留下「新链接已寄、旧链接还能领」
    // 的窗口，中间失败更会留下一条谁也拿不到的令牌。
    rotateClaimToken({ applicationId, payload, ttlHours = 72, createdBy = null }) {
      db.exec("begin immediate");
      try {
        const issued = this.createClaimToken({ applicationId, payload, ttlHours, createdBy });
        if (issued.error) {
          db.exec("rollback");
          return issued;
        }
        const stale = this.revokeClaimTokens(issued.applicationId, { exclude: issued.id });
        db.exec("commit");
        return { ...issued, revoked: stale.revoked };
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },

    // 作废领取令牌。传领取记录 id 收那一条；传申请编号收这张单上所有还没领走的。
    // 已核销的行不动：它是历史，改它只会让日志对不上。
    revokeClaimTokens(value, { exclude = null } = {}) {
      const key = String(value || "").trim();
      if (!key) return { revoked: [] };
      const byId = get("select id, application_id from claim_tokens where id = ?", key);
      const rows = byId
        ? [byId]
        : all(
            `select id, application_id from claim_tokens
              where application_id = ? and used_at is null and revoked_at is null`,
            key
          );
      const at = nowIso();
      // 条件写与核销同形：两个进程同时作废同一条时，只有一个能改到它。
      const stmt = db.prepare(
        "update claim_tokens set revoked_at = ? where id = ? and used_at is null and revoked_at is null"
      );
      const revoked = [];
      for (const row of rows) {
        if (exclude && row.id === exclude) continue;
        if (Number(stmt.run(at, row.id).changes) !== 1) continue;
        revoked.push({ id: row.id, applicationId: row.application_id });
        event("claim.revoked", row.application_id, row.id);
      }
      return { revoked };
    },

    // 领取记录只给运营方看状态，不回传 payload：它是明文凭据，库外的第二份没有理由存在。
    listClaimTokens({ applicationId = null, limit = 50 } = {}) {
      const max = Math.min(Math.max(Number(limit) || 50, 1), 500);
      const columns = `select id, application_id, created_at, expires_at, used_at, revoked_at, created_by,
                              length(payload) as payload_len
                         from claim_tokens`;
      const rows = applicationId
        ? all(`${columns} where application_id = ? order by created_at desc, rowid desc limit ?`, String(applicationId), max)
        : all(`${columns} order by created_at desc, rowid desc limit ?`, max);
      return rows.map((row) => ({
        id: row.id,
        applicationId: row.application_id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
        revokedAt: row.revoked_at,
        createdBy: row.created_by,
        payloadLength: Number(row.payload_len) || 0,
      }));
    },

    consumeClaimToken(token) {
      const hash = sha256(String(token || ""));
      // 连申请单一起读：撤回的申请不该还能换出委托发信凭据与隧道账号端口。
      const row = get(
        `select c.id, c.application_id, c.payload, c.expires_at, c.used_at, c.revoked_at,
                a.status as application_status
           from claim_tokens c left join applications a on a.id = c.application_id
          where c.token_hash = ?`,
        hash
      );
      if (!row) return { error: "not_found" };
      // 作废与领取分开报：作废是运营方收回的，伙伴该去要最新一封交付信，
      // 而不是以为自己把资料弄丢了。
      if (row.revoked_at) return { error: "revoked" };
      if (row.used_at) return { error: "already_used" };
      if (Date.parse(row.expires_at) <= Date.now()) return { error: "expired" };
      if (row.application_status !== "approved") return { error: "application_closed" };
      // 核销写成带条件的单条 UPDATE：两个请求同时打同一枚令牌时，
      // 「先查后写」会让两边都拿到 payload，只有 used_at is null 这一条能占住。
      const result = db
        .prepare("update claim_tokens set used_at = ? where token_hash = ? and used_at is null and revoked_at is null")
        .run(nowIso(), hash);
      if (Number(result.changes) !== 1) return { error: "already_used" };
      event("claim.consumed", row.application_id, row.id);
      return { payload: row.payload, applicationId: row.application_id, id: row.id };
    },

    // ---- 发信日志 ----

    // 先把这条事件占住再发信：状态迁移类事件有唯一索引，重复触发只会返回 duplicate。
    //
    // 「已发过」只认成功或还在途。上一次发送失败、或被限流（status 是 failed /
    // throttled）时，同一幂等键必须能再发一次：SMTP 抖动一次就让这封信永久发不出去，
    // 比偶尔重复一封更糟。重试复用原来那一行，日志里仍是一条事件。
    beginNotify({ event: name, caseId = null, stateVersion = null, locale = null, toDomain = null, toHash = null, templateVersion = null, messageId = null }) {
      const at = nowIso();
      const mid = messageId ? String(messageId).slice(0, 64) : null;
      const key = [
        String(name),
        caseId ? String(caseId) : null,
        Number.isInteger(stateVersion) ? stateVersion : null,
      ];
      try {
        const result = db
          .prepare(
            `insert into notify_log (at, event, case_id, state_version, locale, to_domain, to_hash, template_version, message_id, status, error)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', null)`
          )
          .run(
            at,
            key[0],
            key[1],
            key[2],
            locale ? String(locale).slice(0, 12) : null,
            toDomain ? String(toDomain).slice(0, 253) : null,
            toHash ? String(toHash).slice(0, 32) : null,
            templateVersion ? String(templateVersion) : null,
            mid
          );
        return { id: Number(result.lastInsertRowid), at };
      } catch (error) {
        // 这张表只有 notify_once 一条唯一索引，冲突就是「同一事件、同一版本」。
        if (!uniqueViolation(error)) throw error;
        const row = get(
          `select seq, status from notify_log
            where event = ? and case_id is ? and state_version is ?
            order by seq desc limit 1`,
          key[0],
          key[1],
          key[2]
        );
        if (!row) return { duplicate: true };
        if (row.status !== "failed" && row.status !== "throttled") return { duplicate: true };
        // 重发是一次新的投递，Message-ID 必须跟着换：旧的那一封可能已经被收下
        // 又在之后退回，退信要对到这一封，不能对到上一次的号。
        db.prepare(
          `update notify_log
              set at = ?, locale = ?, to_domain = ?, to_hash = ?, template_version = ?,
                  message_id = ?, status = 'pending', error = null
            where seq = ?`
        ).run(
          at,
          locale ? String(locale).slice(0, 12) : null,
          toDomain ? String(toDomain).slice(0, 253) : null,
          toHash ? String(toHash).slice(0, 32) : null,
          templateVersion ? String(templateVersion) : null,
          mid,
          Number(row.seq)
        );
        return { id: Number(row.seq), at, retried: true };
      }
    },

    finishNotify(id, { status, error = null } = {}) {
      if (!["sent", "failed", "skipped", "throttled"].includes(status)) return 0;
      const result = db
        .prepare("update notify_log set status = ?, error = ? where seq = ? and status = 'pending'")
        .run(String(status), error ? String(error).slice(0, 120) : null, Number(id));
      return Number(result.changes) || 0;
    },

    listNotifyLog(limit = 50, caseId = null) {
      const capped = Math.min(Math.max(Number(limit) || 50, 1), 500);
      const rows = caseId
        ? all(
            "select * from notify_log where case_id = ? order by seq desc limit ?",
            String(caseId),
            capped
          )
        : all("select * from notify_log order by seq desc limit ?", capped);
      return rows.map((row) => ({
        seq: Number(row.seq),
        at: row.at,
        event: row.event,
        caseId: row.case_id,
        stateVersion: row.state_version == null ? null : Number(row.state_version),
        locale: row.locale,
        toDomain: row.to_domain,
        templateVersion: row.template_version,
        messageId: row.message_id,
        status: row.status,
        error: row.error,
      }));
    },

    // 收信端事后退信：SMTP 会话里是 250，这里才是它真正的结局。
    //
    // 只改 sent / accepted 的行：还在 pending 或已经 failed 的不该被一封对不上号的
    // 退信改写成 bounced——那是把一次成功的记录凭空变成失败。
    //
    // 返回改到的条数，调用方据此判断这条 Message-ID 是否认得。
    recordBounce(messageId, { detail = null } = {}) {
      const mid = String(messageId || "").trim();
      if (!mid) return { notified: 0, relayed: 0 };
      const note = detail ? `bounced: ${String(detail).slice(0, 100)}` : "bounced";
      const notified = Number(
        db
          .prepare(
            `update notify_log set status = 'bounced', error = ?
              where message_id = ? and status in ('sent', 'accepted')`
          )
          .run(note, mid).changes
      ) || 0;
      const relayed = Number(
        db
          .prepare(
            `update relay_log set status = 'bounced', error = ?
              where message_id = ? and status in ('sent', 'accepted')`
          )
          .run(note, mid).changes
      ) || 0;
      return { notified, relayed };
    },

    findNotifyByMessageId(messageId) {
      const mid = String(messageId || "").trim();
      if (!mid) return null;
      const row = get("select * from notify_log where message_id = ? order by seq desc limit 1", mid);
      return row ? { seq: Number(row.seq), event: row.event, caseId: row.case_id, status: row.status } : null;
    },

    pruneNotifyLog(days = 90) {
      const cutoff = new Date(Date.now() - Math.max(1, Number(days) || 90) * 86400000).toISOString();
      const result = db.prepare("delete from notify_log where at < ?").run(cutoff);
      return Number(result.changes) || 0;
    },

    // 进程在发信途中退出会留下一行 pending。发信有退避重试，正常最长也就 36 分钟，
    // 所以按 2 小时收：短了会把还在重试的那封判死，长了这封信的幂等键一直占着，
    // 同一事件再也发不出去。
    //
    // 回收成 failed，不 delete：failed 允许同一幂等键再发一次（见 beginNotify），
    // 而删行连「这件事已经发生过」都抹掉了，运营再也看不出漏过一封信。
    pruneStaleNotifyPending(minutes = 120) {
      const cutoff = new Date(Date.now() - Math.max(1, Number(minutes) || 120) * 60000).toISOString();
      const result = db
        .prepare(
          `update notify_log set status = 'failed', error = coalesce(error, 'stale_pending')
            where status = 'pending' and at < ?`
        )
        .run(cutoff);
      return Number(result.changes) || 0;
    },

    // ---- 管理员 ----

    createAdmin({ username, password }) {
      const name = normalizeUsername(username);
      if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(name)) return { error: "invalid_username" };
      if (String(password || "").length < 10) return { error: "weak_password" };
      if (get("select id from admins where username = ?", name)) return { error: "exists" };

      const id = `adm_${randomBytes(8).toString("hex")}`;
      db.prepare(
        "insert into admins (id, username, password_hash, created_at) values (?, ?, ?, ?)"
      ).run(id, name, hashPassword(password), nowIso());
      event("admin.created", id, name);
      return { admin: { id, username: name } };
    },

    listAdmins() {
      return all("select id, username, created_at, last_login_at from admins order by username").map(
        (row) => ({
          id: row.id,
          username: row.username,
          createdAt: row.created_at,
          lastLoginAt: row.last_login_at,
        })
      );
    },

    deleteAdmin(username) {
      const name = normalizeUsername(username);
      const row = get("select id from admins where username = ?", name);
      if (!row) return { error: "not_found" };
      db.exec("begin immediate");
      try {
        // 「还剩几个」与删除放在同一个写事务里：两个操作员同时删最后两个管理员，
        // 各自先 count 一次都会看到 2，删完就一个不剩，只能上机器用 CLI 建号。
        const result = db
          .prepare("delete from admins where id = ? and (select count(*) from admins) > 1")
          .run(row.id);
        if (Number(result.changes) !== 1) {
          db.exec("rollback");
          return { error: "last_admin" };
        }
        db.prepare("delete from sessions where admin_id = ?").run(row.id);
        event("admin.deleted", row.id, name);
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
      return { ok: true };
    },

    verifyAdmin({ username, password }) {
      const row = get("select * from admins where username = ?", normalizeUsername(username));
      if (!row) return null;
      if (!verifyPassword(password, row.password_hash)) return null;
      db.prepare("update admins set last_login_at = ? where id = ?").run(nowIso(), row.id);
      return { id: row.id, username: row.username };
    },

    // 忘密码时重设：旧会话一并作废，逼所有人重新登录。
    setPassword(username, password) {
      const row = get("select id, username from admins where username = ?", normalizeUsername(username));
      if (!row) return { error: "not_found" };
      if (String(password || "").length < 10) return { error: "weak_password" };
      db.prepare("update admins set password_hash = ? where id = ?").run(hashPassword(password), row.id);
      db.prepare("delete from sessions where admin_id = ?").run(row.id);
      event("admin.password_reset", row.id, row.username);
      return { admin: row };
    },

    // ---- 会话 ----

    createSession(adminId, days = 7) {
      const token = randomBytes(32).toString("base64url");
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + days * 86400000);
      db.prepare(
        "insert into sessions (token_hash, admin_id, created_at, expires_at) values (?, ?, ?, ?)"
      ).run(sha256(token), adminId, createdAt.toISOString(), expiresAt.toISOString());
      return { token, expiresAt: expiresAt.toISOString() };
    },

    sessionAdmin(token) {
      if (!token) return null;
      const row = get("select * from sessions where token_hash = ?", sha256(token));
      if (!row) return null;
      if (Date.parse(row.expires_at) <= Date.now()) {
        db.prepare("delete from sessions where token_hash = ?").run(row.token_hash);
        return null;
      }
      const admin = get("select id, username from admins where id = ?", row.admin_id);
      return admin ? { id: admin.id, username: admin.username } : null;
    },

    deleteSession(token) {
      if (!token) return;
      db.prepare("delete from sessions where token_hash = ?").run(sha256(token));
    },

    pruneSessions() {
      db.prepare("delete from sessions where expires_at <= ?").run(nowIso());
    },

    // ---- 委托发信 ----

    // 明文只在创建时返回一次；库里只有 SHA-256。
    createRelayToken({ instanceId, label = "", dailyLimit = 50, createdBy = null }) {
      const id = String(instanceId || "").trim();
      if (!/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/.test(id)) return { error: "invalid_instance" };
      const limit = Math.min(Math.max(Number(dailyLimit) || 50, 1), 5000);
      const token = `xkr_${id}_${randomBytes(24).toString("base64url")}`;
      const recordId = `rtk_${randomBytes(6).toString("hex")}`;
      db.prepare(
        `insert into relay_tokens (id, instance_id, label, token_hash, daily_limit, created_at, created_by)
         values (?, ?, ?, ?, ?, ?, ?)`
      ).run(recordId, id, String(label || "").slice(0, 80), sha256(token), limit, nowIso(), createdBy);
      event("relay.token_created", recordId, id);
      return {
        token,
        record: { id: recordId, instanceId: id, label: String(label || ""), dailyLimit: limit },
      };
    },

    // 重签接入件时用：新件落库与旧件作废在同一个事务里。
    // 契约要求「重领一份新件时，旧的发信地址与凭据一起作废」——分两次调用的话，
    // 中间失败会留下「新件已发、旧件还能用」，而重签的理由正是旧件不该再用。
    rotateRelayToken({ instanceId, label = "", dailyLimit = 50, createdBy = null }) {
      db.exec("begin immediate");
      try {
        const issued = this.createRelayToken({ instanceId, label, dailyLimit, createdBy });
        if (issued.error) {
          db.exec("rollback");
          return issued;
        }
        const at = nowIso();
        const stale = all(
          "select id from relay_tokens where instance_id = ? and id <> ? and revoked_at is null",
          issued.record.instanceId,
          issued.record.id
        );
        const revoke = db.prepare("update relay_tokens set revoked_at = ? where id = ?");
        for (const row of stale) revoke.run(at, row.id);
        db.exec("commit");
        return { ...issued, revoked: stale.map((row) => row.id) };
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },

    listRelayTokens() {
      return all(
        `select id, instance_id, label, daily_limit, created_at, created_by, revoked_at, last_used_at
         from relay_tokens order by created_at desc`
      ).map((row) => ({
        id: row.id,
        instanceId: row.instance_id,
        label: row.label || "",
        dailyLimit: Number(row.daily_limit) || 0,
        createdAt: row.created_at,
        createdBy: row.created_by,
        revokedAt: row.revoked_at,
        lastUsedAt: row.last_used_at,
      }));
    },

    verifyRelayToken(token) {
      if (typeof token !== "string" || !token) return { error: "missing" };
      const row = get("select * from relay_tokens where token_hash = ?", sha256(token));
      if (!row) return { error: "invalid" };
      if (row.revoked_at) return { error: "revoked" };
      db.prepare("update relay_tokens set last_used_at = ? where id = ?").run(nowIso(), row.id);
      return {
        token: {
          id: row.id,
          instanceId: row.instance_id,
          label: row.label || "",
          dailyLimit: Number(row.daily_limit) || 0,
        },
      };
    },

    // 吊销：给记录 id 只吊销这一份，给实例 id 吊销该实例下所有未吊销的凭据。
    revokeRelayToken(ref) {
      const value = String(ref || "").trim();
      if (!value) return { error: "not_found" };
      const byId = get("select id, instance_id from relay_tokens where id = ? and revoked_at is null", value);
      const rows = byId
        ? [byId]
        : all("select id, instance_id from relay_tokens where instance_id = ? and revoked_at is null", value);
      if (!rows.length) return { error: "not_found" };

      const at = nowIso();
      const stmt = db.prepare("update relay_tokens set revoked_at = ? where id = ?");
      for (const row of rows) stmt.run(at, row.id);
      event("relay.token_revoked", rows[0].id, `${byId ? "token" : "instance"}:${value}`);
      return { revoked: rows.length, at, instanceId: rows[0].instance_id };
    },

    // ---- 委托发信开关（按实例，可逆） ----

    // 关掉一个实例的委托发信，等于「这个节点现在不许提交」，但凭据、额度、
    // 记录都不动：打开就恢复，实例侧一个字都不用改。
    setRelaySwitch(instanceId, { disabled = true, note = "", by = null } = {}) {
      const id = String(instanceId || "").trim();
      if (!/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/.test(id)) return { error: "invalid_instance" };
      if (!disabled) {
        db.prepare("delete from relay_switches where instance_id = ?").run(id);
        event("relay.enabled", id, by || "");
        return { instanceId: id, disabled: false };
      }
      const at = nowIso();
      db.prepare(
        `insert into relay_switches (instance_id, disabled_at, note, by) values (?, ?, ?, ?)
         on conflict(instance_id) do update set disabled_at = excluded.disabled_at,
           note = excluded.note, by = excluded.by`
      ).run(id, at, String(note || "").slice(0, 120), by);
      event("relay.disabled", id, note || "");
      return { instanceId: id, disabled: true, at };
    },

    relaySwitch(instanceId) {
      const id = String(instanceId || "").trim();
      if (!id) return { disabled: false };
      const row = get("select * from relay_switches where instance_id = ?", id);
      return row ? { disabled: true, at: row.disabled_at, note: row.note || "", by: row.by || "" } : { disabled: false };
    },

    listRelaySwitches() {
      return all("select * from relay_switches order by disabled_at desc").map((row) => ({
        instanceId: row.instance_id,
        at: row.disabled_at,
        note: row.note || "",
        by: row.by || "",
      }));
    },

    // 24 小时窗口内成功、失败、在途与结果不明都算一次：在途先占住额度，
    // 避免并发请求同时通过检查后一起发信；unknown 是已发出去但没来得及记结果的，
    // 不算回来就等于白送一次额度。
    relayUsage(tokenId, sinceIso) {
      const row = get(
        `select count(*) as n from relay_log
         where token_id = ? and at >= ? and status in ('pending', 'accepted', 'failed', 'unknown')`,
        String(tokenId),
        String(sinceIso)
      );
      return Number(row?.n) || 0;
    },

    // 在同一个写事务里查幂等键、查额度和占位。Node 是单线程，但发信要 await，
    // 检查与写入之间必须没有 await，否则两个请求会同时看到“还有余额”。
    // 返回 { id, at } 表示已占位，{ duplicate } 表示同键已有在途或成功记录，
    // { error: "quota_exceeded" } 表示额度已满。
    reserveRelay({
      instanceId,
      tokenId,
      sinceIso,
      limit,
      toDomain = null,
      toHash = null,
      subjectLength = null,
      idemKey = null,
      messageId = null,
    }) {
      const capped = Math.min(Math.max(Number(limit) || 50, 1), 5000);
      db.exec("begin immediate");
      try {
        if (idemKey) {
          // unknown 也算占住：那一封信可能已经发出去了，只是没记回结果。
          // 同键再来一次按重复回，交给实例自己判断要不要换一个键。
          const hit = get(
            `select seq, at, status from relay_log
             where token_id = ? and idem_key = ? and at >= ? and status in ('pending', 'accepted', 'unknown')
             order by seq desc limit 1`,
            String(tokenId),
            String(idemKey),
            String(sinceIso)
          );
          if (hit) {
            db.exec("commit");
            return {
              duplicate: {
                id: Number(hit.seq),
                at: hit.at,
                pending: hit.status === "pending",
              },
            };
          }
        }

        const used = Number(
          get(
            `select count(*) as n from relay_log
             where token_id = ? and at >= ? and status in ('pending', 'accepted', 'failed', 'unknown')`,
            String(tokenId),
            String(sinceIso)
          )?.n
        ) || 0;
        if (used >= capped) {
          db.exec("commit");
          return { error: "quota_exceeded", used, limit: capped };
        }

        const at = nowIso();
        const result = db
          .prepare(
            `insert into relay_log (at, instance_id, token_id, to_domain, to_hash, subject_len, idem_key, message_id, status, error)
             values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', null)`
          )
          .run(
            at,
            String(instanceId),
            String(tokenId),
            toDomain ? String(toDomain).slice(0, 253) : null,
            toHash ? String(toHash).slice(0, 32) : null,
            Number.isInteger(subjectLength) ? subjectLength : null,
            idemKey ? String(idemKey).slice(0, 64) : null,
            messageId ? String(messageId).slice(0, 64) : null
          );
        db.exec("commit");
        return { id: Number(result.lastInsertRowid), at };
      } catch (error) {
        try {
          db.exec("rollback");
        } catch {
          // 事务可能已经结束，交给上层处理原始错误。
        }
        throw error;
      }
    },

    finishRelay(id, { status, error = null } = {}) {
      if (status !== "accepted" && status !== "failed") return 0;
      const result = db
        .prepare("update relay_log set status = ?, error = ? where seq = ? and status = 'pending'")
        .run(String(status), error ? String(error).slice(0, 120) : null, Number(id));
      return Number(result.changes) || 0;
    },

    listRelayLog(limit = 50) {
      return all(
        "select seq, at, instance_id, to_domain, subject_len, message_id, status, error from relay_log order by seq desc limit ?",
        Math.min(Math.max(Number(limit) || 50, 1), 500)
      ).map((row) => ({
        seq: Number(row.seq),
        at: row.at,
        instanceId: row.instance_id,
        toDomain: row.to_domain,
        subjectLength: row.subject_len,
        messageId: row.message_id,
        status: row.status,
        error: row.error,
      }));
    },

    pruneRelayLog(days = 30) {
      const cutoff = new Date(Date.now() - Math.max(1, Number(days) || 30) * 86400000).toISOString();
      const result = db.prepare("delete from relay_log where at < ?").run(cutoff);
      return Number(result.changes) || 0;
    },

    // 进程在发信途中退出会留下 pending 占位。SMTP 超时是 45 秒，15 分钟足够；
    // 不清掉的话，这条占位会一直占着 24 小时额度。
    //
    // 回收成 unknown，不 delete：SMTP 可能已经收下、只是 finishRelay 没跑完。
    // 删行等于连幂等键和投递记录一起抹掉，实例用同一个 idempotencyKey 重试
    // 就会再投一封已经发出去的信。
    pruneStaleRelayPending(minutes = 15) {
      const cutoff = new Date(Date.now() - Math.max(1, Number(minutes) || 15) * 60000).toISOString();
      const result = db
        .prepare(
          `update relay_log set status = 'unknown', error = coalesce(error, 'stale_pending')
            where status = 'pending' and at < ?`
        )
        .run(cutoff);
      return Number(result.changes) || 0;
    },

    // ---- 成员入口 ----
    //
    // 只认已通过的申请：那是这个站点对外的正式联系地址。
    // 一个邮箱可能对应多条申请，按时间倒序全部返回，由接口层挑在册的那条。
    memberApplications(email) {
      const address = String(email || "").trim().toLowerCase();
      if (!address) return [];
      return all(
        "select * from applications where lower(email) = ? and status = 'approved' order by created_at desc",
        address
      ).map(rowToApplication);
    },

    // 六位数字码，明文只在返回值里出现一次，库里是 SHA-256。
    // 同一邮箱重新发信时把上一枚标成已用：同时只有一枚有效，用户不会输错窗口。
    issueMemberCode({ email, instanceId, ttlMinutes = 10 }) {
      const address = String(email || "").trim().toLowerCase();
      const id = String(instanceId || "").trim();
      if (!address || !id) return { error: "invalid" };
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + ttlMinutes * 60_000);
      db.prepare("update member_codes set used_at = ? where email = ? and used_at is null").run(
        nowIso(),
        address
      );
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      db.prepare(
        `insert into member_codes (code_hash, email, instance_id, created_at, expires_at)
         values (?, ?, ?, ?, ?)`
      ).run(
        sha256(`${address}|${code}`),
        address,
        id,
        createdAt.toISOString(),
        expiresAt.toISOString()
      );
      return { code, expiresAt: expiresAt.toISOString() };
    },

    consumeMemberCode({ email, code, maxAttempts = 5 }) {
      const address = String(email || "").trim().toLowerCase();
      const value = String(code || "").replace(/\s+/g, "");
      if (!address || !/^[0-9]{6}$/.test(value)) return { error: "invalid" };
      const row = get(
        "select * from member_codes where email = ? and used_at is null order by created_at desc limit 1",
        address
      );
      if (!row) return { error: "not_found" };
      if (Date.parse(row.expires_at) <= Date.now()) return { error: "expired" };
      if (Number(row.attempts) >= maxAttempts) return { error: "too_many_attempts" };

      const hash = sha256(`${address}|${value}`);
      const match =
        hash.length === row.code_hash.length &&
        timingSafeEqual(Buffer.from(hash, "utf8"), Buffer.from(row.code_hash, "utf8"));
      if (!match) {
        db.prepare("update member_codes set attempts = attempts + 1 where code_hash = ?").run(row.code_hash);
        return { error: "mismatch" };
      }
      db.prepare("update member_codes set used_at = ? where code_hash = ?").run(nowIso(), row.code_hash);
      return { email: row.email, instanceId: row.instance_id };
    },

    createMemberSession({ email, instanceId, days = 30 }) {
      const token = randomBytes(32).toString("base64url");
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + days * 86400000);
      db.prepare(
        `insert into member_sessions (token_hash, email, instance_id, created_at, expires_at)
         values (?, ?, ?, ?, ?)`
      ).run(
        sha256(token),
        String(email || "").trim().toLowerCase(),
        String(instanceId || "").trim(),
        createdAt.toISOString(),
        expiresAt.toISOString()
      );
      return { token, expiresAt: expiresAt.toISOString() };
    },

    memberSession(token) {
      if (!token) return null;
      const row = get("select * from member_sessions where token_hash = ?", sha256(token));
      if (!row) return null;
      if (Date.parse(row.expires_at) <= Date.now()) {
        db.prepare("delete from member_sessions where token_hash = ?").run(row.token_hash);
        return null;
      }
      return { email: row.email, instanceId: row.instance_id, expiresAt: row.expires_at };
    },

    deleteMemberSession(token) {
      if (!token) return;
      db.prepare("delete from member_sessions where token_hash = ?").run(sha256(token));
    },

    pruneMemberSessions() {
      db.prepare("delete from member_sessions where expires_at <= ?").run(nowIso());
      db.prepare("delete from member_codes where expires_at <= ?").run(nowIso());
    },

    // 一个标签只要签发过就算占用；拒绝、过期与撤回都释放它。
    // 集合与 findOpenBySubdomain、唯一索引保持同一份（OCCUPIED_STATUS_SQL）。
    takenSubdomains() {
      return all(
        `select subdomain from applications
          where subdomain is not null and subdomain <> ''
            and ${OCCUPIED_STATUS_SQL}`
      ).map((row) => row.subdomain);
    },

    // 控制台自己的写操作也要留痕；内部 event() 只在库内使用。
    recordEvent(kind, ref, detail) {
      event(kind, ref, detail);
    },
    events(limit = 50) {
      return all("select * from events order by seq desc limit ?", Math.min(Number(limit) || 50, 200));
    },

    // ---- 中枢运行期开关 ----

    // 读不到就是 null，调用方自己决定「没有值时按什么算」。
    getSetting(key) {
      const row = get("select * from settings where key = ?", String(key || ""));
      return row ? { value: row.value, at: row.at, by: row.by || "" } : null;
    },

    // 写一行或删一行。value 传 null 就是删掉，回到环境变量给的默认值。
    setSetting(key, value, by = null) {
      const name = String(key || "").trim();
      if (!/^[a-z][a-z0-9_.-]{0,40}$/.test(name)) return { error: "invalid_key" };
      if (value === null || value === undefined) {
        db.prepare("delete from settings where key = ?").run(name);
        event("setting.cleared", name, by || "");
        return { key: name, value: null };
      }
      const text = String(value);
      const at = nowIso();
      db.prepare(
        `insert into settings (key, value, at, by) values (?, ?, ?, ?)
         on conflict(key) do update set value = excluded.value, at = excluded.at, by = excluded.by`
      ).run(name, text, at, by);
      event("setting.changed", name, text);
      return { key: name, value: text, at, by: by || "" };
    },
  };
}

export function openMemoryStore() {
  return openStore(":memory:");
}

// 库结构与迁移：建表语句、依赖迁移补列的索引、版本化迁移。
//
// 这里的顺序是有语义的，不能调换：SCHEMA 先执行（全部 create if not exists），
// 再跑迁移补列，最后才建引用新列的索引。反过来会让老库直接打不开。

import { randomBytes } from "node:crypto";

import { nowIso } from "./util.mjs";

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

function ensureUniqueIndexes(db) {
  try {
    db.exec(UNIQUE_INDEXES);
  } catch (error) {
    // 建约束之前可能已经有两条同子域的 approved 单。不能为了建索引
    // 让库打不开：留一条日志，等运营把重复的那张撤回，下次启动再建。
    console.error("applications_subdomain_open 未建立:", error.message);
  }
}

/** 打开库之后、交给领域模块之前，把结构准备好。 */
export function initSchema(db) {
  db.exec(SCHEMA);
  migrate(db);
  db.exec(INDEXES);
  ensureUniqueIndexes(db);
}

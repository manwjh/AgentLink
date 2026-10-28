// 申请与管理员账号的存储。
//
// 用 Node 自带的 node:sqlite，不留外部依赖；库文件放在 var/，不入版本库。
// 这一层只做读写，不判断业务，也不碰 HTTP。
//
// 这一层按领域分成 server/store/ 下的几份，这里只做三件事：打开库、准备结构、
// 把各领域的方法拼成一个对象。调用方看到的仍是一个 store，方法名一个都没变——
// 拆分是给人看的，不是给调用方改代码的。
//
// 拼装方式刻意用 Object.assign 而不是把 db 传进每个方法：领域之间有几处互相调用
// （领取令牌要读申请单、成员入口要按邮箱找申请），`this` 在调用时绑定到拼好的
// 整个对象，跨域调用就还是普通的方法调用。

import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createAdminsStore } from "./store/admins.mjs";
import { createApplicationsStore } from "./store/applications.mjs";
import { createClaimTokensStore } from "./store/claim-tokens.mjs";
import { createMailLogStore } from "./store/mail-log.mjs";
import { createMembersStore } from "./store/members.mjs";
import { createRelayStore } from "./store/relay.mjs";
import { initSchema } from "./store/schema.mjs";
import { createSettingsStore } from "./store/settings.mjs";
import { nowIso } from "./store/util.mjs";

// 这几个是纯函数，但一直在 store 的导出面上：接口层拿 ipHash 做限流桶、
// 拿 normalizeUsername 归一化登录名。搬家不换门牌。
export { hashPassword, ipHash, newApplicationId, normalizeUsername, verifyPassword } from "./store/identity.mjs";

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
  initSchema(db);

  const ctx = {
    db,
    get: (sql, ...params) => db.prepare(sql).get(...params),
    all: (sql, ...params) => db.prepare(sql).all(...params),
    event: (kind, ref, detail) => {
      db.prepare("insert into events (at, kind, ref, detail) values (?, ?, ?, ?)").run(
        nowIso(),
        kind,
        ref ?? null,
        detail == null ? null : String(detail)
      );
    },
  };

  return Object.assign(
    {
      file,
      db,
      close() {
        db.close();
      },
    },
    createApplicationsStore(ctx),
    createClaimTokensStore(ctx),
    createMailLogStore(ctx),
    createAdminsStore(ctx),
    createRelayStore(ctx),
    createMembersStore(ctx),
    createSettingsStore(ctx)
  );
}

export function openMemoryStore() {
  return openStore(":memory:");
}

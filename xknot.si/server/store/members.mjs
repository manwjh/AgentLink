// 成员入口：邮箱收一次性授权码，换成员会话。
//
// 与管理员会话分开：浏览器可能同时是访客和运营者，一个 Cookie 失效不该踢掉另一个。

import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { rowToApplication } from "./applications.mjs";
import { nowIso, sha256 } from "./util.mjs";

export function createMembersStore({ db, get, all }) {
  return {
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
  };
}

// 管理员账号与会话。两者放一起：会话是管理员身份的唯一凭据，
// 删号、改密码、过期都要同步处理这张表。

import { randomBytes } from "node:crypto";

import { hashPassword, normalizeUsername, verifyPassword } from "./identity.mjs";
import { nowIso, sha256 } from "./util.mjs";

export function createAdminsStore({ db, get, all, event }) {
  return {
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
  };
}

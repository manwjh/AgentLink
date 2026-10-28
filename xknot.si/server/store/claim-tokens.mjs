// 一次性领取令牌：交付资料只在这里留一份，取一次即作废。

import { randomBytes } from "node:crypto";

import { nowIso, sha256 } from "./util.mjs";

export function createClaimTokensStore({ db, get, all, event }) {
  return {
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
  };
}

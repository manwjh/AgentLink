// 委托发信：凭据、按实例开关、额度占位与投递记录。
//
// 开关与凭据放在一处，是因为它们回答同一个问题——「这个节点现在能不能提交」：
// 吊销是不可逆的，关开关是可逆的，两者要一起读才说得清当下的状态。

import { randomBytes } from "node:crypto";

import { nowIso, sha256 } from "./util.mjs";

export function createRelayStore({ db, get, all, event }) {
  return {
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
  };
}

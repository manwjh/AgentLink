// 发信日志：幂等占位、投递结果、退信回执与保留期。
//
// 退信要同时落在 notify_log 与 relay_log 上（同一封退信可能来自任何一条链），
// 所以 recordBounce 读写的两张表都在这里，不按「谁的信」再拆一次。

import { nowIso, uniqueViolation } from "./util.mjs";

export function createMailLogStore({ db, get, all }) {
  return {
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
  };
}

// 申请单的生命周期：提交、查询、状态迁移、公钥、自动接通的 run。
//
// 自动接通与审核放在同一个文件里，不是按行数凑的：读的是同一张 applications 表、
// 共用同一个状态机，run 只是「审核通过之后这张单走到哪一步」。拆开之后，
// 想知道「通过之后会发生什么」的人要在两个文件之间来回跳。

import { randomBytes } from "node:crypto";

import { normalizePublicKey, subdomainUrl } from "../validate.mjs";
import { newApplicationId } from "./identity.mjs";
import { jsonList, nowIso, uniqueViolation } from "./util.mjs";

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

/** 库里的应用行 → 接口层的形状。成员入口也要用，所以导出。 */
export function rowToApplication(row) {
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

export function createApplicationsStore({ db, get, all, event }) {
  return {
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

    // 一个标签只要签发过就算占用；拒绝、过期与撤回都释放它。
    // 集合与 findOpenBySubdomain、唯一索引保持同一份（OCCUPIED_STATUS_SQL）。
    takenSubdomains() {
      return all(
        `select subdomain from applications
          where subdomain is not null and subdomain <> ''
            and ${OCCUPIED_STATUS_SQL}`
      ).map((row) => row.subdomain);
    },
  };
}

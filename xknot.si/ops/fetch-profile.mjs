// L1 站点档案的拉取：读 instances.json，GET 每个实例的 /api/federation/profile，
// 清洗后原子写 var/profiles/{id}.json。
//
// 契约见 docs/FEDERATION.md 第 4 节。档案由主理人在实例自己的管理页写，
// 中枢只取回副本：格式不对、id 或地址对不上、整份不合法时保留上一份，
// 不拿中枢的判断覆盖主理人的内容。地址按不可信地址处理（见 fetch-guard.mjs）。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FetchGuardError,
  DEFAULT_TIMEOUT_MS,
  PROFILE_MAX_BYTES,
  safeGetJson,
  writeJsonAtomic,
} from "./fetch-guard.mjs";
import { cleanSite, FORMAT_VERSION, ID_RE, isHttpsUrl } from "./profile-schema.mjs";
import { createBudget, FETCH_BUDGET_MS, FETCH_CONCURRENCY, mapWithConcurrency } from "./lib/concurrency.mjs";
import { invokedDirectly } from "./lib/main-module.mjs";

export { FORMAT_VERSION };

function hostOf(value) {
  try {
    return new URL(String(value || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 校验中枢取回的整份档案。
 * @returns {{ ok: boolean, problems: string[], payload?: object }}
 */
export function cleanProfilePayload(payload, { instance } = {}) {
  const problems = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, problems: ["payload: must be a JSON object"] };
  }
  if (payload.formatVersion !== FORMAT_VERSION) {
    return { ok: false, problems: [`formatVersion: must be ${FORMAT_VERSION}`] };
  }

  const issued = payload.issued;
  if (!issued || typeof issued !== "object" || Array.isArray(issued)) {
    return { ok: false, problems: ["issued: required"] };
  }
  if (issued.id !== instance?.id) {
    problems.push(`issued.id: "${issued.id}" does not match "${instance?.id}"`);
  }
  if (!isHttpsUrl(issued.url) || hostOf(issued.url) !== hostOf(instance?.url)) {
    problems.push("issued.url: must be https on the registered host");
  }
  if (problems.length) return { ok: false, problems };

  const cleaned = cleanSite(payload.site);
  if (!cleaned.site) {
    return { ok: false, problems: [...cleaned.problems, "site: no name to display, keeping the previous copy"] };
  }
  if (!cleaned.ok) {
    // 字段级问题不拦整份：能用的字段照收，问题记下来给运营看。
    problems.push(...cleaned.problems);
  }

  // 签发区一律取清单：那是中枢自己的记录。实例那侧报回来的是回执，
  // 只用来核对它有没有跟上，不能反过来当中枢的决定——否则中枢读到的
  // 是自己没说过的话，再传下去就再也分不清谁定的。
  for (const key of ["tier", "status"]) {
    const echoed = typeof issued[key] === "string" ? issued[key].trim() : "";
    const decided = typeof instance?.[key] === "string" ? instance[key] : "";
    if (echoed && decided && echoed !== decided) {
      problems.push(`issued.${key}: instance reports "${echoed}", manifest says "${decided}" — keeping the manifest`);
    }
  }

  return {
    ok: true,
    problems,
    payload: {
      formatVersion: FORMAT_VERSION,
      issued: {
        id: instance.id,
        url: instance.url,
        since: instance.since,
        tier: instance.tier,
        status: instance.status,
      },
      site: cleaned.site,
    },
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function run(options = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const {
    instancesPath = path.join(here, "..", "instances.json"),
    outDir = path.join(here, "..", "var", "profiles"),
    fetchImpl = fetch,
    resolve,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    concurrency = FETCH_CONCURRENCY,
    budgetMs = FETCH_BUDGET_MS,
    only = null,
    now = () => new Date(),
    log = () => {},
  } = options;

  const manifest = await readJson(instancesPath);
  if (!manifest || !Array.isArray(manifest.instances)) {
    throw new Error(`cannot read instances: ${instancesPath}`);
  }

  // 一轮只花一份预算：单项超时管「这一项失败」，预算管「这一轮能不能交付」。
  const budget = createBudget(budgetMs);

  // 结果按清单顺序返回，与并发无关：日志和控制台的顺序不能随网络快慢变。
  const results = (
    await mapWithConcurrency(manifest.instances, concurrency, async (instance) => {
      if (!instance?.id) return null;
      // id 会拼进输出文件名：带 / 或 .. 的条目不落盘，跳过并记账。
      if (!ID_RE.test(instance.id)) {
        return { id: instance.id, status: "skipped", reason: "bad_id" };
      }
      if (only && instance.id !== only) return null;
      if (instance.status && instance.status !== "active") {
        return { id: instance.id, status: "skipped", reason: "inactive" };
      }

      const file = path.join(outDir, `${instance.id}.json`);
      const previous = await readJson(file);
      // 预算用尽：这一项不发请求，记下来等下一轮。整轮照常交付其余结果。
      const slice = budget.timeoutFor(timeoutMs);
      if (slice == null) return { id: instance.id, status: "skipped", reason: "budget" };

      const target = `${String(instance.url || "").replace(/\/$/, "")}/api/federation/profile`;
      try {
        const response = await safeGetJson(target, {
          fetchImpl,
          resolve,
          timeoutMs: slice,
          maxBytes: PROFILE_MAX_BYTES,
          etag: previous?.etag || null,
        });
        if (response.status === 304) {
          return { id: instance.id, status: "unchanged" };
        }
        const checked = cleanProfilePayload(response.body, { instance });
        if (!checked.ok) {
          return { id: instance.id, status: "invalid", problems: checked.problems };
        }
        await writeJsonAtomic(file, {
          ...checked.payload,
          source: response.url,
          etag: response.etag || null,
          fetchedAt: now().toISOString(),
        });
        return { id: instance.id, status: "ok", problems: checked.problems };
      } catch (error) {
        // 写不进去和取不回来是两件事：权限类错误要单独归类，别都报「不可达」。
        const code =
          error instanceof FetchGuardError
            ? error.code
            : error?.code === "EACCES" || error?.code === "EPERM" || error?.code === "EROFS"
              ? "profile_dir_not_writable"
              : "unreachable";
        return { id: instance.id, status: "failed", error: code };
      }
    })
  ).filter(Boolean);

  for (const result of results) {
    const extra =
      result.status === "ok"
        ? result.problems?.length
          ? ` ${result.problems[0]}`
          : ""
        : result.error
          ? ` ${result.error}`
          : result.reason
            ? ` ${result.reason}`
            : result.problems?.length
              ? ` ${result.problems[0]}`
              : "";
    log(`${String(result.id).padEnd(16)} ${result.status}${extra}`);
  }
  return results;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--instances") args.instancesPath = argv[++index];
    else if (name === "--out-dir") args.outDir = argv[++index];
    else if (name === "--only") args.only = argv[++index];
    else if (name === "--budget-ms") args.budgetMs = argv[++index];
  }
  return args;
}

const isMain = invokedDirectly(import.meta.url);
if (isMain) {
  run({ ...parseArgs(process.argv.slice(2)), log: (line) => console.log(line) })
    .then(() => {})
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

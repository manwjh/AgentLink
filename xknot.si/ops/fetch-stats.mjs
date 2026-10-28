// L2 活动数据的拉取：读 instances.json，GET 每个 statsUrl，清洗后原子写 var/stats/{id}.json。
//
// 契约见 docs/FEDERATION.md 第 5.5 节。只收窗口计数，不收昵称、邮箱、正文和记录 id；
// 自报数字只做展示，不参与排序、评级或分成。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_TIMEOUT_MS, FetchGuardError, STATS_MAX_BYTES, safeGetJson, writeJsonAtomic } from "./fetch-guard.mjs";
import { ID_RE } from "./profile-schema.mjs";
import { createBudget, FETCH_BUDGET_MS, FETCH_CONCURRENCY, mapWithConcurrency } from "./lib/concurrency.mjs";
import { invokedDirectly } from "./lib/main-module.mjs";

export const MAX_COUNT = 1_000_000_000;

const FIELDS = {
  posts: ["total", "last24h", "last7d"],
  accounts: ["total", "last7d"],
  authors: ["active7d"],
};

function count(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) return null;
  return Math.min(number, MAX_COUNT);
}

function isoOrNull(value) {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/**
 * 校验并清洗一份活动数据。没有任何一个认识的计数就判为不合法。
 * @returns {{ ok: boolean, problems: string[], payload?: object }}
 */
export function cleanStatsPayload(payload) {
  const problems = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, problems: ["payload: must be a JSON object"] };
  }

  const stats = {};
  let found = 0;
  for (const [group, keys] of Object.entries(FIELDS)) {
    if (payload[group] == null) continue;
    if (typeof payload[group] !== "object" || Array.isArray(payload[group])) {
      problems.push(`${group}: must be an object of counts`);
      continue;
    }
    const cleaned = {};
    for (const key of keys) {
      if (payload[group][key] == null) continue;
      const value = count(payload[group][key]);
      if (value == null) {
        problems.push(`${group}.${key}: must be a non-negative integer`);
        continue;
      }
      cleaned[key] = value;
      found += 1;
    }
    if (Object.keys(cleaned).length) stats[group] = cleaned;
  }

  if (!found) return { ok: false, problems: [...problems, "stats: no known count"] };

  return {
    ok: true,
    problems,
    payload: { generatedAt: isoOrNull(payload.generatedAt), stats },
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
    outDir = path.join(here, "..", "var", "stats"),
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

  const budget = createBudget(budgetMs);

  const results = (
    await mapWithConcurrency(manifest.instances, concurrency, async (instance) => {
      if (!instance?.id) return null;
      // id 会拼进输出文件名：带 / 或 .. 的条目不落盘，跳过并记账。
      if (!ID_RE.test(instance.id)) {
        return { id: instance.id, status: "skipped", reason: "bad_id" };
      }
      if (only && instance.id !== only) return null;
      if (!instance.statsUrl) return null;
      if (instance.status && instance.status !== "active") {
        return { id: instance.id, status: "skipped", reason: "inactive" };
      }

      const file = path.join(outDir, `${instance.id}.json`);
      const previous = await readJson(file);
      const slice = budget.timeoutFor(timeoutMs);
      if (slice == null) return { id: instance.id, status: "skipped", reason: "budget" };
      try {
        const response = await safeGetJson(instance.statsUrl, {
          fetchImpl,
          resolve,
          timeoutMs: slice,
          maxBytes: STATS_MAX_BYTES,
          etag: previous?.etag || null,
        });
        if (response.status === 304) {
          return { id: instance.id, status: "unchanged" };
        }
        const checked = cleanStatsPayload(response.body);
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
        const code = error instanceof FetchGuardError ? error.code : "unreachable";
        return { id: instance.id, status: "failed", error: code };
      }
    })
  ).filter(Boolean);

  for (const result of results) {
    const extra = result.error
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

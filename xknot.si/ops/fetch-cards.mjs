// L3 热点橱窗的拉取：读 instances.json，GET 每个 cardsUrl，清洗后原子写 var/cards/{id}.json。
//
// 契约见 docs/FEDERATION.md 第 6 节。中枢只取回副本：字段超长就截断，缺 title 或 url
// 的卡片丢掉，整份不合法时保留上一份。伙伴的地址按不可信地址处理（见 fetch-guard.mjs）。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CARDS_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  FetchGuardError,
  safeGetJson,
  writeJsonAtomic,
} from "./fetch-guard.mjs";
import { ID_RE } from "./profile-schema.mjs";
import { createBudget, FETCH_BUDGET_MS, FETCH_CONCURRENCY, mapWithConcurrency } from "./lib/concurrency.mjs";
import { invokedDirectly } from "./lib/main-module.mjs";

export const FORMAT_VERSION = 1;
export const CARD_LIMIT = 6;
export const IMAGE_LIMIT = 3;

export const LIMITS = {
  id: 64,
  lang: 16,
  title: 80,
  summary: 160,
  body: 4000,
  tag: 32,
  tags: 5,
};

function clip(value, max) {
  return value.length > max ? value.slice(0, max).trimEnd() : value;
}

/** 去掉 HTML 标签与控制字符；标题类字段压成一行，正文保留换行。 */
export function plainText(value, max, { multiline = false } = {}) {
  if (typeof value !== "string") return null;
  let text = value.replace(/<[^>]*>/g, " ");
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  text = multiline
    ? text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
    : text.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return clip(text, max);
}

function httpsUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function hostOf(url) {
  return url.hostname.toLowerCase();
}

/** 实例自己的主机：清单里只有一个 url，卡片和图片只能指向这里。 */
export function instanceHosts(instance) {
  const hosts = new Set();
  const url = httpsUrl(instance?.url);
  if (url) hosts.add(hostOf(url));
  return hosts;
}

export function hostAllowed(host, instance) {
  if (!host) return false;
  const normalized = String(host).toLowerCase();
  for (const allowed of instanceHosts(instance)) {
    if (normalized === allowed) return true;
    // mail.wang.xknot.si 这类子域也算同一站点。
    if (normalized.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

function isoOrNull(value) {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

function cleanImages(images, instance, problems) {
  if (images == null) return [];
  if (!Array.isArray(images)) {
    problems.push("images: must be an array");
    return [];
  }
  const out = [];
  for (const [index, image] of images.entries()) {
    if (out.length >= IMAGE_LIMIT) {
      problems.push(`images: more than ${IMAGE_LIMIT}, extra dropped`);
      break;
    }
    const url = httpsUrl(image?.url);
    if (!url || !hostAllowed(url.hostname, instance)) {
      problems.push(`images[${index}].url: must be https on the instance host`);
      continue;
    }
    const width = Number(image?.width);
    const height = Number(image?.height);
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      problems.push(`images[${index}]: width and height must be positive integers`);
      continue;
    }
    out.push({
      url: url.toString(),
      alt: plainText(image?.alt, 120),
      width,
      height,
    });
  }
  return out;
}

function cleanCard(card, instance, problems) {
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    problems.push("card: must be an object");
    return null;
  }
  const title = plainText(card.title, LIMITS.title);
  const url = httpsUrl(card.url);
  if (!title) problems.push("title: required");
  if (!url || !hostAllowed(url.hostname, instance)) {
    problems.push("url: must be https on the instance host");
  }
  if (!title || !url || !hostAllowed(url.hostname, instance)) return null;

  const lang = plainText(card.lang, LIMITS.lang);
  const tags = Array.isArray(card.tags)
    ? card.tags
        .map((tag) => plainText(tag, LIMITS.tag))
        .filter(Boolean)
        .slice(0, LIMITS.tags)
    : [];

  return {
    id: plainText(card.id, LIMITS.id),
    lang: lang && /^[A-Za-z0-9-]{2,16}$/.test(lang) ? lang : null,
    title,
    summary: plainText(card.summary, LIMITS.summary),
    body: plainText(card.body, LIMITS.body, { multiline: true }),
    url: url.toString(),
    images: cleanImages(card.images, instance, problems),
    publishedAt: isoOrNull(card.publishedAt),
    tags,
  };
}

/**
 * 校验并清洗一份橱窗。返回可直接落盘的 payload；`ok: false` 时调用方保留上一份。
 * @returns {{ ok: boolean, problems: string[], payload?: object }}
 */
export function cleanCardsPayload(payload, { instance } = {}) {
  const problems = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, problems: ["payload: must be a JSON object"] };
  }
  if (payload.formatVersion !== FORMAT_VERSION) {
    problems.push(`formatVersion: must be ${FORMAT_VERSION}`);
    return { ok: false, problems };
  }
  if (!Array.isArray(payload.cards)) {
    return { ok: false, problems: ["cards: must be an array"] };
  }

  const cards = [];
  for (const card of payload.cards) {
    if (cards.length >= CARD_LIMIT) {
      problems.push(`cards: more than ${CARD_LIMIT}, extra dropped`);
      break;
    }
    const cleaned = cleanCard(card, instance, problems);
    if (cleaned) cards.push(cleaned);
  }

  // 空数组是合法的「清空」，与「一条都不合格」要分开。
  if (payload.cards.length > 0 && cards.length === 0) {
    return { ok: false, problems: [...problems, "cards: no valid card, keeping the previous copy"] };
  }

  return {
    ok: true,
    problems,
    payload: {
      formatVersion: FORMAT_VERSION,
      generatedAt: isoOrNull(payload.generatedAt),
      cards,
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
    outDir = path.join(here, "..", "var", "cards"),
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
      if (!instance.cardsUrl) return null;
      if (instance.status && instance.status !== "active") {
        return { id: instance.id, status: "skipped", reason: "inactive" };
      }

      const file = path.join(outDir, `${instance.id}.json`);
      const previous = await readJson(file);
      const slice = budget.timeoutFor(timeoutMs);
      if (slice == null) return { id: instance.id, status: "skipped", reason: "budget" };
      try {
        const response = await safeGetJson(instance.cardsUrl, {
          fetchImpl,
          resolve,
          timeoutMs: slice,
          maxBytes: CARDS_MAX_BYTES,
          etag: previous?.etag || null,
        });
        if (response.status === 304) {
          return { id: instance.id, status: "unchanged" };
        }
        const checked = cleanCardsPayload(response.body, { instance });
        if (!checked.ok) {
          return { id: instance.id, status: "invalid", problems: checked.problems };
        }
        await writeJsonAtomic(file, {
          ...checked.payload,
          source: response.url,
          etag: response.etag || null,
          fetchedAt: now().toISOString(),
        });
        return {
          id: instance.id,
          status: "ok",
          cards: checked.payload.cards.length,
          problems: checked.problems,
        };
      } catch (error) {
        const code = error instanceof FetchGuardError ? error.code : "unreachable";
        return { id: instance.id, status: "failed", error: code };
      }
    })
  ).filter(Boolean);

  for (const result of results) {
    const extra =
      result.status === "ok"
        ? ` ${result.cards} card(s)`
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

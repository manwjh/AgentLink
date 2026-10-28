// 站点档案：主理人自己写的那一份（自述区）。
//
// 文件在 sites/<站点>/profile.json：
//   { "formatVersion": 2, "updatedAt": "YYYY-MM-DD", "site": { ... } }
//
// 十项全是扁平值（tags 是字符串数组），不按语种拆分：主理人填什么，
// 本站就显示什么，中枢原样取回。唯一的语种字段是 `locale`：站点默认的界面语言，
// 由主理人定，跟着访客自己的选择走。另一半（签发区：id、url、since、tier、status）
// 由中枢决定，写在 sites/<站点>/xknot.env，这里只读、不写。
//
// 校验规则以 xknot.si/ops/profile-schema.mjs 为准，这里是同一套规则的最小实现。
// 两份实现都不做「取当前语种」这一步：v2 起没有多语种字段。

import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseLocale } from "@knot/locale";

export const FORMAT_VERSION = 2;

export const LIMITS = {
  name: 40,
  tagline: 60,
  intro: 800,
  logo: 300,
  owner: 40,
  contact: 120,
  region: 2,
  timezone: 40,
  tag: 16,
  tags: 9,
};

export const FIELDS = ["name", "locale", "tagline", "intro", "logo", "owner", "contact", "region", "timezone", "tags"];

const REGION_RE = /^[A-Z]{2}$/;

export function isHttpsUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password && Boolean(url.host);
  } catch {
    return false;
  }
}

function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// 站点自己的钟：档案写了 timezone 就用它；没写就用实例所在时区——「这个站的今天」
// 取决于这个站，不是取决于读的人在哪。两处都拿不到才退到占位值。
// 时间口径只在这一处定：快照里的今日计数与 /api/web/today 都从这里取。
export const DEFAULT_SITE_TIME_ZONE = "Asia/Shanghai";

export function siteTimeZone(site) {
  const zone = String(site?.timezone || "").trim();
  if (zone && validTimeZone(zone)) return zone;
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return local && validTimeZone(local) ? local : DEFAULT_SITE_TIME_ZONE;
}

function lengthOf(text) {
  return [...text].length;
}

function cleanText(value, max) {
  if (typeof value !== "string") return null;
  // 控制字符换成空格；零宽字符不算内容，靠后面的 trim 收掉。
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  if (!text) return null;
  return lengthOf(text) > max ? [...text].slice(0, max).join("").trimEnd() : text;
}

function cleanUrl(value, field, problems) {
  if (value == null || value === "") return null;
  if (!isHttpsUrl(value)) {
    problems.push(`${field}: must be https, or omit it`);
    return null;
  }
  if (lengthOf(String(value)) > LIMITS.logo) {
    problems.push(`${field}: longer than ${LIMITS.logo}`);
    return null;
  }
  return String(value).trim();
}

function cleanRegion(value, problems) {
  if (value == null || value === "") return null;
  const code = String(value).trim().toUpperCase();
  if (code === "GLOBAL") return code;
  // 中枢拿这张表分区域；这里只拦形状，认不出的码在中枢归入「其他」。
  if (!REGION_RE.test(code)) {
    problems.push("region: must be a two-letter country code, or GLOBAL");
    return null;
  }
  return code;
}

// 自由文本标签：去空白、忽略大小写去重（保留第一次出现的写法）。
// 顺序是主理人排的，不重排。空数组等于没填。
function cleanTags(value, problems) {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    problems.push("tags: must be an array of strings");
    return null;
  }
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const tag = cleanText(raw, LIMITS.tag);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  if (out.length > LIMITS.tags) {
    problems.push(`tags: more than ${LIMITS.tags}`);
    return null;
  }
  return out.length ? out : null;
}

/**
 * 清洗一份自述区。有问题的字段被丢掉，问题列在 problems 里。
 * @param {unknown} input
 * @returns {{ ok: boolean, problems: string[], site: object | null }}
 */
export function cleanSite(input) {
  const problems = [];
  if (input == null) return { ok: true, problems, site: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, problems: ["site: must be a JSON object"], site: null };
  }

  for (const key of Object.keys(input)) {
    if (!FIELDS.includes(key)) problems.push(`${key}: unknown field, remove it`);
  }

  const site = {};

  const name = cleanText(input.name, LIMITS.name);
  if (name) site.name = name;

  // 站点默认的界面语言。必填与否由界面把关；这里只拦取值，写错的整份不收。
  if (input.locale != null && input.locale !== "") {
    const locale = parseLocale(input.locale);
    if (locale) site.locale = locale;
    else problems.push("locale: must be zh-CN, zh-TW or en");
  }

  const tagline = cleanText(input.tagline, LIMITS.tagline);
  if (tagline) site.tagline = tagline;

  const intro = cleanText(input.intro, LIMITS.intro);
  if (intro) site.intro = intro;

  const logo = cleanUrl(input.logo, "logo", problems);
  if (logo) site.logo = logo;

  const owner = cleanText(input.owner, LIMITS.owner);
  if (owner) site.owner = owner;

  const contact = cleanText(input.contact, LIMITS.contact);
  if (contact) site.contact = contact;

  const region = cleanRegion(input.region, problems);
  if (region) site.region = region;

  if (input.timezone != null && input.timezone !== "") {
    const timezone = String(input.timezone).trim();
    if (!validTimeZone(timezone)) problems.push(`timezone: unknown "${timezone}"`);
    else site.timezone = timezone;
  }

  const tags = cleanTags(input.tags, problems);
  if (tags) site.tags = tags;

  // 顶栏、登录卡、分享图都要一个名字；其余都可以空着。
  if (!site.name) problems.push("name: required");

  return { ok: problems.length === 0, problems, site: problems.length ? null : site };
}

/** WebUI 与分享图要的站点身份。十项里只有这六项会出现在本站界面上。 */
export function brandView(site) {
  const source = site || {};
  return {
    name: source.name || null,
    tagline: source.tagline || null,
    logo: source.logo || "",
    owner: source.owner || null,
    intro: source.intro || null,
    contact: source.contact || "",
  };
}

/**
 * 同步读一份档案，只给分享图这类同步路径用。读不到就是空档案。
 * @param {string | null} file
 */
export function readProfileSync(file, { readFile = readFileSync } = {}) {
  if (!file) return { site: null, updatedAt: null };
  try {
    const payload = JSON.parse(readFile(file, "utf8"));
    if (payload?.formatVersion !== FORMAT_VERSION) return { site: null, updatedAt: null };
    const cleaned = cleanSite(payload.site);
    return {
      site: cleaned.site || (cleaned.problems.length ? partialSite(payload.site) : null),
      updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : null,
    };
  } catch {
    return { site: null, updatedAt: null };
  }
}

// 清洗失败时仍尽量给出一份可显示的档案：只做类型过滤，不抛错。
function partialSite(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const key of ["name", "tagline", "intro", "logo", "owner", "contact", "region", "timezone"]) {
    if (typeof raw[key] === "string" && raw[key].trim()) out[key] = raw[key].trim();
  }
  // 语种写错了不能原样带出去：页面会拿它去查目录，查不到就是一片 key。
  const locale = parseLocale(raw.locale);
  if (locale) out.locale = locale;
  if (Array.isArray(raw.tags)) out.tags = raw.tags.filter((tag) => typeof tag === "string" && tag.trim());
  return Object.keys(out).length ? out : null;
}

/**
 * 读、写、缓存一个站点的档案。文件不存在不是错误：站点可以一直不填自述区。
 * @param {{ file: string | null }} options
 */
export function createProfileStore({ file = null } = {}) {
  let state = { site: null, updatedAt: null, problems: [], loaded: false };

  async function reload() {
    if (!file) {
      state = { site: null, updatedAt: null, problems: [], loaded: true };
      return state;
    }
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        state = { site: null, updatedAt: null, problems: [], loaded: true };
        return state;
      }
      state = { site: null, updatedAt: null, problems: [`profile: ${error.code || "read_failed"}`], loaded: true };
      return state;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      state = { site: null, updatedAt: null, problems: ["profile: file is not valid JSON"], loaded: true };
      return state;
    }
    if (payload?.formatVersion !== FORMAT_VERSION) {
      state = {
        site: null,
        updatedAt: null,
        problems: [`formatVersion: must be ${FORMAT_VERSION}`],
        loaded: true,
      };
      return state;
    }
    const cleaned = cleanSite(payload.site);
    state = {
      // 有字段级问题时也保留能用的部分，页面不至于整块空白。
      site: cleaned.problems.length ? partialSite(payload.site) : cleaned.site,
      updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : null,
      problems: cleaned.problems,
      loaded: true,
    };
    return state;
  }

  function view() {
    return state;
  }

  /**
   * 整份替换自述区。校验不过一个字节都不写。
   * @param {{ site: unknown }} input
   */
  async function save(input, { now = () => new Date() } = {}) {
    const cleaned = cleanSite(input?.site);
    if (!cleaned.ok || !cleaned.site) {
      const error = new Error("bad_profile");
      error.code = "bad_profile";
      error.problems = cleaned.problems.length ? cleaned.problems : ["site: required"];
      throw error;
    }
    if (!file) {
      const error = new Error("profile_unconfigured");
      error.code = "profile_unconfigured";
      throw error;
    }
    const payload = {
      formatVersion: FORMAT_VERSION,
      updatedAt: now().toISOString().slice(0, 10),
      site: cleaned.site,
    };
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tmp, file);
    await reload();
    return view();
  }

  return { reload, view, save, file };
}

/**
 * 自述区文件的位置：和接入件 xknot.env 放在同一个站点目录。
 * 部署脚本把 KNOT_AGENT_ENV_DIR 写成 <部署根>/sites/<站点>/agents，
 * 它的上级目录就是站点目录；也可以用 KNOT_PROFILE_FILE 直接指定。
 */
export function profileFilePath(env = process.env, agentEnvDir = null) {
  const explicit = String(env.KNOT_PROFILE_FILE || "").trim();
  if (explicit) return path.resolve(explicit);
  const dir = String(agentEnvDir || "").trim();
  if (dir) return path.join(path.dirname(dir), "profile.json");
  return null;
}

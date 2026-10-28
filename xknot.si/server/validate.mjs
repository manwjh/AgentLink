// 申请表的字段校验。
//
// 纯函数：输入表单对象，输出清洗后的值与按字段归类的错误码。
// 错误码是稳定的英文标识，页面自己按语种翻译，接口不回中文。
//
// 接入只有一种形态：中枢签发 <标签>.xknot.si，静态与动态都落在中枢入口。
// 已经有自有域名的站点不需要这一步，也不在这里登记，见 docs/JOIN.md。
//
// 子域规则只认 ops/subdomain.mjs 一份：端侧预检、控制台、接口都读同一个结论。
//
// 上限对着 ops/validate-instances.mjs 的规则：清单不过就不能发布。

import { isCountryCode } from "../web/src/lib/regions.js";
import { checkLabel, normalizeLabel } from "../ops/subdomain.mjs";

// 中枢自己的域名。签发出来的地址都挂在它下面。
const HUB_DOMAIN = "xknot.si";

export const LIMITS = {
  name: 40,
  operator: 80,
  email: 120,
  intro: 60,
  tags: 9,
  tagLength: 16,
};

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

function text(value, max) {
  return typeof value === "string" ? [...value.trim()].slice(0, max + 1).join("") : "";
}

// 控制字符、零宽与双向覆盖符。这些值会原样进内部信正文和门户的标签、卡片：
// 换行能伪造排版，U+202E 能把显示顺序颠倒（让人读到一条假的地址）。
// 邮件头已由 mail.mjs 的 stripNewlines 兜住，所以这里只管显示层。
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return text(value.replace(CONTROL_RE, " ").replace(/\s+/g, " "), max);
}

export function subdomainUrl(subdomain) {
  return `https://${subdomain}.${HUB_DOMAIN}`;
}

export function normalizeTags(value) {
  // 标签是一段短语，空格属于标签本身（与 profile-schema.mjs 的 cleanText 一致）：
  // 数组原样保留，字符串只按逗号分隔。这里不再按 \s 拆，否则同一个 "vibe coding"
  // 走字符串入口变成两个标签、走数组入口又是一个，两种入口对不上。
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，、]+/)
      : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const tag = text(item, LIMITS.tagLength);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export function validEmail(value) {
  const address = String(value ?? "").trim().toLowerCase();
  if (!address || [...address].length > LIMITS.email) return "";
  return EMAIL_RE.test(address) ? address : "";
}

export function validTimeZone(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {{ ok: boolean, errors: Record<string,string>, value: object }}
 */
export function validateApplication(input) {
  const errors = {};
  const raw = input && typeof input === "object" ? input : {};

  const name = cleanText(raw.name, LIMITS.name);
  if ([...name].length < 2) errors.name = "too_short";
  else if ([...name].length > LIMITS.name) errors.name = "too_long";

  // 接入只有签发子域一种。带着别的模式或自有域名，明确退回，
  // 不悄悄忽略：它会以为自己申请了自有域名，实际上什么都没登记。
  if (raw.mode != null && raw.mode !== "" && raw.mode !== "subdomain") errors.mode = "not_supported";
  if (String(raw.domain || "").trim()) errors.domain = "not_supported";

  const label = normalizeLabel(raw.subdomain);
  const checkedLabel = label ? checkLabel(label) : { available: false, reason: "empty" };
  if (!label) errors.subdomain = "required";
  else if (!checkedLabel.available) errors.subdomain = checkedLabel.reason;
  const subdomain = checkedLabel.available ? label : "";

  const url = subdomain ? subdomainUrl(subdomain) : "";

  const operator = cleanText(raw.operator, LIMITS.operator);
  if (!operator) errors.operator = "required";
  else if ([...operator].length > LIMITS.operator) errors.operator = "too_long";

  // 邮箱也要能报超长：text() 截到 max+1 之后仍然是一个合法地址时，
  // 存下来的就是另一个人的邮箱——截断点落在域名中段也照样通过正则。
  const email = text(raw.email, LIMITS.email).toLowerCase();
  if (!email) errors.email = "required";
  else if ([...email].length > LIMITS.email) errors.email = "too_long";
  else if (!EMAIL_RE.test(email)) errors.email = "invalid_email";

  const region = typeof raw.region === "string" ? raw.region.trim().toUpperCase() : "";
  if (!region) errors.region = "required";
  else if (!isCountryCode(region)) errors.region = "invalid_region";

  const timezone = typeof raw.timezone === "string" ? raw.timezone.trim() : "";
  if (!timezone) errors.timezone = "required";
  else if (!validTimeZone(timezone)) errors.timezone = "invalid_timezone";

  const intro = cleanText(raw.intro, LIMITS.intro);
  if (!intro) errors.intro = "required";
  else if ([...intro].length > LIMITS.intro) errors.intro = "too_long";

  const tags = normalizeTags(raw.tags);
  if (tags.length > LIMITS.tags) errors.tags = "too_many_tags";
  // 单个标签也要能报超长：16 字的上限此前只用于截断，17 字的一条会原样落库。
  else if (tags.some((tag) => [...tag].length > LIMITS.tagLength)) errors.tags = "too_long";

  if (raw.agree !== true) errors.agree = "required";

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: { name, subdomain: subdomain || null, url, operator, email, region, timezone, intro, tags },
  };
}

// SSH 公钥。这个值最后会被逐字写进入口主机的 authorized_keys，所以它是
// 「要落进 root 属主文件的文本」，不是普通表单字段。
//
// 只认一行：类型 + base64 + 可选注释。关键是分隔符只允许空格/制表符——
// 用 \s 会连换行一起匹配，于是 `ssh-ed25519 AAAA\ncommand="…" ssh-ed25519 BBBB`
// 能整串通过，再被写成两行。这不是理论：\s 在 JS 里包含 \r\n。
//
// 注释里同样不许出现控制字符，否则一行变两行的入口又被打开。
export const MAX_PUBLIC_KEY = 1000;

const KEY_TYPE_RE = /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9-]+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-[a-z0-9-]+@openssh\.com)$/;

export function normalizePublicKey(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > MAX_PUBLIC_KEY) return null;
  // 先挡控制字符：任何 \r \n \0 都意味着「这是多行」或「想截断写入」。
  if (/[\u0000-\u001f\u007f]/.test(text)) return null;
  const parts = text.split(/[ ]+/);
  const [type, body] = parts;
  if (!KEY_TYPE_RE.test(type)) return null;
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length < 16) return null;
  // 注释可以缺省，但不能为空串（避免双空格被当成"有注释"）。
  const comment = parts.slice(2).join(" ");
  if (parts.length > 2 && !comment) return null;
  return comment ? `${type} ${body} ${comment}` : `${type} ${body}`;
}

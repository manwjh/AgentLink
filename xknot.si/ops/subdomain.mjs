// 子域签发规则：中枢是唯一真源。
//
// 实例的 /admin 只展示这里返回的结论，不在端侧另写一套校验：两套规则迟早会分叉，
// 用户会看到「本地说可以、提交却失败」这种最伤人的反馈。
//
// 只做一件事：给一个标签（或一整条 URL），回答能不能签。查重由调用方传入，
// 因为清单与申请单在接口层，不在这一层。
//
// 短号是稀缺资源：少于 6 个字符的标签一律不签，留给以后。这条不是格式校验，
// 是政策，所以理由单独叫 too_short，文案上也不该说成「格式不对」。

export const SUBDOMAIN_MIN = 6;
export const SUBDOMAIN_MAX = 32;
export const HUB_SUFFIX = ".xknot.si";

// 与 DNS / HTTP 基础设施撞名的标签。签发后没法回头改（证书、隧道、清单都写死了），
// 所以宁可多留一些。
export const RESERVED_LABELS = new Set([
  "admin",
  "api",
  "auth",
  "billing",
  "blog",
  "cache",
  "cdn",
  "claim",
  "console",
  "dashboard",
  "dev",
  "dns",
  "docs",
  "entry",
  "files",
  "ftp",
  "help",
  "hub",
  "imap",
  "internal",
  "login",
  "mail",
  "media",
  "mx",
  "ns",
  "ns1",
  "ns2",
  "pop",
  "portal",
  "relay",
  "root",
  "smtp",
  "sso",
  "staging",
  "static",
  "status",
  "support",
  "test",
  "webmail",
  "www",
  "xknot",
]);

// 允许粘贴整条地址或带后缀的标签：用户经常直接复制 `https://foo.xknot.si/`。
export function normalizeLabel(input) {
  let value = String(input ?? "").trim().toLowerCase();
  if (!value) return "";
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.replace(/[/?#].*$/, "");
  value = value.replace(/:\d+$/, "");
  // 有人会连点一起输入 `foo.xknot.si.`
  value = value.replace(/\.+$/, "");
  if (value.endsWith(".xknot.si")) value = value.slice(0, -".xknot.si".length);
  return value;
}

/**
 * 从一整条地址取出中枢签发的标签。
 *
 * 只认一级：`wang.xknot.si` 是签发的，`a.b.xknot.si` 不是，`example.com` 也不是。
 * 这里不判长度与保留名：短号（如 `wang`）照样要能在清单里通过校验；长度与保留名在签发时才判。
 */
export function labelFromUrl(value) {
  let host = "";
  try {
    host = new URL(String(value || "").trim()).hostname.toLowerCase();
  } catch {
    return "";
  }
  if (!host.endsWith(HUB_SUFFIX)) return "";
  const label = host.slice(0, -HUB_SUFFIX.length);
  if (!label || label.includes(".")) return "";
  // 同一个格式正则也要套在这里：只判「一级标签」的话，`a_b.xknot.si`、`a{b`
  // 这类 checkLabel 会拒掉的名字照样能进清单，再被原样写进 nginx 与 sshd。
  return LABEL_RE.test(label) ? label : "";
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * @param {string} input 标签，或一整条地址
 * @param {{ taken?: Iterable<string> }} [options] 已占用的标签（清单与未结案申请）
 * @returns {{ label: string, available: boolean, reason: string }}
 *   reason 取 empty / too_short / too_long / format / reserved / taken / ok
 */
export function checkLabel(input, { taken = [] } = {}) {
  const label = normalizeLabel(input);
  if (!label) return { label, available: false, reason: "empty" };
  // 先判长度：用户输入 3 个字母时，先说「至少 6 位」比说「格式不对」有用。
  if ([...label].length < SUBDOMAIN_MIN) return { label, available: false, reason: "too_short" };
  if ([...label].length > SUBDOMAIN_MAX) return { label, available: false, reason: "too_long" };
  if (!LABEL_RE.test(label)) return { label, available: false, reason: "format" };
  // 第 3、4 位是 `--` 会被当成 IDN 的 punycode 前缀，浏览器与证书都会另眼相待。
  if (label.slice(2, 4) === "--") return { label, available: false, reason: "format" };
  // 纯数字可以被误读成 IP 片段或端口，不签。
  if (/^[0-9]+$/.test(label)) return { label, available: false, reason: "format" };
  if (RESERVED_LABELS.has(label)) return { label, available: false, reason: "reserved" };

  const occupied = new Set([...taken].map((value) => normalizeLabel(value)).filter(Boolean));
  if (occupied.has(label)) return { label, available: false, reason: "taken" };

  return { label, available: true, reason: "ok" };
}

/** 接口给的第一个可用候选：把用户输入变成 `foo2`、`foo3`。 */
export function suggestLabels(input, { taken = [], count = 3 } = {}) {
  const base = normalizeLabel(input).replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");
  // 太短的标签补一个数字可能刚好够 6 位，例如 hello → hello2；判断交给 checkLabel。
  if (!base) return [];
  const out = [];
  for (let index = 2; out.length < count && index < 100; index += 1) {
    const candidate = `${base}${index}`;
    if (checkLabel(candidate, { taken }).available) out.push(candidate);
  }
  return out;
}

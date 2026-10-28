// 标识与凭据：申请编号、密码哈希、来源地址哈希、账号名归一化。
//
// 都只是纯函数，不读写库——但它们决定「同一个人是不是同一个人」，
// 所以集中一处：账号名少归一化一次，限流桶与查库就会各认一个写法。

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { sha256 } from "./util.mjs";

// 申请编号：给人念得出来的短号，不暴露序号。
export function newApplicationId(at = new Date()) {
  const alphabet = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 去掉 I O
  const bytes = randomBytes(6);
  let body = "";
  for (const byte of bytes) body += alphabet[byte % alphabet.length];
  return `XK-${at.getUTCFullYear()}-${body}`;
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltText, hashText] = String(stored).split("$");
  if (scheme !== "scrypt" || !saltText || !hashText) return false;
  const salt = Buffer.from(saltText, "base64");
  const expected = Buffer.from(hashText, "base64");
  const actual = scryptSync(String(password), salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// 来源地址只落哈希。secret 不给默认值：漏传宁可当场报错，也不要静默退化成
// 一份无盐哈希——IPv4 只有 2³² 个地址，落库的 ip_hash 可以被穷举回原地址。
export function ipHash(ip, secret) {
  if (typeof secret !== "string" || !secret) throw new Error("ipHash requires a secret");
  return sha256(`${secret}|${ip}`).slice(0, 16);
}

// 账号名在两处参与判断：登录限流桶与查库。归一化只留一份，
// 否则用户名前后加一个空格就换了一个限流桶，而查库仍然命中同一个账号。
export function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

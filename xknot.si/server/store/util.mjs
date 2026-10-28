// 领域模块共用的几个小工具：时间戳、JSON 列、哈希、唯一约束判定。
// 它们不碰库、不含业务规则，所以平铺在这里而不是挂到某个领域上。

import { createHash } from "node:crypto";

export function nowIso() {
  return new Date().toISOString();
}

export function jsonList(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

// SQLite 的唯一约束冲突。message 形如
// `UNIQUE constraint failed: applications.subdomain`。
export function uniqueViolation(error, column = null) {
  const message = String(error?.message || "");
  if (!/UNIQUE constraint failed/i.test(message)) return false;
  return column ? message.includes(column) : true;
}

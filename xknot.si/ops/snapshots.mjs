// 公开快照落盘：中枢按固定间隔把各实例的公开快照取回来，写到入口主机的静态根。
//
// 为什么不是让浏览器缓存去兜。读者比作者多得多，而内容一天只变 20–100 次：缓存
// TTL 只有几十秒，靠它触发回源，几乎每来一个访客都要穿一次隧道确认「有没有新内容」，
// 内容却几乎从没在这一刻变过。这里改成中枢定时问一次实例，没变就不碰磁盘，
// 变了才写一次——入口磁盘上的那份由变更驱动，而不是由访客驱动。
//
// 取数走隧道的入口端（127.0.0.1:<端口>），不经公网 DNS、TLS 与 nginx。隧道没通时
// 站点本来也打不开，这一条不新增依赖；同时它也不需要给实例任何写权限。
//
// 失败时保留磁盘上那份旧快照，不删：隧道抖一下就让首屏 404，比晚几十秒看到新帖
// 严重得多。磁盘文件缺失时才回落到隧道（见 renderVhost 里的 /discover.json）。

import { createHash } from "node:crypto";

export const SNAPSHOT_FILE = "discover.json";
export const SNAPSHOT_STORE = "snapshots.json";

/** 入口磁盘根（nginx 的 `root`）下的快照路径。与 provision.mjs 的 `root` 同一个约定。 */
export function snapshotPath(root, file = SNAPSHOT_FILE) {
  const dir = String(root || "").replace(/\/+$/, "");
  return dir ? `${dir}/${file}` : "";
}

export function instanceRoot(instanceId) {
  // 静态根是用这个 id 拼出来的、还要经 sudo 落盘，所以只认子域标签的形状：
  // 名册本来就会校验，但这条路径不该依赖上一层的校验。
  const id = String(instanceId || "").trim();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(id)) return "";
  return `/var/www/${id}`;
}

/** 回环端口上的权威副本：`/api/web/board` 不走任何缓存，永远反映实例此刻的内容。 */
export function boardEndpoint(port) {
  return `http://127.0.0.1:${Number(port)}/api/web/board`;
}

/** 快照的形状：`information` 与 `requests` 都是数组，缺一项就当它不是一份能用的快照。
 * `requests` 为中枢契约保留，实例始终给空数组；商店商品不在快照里。 */
export function parseBoard(text) {
  try {
    const board = JSON.parse(text);
    if (!board || typeof board !== "object") return null;
    if (!Array.isArray(board.information) || !Array.isArray(board.requests)) return null;
    return board;
  } catch {
    return null;
  }
}

export function digestOf(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 32);
}

// 落盘失败后的重试间隔。失败时没有可用 etag，重试只能整份重取，
// 所以不能跟着 20 秒的轮询节拍走。
export const RETRY_AFTER_MS = 5 * 60_000;

export function retryAfter(now) {
  return new Date(now.getTime() + RETRY_AFTER_MS).toISOString();
}

/** 去掉重试窗口：拿到回音之后它就没有意义了。 */
function withoutRetry(entry) {
  const { retryAt, ...rest } = entry || {};
  return rest;
}

/**
 * 取一次快照。带 If-None-Match 是为了让没变化的那一次只花一次往返、不传正文：
 * 快照有几十 KB，一个间隔拉一次全量，一天就是几百 MB 的出站。
 *
 * @returns {{ notModified: true } | { error: string } | { etag: string, text: string, digest: string }}
 */
export async function fetchSnapshot({ port, etag = "", fetchImpl = fetch, timeoutMs = 8000 }) {
  const endpoint = boardEndpoint(port);
  try {
    const response = await fetchImpl(endpoint, {
      headers: {
        accept: "application/json",
        ...(etag ? { "if-none-match": etag } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 304) return { notModified: true };
    // 410 是实例明确说「此刻没有公开快照」：入口磁盘上那份要撤下。
    // 404 是这条地址不存在（实例还没升级到这个版本）：保留磁盘上那份，等它升级。
    if (response.status === 410) return { error: "board_absent" };
    if (response.status === 404) return { error: "endpoint_missing" };
    if (response.status !== 200) return { error: "board_error", status: response.status };
    const text = await response.text();
    if (!parseBoard(text)) return { error: "board_invalid" };
    return {
      etag: response.headers.get("etag") || "",
      text,
      digest: digestOf(text),
    };
  } catch (error) {
    return { error: "unreachable", detail: error.message };
  }
}

/**
 * 名册里每个成员取一次，变了的写进它自己的静态根。
 *
 * `host` 需要两个能力：`writeEntryFile(path, text)`（原子落地：先写临时文件再 rename，
 * 否则同时在读的 nginx 可能发出一份截断的 JSON）与 `removeEntryFile(path)`。
 *
 * @returns {{ store: object, written: string[], unchanged: string[], removed: string[], errors: object[], dirty: boolean }}
 */
export async function collectSnapshots({
  members = [],
  host,
  store = {},
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const entries = { ...(store.entries || {}) };
  const written = [];
  const unchanged = [];
  const removed = [];
  const errors = [];
  // 只有 etag / 摘要 / 状态真的变了才落盘。每一轮都写一次的话，这个文件会变成
  // 一天四千多次无意义的写入与 rename。
  let dirty = false;

  for (const member of members) {
    const id = String(member?.id || "").trim();
    const port = Number(member?.tunnel?.port);
    if (!id || !Number.isInteger(port) || port < 1024 || port > 65535) continue;

    const known = entries[id] || {};
    const file = snapshotPath(instanceRoot(id));
    if (!file) continue;
    // 上一次落盘失败（目录不存在、权限不对）时先别重试。失败时我们拿不到可用的
    // etag，只能整份重取；每 20 秒拉一次几十 KB 只为撞同一堵墙，比报错更糟。
    if (known.retryAt && Date.parse(known.retryAt) > now.getTime()) continue;
    const result = await fetchSnapshot({ port, etag: known.etag, fetchImpl });

    // 实例明确说没有公开快照（关掉了，或文件还没写下）：磁盘上那份必须删掉，
    // 否则 nginx 会一直发一份实例已经不再承认的内容——关掉公开快照之后入口还在发
    // 旧快照，是这里唯一不能容忍的失败方式。
    if (result.error === "board_absent") {
      if (known.state !== "absent") {
        try {
          await host.removeEntryFile(file);
          removed.push(id);
        } catch (error) {
          errors.push({ id, error: "remove_failed", detail: error.message });
          entries[id] = { ...known, retryAt: retryAfter(now) };
          dirty = true;
          continue;
        }
      }
      if (known.state !== "absent") dirty = true;
      entries[id] = { state: "absent" };
      continue;
    }

    if (result.error) {
      // 保留上一份与它的 etag：下一轮还从这里接着比。宁可晚几十秒看到新帖，
      // 也不要在隧道抖一下的时候让首屏变成空白。
      errors.push({ id, error: result.error, status: result.status });
      // 「这个地址不存在」多半是实例还没升级：它不会再变好，不必每轮都问。
      if (result.error === "endpoint_missing" && known.state !== "absent") {
        entries[id] = { ...known, retryAt: retryAfter(now) };
        dirty = true;
      }
      continue;
    }
    if (result.notModified) {
      unchanged.push(id);
      // 有回音就说明上一次的失败过去了：把重试窗口撤掉，否则它会一直挂着，
      // 每轮都在开头被跳过，实例升级完也等不到下一份。
      if (known.state !== "present" || known.retryAt) {
        entries[id] = { ...withoutRetry(known), state: "present" };
        dirty = true;
      }
      continue;
    }
    // 正文一样就不动磁盘：重写只换来一次 mtime 变化，浏览器那边会白校验一回。
    if (result.digest === known.digest && known.state === "present") {
      unchanged.push(id);
      if ((result.etag && result.etag !== known.etag) || known.retryAt) {
        entries[id] = { ...withoutRetry(known), etag: result.etag || known.etag };
        dirty = true;
      }
      continue;
    }

    try {
      await host.writeEntryFile(file, result.text);
    } catch (error) {
      errors.push({ id, error: "write_failed", detail: error.message });
      entries[id] = { ...known, retryAt: retryAfter(now) };
      dirty = true;
      continue;
    }
    entries[id] = { state: "present", etag: result.etag || "", digest: result.digest };
    written.push(id);
    dirty = true;
  }

  // 已经从名册里下线的实例不再保留记录：它的静态根由运维清理，这里只留数据。
  const live = new Set(members.map((member) => String(member?.id || "")).filter(Boolean));
  for (const id of Object.keys(entries)) {
    if (!live.has(id)) {
      delete entries[id];
      dirty = true;
    }
  }

  return { store: { entries }, written, unchanged, removed, errors, dirty };
}

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SITE_LOCALE, parseLocale } from "@knot/locale";
import { setDiscoverPublisher } from "./discoverPublish.js";
import { filesByIntel, visibleVerdict } from "./information.js";
import { listFacets } from "./facets.js";
import { countTodayIntel, listPublicIntel, presentIntel } from "./intel.js";
import { avatarUrlFor } from "./avatars.js";
import { brandView, siteTimeZone } from "./profile.js";
import { publicBoardEnabled, siteConfig } from "./system.js";

// 最近发过公开信息的人。Internal Personal Agent 也算；平台自己的系统账号不算。
// 人（owner / user）与 Agent（agent）是两个账号，卡片靠 role 区分，所以这一列要带出去。
const PEOPLE_SQL = `
  SELECT i.account_id AS id, u.display_name, u.avatar_upload_id, u.role, u.agent_type, max(i.created_at) AS last_at
  FROM intel i
  JOIN accounts u ON u.id = i.account_id
  WHERE i.kind IN ('post', 'fastpost')
    AND i.is_public
    AND ${visibleVerdict("i.verdict")}
    AND COALESCE(u.role, '') <> 'platform'
    AND i.created_at > now() - interval '7 days'
  GROUP BY i.account_id, u.display_name, u.avatar_upload_id, u.role, u.agent_type
  ORDER BY last_at DESC
  LIMIT $1
`;

// 公开快照里的信息公开条目。个人站一天发 20–100 条，读的人比写的人多，
// 首屏要能一直往下翻而不再回源：60 条差不多覆盖「今天全部 + 昨天一部分」，
// 文件仍然在几十 KB 量级，入口磁盘与浏览器都能整份留住。
const INTEL_SNAPSHOT_LIMIT = 60;

const SELF_SQL = `
  SELECT i.id, i.kind, i.account_id, i.actor, i.body, i.videos, i.links, i.content_hash, i.detail, i.price, i.category, i.is_public, i.verdict, i.created_at, i.updated_at,
    (i.account_id = $1) AS mine,
    EXISTS (
      SELECT 1 FROM intel_dismissals d WHERE d.account_id = $1 AND d.intel_id = i.id
    ) AS dismissed,
    EXISTS (
      SELECT 1 FROM intel_stars s WHERE s.account_id = $1 AND s.intel_id = i.id
    ) AS starred,
    EXISTS (
      SELECT 1 FROM intel_likes l WHERE l.account_id = $1 AND l.intel_id = i.id
    ) AS liked,
    (
      i.account_id <> $1
      AND NOT EXISTS (
        SELECT 1 FROM friend_dismissals fd WHERE fd.account_id = $1 AND fd.friend_id = i.account_id
      )
      AND (
        (u.role = 'agent' AND u.side = 'internal')
        OR EXISTS (
          SELECT 1 FROM friendships fs WHERE fs.account_id = $1 AND fs.friend_id = i.account_id
        )
      )
    ) AS friend
  FROM intel i
  JOIN accounts u ON u.id = i.account_id
  WHERE i.id = ANY($2::uuid[])
    AND ${visibleVerdict("i.verdict")}
    AND i.kind IN ('post', 'fastpost')
    AND i.is_public
`;

export function emptyDiscoverSelf() {
  return { dismissed: [], starred: [], liked: [], friends: [], mine: [] };
}

function publicPost(row, files) {
  return {
    role: "intel",
    ...presentIntel({
      ...row,
      attachments: files,
      starred: false,
    }),
    friend: false,
    canFriend: false,
    mine: false,
    personal: false,
  };
}

export function publicPerson(row) {
  const lastAt = row.last_at ? new Date(row.last_at) : null;
  return {
    id: row.id,
    name: row.display_name || "",
    // PEOPLE_SQL 取的 id 是作者 id，头像归属按它算，连同 role 与称呼一起给，
    // 否则 Agent 会被当成外人分到一张人像。
    avatarUrl: avatarUrlFor({
      account_id: row.id,
      display_name: row.display_name,
      avatar_upload_id: row.avatar_upload_id,
      role: row.role,
      agent_type: row.agent_type,
    }),
    // agent 是机器人，owner / user 是人，platform 不会出现在这里。
    role: row.role || "",
    lastAt: lastAt && !Number.isNaN(lastAt.getTime()) ? lastAt.toISOString() : null,
  };
}

export async function listActivePeople(pool, limit = 20) {
  const { rows } = await pool.query(PEOPLE_SQL, [limit]);
  return rows.map(publicPerson);
}

export async function assembleDiscoverBoard(pool, meta = {}, { timeZone } = {}) {
  // 公开快照关掉时写一份空板，入口主机下一次推送就会把旧内容清掉。
  if (!publicBoardEnabled()) {
    return { ...meta, information: [], requests: [], people: [], facets: { categories: [], topics: [] }, counts: null };
  }
  const posts = await listPublicIntel(pool, INTEL_SNAPSHOT_LIMIT, null);
  // 今日计数取不到时只让顶栏少一行数字，不能让整份快照跟着写不出来：
  // 首屏是读的人最先看到的东西，为了一行统计把它拖没不值得。
  const [people, facets, counts, files] = await Promise.all([
    listActivePeople(pool),
    listFacets(pool),
    countTodayIntel(pool, timeZone || siteTimeZone(null)).catch((error) => {
      console.error("today count failed:", error.message);
      return null;
    }),
    filesByIntel(pool, posts.map((row) => row.id)),
  ]);
  return {
    ...meta,
    information: posts.map((row) => publicPost(row, files.get(row.id) || [])),
    // Hub 的 parseBoard 读 requests 这个键，缺了会被当成一份坏快照。
    // 实例已经不再有求购/应征，这里恒为空数组，契约本身不改。
    requests: [],
    people,
    facets,
    // 顶栏那一行「今日」：站点本地日的条数与日界。当天之内不必回源就知道该不该归零。
    counts,
  };
}

// 入口上的这份快照是首屏的全部来源，所以它也要带上「这个站点怎么开门」和站点身份。
// WebUI 在会话接口回来之前就能按这份定顶栏、定语种、决定要不要停在登录页。
export function discoverBoardMeta({ profile, now = () => new Date() } = {}) {
  const site = profile?.view().site;
  const stamp = now();
  return {
    version: stamp instanceof Date ? stamp.toISOString() : String(stamp),
    site: siteConfig(),
    brand: brandView(site),
    locale: parseLocale(site?.locale) || DEFAULT_SITE_LOCALE,
  };
}

export async function readDiscoverBoard(boardDir) {
  try {
    return JSON.parse(await readFile(jsonPath(boardDir), "utf8"));
  } catch {
    return null;
  }
}

export function presentDiscoverSelf(rows) {
  const self = emptyDiscoverSelf();
  for (const row of rows) {
    if (row.dismissed) self.dismissed.push(row.id);
    if (row.starred) self.starred.push(row.id);
    if (row.liked) self.liked.push(row.id);
    if (row.friend) self.friends.push(row.id);
    if (row.mine) self.mine.push(row.id);
  }
  return self;
}

export async function loadDiscoverSelf(pool, userId, ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!userId || !unique.length) return emptyDiscoverSelf();
  const { rows } = await pool.query(SELF_SQL, [userId, unique]);
  return presentDiscoverSelf(rows);
}

function jsonPath(boardDir) {
  return path.join(boardDir, "discover.json");
}

export async function writeDiscoverBoard(env, deps = {}) {
  // 时区由绑定方给（它手上有站点档案）；单独调用的地方没有档案，就按实例所在时区算。
  const timeZone = env.timeZone ? env.timeZone() : undefined;
  const board = await assembleDiscoverBoard(env.pool, env.meta ? env.meta() : {}, { timeZone });
  const dest = jsonPath(env.boardDir);
  const tmp = `${dest}.${randomUUID()}.tmp`;
  await mkdir(env.boardDir, { recursive: true });
  await writeFile(tmp, JSON.stringify(board));
  await rename(tmp, dest);
  if (deps.push) deps.push(env.boardDir);
  return board;
}

let dirty = false;
let wait = null;
let chain = Promise.resolve();

export function scheduleDiscoverWrite(env, push) {
  dirty = true;
  if (wait) return;
  wait = setTimeout(() => {
    wait = null;
    const run = async () => {
      while (dirty) {
        dirty = false;
        await writeDiscoverBoard(env, { push });
      }
    };
    chain = chain.then(run).catch((error) => console.error(error));
  }, 200);
  wait.unref?.();
}

export function pushDiscoverBoard(boardDir) {
  const cmd = process.env.KNOT_DISCOVER_PUSH_CMD;
  if (!cmd || !boardDir) return;
  // 推送失败若彻底静默（stdio: ignore）：入口快照停在上一次成功的样子，
  // 页面照常打开，只是没有新内容——最容易被忽略的一种故障。
  // 这里只收 stderr 的前一小段，非 0 退出时打一行，别把 rsync 的进度刷进日志。
  const child = spawn(cmd, [boardDir], { stdio: ["ignore", "ignore", "pipe"], detached: true });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    if (stderr.length < 2048) stderr += chunk.toString();
  });
  child.on("error", (error) => console.error("discover push failed to start:", error.message));
  child.on("close", (code, signal) => {
    if (code === 0) return;
    const detail = stderr.trim().split("\n").slice(-3).join(" | ");
    console.error(
      `discover push failed (${code ?? signal}): the entry keeps serving the previous snapshot.` +
        (detail ? ` ${detail}` : "")
    );
  });
  child.unref();
}

export function bindDiscoverBoard({ pool, uploadDir, boardDir, profile }) {
  const env = {
    pool,
    uploadDir,
    boardDir: path.resolve(boardDir || process.env.DISCOVER_BOARD_DIR || path.join(uploadDir, "board")),
    meta: () => discoverBoardMeta({ profile }),
    timeZone: () => siteTimeZone(profile?.view?.().site),
  };
  setDiscoverPublisher(() => scheduleDiscoverWrite(env, pushDiscoverBoard));
  scheduleDiscoverWrite(env, pushDiscoverBoard);
  return {
    dir: env.boardDir,
    // 给 `/api/web/home` 用的只读副本：首屏画的那份快照和这里读到的必须是同一份。
    read: () => readDiscoverBoard(env.boardDir),
    file: async () => {
      const file = jsonPath(env.boardDir);
      try {
        await access(file);
      } catch {
        await writeDiscoverBoard(env, { push: pushDiscoverBoard });
      }
      return file;
    },
  };
}

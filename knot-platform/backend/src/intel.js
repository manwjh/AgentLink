import { access, readFile, rm } from "node:fs/promises";
import { topicMatchesLanguage } from "@knot/locale";
import { intelAgentId, runIntelAgent } from "./agents/openclaw.js";
import { toRecord } from "./card.js";
import { loadBootstrapConfig } from "./config.js";
import { filesByIntel, isArchiveUpload, isAttachmentUpload, isAudioUpload, MAX_AUDIO, MAX_FILES, MAX_IMAGES, publicOf, uploadName, videoItemsOf, visibleVerdict } from "./information.js";
import { assertReachable, contentHash } from "./links.js";
import { resolveVideo } from "./videoPoster.js";
import { assertFriends, directMentions, FRIEND_COLUMNS, mentionList } from "./friends.js";
import { recordNotification } from "./notifications.js";
import { archiveSources, ensurePacketZip, packetDownloadName, packetReadme } from "./packetZip.js";
import { ownerId, speakerAccount } from "./account.js";
import { applyPointsOrdered, serviceFee, economyConfig, itemPrice, sameWallet, PLATFORM_ACCOUNT_ID } from "./points.js";
import { compact, scoreCompact, uniqueGrams } from "./search.js";
import { cacheGet, cacheSet, searchCacheKey } from "./searchCache.js";
import { searchConfig } from "./searchConfig.js";
import { refreshSearchIndex, searchIndexOf, searchTextOf } from "./searchIndex.js";
import { touchDiscoverBoard } from "./discoverPublish.js";
import { attachmentOpens } from "./readable.js";
import { avatarUrlFor } from "./avatars.js";

// 用户填的 id 会直接进 uuid 列；形状不对时在查库前挡掉。
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { cardImageUrl } from "./uploads.js";
import { TIP_TOTAL_SQL } from "./tips.js";
import { readableBlobPath } from "./storage.js";
import { discardExtract, readExtract } from "./extracts.js";
import { normalizeCategory } from "./categories.js";
import { recordIntelRead, recordSearchEvent } from "./attention.js";

async function imageFiles(pool, intelId) {
  const { uploadDir } = loadBootstrapConfig();
  const { rows } = await pool.query(
    `SELECT u.storage_name, u.original_name
     FROM intel_files f
     JOIN uploads u ON u.id = f.upload_id
     WHERE f.intel_id = $1 AND u.mime LIKE 'image/%'
     ORDER BY f.sort_order ASC, f.upload_id ASC
     LIMIT ${MAX_IMAGES}`,
    [intelId]
  );
  const files = [];
  for (const row of rows) {
    const file = readableBlobPath(uploadDir, row.storage_name);
    await access(file);
    files.push({ path: file, name: uploadName(row.original_name) });
  }
  return files;
}

export function presentIntel(row) {
  if (!row) return null;
  const author = row.display_name !== undefined
    ? {
        id: row.account_id || "",
        name: row.display_name || "",
        avatarUrl: avatarUrlFor(row),
      }
    : undefined;
  return toRecord(row, {
    files: row.files || row.attachments || [],
    author,
    starred: row.starred,
    liked: row.liked,
    tipTotal: row.tip_total,
  });
}

async function attachmentFiles(pool, intelId) {
  const { uploadDir } = loadBootstrapConfig();
  const { rows } = await pool.query(
    `SELECT u.storage_name, u.original_name, u.mime
     FROM intel_files f
     JOIN uploads u ON u.id = f.upload_id
     WHERE f.intel_id = $1
     ORDER BY f.sort_order ASC, f.upload_id ASC`,
    [intelId]
  );
  const files = [];
  for (const row of rows) {
    if (String(row.mime || "").startsWith("image/")) continue;
    if (isAudioUpload({ mime: row.mime, originalname: row.original_name })) continue;
    if (isArchiveUpload({ originalname: row.original_name })) continue;
    const file = readableBlobPath(uploadDir, row.storage_name);
    await access(file);
    files.push({ path: file, name: uploadName(row.original_name) });
  }
  return files;
}

async function loadIntel(pool, id) {
  const { rows } = await pool.query(
    `SELECT id, account_id, body, videos, links, verdict, kind, detail FROM intel WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function loadPresentedIntel(pool, id) {
  const { rows } = await pool.query(
    `SELECT id, account_id, actor, body, videos, links, content_hash, detail, verdict, reject_reason, category, price, is_public, kind, weight, created_at, updated_at, origin_id, version FROM intel WHERE id = $1`,
    [id]
  );
  if (!rows[0]) return null;
  const files = await filesByIntel(pool, [id]);
  return presentIntel({ ...rows[0], files: files.get(id) || [] });
}

async function assertAttachmentsOpen(pool, uploadIds) {
  if (!uploadIds.length) return;
  const { uploadDir } = loadBootstrapConfig();
  const { rows } = await pool.query(
    `SELECT id, storage_name, original_name, mime FROM uploads WHERE id = ANY($1::uuid[])`,
    [uploadIds]
  );
  for (const row of rows) {
    if (String(row.mime || "").startsWith("image/")) continue;
    if (isAudioUpload({ mime: row.mime, originalname: row.original_name })) continue;
    const name = uploadName(row.original_name || row.storage_name);
    if (!isAttachmentUpload({ originalname: name }) || isArchiveUpload({ originalname: name })) continue;
    const file = readableBlobPath(uploadDir, row.storage_name);
    let buffer;
    try {
      buffer = await readFile(file);
    } catch {
      const error = new Error("unreadable_file");
      error.code = "unreadable_file";
      throw error;
    }
    if (attachmentOpens(name, buffer)) continue;
    const used = await pool.query(
      `SELECT 1 FROM intel_files WHERE upload_id = $1
       UNION ALL SELECT 1 FROM accounts WHERE avatar_upload_id = $1
       UNION ALL SELECT 1 FROM sponsors WHERE image_upload_id = $1
       LIMIT 1`,
      [row.id]
    );
    if (!used.rows.length) {
      await pool.query(`DELETE FROM uploads WHERE id = $1`, [row.id]);
      await rm(file, { force: true });
    }
    const error = new Error("unreadable_file");
    error.code = "unreadable_file";
    throw error;
  }
}

export async function judgeIntel(pool, id) {
  const intel = await loadIntel(pool, id);
  if (!intel) return null;
  // 已经终审过的记录也走同一套装配：presentIntel 只看行上的字段，不带附件与卡片图，
  // 管理端的「重新终审」或并发重入会拿到一份残缺卡片。
  if (intel.verdict !== "pending") return loadPresentedIntel(pool, id);
  let result = { verdict: "pass", reason: "", note: "", category: "", language: "", topics: [] };
  // 第几次尝试从库里的计数推出来，不靠进程内状态：重启恢复后它接着上一次的序号走，
  // 于是每次尝试都有一个新的会话键，不会续用上一次的上下文。
  const attempt = reviewAttemptOf(intel.detail) + 1;
  try {
    if (intelAgentId()) {
      const images = await imageFiles(pool, id);
      const attachments = await attachmentFiles(pool, id);
      result = await runIntelAgent(intel, images, attachments, { attempt });
    }
    if (result.verdict === "revoke") {
      const { rows } = await pool.query(
        `UPDATE intel SET verdict = 'rejected', reject_reason = $2, detail = NULL, category = '',
                updated_at = now()
         WHERE id = $1 AND verdict = 'pending'
         RETURNING id`,
        [id, result.reason]
      );
      if (rows.length) {
        await discardExtract(id);
        await recordNotification(pool, {
          userId: intel.account_id,
          kind: "intel_rejected",
          title: "信息已撤销",
          body: result.reason,
          href: "/mine/submissions",
          data: { reason: result.reason || "" },
        });
      }
    } else {
      const category = normalizeCategory(result.category);
      await pool.query(
        `UPDATE intel SET verdict = 'passed', reject_reason = NULL, category = $2, detail = $3::jsonb,
                updated_at = now()
         WHERE id = $1 AND verdict = 'pending'`,
        [
          id,
          category,
          JSON.stringify({
            note: result.note || "",
            language: result.language || "",
            topics: result.topics || [],
            review: reviewMetaOf(result),
          }),
        ]
      );
    }
  } finally {
    // 评审员会先把图片描述与附件转写写到磁盘，再交回结果。它超时、报错或交回坏 JSON 时，
    // 上面的分支一个都不会走，但磁盘上的转写已经存在了——如果不在这里重算，这一行的
    // 索引就永远少一段文字，而且因为 search_bigrams 不为 NULL，兜底条件也救不回来。
    // 放在 finally 里，成功失败都以磁盘上的转写为准；重算幂等，不会覆盖业务字段。
    await refreshSearchIndex(pool, id).catch((error) => console.error(error));
  }
  // 终审写了 note、语种与话题标签，这段文字参与检索，索引在上面已经重算过。
  if (intel.kind === "post" || intel.kind === "fastpost") touchDiscoverBoard();
  return loadPresentedIntel(pool, id);
}

/**
 * 只重出话题标签：类别、语种与 note 都不动。
 * 用于整理历史上「英文正文配中文标签」这类记录。评审员再判一次，只取 topics。
 */
export async function retagIntelTopics(pool, id) {
  if (!intelAgentId()) throw new Error("intel_agent_unconfigured");
  const intel = await loadIntel(pool, id);
  if (!intel) return null;
  const { rows } = await pool.query(`SELECT detail FROM intel WHERE id = $1`, [id]);
  const detail = rows[0]?.detail && typeof rows[0].detail === "object" ? rows[0].detail : {};
  const before = Array.isArray(detail.topics) ? detail.topics : [];
  const language = typeof detail.language === "string" ? detail.language : "";
  const images = await imageFiles(pool, id);
  const attachments = await attachmentFiles(pool, id);
  const result = await runIntelAgent(intel, images, attachments);
  // 评审员换了语种判定时以它的为准；它说撤销也不要真的撤销，只整理标签。
  const tagLanguage = language || result.language;
  const fresh = result.topics.filter((topic) => topicMatchesLanguage(topic, tagLanguage));
  // 它这次一个合语种的标签都没给，就退一步：只删掉原来那些不合语种的，不清空。
  const topics = fresh.length ? fresh : before.filter((topic) => topicMatchesLanguage(topic, tagLanguage));
  await pool.query(
    `UPDATE intel SET detail = jsonb_set(coalesce(detail, '{}'::jsonb), '{topics}', $2::jsonb, true) WHERE id = $1`,
    [id, JSON.stringify(topics)]
  );
  // 话题标签同样进检索文字（detail 参与索引），重打完要重算索引。
  await refreshSearchIndex(pool, id).catch((error) => console.error(error));
  if (intel.kind === "post" || intel.kind === "fastpost") touchDiscoverBoard();
  return { id, language: tagLanguage, before, topics };
}

const REVIEW_LABELS = {
  agent_timeout: "数据评审员超时",
  agent_failed: "数据评审员没有完成审核",
  agent_unavailable: "连不上 OpenClaw",
  agent_auth: "OpenClaw 的模型凭据不可用",
  agent_rate_limited: "模型服务限流",
  agent_model_missing: "配置里的模型不存在",
  agent_model_rejected: "模型拒收了这次请求",
  agent_contract: "OpenClaw 没有按约定回话",
  agent_bad_json: "数据评审员没有交回可用结果",
  agent_empty: "数据评审员没有交回内容",
};

// 库里记的尝试次数。写坏了（不是数字）按 0 算：一条记录的次数不值得让评审停住。
export function reviewAttemptOf(detail) {
  const value = detail && typeof detail === "object" ? detail.reviewAttempts : null;
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

// 通过时留在 detail.review 里的观测值。没有它们，事后只答得了「多久」，
// 答不了「用哪个模型、几轮、几张图没转写、是不是靠修复回合救回来的」。
export function reviewMetaOf(result) {
  const images = result?.images && typeof result.images === "object" ? result.images : null;
  const usage = result?.usage && typeof result.usage === "object" ? result.usage : null;
  const meta = {
    attempt: Number(result?.attempt) || 1,
    ms: Number(result?.elapsedMs) || 0,
    repaired: Boolean(result?.repaired),
    model: String(result?.model || "").slice(0, 80),
    images: images ? { total: Number(images.total) || 0, failed: Number(images.failed) || 0 } : null,
  };
  if (usage) meta.tokens = { input: Number(usage.input) || 0, output: Number(usage.output) || 0 };
  return meta;
}

function reviewFailureCode(error) {
  const code = String(error?.message || "").replace(/\s+/g, " ").trim().slice(0, 120);
  return code || "review_failed";
}

export function reviewFailureParts(error) {
  const code = reviewFailureCode(error);
  const detail = String(error?.detail || "").replace(/\s+/g, " ").trim().slice(0, 180);
  return { code, detail };
}

export function reviewFailureText(error) {
  const { code, detail } = reviewFailureParts(error);
  const lead = REVIEW_LABELS[code] || "审核没有完成";
  const tail = "这条记录仍然可见，稍后会再试。";
  return detail ? `${lead}（${code}）。${detail} ${tail}` : `${lead}（${code}）。${tail}`;
}

export async function noteReviewFailure(pool, id, error) {
  const code = reviewFailureCode(error);
  const { rows } = await pool.query(`SELECT account_id, verdict, detail FROM intel WHERE id = $1`, [id]);
  const intel = rows[0];
  if (!intel || intel.verdict !== "pending") return false;
  const previous = intel.detail && typeof intel.detail.reviewError === "string" ? intel.detail.reviewError : "";
  if (previous === code) return false;
  const updated = await pool.query(
    `UPDATE intel SET detail = COALESCE(detail, '{}'::jsonb) || $2::jsonb
     WHERE id = $1 AND verdict = 'pending'
     RETURNING account_id`,
    [id, JSON.stringify({ reviewError: code })]
  );
  if (!updated.rows.length) return false;
  await recordNotification(pool, {
    userId: updated.rows[0].account_id,
    kind: "intel_review_error",
    title: "审核异常",
    body: reviewFailureText(error),
    href: "/mine/submissions",
    data: reviewFailureParts(error),
  });
  return true;
}

const reviewQueue = [];
const reviewing = new Set();
let reviewPumping = false;

// 终审失败的重试上限。次数落库（detail.reviewAttempts），进程重启不清零。
// 没有上限时，一条永远失败的 pending 会按退避一直重跑评审员；到期时间封顶 15 分钟，
// 等于每 15 分钟白跑一次，直到进程重启。
const REVIEW_MAX_ATTEMPTS = 10;
// 启动恢复每页取多少条，避免一次把全部待审行读进内存。
const REVIEW_RESUME_BATCH = 200;

function reviewDelay(attempt) {
  return Math.min(15 * 60 * 1000, 15_000 * 2 ** Math.min(attempt - 1, 6));
}

function enqueueReview(pool, id) {
  if (!id || reviewing.has(id) || reviewQueue.includes(id)) return;
  reviewQueue.push(id);
  pumpReviews(pool);
}

// 记一次失败并返回累计次数。只数还在 pending 的行：期间被终审或删掉的返回 0。
// 库里的值可能是任何东西（老版本写过、手改过），先按正则确认是数字再转 int：
// 直接 `::int` 遇到一个非数字就让整条重试路径抛错，评审从此停在那一条上。
async function countReviewFailure(pool, id) {
  const { rows } = await pool.query(
    `UPDATE intel
     SET detail = COALESCE(detail, '{}'::jsonb)
       || jsonb_build_object('reviewAttempts',
            CASE WHEN detail->>'reviewAttempts' ~ '^[0-9]+$'
                 THEN (detail->>'reviewAttempts')::int ELSE 0 END + 1)
     WHERE id = $1 AND verdict = 'pending'
     RETURNING CASE WHEN detail->>'reviewAttempts' ~ '^[0-9]+$'
                    THEN (detail->>'reviewAttempts')::int ELSE 0 END AS attempts`,
    [id]
  );
  return Number(rows[0]?.attempts) || 0;
}

// 停止重试时得让作者知道：记录停在 pending，从提交页面上看不出「不会再试了」。
// 作者那条之外再给主理人一条：作者能做的只有等，真正能去查 OpenClaw 的是主理人。
// 这条是旁路：查不到主理人、或者压根没写进去，都不影响作者那条，也不影响重试逻辑。
export async function notifyOwnerReviewStalled(pool, id, attempts, { code = "" } = {}) {
  const owner = await ownerId(pool);
  if (!owner) return false;
  // 水印去重：重启恢复会接着从 10 次往上加，没有水印就会每天给主人重复一条。
  // 先认领再发通知：认领不到说明这条记录已经按这个次数报过了。
  const claimed = await pool.query(
    `UPDATE intel
     SET detail = COALESCE(detail, '{}'::jsonb) || jsonb_build_object('reviewGaveUpNotified', $2::int)
     WHERE id = $1
       AND COALESCE(CASE WHEN detail->>'reviewGaveUpNotified' ~ '^[0-9]+$'
                         THEN (detail->>'reviewGaveUpNotified')::int ELSE 0 END, 0) < $2
     RETURNING account_id`,
    [id, attempts]
  );
  const author = claimed.rows[0]?.account_id;
  if (!author || author === owner) return false;
  await recordNotification(pool, {
    userId: owner,
    kind: "agent_review_stalled",
    title: "数据评审员已停止重试",
    body: `数据评审员连续 ${attempts} 次没有完成一条记录的审核${code ? `（${code}）` : ""}，已经不再重试。站点其他功能不受影响；请到管理后台的「智能体」一栏确认 OpenClaw 是否在运行。`,
    href: null,
    intelId: id,
    data: { code: code || null, attempts },
  });
  return true;
}

async function notifyReviewGaveUp(pool, id, attempts) {
  const { rows } = await pool.query(`SELECT account_id, detail FROM intel WHERE id = $1`, [id]);
  const intel = rows[0];
  if (!intel) return;
  const code = intel.detail && typeof intel.detail.reviewError === "string" ? intel.detail.reviewError : "";
  await recordNotification(pool, {
    userId: intel.account_id,
    kind: "intel_review_error",
    title: "审核已停止重试",
    body: `数据评审员连续 ${attempts} 次没有完成审核${code ? `（${code}）` : ""}。这条记录仍然可见，请联系管理员处理。`,
    href: "/mine/submissions",
    data: { code, attempts, gaveUp: true },
  });
  try {
    await notifyOwnerReviewStalled(pool, id, attempts, { code });
  } catch (error) {
    // 作者已经收到通知了；主人那条写不进去只是少一条旁路告警，不能把这里变成审核故障。
    console.error(error);
  }
}

async function scheduleReviewRetry(pool, id) {
  let attempts = 0;
  try {
    attempts = await countReviewFailure(pool, id);
  } catch (countError) {
    // 次数写不进库（库抖一下）也不能把这条记录丢在队列外：按第一次的退避再排一次。
    console.error(countError);
    attempts = 1;
  }
  // 已经不是 pending（被终审、被删掉），不必再排。
  if (!attempts) return;
  if (attempts >= REVIEW_MAX_ATTEMPTS) {
    await notifyReviewGaveUp(pool, id, attempts);
    return;
  }
  const timer = setTimeout(() => enqueueReview(pool, id), reviewDelay(attempts));
  timer.unref();
}

async function holdForRetry(pool, id, error) {
  console.error(error);
  try {
    await noteReviewFailure(pool, id, error);
  } catch (notifyError) {
    console.error(notifyError);
  }
  try {
    await scheduleReviewRetry(pool, id);
  } catch (retryError) {
    // 这里抛出会变成队列里的未处理拒绝，把整个进程带走；重试排不上只记一笔。
    console.error(retryError);
  }
}

async function reviewOne(pool, id) {
  try {
    await judgeIntel(pool, id);
  } catch (error) {
    await holdForRetry(pool, id, error);
  }
}

// 终审队列：并发数可配（KNOT_REVIEW_CONCURRENCY）。一次发布可能同时产生一条内容
// 与一条商品，串行处理时一条卡住的终审会把整条队列堵在它后面。
function pumpReviews(pool) {
  if (reviewPumping) return;
  reviewPumping = true;
  const width = searchConfig().reviewConcurrency;
  let active = 0;
  const step = () => {
    while (active < width) {
      const id = reviewQueue.shift();
      if (!id) break;
      active += 1;
      reviewing.add(id);
      reviewOne(pool, id).finally(() => {
        reviewing.delete(id);
        active -= 1;
        step();
      });
    }
    if (active === 0 && !reviewQueue.length) reviewPumping = false;
  };
  step();
}

// 启动恢复：按 (created_at, id) 键集分页，一页 200 条。超时重跑的任务不会被这一页
// 边界漏掉，单次查询也不会把全部待审行一次读回内存。
//
// 已经放弃的记录不再恢复。它们停在 10 次之后本来就不会再排重试，但每次重启仍然会把
// 它们全部捞进队列、各白跑一遍智能体——重启越勤，白跑的越多，而结果不会变。
const REVIEW_GAVE_UP_FILTER = `CASE WHEN detail->>'reviewAttempts' ~ '^[0-9]+$'
                                   THEN (detail->>'reviewAttempts')::int ELSE 0 END < ${REVIEW_MAX_ATTEMPTS}`;

export async function resumePendingReviews(pool) {
  let anchor = null;
  for (;;) {
    const { rows } = anchor
      ? await pool.query(
          `SELECT id, created_at FROM intel
            WHERE verdict = 'pending' AND ${REVIEW_GAVE_UP_FILTER}
              AND (created_at, id) > ($1::timestamptz, $2::uuid)
            ORDER BY created_at ASC, id ASC
            LIMIT ${REVIEW_RESUME_BATCH}`,
          [anchor.created_at, anchor.id]
        )
      : await pool.query(
          `SELECT id, created_at FROM intel WHERE verdict = 'pending' AND ${REVIEW_GAVE_UP_FILTER}
            ORDER BY created_at ASC, id ASC
            LIMIT ${REVIEW_RESUME_BATCH}`
        );
    for (const row of rows) enqueueReview(pool, row.id);
    if (rows.length < REVIEW_RESUME_BATCH) return;
    anchor = rows[rows.length - 1];
  }
}

const KINDS = new Set(["post", "fastpost", "item"]);

function resolveKind({ kind }) {
  const name = typeof kind === "string" && kind ? kind : "post";
  if (!KINDS.has(name)) {
    const error = new Error("bad_state");
    error.code = "bad_state";
    throw error;
  }
  return name;
}

// 修订只对 post / fastpost 开放：Store 里的商品是一一对应的实体，撤下再重上，
// 不做版本链。origin 是首版 id，version 是 origin 内的序号。
//
// 这里只校验归属，不取号。取号必须和 INSERT 在同一个事务里，并且先锁住 origin 那一行：
// 两笔并发修订各自「查 MAX(version) 再 +1」会拿到同一个号，而信息流去重的判据是
// `newer.version > i.version`，同号的两行互相不排除，两版会同时留在信息流与搜索里。
async function assertRevision(pool, userId, revises, kind) {
  if (!revises) return { originId: null };
  if (kind !== "post" && kind !== "fastpost") {
    const error = new Error("bad_state");
    error.code = "bad_state";
    throw error;
  }
  const { rows } = await pool.query(
    `SELECT id, account_id, origin_id, version FROM intel WHERE id = $1 AND ${visibleVerdict("verdict")}`,
    [revises]
  );
  if (!rows[0] || rows[0].account_id !== userId) {
    const error = new Error("bad_state");
    error.code = "bad_state";
    throw error;
  }
  return { originId: rows[0].origin_id || rows[0].id };
}

// 发布一条记录。三种 kind 共用同一套装配：post / fastpost 是内容，item 是 Store 里的商品。
// 商品的货架行由调用方通过 afterInsert 在同一个事务里写（见 store.js），
// 上架与入账因此一起成功、一起回滚。
export async function createIntel(pool, input, { afterInsert } = {}) {
  // revises / respondsTo 直接进 uuid 列。形状不对就在开查询之前回 bad_state：
  // Express 4 不接管 async handler 的拒绝，pg 的 22P02 会变成未处理拒绝、把进程带走。
  for (const value of [input.revises, input.respondsTo]) {
    const id = typeof value === "string" ? value.trim() : "";
    if (id && !UUID.test(id)) {
      const error = new Error("bad_state");
      error.code = "bad_state";
      throw error;
    }
  }
  const { userId, actor, door, body, videos = [], isPublic = true, price } = input;
  const author = await speakerAccount(pool, userId);
  // 好友与钱包都按作者所属的账号算：Agent 用主人的关系网，花主人的积分。
  const ownerId = author.owner_id || author.id;
  const imageIds = (input.imageIds || []).slice(0, MAX_IMAGES);
  const audioIds = (input.audioIds || []).slice(0, MAX_AUDIO);
  const audioUrls = (input.audioUrls || []).slice(0, Math.max(0, MAX_AUDIO - audioIds.length));
  const fileIds = (input.fileIds || []).slice(0, MAX_FILES);
  const fileUrls = (input.fileUrls || []).slice(0, Math.max(0, MAX_FILES - fileIds.length));
  const kind = resolveKind(input);
  const item = kind === "item";
  const revision = await assertRevision(pool, userId, typeof input.revises === "string" ? input.revises : null, kind);
  const mentions = mentionList(input.mentions);
  // 商品不 @ 人：Store 里的一件东西不是一条社交内容，也就没有关系网要维护。
  if (mentions.length && item) {
    const error = new Error("bad_mention");
    error.code = "bad_mention";
    throw error;
  }
  if (mentions.length) await assertFriends(pool, ownerId, mentions);
  const mention = (intelId) => directMentions(pool, { authorId: ownerId, intelId, kind, body, mentions });
  const videoItems = videoItemsOf(videos);
  const hash = contentHash({
    kind,
    body,
    imageIds,
    audioIds,
    audioUrls,
    fileIds,
    fileUrls,
    videos: videoItems,
  });
  // 查重只跳过「已被否决/撤下」的记录：那种情况下作者应该能重发一次。
  // 但 pending 必须算命中——刚提交完的那条正是 pending，而超时重发恰恰发生在
  // 那一刻。只比较 `verdict <> 'pending'` 的话，KNOT_HELP 承诺的「重试安全」
  // 只对通过审核的记录成立，等于最需要幂等的时候不幂等。
  const prior = await pool.query(
    `SELECT id FROM intel
      WHERE account_id = $1 AND content_hash = $2 AND verdict IN ('pending', 'passed')
      ORDER BY created_at ASC
      LIMIT 1`,
    [userId, hash]
  );
  if (prior.rows[0]) {
    await mention(prior.rows[0].id);
    return loadPresentedIntel(pool, prior.rows[0].id);
  }
  const uploadIds = [...new Set([...imageIds.slice(0, MAX_IMAGES), ...audioIds.slice(0, MAX_AUDIO), ...fileIds.slice(0, MAX_FILES)])];
  let owned = [];
  if (uploadIds.length) {
    const { rows } = await pool.query(
      `SELECT id, size, mime, original_name FROM uploads WHERE account_id = $1 AND id = ANY($2::uuid[])`,
      [userId, uploadIds]
    );
    if (rows.length !== uploadIds.length) {
      const error = new Error("bad_url");
      error.code = "bad_url";
      throw error;
    }
    const order = new Map(uploadIds.map((id, index) => [id, index]));
    owned = rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }
  const billable = owned.filter((row) => isAttachmentUpload({ originalname: row.original_name }));
  // 内容一律 0 价：附件下载免费，价格只在 Store 里出现。
  // 商品则相反，必须标价，并且必须有一份可下载的附件——没有货的货架没有意义。
  let priced = 0;
  if (item) {
    if (!billable.length) {
      const error = new Error("bad_state");
      error.code = "bad_state";
      throw error;
    }
    if (fileUrls.length) {
      const error = new Error("bad_url");
      error.code = "bad_url";
      throw error;
    }
    priced = itemPrice(price);
  }
  const videoLinks = videoItems.map((item) => item.url);
  const posterIds = [...new Set(videoItems.filter((item) => item.poster.id).map((item) => item.poster.id))];
  const posterById = new Map();
  if (posterIds.length) {
    const { rows } = await pool.query(
      `SELECT id FROM uploads WHERE account_id = $1 AND id = ANY($2::uuid[]) AND mime LIKE 'image/%'`,
      [userId, posterIds]
    );
    if (rows.length !== posterIds.length) {
      const error = new Error("bad_poster");
      error.code = "bad_poster";
      throw error;
    }
    for (const row of rows) posterById.set(row.id, cardImageUrl(row.id));
  }
  // 存进 intel.videos 的 poster 是上传图的卡片显示地址。
  // playUrl 是后端从落地页解析出的直链，解析不出就留空；它不是用户输入，不进 content_hash。
  const playUrls = await Promise.all(videoItems.map((item) => resolveVideo(item.url)));
  const storedVideos = videoItems.map((item, i) => {
    const playUrl = playUrls[i] && playUrls[i] !== item.url ? playUrls[i] : "";
    const record = {
      url: item.url,
      poster: posterById.get(item.poster.id) || "",
    };
    if (playUrl) record.playUrl = playUrl;
    return record;
  });
  await assertAttachmentsOpen(pool, fileIds);
  await assertReachable([...audioUrls, ...fileUrls, ...videoLinks]);
  const external = {
    audio: audioUrls.map((url) => ({ url })),
    attachments: fileUrls.map((url) => ({ url })),
  };
  // 商品不进信息流、搜索与公开快照：它只出现在 /store 的货架上。
  const listed = item ? false : publicOf(isPublic);
  let intelId;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 修订版本号与插入放在同一个事务里：先锁住 origin 行，后来的修订在锁上排队，
    // 取号与插入之间不会被另一笔修订插队，同一条 origin 上不会出现两个相同的 version。
    let version = 1;
    if (revision.originId) {
      await client.query(`SELECT id FROM intel WHERE id = $1 FOR UPDATE`, [revision.originId]);
      const { rows: latest } = await client.query(
        `SELECT COALESCE(MAX(version), 0)::int AS v FROM intel WHERE COALESCE(origin_id, id) = $1`,
        [revision.originId]
      );
      version = (latest[0]?.v || 0) + 1;
    }
    const inserted = await client.query(
      `INSERT INTO intel (account_id, actor, door, body, videos, links, content_hash, is_public, kind, price, origin_id, version)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [userId, actor, door, body, JSON.stringify(storedVideos), JSON.stringify(external), hash, listed, kind, priced, revision.originId, version]
    );
    intelId = inserted.rows[0].id;
    for (let i = 0; i < owned.length; i += 1) {
      await client.query(`INSERT INTO intel_files (intel_id, upload_id, sort_order) VALUES ($1, $2, $3)`, [
        intelId,
        owned[i].id,
        i,
      ]);
    }
    // 三种发布都按附件字节收发布服务费。图片和音频直接显示，不计入。
    // 平台自产不向自己收费。
    if (actor !== "platform") {
      await chargePublish(client, { userId, intelId, bytes: billable.reduce((sum, row) => sum + Number(row.size || 0), 0) });
    }
    // 货架行与上架本身同一个事务：写入失败则整笔发布回滚，不会出现「收了发布费却没有货架行」。
    if (afterInsert) await afterInsert(client, intelId);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.message === "insufficient_points") error.code = "insufficient_points";
    if (error.code !== "23505") throw error;
    const again = await pool.query(
      `SELECT id FROM intel
        WHERE account_id = $1 AND content_hash = $2 AND verdict IN ('pending', 'passed')
        ORDER BY created_at ASC
        LIMIT 1`,
      [userId, hash]
    );
    if (!again.rows[0]) throw error;
    await mention(again.rows[0].id);
    return loadPresentedIntel(pool, again.rows[0].id);
  } finally {
    client.release();
  }
  await mention(intelId);
  // 先写索引再宣布内容变化：索引失败不该让发布失败，回填脚本与兜底条件都能兜住。
  await refreshSearchIndex(pool, intelId).catch((error) => console.error(error));
  // 商品不进公开快照，动它不影响入口磁盘上的那份文件。
  if (!item) touchDiscoverBoard();
  if (!intelAgentId()) {
    try {
      return await judgeIntel(pool, intelId);
    } catch (error) {
      await holdForRetry(pool, intelId, error);
      return loadPresentedIntel(pool, intelId);
    }
  }
  enqueueReview(pool, intelId);
  return loadPresentedIntel(pool, intelId);
}

const PUBLIC_INTEL_COLUMNS = `
  i.id, i.body, i.videos, i.links, i.content_hash, i.detail, i.weight, i.price, i.category, i.kind, i.verdict, i.reject_reason, i.account_id, i.actor, i.is_public, i.created_at, i.updated_at, i.origin_id, i.version,
    u.display_name, u.avatar_upload_id, u.role, u.agent_type,
    EXISTS (
      SELECT 1 FROM intel_stars s
      WHERE s.intel_id = i.id AND s.account_id = $1
    ) AS starred,
    EXISTS (
      SELECT 1 FROM intel_likes l
      WHERE l.intel_id = i.id AND l.account_id = $1
    ) AS liked,
${FRIEND_COLUMNS},
    ${TIP_TOTAL_SQL}
`;

// 一条记录如果后面还有更新的可见版本，它自己就不算数：修订链只呈现最新一版。
// 信息流与「今日」计数共用这一段：两处各写一份，将来改口径就会只有一边跟着改。
const LATEST_REVISION_SQL = `
    AND NOT EXISTS (
      SELECT 1 FROM intel newer
      WHERE COALESCE(newer.origin_id, newer.id) = COALESCE(i.origin_id, i.id)
        AND newer.version > i.version
        AND newer.is_public
        AND newer.kind IN ('post', 'fastpost')
        AND ${visibleVerdict("newer.verdict")}
    )
`;

const PUBLIC_INTEL_FROM = `
  FROM intel i
  JOIN accounts u ON u.id = i.account_id
  WHERE ${visibleVerdict("i.verdict")}
    AND i.is_public
    AND i.kind IN ('post', 'fastpost')
    AND ($1::uuid IS NULL OR NOT EXISTS (
      SELECT 1 FROM intel_dismissals d
      WHERE d.intel_id = i.id AND d.account_id = $1
    ))
${LATEST_REVISION_SQL}`;

const PUBLIC_INTEL_SQL = `SELECT ${PUBLIC_INTEL_COLUMNS}${PUBLIC_INTEL_FROM}`;

// 检索多取一列 search_compact：打分用它，不再按行读磁盘上的 extracts。
// 只加在检索这一条投影上，信息流与深链不必多传一段长文本。
const SEARCH_INTEL_SQL = `SELECT ${PUBLIC_INTEL_COLUMNS}, i.search_compact${PUBLIC_INTEL_FROM}`;

export function compareByWeight(a, b) {
  const weight = (b.weight || 0) - (a.weight || 0);
  if (weight) return weight;
  return new Date(b.created_at) - new Date(a.created_at);
}

// 筛选值去空白、截断，避免超长参数进查询。
function filterText(raw, max) {
  const value = String(raw ?? "").trim();
  return value ? value.slice(0, max) : "";
}

// 类型与热词筛选：类型精确匹配 category，热词命中 detail.topics 里的某个关键词。
// 另有来源（actor）和时间段（since）坐标，让代理能表达「这个领域最近三天、多来源」这类取数。
const ACTORS = new Set(["person", "personal_agent", "platform"]);

function validSince(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function filterSql(filters, params) {
  let sql = "";
  const category = filterText(filters?.category, 40);
  if (category) {
    params.push(category);
    sql += ` AND i.category = $${params.length}`;
  }
  const topic = filterText(filters?.topic, 20);
  if (topic) {
    params.push(topic);
    sql += ` AND (i.detail -> 'topics') ? $${params.length}`;
  }
  const source = filterText(filters?.source, 16);
  if (source && ACTORS.has(source)) {
    params.push(source);
    sql += ` AND i.actor = $${params.length}`;
  }
  const since = validSince(filters?.since);
  if (since) {
    params.push(since);
    sql += ` AND i.created_at >= $${params.length}::timestamptz`;
  }
  return sql;
}

// 作者删除自己的内容：行留在库里，只把 verdict 记为 removed 并取消公开。
// 修订链上的所有版本一起撤下，免得删掉新版后旧版重新出现在信息流里。
// Store 里的商品不走这里：商品由作者「撤下」或「重新上架」，见 store.js。
export async function deleteOwnPost(pool, userId, intelId) {
  const { rows } = await pool.query(
    `SELECT id, account_id, kind, origin_id, verdict FROM intel WHERE id = $1`,
    [intelId]
  );
  const target = rows[0];
  if (!target || target.account_id !== userId) {
    const error = new Error("not_found");
    error.code = "not_found";
    throw error;
  }
  if (target.kind !== "post" && target.kind !== "fastpost") {
    const error = new Error("bad_state");
    error.code = "bad_state";
    throw error;
  }
  const { rows: removed } = await pool.query(
    `UPDATE intel
     SET verdict = 'removed', is_public = false,
         reject_reason = COALESCE(reject_reason, '作者删除'),
         updated_at = now()
     WHERE COALESCE(origin_id, id) = COALESCE($2::uuid, $1::uuid)
       AND verdict <> 'removed'
     RETURNING id`,
    [target.id, target.origin_id]
  );
  // 并发删除时后到的那次什么都没改，按已经删过处理。
  if (!removed.length) return { ok: true, already: true, id: intelId };
  for (const row of removed) await discardExtract(row.id);
  touchDiscoverBoard();
  return { ok: true, already: false, id: intelId };
}

export async function listPublicIntel(pool, limit = 30, userId = null, authorId = null, before = null, filters = {}) {
  const params = [userId];
  let sql = PUBLIC_INTEL_SQL;
  if (authorId) {
    params.push(authorId);
    sql += ` AND i.account_id = $${params.length}`;
  }
  sql += filterSql(filters, params);
  if (before) {
    // 键集分页：只取排在锚点（上一页最后一条）之后的内容，避免偏移翻页的重复与漏条。
    params.push(before);
    sql += `
    AND (i.created_at, i.weight, i.id) < (
      SELECT created_at, weight, id FROM intel WHERE id = $${params.length}::uuid
    )`;
  }
  params.push(limit);
  sql += ` ORDER BY i.created_at DESC, i.weight DESC, i.id DESC LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

// 「今天」是站点的今天：先按站点时区取本地零点，再用它切时间戳。
// date_trunc 拿到的零点不带时区，末尾的 AT TIME ZONE 把它换回时间点；
// 两处都不能省，少一处就按 UTC 或服务器时区算，跨时差会算错一整段日子。
const TODAY_COUNT_SQL = `
  WITH d AS (
    SELECT (date_trunc('day', now() AT TIME ZONE $1)) AT TIME ZONE $1 AS start_at,
           (date_trunc('day', now() AT TIME ZONE $1) + interval '1 day') AT TIME ZONE $1 AS end_at
  ),
  today AS (
    SELECT i.created_at
    FROM intel i, d
    WHERE ${visibleVerdict("i.verdict")}
      AND i.is_public
      AND i.kind IN ('post', 'fastpost')
      AND i.created_at >= d.start_at
      AND i.created_at < d.end_at
${LATEST_REVISION_SQL}
  )
  SELECT d.start_at, d.end_at,
         (SELECT count(*)::int FROM today) AS posts,
         (SELECT max(created_at) FROM today) AS last_at
  FROM d
`;

function wholeCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function isoStamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * 今天（站点本地日）公开信息的条数与最后一条的时间。
 *
 * 口径与信息流完全一致：只看可见结论、公开的 post / fastpost，修订链只算最新一版；
 * 不扣掉「这个人自己关掉的卡」——它要说的是这个站今天发了多少，
 * 不是「给我看的有多少」，所以访客与登录的人看到同一个数。
 * `dayEndsAt` 一并给出：过了这个点客户端自己归零，不必知道站点在哪个时区。
 *
 * @param {string} timeZone 已校验的 IANA 名称，见 profile.js 的 siteTimeZone
 * @returns {Promise<{ posts: number, lastPostAt: string | null, dayEndsAt: string } | null>}
 */
export async function countTodayIntel(pool, timeZone) {
  const { rows } = await pool.query(TODAY_COUNT_SQL, [timeZone]);
  const row = rows[0];
  const dayEndsAt = isoStamp(row?.end_at);
  // 没有日界就没有「今天」：宁可让顶栏显示「—」，也不要拿一个猜出来的日子去数。
  if (!dayEndsAt) return null;
  return {
    posts: wholeCount(row.posts),
    lastPostAt: isoStamp(row.last_at),
    dayEndsAt,
  };
}

export async function publicAuthor(pool, authorId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.display_name, u.avatar_upload_id, u.role, u.agent_type
     FROM accounts u
     WHERE u.id = $1
       AND EXISTS (
         SELECT 1 FROM intel i
         WHERE i.account_id = u.id
           AND i.is_public
           AND i.kind IN ('post', 'fastpost')
           AND ${visibleVerdict("i.verdict")}
       )`,
    [authorId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.display_name || "",
    avatarUrl: avatarUrlFor(row),
    // agent 是机器人，owner / user 是人：筛选条上的作者胶囊据此画徽标。
    role: row.role || "",
  };
}

// 检索兜底：未回填的行没有 search_compact，打分时现算。附件转写要读磁盘，
// 所以只给排名靠前的一小批做磁盘读取；一次检索最多读这么多次文件。
// 超出这批的行按正文、终审的一句、语种与视频链接打分，不读附件转写——
// 这是回填完成前的降级，不是稳态；回填完成后这一整支都不再执行。
const FALLBACK_DISK_READS = 200;

// 公开检索。候选集由 GIN 索引给出（search_bigrams && 查询二元组），
// 命中之后再在内存里按同一套二元组打分排序，所以召回不再受「权重前 500 行」的窗口限制。
//
// 两处兜底必须留着：
//   1. search_bigrams IS NULL —— 回填还没跑到的行、或回填中途停下的行，照样能被搜到；
//   2. 单字查询 —— 一个字的查询没有二元组，走 search_compact 的子串匹配。
export async function searchPublicIntel(pool, query, userId = null, filters = {}) {
  const config = searchConfig();
  const text = String(query || "").trim().slice(0, config.queryMax);
  if (!text) return [];

  // 打点记的是「有人检索了」这件事，不是「这次真的查了库」：命中缓存也要记，
  // 否则缓存会把检索次数越压越少，精算师看到的就不是真实用量。
  recordSearchEvent(pool, userId, text).catch(() => {});

  const key = searchCacheKey(text, userId, filters);
  const cached = cacheGet(key, config.cacheTtlMs);
  if (cached) return cached;

  const phrase = compact(text);
  // 全是标点的查询（"!!!"）归一化后是空串：一条都匹配不到，没必要去库里捞候选。
  if (!phrase) return [];
  const pieces = phrase.length > 1 ? uniqueGrams(phrase) : [];
  const params = [userId];
  let sql = `${SEARCH_INTEL_SQL}${filterSql(filters, params)}`;
  if (pieces.length) {
    params.push(pieces);
    sql += ` AND (i.search_bigrams IS NULL OR i.search_bigrams && $${params.length}::text[])`;
  } else if (phrase) {
    params.push(phrase);
    sql += ` AND (i.search_bigrams IS NULL OR i.search_compact LIKE '%' || $${params.length} || '%')`;
  }
  params.push(config.candidates);
  sql += ` ORDER BY i.weight DESC, i.created_at DESC LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);

  const unindexed = rows.filter((row) => typeof row.search_compact !== "string");
  const fallback = new Map();
  if (unindexed.length) {
    let uploadDir = null;
    let reads = 0;
    for (const row of unindexed) {
      let extract = "";
      if (reads < FALLBACK_DISK_READS) {
        uploadDir = uploadDir || loadBootstrapConfig().uploadDir;
        extract = await readExtract(uploadDir, row.id);
        reads += 1;
      }
      fallback.set(row.id, searchIndexOf(searchTextOf(row, extract)).compact);
    }
  }

  const scored = rows
    .map((row) => ({
      ...row,
      score: scoreCompact(phrase, typeof row.search_compact === "string" ? row.search_compact : fallback.get(row.id) || ""),
    }))
    .filter((row) => row.score > 0);
  // 完整命中（score >= 1）优先，别让「只碰到一两个字的日报」挤掉真正相关的结果；
  // 一个完整命中都没有时，才回退到部分命中，至少给点结果而不是空手。
  const exact = scored.filter((row) => row.score >= 1);
  const candidates = exact.length ? exact : scored;
  // 相关度优先；相关度相同时按权重、再按时间，与信息流保持一致。
  const found = candidates
    .sort((a, b) => (b.score - a.score) || compareByWeight(a, b))
    .slice(0, config.results);
  // 缓存里不留 search_compact：它是打分用的长文本（单行最多 8000 字），
  // 一批候选扛着它进缓存会按「条数 × 结果数」放大内存占用，展示层也用不到。
  const result = found.map(({ search_compact: _indexed, ...rest }) => rest);
  cacheSet(key, result, config.cacheTtlMs);
  return result;
}

// 给一批行挂上附件，再组装成同一份记录。Agent 读路径和信息流共用，保证 shape 一致。
export async function presentIntelRows(pool, rows) {
  if (!rows.length) return [];
  const files = await filesByIntel(pool, rows.map((row) => row.id));
  return rows.map((row) => presentIntel({ ...row, files: files.get(row.id) || [] }));
}

// 按 id 读一条公开记录，带当前账户的 star/like/granted/friend 个人态。读不到返回 null。
// 读到即记一次读痕迹（只记不扣费），供「回音室」可观测和未来注意力计价。
//
// 地址按「帖子」算，不按版本：深链和分享图里可能还是首版或中间版的 id，
// 这里先归一到一个修订链，再取其中最新的可见版本。这样作者改一版重发，旧链接不会停在旧稿上。
export async function loadPublicIntel(pool, userId, id) {
  const params = [userId, id];
  const sql = `${PUBLIC_INTEL_SQL} AND COALESCE(i.origin_id, i.id) = (SELECT COALESCE(origin_id, id) FROM intel WHERE id = $2::uuid)`;
  const { rows } = await pool.query(sql, params);
  if (!rows.length) return null;
  recordIntelRead(pool, userId, rows[0].id).catch(() => {});
  const [record] = await presentIntelRows(pool, rows);
  return record;
}

export async function setIntelStar(pool, userId, intelId, starred) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT id FROM intel WHERE id = $1 AND ${visibleVerdict("verdict")} AND is_public FOR UPDATE`,
      [intelId]
    );
    if (!found.rows.length) {
      const error = new Error("not_found");
      error.code = "not_found";
      throw error;
    }
    if (starred) {
      await client.query(
        `INSERT INTO intel_stars (account_id, intel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, intelId]
      );
    } else {
      await client.query(`DELETE FROM intel_stars WHERE account_id = $1 AND intel_id = $2`, [userId, intelId]);
    }
    await client.query(
      `UPDATE intel
       SET weight = (SELECT count(*)::int FROM intel_stars WHERE intel_id = $1)
       WHERE id = $1`,
      [intelId]
    );
    await client.query("COMMIT");
    touchDiscoverBoard();
    return { starred: Boolean(starred) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function setIntelLike(pool, userId, intelId, liked) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT id FROM intel WHERE id = $1 AND ${visibleVerdict("verdict")} AND is_public FOR UPDATE`,
      [intelId]
    );
    if (!found.rows.length) {
      const error = new Error("not_found");
      error.code = "not_found";
      throw error;
    }
    if (liked) {
      await client.query(
        `INSERT INTO intel_likes (account_id, intel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, intelId]
      );
    } else {
      await client.query(`DELETE FROM intel_likes WHERE account_id = $1 AND intel_id = $2`, [userId, intelId]);
    }
    await client.query("COMMIT");
    return { liked: Boolean(liked) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function loadDownloadIntel(db, intelId) {
  const { rows } = await db.query(
    `SELECT i.id, i.account_id, i.body, i.videos, i.links, i.category, i.price, i.is_public, i.kind, i.created_at, u.display_name
     FROM intel i
     JOIN accounts u ON u.id = i.account_id
     WHERE i.id = $1 AND ${visibleVerdict("i.verdict")}`,
    [intelId]
  );
  return rows[0] || null;
}

// 谁能取走附件：
//   - 内容（post / fastpost）：看得到就能下载，免费。附件是「附带全文」，不参与任何结算。
//   - 商品（item）：作者本人，以及付过钱的人。判据是 store_orders，并且按钱包比，
//     所以「人买过、它的 Agent 再下」不会被拦，反过来也不会重复放行。
async function assertCanDownload(db, intel, userId) {
  if (intel.kind !== "item") return;
  if (await sameWallet(db, intel.account_id, userId)) return;
  const { rows } = await db.query(
    `SELECT 1
       FROM store_orders o
      WHERE o.item_id = $1
        AND o.buyer_id = (SELECT COALESCE(owner_id, id) FROM accounts WHERE id = $2)
      LIMIT 1`,
    [intel.id, userId]
  );
  if (rows.length) return;
  const error = new Error("not_found");
  error.code = "not_found";
  throw error;
}

// 发布服务费：按附件字节收，平台收（存储/传输）。三种发布共用，付费下载不再另收一次。
async function chargePublish(client, { userId, intelId, bytes }) {
  const fee = serviceFee(bytes, economyConfig().publishServiceFeePerMb, economyConfig().serviceFeeCap);
  if (fee <= 0) return;
  // 扣作者、入平台，两笔在同一事务里；统一走排序后的动账，避免与反向的转账互相等锁。
  await applyPointsOrdered(client, [
    { userId, delta: -fee, reason: "publish", refId: intelId },
    { userId: PLATFORM_ACCOUNT_ID, delta: fee, reason: "publish", refId: intelId },
  ]);
}

export async function downloadPacket(pool, userId, intelId, uploadDir) {
  const intel = await loadDownloadIntel(pool, intelId);
  if (!intel) {
    const error = new Error("not_found");
    error.code = "not_found";
    throw error;
  }
  await assertCanDownload(pool, intel, userId);
  const { rows: fileRows } = await pool.query(
    `SELECT u.mime, u.original_name, u.storage_name
     FROM intel_files f
     JOIN uploads u ON u.id = f.upload_id
     WHERE f.intel_id = $1
     ORDER BY f.sort_order ASC, f.upload_id ASC`,
    [intelId]
  );
  const sources = archiveSources(fileRows);
  if (!sources.length) {
    const error = new Error("nothing_to_download");
    error.code = "nothing_to_download";
    throw error;
  }
  if (!uploadDir) {
    const error = new Error("packet_unavailable");
    error.code = "packet_unavailable";
    throw error;
  }
  const zipPath = await ensurePacketZip(
    uploadDir,
    intel.id,
    packetReadme({
      category: intel.category,
      price: intel.price,
      author: intel.display_name,
      createdAt: intel.created_at,
      videos: intel.videos,
      links: intel.links,
      body: intel.body,
      files: sources,
    }),
    sources
  );
  return {
    intel: await loadPresentedIntel(pool, intelId),
    zipPath,
    downloadName: packetDownloadName(intel.body),
  };
}

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { keyEntry } from "@knot/config";
import { FAILURE_CODES } from "./agents/openclaw.js";
import { saveReviewExtract } from "./extracts.js";
import { compareByWeight, countTodayIntel, createIntel, deleteOwnPost, judgeIntel, listPublicIntel, loadPublicIntel, noteReviewFailure, notifyOwnerReviewStalled, presentIntel, publicAuthor, reviewAttemptOf, reviewFailureText, reviewMetaOf, searchPublicIntel } from "./intel.js";
import { clearSearchCache } from "./searchCache.js";
import { imageUploadLimit, itemPrice, serviceFee, policyConfig } from "./points.js";

const AUTHOR = "33333333-3333-4333-8333-333333333333";

test("a revise target that is not a uuid is rejected before the query", async () => {
  // revises / respondsTo 直接进 uuid 列；形状不对时 pg 会抛 22P02，
  // Express 4 不接管 async handler 的拒绝，一条错输入就能把进程带走。
  const calls = [];
  const pool = {
    async query(...args) {
      calls.push(args);
      throw new Error("22P02 invalid input syntax for type uuid");
    },
  };
  for (const bad of [{ revises: "not-a-uuid" }, { respondsTo: "3333" }]) {
    await assert.rejects(
      createIntel(pool, { userId: AUTHOR, actor: "human", door: "web", body: "改一条", ...bad }),
      (error) => error.code === "bad_state",
      JSON.stringify(bad)
    );
  }
  assert.equal(calls.length, 0);
});

test("a public card keeps the author account id", () => {
  const card = presentIntel({
    id: "post",
    account_id: AUTHOR,
    display_name: "甲",
    avatar_upload_id: null,
    body: "原文",
    videos: [],
    links: {},
    kind: "post",
    price: 0,
    is_public: true,
    verdict: "passed",
    created_at: "2026-10-16T00:00:00.000Z",
    updated_at: "2026-10-16T00:00:00.000Z",
  });
  assert.equal(card.author.id, AUTHOR);
  assert.equal(card.author.name, "甲");
  assert.equal(card.account_id, undefined);
});

// 卡片上的累计打赏由查询一次带出来：一条记录一个数，不按卡片再问一次摘要接口。
test("a card carries the tip total, and zero when nobody has tipped", async () => {
  const row = {
    id: "post",
    account_id: AUTHOR,
    display_name: "甲",
    avatar_upload_id: null,
    body: "原文",
    videos: [],
    links: {},
    kind: "post",
    price: 0,
    is_public: true,
    verdict: "passed",
    created_at: "2026-10-16T00:00:00.000Z",
    updated_at: "2026-10-16T00:00:00.000Z",
  };
  assert.equal(presentIntel({ ...row, tip_total: 12 }).tipTotal, 12);
  assert.equal(presentIntel({ ...row, tip_total: null }).tipTotal, 0);
  // 行里没有这一列时（如发布响应）也是 0，不会变成 undefined 传到卡片上。
  assert.equal(presentIntel(row).tipTotal, 0);

  const calls = [];
  await listPublicIntel({ async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; } }, 30);
  assert.match(calls[0].sql, /AS tip_total/);
});

test("an author filter narrows the public feed by account, then time", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  await listPublicIntel(pool, 30, null, AUTHOR);
  assert.match(calls[0].sql, /AND i\.account_id = \$2/);
  assert.match(calls[0].sql, /ORDER BY i\.created_at DESC, i\.weight DESC, i\.id DESC LIMIT \$3/);
  assert.deepEqual(calls[0].params, [null, AUTHOR, 30]);
});

test("the public feed folds revisions to the newest visible version per origin", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  await listPublicIntel(pool, 30, null);
  // 同一 origin 只保留最新可见版：排除存在「同 origin、版本更高、且可见」的新版本。
  assert.match(calls[0].sql, /COALESCE\(newer\.origin_id, newer\.id\) = COALESCE\(i\.origin_id, i\.id\)/);
  assert.match(calls[0].sql, /newer\.version > i\.version/);
  assert.match(calls[0].sql, /newer\.verdict IN \('pending', 'passed'\)/);
});

test("a before cursor pages strictly after the anchor, then time and weight", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  const anchor = "11111111-1111-4111-8111-111111111111";
  await listPublicIntel(pool, 30, null, null, anchor);
  assert.match(calls[0].sql, /\(i\.created_at, i\.weight, i\.id\) < \(/);
  assert.match(calls[0].sql, /SELECT created_at, weight, id FROM intel WHERE id = \$2::uuid/);
  assert.match(calls[0].sql, /ORDER BY i\.created_at DESC, i\.weight DESC, i\.id DESC LIMIT \$3/);
  assert.deepEqual(calls[0].params, [null, anchor, 30]);
});

test("a category and a topic narrow the public feed together", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  await listPublicIntel(pool, 30, null, null, null, { category: "招聘", topic: "大模型" });
  assert.match(calls[0].sql, /AND i\.category = \$2/);
  assert.match(calls[0].sql, /AND \(i\.detail -> 'topics'\) \? \$3/);
  assert.deepEqual(calls[0].params, [null, "招聘", "大模型", 30]);
});



test("search applies the same category and topic filters", async () => {
  clearSearchCache();
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  await searchPublicIntel(pool, "住房", null, { category: "房产" });
  assert.match(calls[0].sql, /AND i\.category = \$2/);
  // $1 是账户，$2 是类别，$3 是查询的二元组，$4 是候选集上限。
  assert.deepEqual(calls[0].params, [null, "房产", ["住房"], 2000]);
  assert.match(calls[0].sql, /i\.search_bigrams && \$3::text\[\]/);
  assert.match(calls[0].sql, /LIMIT \$4/);
});

test("search narrows candidates in SQL instead of pulling the heftiest rows", async () => {
  clearSearchCache();
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  await searchPublicIntel(pool, "人工智能", null);
  assert.match(calls[0].sql, /i\.search_bigrams && \$2::text\[\]/);
  // 单字查询没有二元组，退回子串匹配，否则一个字的查询永远收不到候选。
  await searchPublicIntel(pool, "高", null);
  assert.match(calls[1].sql, /i\.search_compact LIKE/);
  // 回填未跑完的库也要能搜到：两列还没有值的行保留兜底条件。
  assert.match(calls[0].sql, /i\.search_bigrams IS NULL OR/);
});

test("a cached search still records one event per request", async () => {
  clearSearchCache();
  const inserts = [];
  let selects = 0;
  const pool = {
    async query(sql, params) {
      if (sql.includes("INSERT INTO search_events")) {
        inserts.push(params);
        return { rows: [] };
      }
      selects += 1;
      return { rows: [] };
    },
  };
  const user = "44444444-4444-4444-8444-444444444444";
  await searchPublicIntel(pool, "住房", user);
  await searchPublicIntel(pool, "住房", user);
  await new Promise((resolve) => setImmediate(resolve));
  // 第二次命中缓存，但「有人检索了」这件事要记两次。
  assert.equal(selects, 1);
  assert.equal(inserts.length, 2);
  clearSearchCache();
});

test("a cached row does not carry the index text", async () => {
  clearSearchCache();
  const id = "55555555-5555-4555-8555-555555555555";
  const pool = {
    async query(sql) {
      if (sql.includes("INSERT INTO search_events")) return { rows: [] };
      return {
        rows: [{
          id,
          body: "住房",
          detail: {},
          videos: [],
          weight: 1,
          created_at: "2026-10-16T00:00:00.000Z",
          search_compact: "住房",
        }],
      };
    },
  };
  const found = await searchPublicIntel(pool, "住房", "66666666-6666-4666-8666-666666666666");
  assert.equal(found.length, 1);
  // 打分用的长文本留在检索内部：缓存与响应都不该带上它。
  assert.equal("search_compact" in found[0], false);
  const again = await searchPublicIntel(pool, "住房", "66666666-6666-4666-8666-666666666666");
  assert.equal("search_compact" in again[0], false);
  clearSearchCache();
});

test("a query with no letters or digits skips the database entirely", async () => {
  clearSearchCache();
  let queries = 0;
  const pool = {
    async query() {
      queries += 1;
      return { rows: [] };
    },
  };
  assert.deepEqual(await searchPublicIntel(pool, "！！！", null), []);
  assert.equal(queries, 0);
});

test("a public author is only someone with a visible post", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ id: AUTHOR, display_name: "甲", avatar_upload_id: null, role: "agent" }] };
    },
  };
  const author = await publicAuthor(pool, AUTHOR);
  assert.equal(author.id, AUTHOR);
  assert.equal(author.name, "甲");
  assert.equal(author.role, "agent");
  assert.match(calls[0].sql, /i\.kind IN \('post', 'fastpost'\)/);
  assert.deepEqual(calls[0].params, [AUTHOR]);
  const empty = {
    async query() {
      return { rows: [] };
    },
  };
  assert.equal(await publicAuthor(empty, AUTHOR), null);
});

test("search order is weight, then newer", () => {
  const rows = [
    { weight: 1, created_at: "2026-10-12T00:00:00.000Z", id: "older" },
    { weight: 2, created_at: "2026-10-01T00:00:00.000Z", id: "heavier" },
    { weight: 1, created_at: "2026-10-12T03:00:00.000Z", id: "newer" },
  ];
  assert.deepEqual(rows.sort(compareByWeight).map((row) => row.id), ["heavier", "newer", "older"]);
});

test("search matches text saved from a picture or a file", async () => {
  clearSearchCache();
  const dir = await mkdtemp(path.join(os.tmpdir(), "knot-search-extract-"));
  const previous = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = dir;
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const pool = {
    async query() {
      return {
        rows: [{
          id,
          body: "只有原文",
          detail: {},
          videos: [],
          weight: 1,
          created_at: "2026-10-16T00:00:00.000Z",
        }],
      };
    },
  };
  try {
    await saveReviewExtract(id, [{ heading: "图片 1", text: "传感器规格表" }]);
    const found = await searchPublicIntel(pool, "传感器", null);
    assert.equal(found.length, 1);
    assert.equal(found[0].id, id);
    const missed = await searchPublicIntel(pool, "量子织布机", null);
    assert.equal(missed.length, 0);
  } finally {
    if (previous === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("an item must be priced inside the shelf range and at least one point", () => {
  assert.equal(itemPrice(10), 10);
  assert.equal(itemPrice(100), 100);
  assert.throws(() => itemPrice(0), (error) => error.code === "bad_price");
  assert.throws(() => itemPrice(""), (error) => error.code === "bad_price");
  assert.throws(() => itemPrice(null), (error) => error.code === "bad_price");
  assert.throws(() => itemPrice(101), (error) => error.code === "bad_price");
  assert.throws(() => itemPrice(1.5), (error) => error.code === "bad_price");
});

test("a review failure names the exception and says the record stays visible", () => {
  const error = new Error("agent_timeout");
  error.detail = "openclaw timed out";
  const text = reviewFailureText(error);
  assert.match(text, /数据评审员超时/);
  assert.match(text, /agent_timeout/);
  assert.match(text, /openclaw timed out/);
  assert.match(text, /仍然可见/);
});

test("the same review failure is told once, and a new one is told again", async () => {
  const id = "33333333-3333-4333-8333-333333333333";
  const userId = "11111111-1111-4111-8111-111111111111";
  const notes = [];
  let detail = null;
  const pool = {
    async query(sql, params) {
      if (sql.includes("SELECT account_id, verdict, detail")) {
        return { rows: [{ account_id: userId, verdict: "pending", detail }] };
      }
      if (sql.includes("UPDATE intel")) {
        detail = { reviewError: JSON.parse(params[1]).reviewError };
        return { rows: [{ account_id: userId }] };
      }
      if (sql.includes("INSERT INTO notifications")) {
        notes.push(params);
        return { rows: [{ id: "n1" }] };
      }
      return { rows: [] };
    },
  };
  assert.equal(await noteReviewFailure(pool, id, new Error("agent_timeout")), true);
  assert.equal(await noteReviewFailure(pool, id, new Error("agent_timeout")), false);
  assert.equal(notes.length, 1);
  assert.equal(notes[0][1], "intel_review_error");
  assert.equal(notes[0][2], "审核异常");
  assert.match(notes[0][3], /agent_timeout/);
  assert.equal(notes[0][4], "/mine/submissions");
  assert.deepEqual(JSON.parse(notes[0][6]), { code: "agent_timeout", detail: "" });
  assert.equal(await noteReviewFailure(pool, id, new Error("agent_bad_json")), true);
  assert.equal(notes.length, 2);
  assert.match(notes[1][3], /没有交回可用结果/);
});

// 主人那条通知的池：只认这条路径上的三句 SQL，别的一律当「没有」。
function stalledPool({ owner = "99999999-9999-4999-8999-999999999999", author = AUTHOR, claim = true } = {}) {
  const notes = [];
  const sqls = [];
  const pool = {
    async query(sql, params) {
      sqls.push(sql);
      if (sql.includes("role = 'owner'")) return { rows: owner ? [{ id: owner }] : [] };
      if (sql.includes("UPDATE intel")) return { rows: claim ? [{ account_id: author }] : [] };
      if (sql.includes("INSERT INTO notifications")) {
        notes.push(params);
        return { rows: [{ id: "n1" }] };
      }
      return { rows: [] };
    },
  };
  return { pool, notes, sqls };
}

test("giving up also tells the owner, in a kind the summary can group", async () => {
  const { pool, notes, sqls } = stalledPool();
  assert.equal(await notifyOwnerReviewStalled(pool, "id", 10, { code: "agent_timeout" }), true);
  assert.equal(notes.length, 1);
  const [userId, kind, title, body, href, intelId, data] = notes[0];
  assert.equal(userId, "99999999-9999-4999-8999-999999999999");
  assert.equal(kind, "agent_review_stalled");
  assert.equal(title, "数据评审员已停止重试");
  assert.match(body, /连续 10 次/);
  assert.match(body, /agent_timeout/);
  assert.match(body, /智能体/);
  // 主人不在站点页面上看这条：管理后台在内网地址，链接过去只会是一扇打不开的门。
  assert.equal(href, null);
  assert.equal(intelId, "id");
  assert.deepEqual(JSON.parse(data), { code: "agent_timeout", attempts: 10 });
  // 水印写回同一行：重启恢复从 10 次继续往上加时，不会每天重复通知一遍。
  const claim = sqls.find((sql) => sql.includes("UPDATE intel"));
  assert.match(claim, /reviewGaveUpNotified/);
});

test("no owner means no notice and no throw", async () => {
  const { pool, notes } = stalledPool({ owner: null });
  assert.equal(await notifyOwnerReviewStalled(pool, "id", 10), false);
  assert.equal(notes.length, 0);
});

test("the owner who wrote the record is not told twice", async () => {
  const author = "99999999-9999-4999-8999-999999999999";
  const { pool, notes } = stalledPool({ author });
  assert.equal(await notifyOwnerReviewStalled(pool, "id", 10, { code: "" }), false);
  assert.equal(notes.length, 0);
});

test("the same watermark is reported once, whatever the retries do after it", async () => {
  const { pool, notes } = stalledPool({ claim: false });
  assert.equal(await notifyOwnerReviewStalled(pool, "id", 11, { code: "agent_failed" }), false);
  assert.equal(notes.length, 0);
});

test("a missing error code is null in data, not an empty string", async () => {
  const { pool, notes } = stalledPool();
  await notifyOwnerReviewStalled(pool, "id", 10);
  assert.deepEqual(JSON.parse(notes[0][6]), { code: null, attempts: 10 });
});

test("a finished record does not get a review-failure notice", async () => {
  const pool = {
    async query(sql) {
      if (sql.includes("SELECT account_id, verdict, detail")) {
        return { rows: [{ account_id: "u", verdict: "passed", detail: null }] };
      }
      throw new Error("unexpected");
    },
  };
  assert.equal(await noteReviewFailure(pool, "id", new Error("agent_failed")), false);
});

test("policy limits default to the initial platform values", () => {
  const keys = ["KNOT_DEFAULT_PRICE", "KNOT_PRICE_MIN", "KNOT_PRICE_MAX", "KNOT_PUBLISH_SERVICE_FEE_PER_MB", "KNOT_SERVICE_FEE_CAP", "KNOT_UPLOAD_IMAGE_MAX_BYTES"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    assert.deepEqual(policyConfig(), {
      defaultPrice: 10,
      priceMin: 1,
      priceMax: 100,
      publishServiceFeePerMb: 1,
      serviceFeeCap: 10,
      // WebUI 按这个值决定压到多大，缺省与 KNOT_UPLOAD_IMAGE_MAX_BYTES 的登记值一致。
      imageMaxBytes: Number(keyEntry("KNOT_UPLOAD_IMAGE_MAX_BYTES").default),
    });
  } finally {
    for (const key of keys) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("the image limit follows the instance setting down to the uploader", () => {
  const previous = process.env.KNOT_UPLOAD_IMAGE_MAX_BYTES;
  try {
    process.env.KNOT_UPLOAD_IMAGE_MAX_BYTES = String(4 * 1024 * 1024);
    assert.equal(imageUploadLimit(), 4 * 1024 * 1024);
    // multer 与 policy 读同一个值：客户端压到多小、服务端收多大不会各自成一套。
    assert.equal(policyConfig().imageMaxBytes, 4 * 1024 * 1024);
    delete process.env.KNOT_UPLOAD_IMAGE_MAX_BYTES;
    // 没设值时回落到登记表里的缺省值，不在代码里另写一份。
    assert.equal(imageUploadLimit(), Number(keyEntry("KNOT_UPLOAD_IMAGE_MAX_BYTES").default));
  } finally {
    if (previous == null) delete process.env.KNOT_UPLOAD_IMAGE_MAX_BYTES;
    else process.env.KNOT_UPLOAD_IMAGE_MAX_BYTES = previous;
  }
});

test("service fee rounds attachment bytes up per MB and caps", () => {
  assert.equal(serviceFee(0, 1, 10), 0);
  assert.equal(serviceFee(1, 1, 10), 1); // 1 字节也是 1 单位（向上取整）
  assert.equal(serviceFee(1024 * 1024, 1, 10), 1); // 正好 1MB
  assert.equal(serviceFee(1024 * 1024 + 1, 1, 10), 2); // 1MB 出头 → 2
  assert.equal(serviceFee(1024 * 1024 * 3, 1, 10), 3);
  assert.equal(serviceFee(1024 * 1024 * 50, 1, 10), 10); // 封顶
  assert.equal(serviceFee(1024 * 1024 * 2, 0, 10), 0); // 费率 0 免费
  assert.equal(serviceFee(1024 * 1024 * 5, 2, 10), 10); // 5MB×2=10 正好
});

test("a deep link finds the post through its revision chain, not by exact id", async () => {  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  const ID = "11111111-1111-4111-8111-111111111111";
  assert.equal(await loadPublicIntel(pool, null, ID), null);
  // 地址认的是整条修订链：旧版本的 id 也落到最新那一版上。
  assert.match(calls[0].sql, /COALESCE\(i\.origin_id, i\.id\) = \(SELECT COALESCE\(origin_id, id\) FROM intel WHERE id = \$2::uuid\)/);
  assert.doesNotMatch(calls[0].sql, /AND i\.id = \$2::uuid/);
  assert.deepEqual(calls[0].params, [null, ID]);
});



const POST_V1 = "55555555-5555-4555-8555-555555555555";
const POST_V2 = "66666666-6666-4666-8666-666666666666";
const POST_ORIGIN = "44444444-4444-4444-8444-444444444444";

test("deleting a post keeps the row and takes the whole revision chain down", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("SELECT id, account_id, kind, origin_id, verdict")) {
        return { rows: [{ id: POST_V2, account_id: AUTHOR, kind: "post", origin_id: POST_ORIGIN, verdict: "passed" }] };
      }
      if (sql.includes("UPDATE intel")) return { rows: [{ id: POST_V1 }, { id: POST_V2 }] };
      return { rows: [] };
    },
  };
  const result = await deleteOwnPost(pool, AUTHOR, POST_V2);
  assert.deepEqual(result, { ok: true, already: false, id: POST_V2 });
  const update = calls.find((call) => call.sql.includes("UPDATE intel"));
  assert.match(update.sql, /verdict = 'removed'/);
  assert.match(update.sql, /is_public = false/);
  assert.match(update.sql, /COALESCE\(origin_id, id\) = COALESCE\(\$2::uuid, \$1::uuid\)/);
  assert.deepEqual(update.params, [POST_V2, POST_ORIGIN]);
});

test("deleting is quiet for someone else's post, another kind, or an already deleted one", async () => {
  const other = {
    async query(sql) {
      if (sql.includes("SELECT id, account_id, kind, origin_id, verdict")) {
        return { rows: [{ id: POST_V2, account_id: "22222222-2222-4222-8222-222222222222", kind: "post", origin_id: null, verdict: "passed" }] };
      }
      throw new Error("should not update");
    },
  };
  await assert.rejects(deleteOwnPost(other, AUTHOR, POST_V2), (error) => error.code === "not_found");

  // 商品不走「删帖子」这条路：下架走撤下，删掉订单里的东西会把买过的人一起坑了。
  const item = {
    async query(sql) {
      if (sql.includes("SELECT id, account_id, kind, origin_id, verdict")) {
        return { rows: [{ id: POST_V2, account_id: AUTHOR, kind: "item", origin_id: null, verdict: "passed" }] };
      }
      throw new Error("should not update");
    },
  };
  await assert.rejects(deleteOwnPost(item, AUTHOR, POST_V2), (error) => error.code === "bad_state");

  const gone = {
    async query(sql) {
      if (sql.includes("SELECT id, account_id, kind, origin_id, verdict")) {
        return { rows: [{ id: POST_V2, account_id: AUTHOR, kind: "post", origin_id: null, verdict: "removed" }] };
      }
      if (sql.includes("UPDATE intel")) return { rows: [] };
      throw new Error(sql);
    },
  };
  assert.deepEqual(await deleteOwnPost(gone, AUTHOR, POST_V2), { ok: true, already: true, id: POST_V2 });
});


test("a review that blows up still lands the transcript it already wrote into the index", async () => {
  // 评审员先把转写写盘，再交回结果。它超时或崩掉时，索引也必须跟着磁盘上的内容重算一次，
  // 否则这一行永远少一段文字（search_bigrams 不为 NULL，兜底条件也救不回来）。
  const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const updates = [];
  const pool = {
    async query(sql, params) {
      if (sql.startsWith("UPDATE intel SET search_compact")) {
        updates.push(params);
        return { rows: [] };
      }
      if (sql.startsWith("SELECT id, account_id, body")) {
        return {
          rows: [{
            id,
            account_id: AUTHOR,
            body: "正文",
            videos: [],
            links: {},
            verdict: "pending",
            kind: "post",
            responds_to: null,
          }],
        };
      }
      if (sql.startsWith("SELECT id, body, videos, detail")) {
        return { rows: [{ id, body: "正文", videos: [], detail: null }] };
      }
      return { rows: [] };
    },
  };
  const before = { agent: process.env.OPENCLAW_INTEL_AGENT, bin: process.env.OPENCLAW_BIN };
  process.env.OPENCLAW_INTEL_AGENT = "test-agent";
  process.env.OPENCLAW_BIN = path.join(os.tmpdir(), "knot-no-such-openclaw-binary");
  try {
    await assert.rejects(() => judgeIntel(pool, id));
  } finally {
    if (before.agent === undefined) delete process.env.OPENCLAW_INTEL_AGENT;
    else process.env.OPENCLAW_INTEL_AGENT = before.agent;
    if (before.bin === undefined) delete process.env.OPENCLAW_BIN;
    else process.env.OPENCLAW_BIN = before.bin;
  }
  assert.equal(updates.length, 1);
  assert.match(String(updates[0][1]), /正文/);
});

// 终审落地要动 `updated_at`：管理端的审核快照用 max(updated_at) 当「最后一次成功」，
// 用 updated_at - created_at 算 p50/p95。终审只改 verdict 不改时间时，这两个数永远
// 停在发布时间上（p50/p95 恒为 0），「终审卡了多久」就再也看不出来。
function pendingJudgePool(id, updates) {
  const row = {
    id,
    account_id: AUTHOR,
    actor: "person",
    body: "正文",
    videos: [],
    links: {},
    content_hash: "h",
    detail: null,
    verdict: "pending",
    reject_reason: null,
    category: "",
    price: 0,
    is_public: true,
    kind: "post",
    weight: 0,
    created_at: "2026-10-16T00:00:00.000Z",
    updated_at: "2026-10-16T00:00:00.000Z",
    origin_id: null,
    version: 1,
  };
  return {
    async query(sql, params) {
      if (sql.startsWith("SELECT id, account_id, body, videos, links, verdict")) return { rows: [row] };
      if (sql.startsWith("SELECT id, account_id, actor, body")) return { rows: [row] };
      if (sql.includes("FROM intel_files")) return { rows: [] };
      if (sql.startsWith("UPDATE intel SET verdict")) {
        updates.push({ sql, params });
        return { rows: [{ id }] };
      }
      if (sql.startsWith("SELECT id, body, videos, detail")) return { rows: [{ id, body: "正文", videos: [], detail: null }] };
      return { rows: [] };
    },
  };
}

test("a verdict that lands moves updated_at, so the review snapshot can time it", async () => {
  const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const updates = [];
  const before = process.env.OPENCLAW_INTEL_AGENT;
  delete process.env.OPENCLAW_INTEL_AGENT;
  try {
    await judgeIntel(pendingJudgePool(id, updates), id);
  } finally {
    if (before === undefined) delete process.env.OPENCLAW_INTEL_AGENT;
    else process.env.OPENCLAW_INTEL_AGENT = before;
  }
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /verdict = 'passed'/);
  assert.match(updates[0].sql, /updated_at = now\(\)/);
});

test("a revoked verdict moves updated_at too", async () => {
  const id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const updates = [];
  const dir = await mkdtemp(path.join(os.tmpdir(), "knot-fake-openclaw-"));
  const bin = path.join(dir, "openclaw");
  await writeFile(
    bin,
    `#!/bin/sh\nprintf '%s' '{"ok":true,"final":"{\\"verdict\\":\\"revoke\\",\\"reason\\":\\"含有欺诈内容。\\",\\"note\\":\\"\\",\\"category\\":\\"\\",\\"language\\":\\"\\",\\"topics\\":[]}"}'\n`,
    { mode: 0o755 }
  );
  const before = { agent: process.env.OPENCLAW_INTEL_AGENT, bin: process.env.OPENCLAW_BIN };
  process.env.OPENCLAW_INTEL_AGENT = "knot-intel";
  process.env.OPENCLAW_BIN = bin;
  try {
    await judgeIntel(pendingJudgePool(id, updates), id);
  } finally {
    if (before.agent === undefined) delete process.env.OPENCLAW_INTEL_AGENT;
    else process.env.OPENCLAW_INTEL_AGENT = before.agent;
    if (before.bin === undefined) delete process.env.OPENCLAW_BIN;
    else process.env.OPENCLAW_BIN = before.bin;
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /verdict = 'rejected'/);
  assert.match(updates[0].sql, /updated_at = now\(\)/);
});

// 重试要安全：Agent 超时重发同一条，平台该把原来那条还给它，而不是报错或再发一条。
// 原来查重写的是 `verdict <> 'pending'`，而刚提交的那条恰恰是 pending——
// 最需要幂等的那一刻不幂等。库里对 (account_id, content_hash) 还有唯一索引，
// 于是重发不是「变成两条」，而是直接撞唯一约束。这条测试盯住那条分界线。
test("a retry of a still-pending post returns the original instead of inserting again", async () => {
  const seen = [];
  const pendingRow = {
    id: "post-pending",
    account_id: AUTHOR,
    actor: "person",
    body: "同一条内容",
    videos: [],
    links: {},
    content_hash: "h",
    detail: null,
    verdict: "pending",
    reject_reason: null,
    category: "",
    price: 0,
    is_public: true,
    kind: "post",
    responds_to: null,
    weight: 0,
    created_at: "2026-10-16T00:00:00.000Z",
    updated_at: "2026-10-16T00:00:00.000Z",
    expires_at: null,
    origin_id: null,
    version: 1,
  };
  const pool = {
    async query(sql, params) {
      seen.push(sql.trim().split("\n")[0]);
      if (/FROM accounts a/.test(sql)) return { rows: [{ id: AUTHOR, role: "person", owner_id: null, muted_until: null }] };
      if (/^SELECT id FROM intel/.test(sql.trim())) return { rows: [{ id: pendingRow.id }] };
      if (/FROM intel WHERE id = \$1/.test(sql)) return { rows: [pendingRow] };
      if (/FROM intel_files/.test(sql)) return { rows: [] };
      throw new Error(`重试路径不该走到这条 SQL：${sql.slice(0, 80)}`);
    },
    async connect() {
      throw new Error("重试路径不该开事务：没有新行要写");
    },
  };

  const card = await createIntel(pool, {
    userId: AUTHOR,
    actor: "person",
    door: "webui",
    kind: "post",
    body: "同一条内容",
    isPublic: true,
  });

  assert.equal(card.id, "post-pending");
  assert.equal(
    seen.some((sql) => sql.startsWith("INSERT INTO intel")),
    false,
    "命中已有记录时不得再插入"
  );
});

// 查重只认存活记录。被否决/撤下的内容，作者应当能原样再发一次；
// 库里的唯一索引也只覆盖 pending / passed，两处口径必须一致。
test("the duplicate check only counts records that are still live", async () => {
  const seen = [];
  const pool = {
    async query(sql) {
      seen.push(sql);
      if (/FROM accounts a/.test(sql)) return { rows: [{ id: AUTHOR, role: "person", owner_id: null, muted_until: null }] };
      if (/^SELECT id FROM intel/.test(sql.trim())) return { rows: [] };
      throw new Error(`预期在查重后停下，却走到：${sql.slice(0, 60)}`);
    },
    async connect() {
      throw new Error("预期在查重后停下");
    },
  };
  await assert.rejects(
    createIntel(pool, { userId: AUTHOR, actor: "person", door: "webui", kind: "post", body: "重发", isPublic: true })
  );
  const dedup = seen.find((sql) => /^SELECT id FROM intel/.test(sql.trim()));
  assert.match(dedup, /verdict IN \('pending', 'passed'\)/);
  assert.doesNotMatch(dedup, /verdict <> 'pending'/);
});

// 修订版本号必须在同一个事务里、锁住 origin 行之后再取：两笔并发修订各自
// 「查 MAX 再 +1」会拿到同一个号，而信息流只按 version 大小去重，同号的两版会同时留在流里。
test("a revision takes its version under the origin row lock, inside the publish transaction", async () => {
  const base = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const origin = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const clientSteps = [];
  const poolSteps = [];
  const client = {
    async query(sql, params) {
      clientSteps.push({ sql, params });
      if (sql === "BEGIN" || sql === "ROLLBACK" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("FOR UPDATE")) return { rows: [{ id: origin }] };
      if (sql.includes("MAX(version)")) return { rows: [{ v: 4 }] };
      if (sql.startsWith("INSERT INTO intel")) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async query(sql, params) {
      poolSteps.push({ sql, params });
      if (/FROM accounts a/.test(sql)) return { rows: [{ id: AUTHOR, owner_id: null, muted_until: null }] };
      if (sql.includes("SELECT id, account_id, origin_id, version")) {
        return { rows: [{ id: base, account_id: AUTHOR, origin_id: origin, version: 4 }] };
      }
      if (sql.startsWith("SELECT id FROM intel")) return { rows: [] };
      return { rows: [] };
    },
    async connect() {
      return client;
    },
  };
  await assert.rejects(
    createIntel(pool, { userId: AUTHOR, actor: "person", door: "webui", kind: "post", body: "修订", revises: base, isPublic: true })
  );
  const lockAt = clientSteps.findIndex((step) => step.sql.includes("FOR UPDATE"));
  const maxAt = clientSteps.findIndex((step) => step.sql.includes("MAX(version)"));
  assert.ok(lockAt >= 0, "修订要先锁 origin 行");
  assert.ok(maxAt > lockAt, "取号必须在锁之后");
  // 取号不能留在事务外：连接池上不应再看到这条查询。
  assert.equal(poolSteps.some((step) => step.sql.includes("MAX(version)")), false);
  const insert = clientSteps.find((step) => step.sql.startsWith("INSERT INTO intel"));
  assert.match(insert.sql, /origin_id, version\)/);
  assert.equal(insert.params[10], origin);
  assert.equal(insert.params[11], 5);
});

// 管理端的「重新终审」或并发重入会拿到一条已经终审过的记录。这条路径也要装配附件，
// 否则返回的卡片没有图片与附件，只有行上的字段。
test("re-judging a settled record returns the same assembled card", async () => {
  const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const pool = {
    async query(sql) {
      if (sql.includes("SELECT id, account_id, body, videos, links, verdict, kind FROM intel")) {
        return { rows: [{ id, account_id: AUTHOR, body: "正文", videos: [], links: {}, verdict: "passed", kind: "post" }] };
      }
      if (sql.includes("FROM intel WHERE id = $1")) {
        return {
          rows: [{
            id,
            account_id: AUTHOR,
            actor: "person",
            body: "正文",
            videos: [],
            links: {},
            content_hash: "h",
            detail: null,
            verdict: "passed",
            reject_reason: null,
            category: "",
            price: 0,
            is_public: true,
            kind: "post",
            weight: 0,
            created_at: "2026-10-16T00:00:00.000Z",
            updated_at: "2026-10-16T00:00:00.000Z",
            origin_id: null,
            version: 1,
          }],
        };
      }
      if (sql.includes("FROM intel_files")) {
        return {
          rows: [{
            intel_id: id,
            id: "99999999-9999-4999-8999-999999999999",
            mime: "application/pdf",
            original_name: "报告.pdf",
            size: 1024,
            width: null,
            height: null,
          }],
        };
      }
      throw new Error(`不该走到这条 SQL：${sql.slice(0, 60)}`);
    },
  };
  const card = await judgeIntel(pool, id);
  assert.equal(card.id, id);
  assert.equal(card.attachments.length, 1);
  assert.equal(card.attachments[0].name, "报告.pdf");
  assert.equal(card.kMeta.verdict, "passed");
});

test("a missing record is judged as nothing, not an empty card", async () => {
  const pool = {
    async query() {
      return { rows: [] };
    },
  };
  assert.equal(await judgeIntel(pool, "12121212-1212-4212-8212-121212121212"), null);
});

// 尝试次数是「换个新会话再试」的依据：同一序号两次一定撞上一个还在跑的回合。
// 库里的值可能是任何东西，读坏了按 0 算——一条记录的计数不值得让评审停住。
test("the attempt counter reads a broken value as zero", () => {
  assert.equal(reviewAttemptOf(null), 0);
  assert.equal(reviewAttemptOf({}), 0);
  assert.equal(reviewAttemptOf({ reviewAttempts: "3" }), 3);
  assert.equal(reviewAttemptOf({ reviewAttempts: 2 }), 2);
  assert.equal(reviewAttemptOf({ reviewAttempts: "many" }), 0);
  assert.equal(reviewAttemptOf({ reviewAttempts: -4 }), 0);
});

// 通过时留下的观测值。没有它们，事后只答得了「多久」，答不了
// 「用哪个模型、几轮、几张图没转写、是不是靠修复回合救回来的」。
test("a passing review keeps what it took", () => {
  const meta = reviewMetaOf({
    attempt: 2,
    elapsedMs: 41_000,
    repaired: true,
    model: "qwen",
    images: { total: 4, transcribed: 3, failed: 1 },
    usage: { input: 9000, output: 40 },
  });
  assert.equal(meta.attempt, 2);
  assert.equal(meta.ms, 41_000);
  assert.equal(meta.repaired, true);
  assert.deepEqual(meta.images, { total: 4, failed: 1 });
  assert.deepEqual(meta.tokens, { input: 9000, output: 40 });
});

test("a review with no agent still writes a usable record of the attempt", async () => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const updates = [];
  const before = process.env.OPENCLAW_INTEL_AGENT;
  delete process.env.OPENCLAW_INTEL_AGENT;
  try {
    await judgeIntel(pendingJudgePool(id, updates), id);
  } finally {
    if (before === undefined) delete process.env.OPENCLAW_INTEL_AGENT;
    else process.env.OPENCLAW_INTEL_AGENT = before;
  }
  const detail = JSON.parse(updates[0].params[2]);
  assert.equal(detail.review.attempt, 1);
  // 没跑智能体时 images 是 null，不是 0：这两种情况在观测上必须分得开。
  assert.equal(detail.review.images, null);
  assert.equal(detail.review.repaired, false);
});

// 码是给运维看的，人话是给作者看的。新增一个码却没有对应的一句话，作者收到的就是
// 「审核没有完成」——和他什么都不知道是一样的。这条测试把两张表钉在一起。
test("every failure code has its own sentence, not the generic one", () => {
  for (const code of FAILURE_CODES) {
    const text = reviewFailureText(new Error(code));
    assert.match(text, new RegExp(code), `${code} 应该在通知里出现`);
    assert.doesNotMatch(text, /^审核没有完成/, `${code} 不应该退到兜底文案`);
  }
  assert.match(reviewFailureText(new Error("没见过的码")), /^审核没有完成/);
});

// 「今日」是顶栏上那一行数字的全部来源：条数、最后一条的时间、日界。
// 口径必须和信息流一致，否则会出现「说 12 条，翻到下面只数得出 9 条」。
test("the today count is the feed's own filter, bounded to the site's local day", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [
          {
            start_at: new Date("2026-10-14T16:00:00.000Z"),
            end_at: new Date("2026-10-15T16:00:00.000Z"),
            posts: 12,
            last_at: new Date("2026-10-15T09:20:00.000Z"),
          },
        ],
      };
    },
  };
  assert.deepEqual(await countTodayIntel(pool, "Asia/Shanghai"), {
    posts: 12,
    lastPostAt: "2026-10-15T09:20:00.000Z",
    dayEndsAt: "2026-10-15T16:00:00.000Z",
  });
  assert.deepEqual(calls[0].params, ["Asia/Shanghai"]);
  const sql = calls[0].sql;
  // 日界按站点时区切，不是按 UTC 切。
  assert.match(sql, /date_trunc\('day', now\(\) AT TIME ZONE \$1\)/);
  assert.match(sql, /AT TIME ZONE \$1/);
  // 与信息流同一套可见口径：可见结论、公开、post/fastpost、修订链只算最新一版。
  assert.match(sql, /verdict IN \('pending', 'passed'\)/);
  assert.match(sql, /i\.kind IN \('post', 'fastpost'\)/);
  assert.match(sql, /newer\.version > i\.version/);
  // 个人关掉的卡不影响这个数：它是全站的量，不是「给我看的有多少」。
  assert.doesNotMatch(sql, /intel_dismissals/);
  // 一行只讲一件事：不再顺手数作者数（顶栏不显示它，多算一次就是白花一次索引）。
  assert.doesNotMatch(sql, /DISTINCT account_id/);
});

test("a today count without a day boundary is unknown, not zero", async () => {
  // 没有日界就没有「今天」。写 0 会被读成「这个站今天一条都没发」。
  const empty = { async query() { return { rows: [] }; } };
  assert.equal(await countTodayIntel(empty, "Asia/Shanghai"), null);
  const broken = { async query() { return { rows: [{ posts: 5, end_at: null }] }; } };
  assert.equal(await countTodayIntel(broken, "Asia/Shanghai"), null);
});

test("a count that comes back as text or negative still reads as a whole number", async () => {
  // pg 对 bigint 回文本，聚合被换成 bigint 时这里就是 "12"。界面要画的是数字，
  // 不能把字符串直接塞进模板，也不能让负数穿到「今日 -1 条」。
  const pool = {
    async query() {
      return { rows: [{ end_at: "2026-10-15T16:00:00.000Z", posts: "12", last_at: null }] };
    },
  };
  assert.deepEqual(await countTodayIntel(pool, "Europe/Oslo"), {
    posts: 12,
    lastPostAt: null,
    dayEndsAt: "2026-10-15T16:00:00.000Z",
  });
  const negative = { async query() { return { rows: [{ end_at: "2026-10-15T16:00:00.000Z", posts: -3 }] }; } };
  assert.equal((await countTodayIntel(negative, "Europe/Oslo")).posts, 0);
});

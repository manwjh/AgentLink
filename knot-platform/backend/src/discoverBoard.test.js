import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assembleDiscoverBoard, discoverBoardMeta, presentDiscoverSelf, publicPerson, readDiscoverBoard, writeDiscoverBoard } from "./discoverBoard.js";
import { setDiscoverPublisher, touchDiscoverBoard } from "./discoverPublish.js";
import { installSystemPolicy } from "./system.js";

// 这个文件只测快照本身，先把系统开关放到「可浏览 + 快照开」。
installSystemPolicy({ guestBrowsing: true, registrationMode: "open", publicBoard: true });

const POST = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const AUTHOR = "33333333-3333-4333-8333-333333333333";
const FILE = "44444444-4444-4444-8444-444444444444";

function pool() {
  const post = {
    id: POST,
    body: "原文",
    videos: [],
    links: {},
    content_hash: "abc",
    detail: { note: "一句" },
    weight: 2,
    price: 8,
    category: "价格",
    kind: "post",
    verdict: "passed",
    reject_reason: null,
    account_id: AUTHOR,
    is_public: true,
    created_at: "2026-10-15T00:00:00.000Z",
    updated_at: "2026-10-15T00:00:00.000Z",
    display_name: "甲",
    avatar_upload_id: null,
    starred: true,
    friend: true,
    can_friend: true,
  };
  return {
    post,
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      // 「今日」计数：一句话聚合出条数、最后一条和日界。
      if (sql.includes("AS start_at")) {
        if (this.countFails) throw new Error("count unavailable");
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
      }
      if (sql.includes("SELECT f.intel_id")) {
        return { rows: [{ intel_id: POST, id: FILE, mime: "image/jpeg", original_name: "a.jpg" }, { intel_id: POST, id: "sound", mime: "audio/mpeg", original_name: "a.mp3" }] };
      }
      if (sql.includes("GROUP BY i.account_id")) {
        return { rows: [{ id: AUTHOR, display_name: "甲", avatar_upload_id: null, last_at: "2026-10-15T03:00:00.000Z" }] };
      }
      // 筛选栏的计数在库里聚合（FACET_SQL），回来的是 kind / value / n 三列。
      if (sql.includes("'category' AS kind")) {
        return { rows: [{ kind: "category", value: "价格", n: 5 }] };
      }
      if (sql.includes("now() - interval '7 days'")) return { rows: [post, post, post, post, post] };
      if (sql.includes("kind IN ('post', 'fastpost')")) return { rows: [post] };
      return { rows: [] };
    },
  };
}

test("the public board drops personal fields and keeps the author", async () => {  const board = await assembleDiscoverBoard(pool());
  const card = board.information[0];
  assert.equal(card.personal, false);
  assert.equal(card.starred, false);
  assert.equal(card.friend, false);
  assert.equal(card.canFriend, false);
  assert.equal(card.mine, false);
  assert.equal(card.author.id, AUTHOR);
  assert.equal(card.author.name, "甲");
  assert.equal(card.account_id, undefined);
  assert.equal(card.images[0].url, `/api/web/uploads/${FILE}/display`);
  assert.equal(card.audio[0].url, "/api/web/uploads/sound");
  // requests 恒为空数组：Hub 的 parseBoard 读这个键，实例已经不再有求购。
  assert.deepEqual(board.requests, []);
  assert.equal(board.people.length, 1);
  assert.equal(board.people[0].id, AUTHOR);
  assert.equal(board.people[0].name, "甲");
  assert.equal(board.people[0].lastAt, "2026-10-15T03:00:00.000Z");
  assert.match(board.people[0].avatarUrl, /^\/avatars\/\d+\.svg$|^\/api\/web\/uploads\//);
  assert.deepEqual(board.facets, { categories: ["价格"], topics: [] });
});

test("a person row without a timestamp or avatar still comes back whole", () => {
  const person = publicPerson({ id: AUTHOR, display_name: "", avatar_upload_id: null, last_at: null });
  assert.equal(person.id, AUTHOR);
  assert.equal(person.name, "");
  assert.equal(person.lastAt, null);
  assert.equal(person.role, "");
  assert.ok(person.avatarUrl);
});

test("a person row keeps the account role so the card can tell a bot from a person", () => {
  // 人是 owner / user，Agent 是 agent：最近活跃条上这两个卡片长得一样，只靠这一列分开。
  const agent = publicPerson({ id: AUTHOR, display_name: "豆包", role: "agent", last_at: null });
  const owner = publicPerson({ id: AUTHOR, display_name: "甲", role: "owner", last_at: null });
  const user = publicPerson({ id: AUTHOR, display_name: "乙", role: "user", last_at: null });
  assert.equal(agent.role, "agent");
  assert.equal(owner.role, "owner");
  assert.equal(user.role, "user");
});

test("a personal patch lists dismissals, stars, likes, and friends", () => {
  const self = presentDiscoverSelf([
    { id: POST, kind: "post", dismissed: true, starred: true, liked: true, friend: false, mine: false, links: {}, videos: [] },
    { id: OTHER, kind: "post", dismissed: false, starred: false, liked: false, friend: true, mine: true, links: {}, videos: [] },
  ]);
  assert.deepEqual(self.dismissed, [POST]);
  assert.deepEqual(self.starred, [POST]);
  assert.deepEqual(self.liked, [POST]);
  assert.deepEqual(self.friends, [OTHER]);
  assert.deepEqual(self.mine, [OTHER]);
  assert.equal("granted" in self, false);
});

test("writing the board keeps image addresses", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "knot-board-"));
  try {
    const board = await writeDiscoverBoard({ pool: pool(), uploadDir: dir, boardDir: dir });
    assert.equal(board.information[0].images[0].url, `/api/web/uploads/${FILE}/display`);
    const saved = JSON.parse(await readFile(path.join(dir, "discover.json"), "utf8"));
    assert.deepEqual(saved.requests, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("快照带上站点开关与身份，首帧不必先问会话", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "knot-board-"));
  try {
    const meta = discoverBoardMeta({ now: () => new Date("2026-10-22T00:00:00.000Z") });
    assert.equal(meta.version, "2026-10-22T00:00:00.000Z");
    assert.equal(meta.site.publicBoard, true);
    assert.equal(meta.site.guestBrowsing, true);
    assert.equal(meta.brand.contact, "");
    assert.equal(meta.locale, "zh-CN");

    await writeDiscoverBoard({ pool: pool(), uploadDir: dir, boardDir: dir, meta: () => meta });
    const saved = await readDiscoverBoard(dir);
    assert.equal(saved.version, meta.version);
    assert.deepEqual(saved.site, meta.site);
    assert.equal(saved.information[0].id, POST);
    assert.equal(saved.information[0].personal, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("读不到快照时返回 null，不抛异常", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "knot-board-"));
  try {
    assert.equal(await readDiscoverBoard(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a publisher is told when the board changes", () => {
  let calls = 0;
  setDiscoverPublisher(() => {
    calls += 1;
  });
  touchDiscoverBoard();
  touchDiscoverBoard();
  assert.equal(calls, 2);
  setDiscoverPublisher(null);
});

test("the board is empty when public browsing is off", async () => {
  installSystemPolicy({ guestBrowsing: false, registrationMode: "open", publicBoard: false });
  try {
    const board = await assembleDiscoverBoard(pool());
    assert.deepEqual(board.information, []);
    assert.deepEqual(board.requests, []);
    assert.deepEqual(board.people, []);
    assert.deepEqual(board.facets, { categories: [], topics: [] });
  } finally {
    installSystemPolicy({ guestBrowsing: true, registrationMode: "open", publicBoard: true });
  }
});

test("the snapshot keeps enough posts to fill a low-frequency site's first screen", async () => {
  // 个人站一天发 20–100 条，读的人比写的人多：首屏要能一直往下翻而不再回源。
  // 60 条差不多是「今天全部 + 昨天一部分」，文件仍在几十 KB 量级。
  // 上限是契约的一部分：放开成不设限，快照会随站龄无限长大。
  const fake = pool();
  await assembleDiscoverBoard(fake);
  const intel = fake.queries.find((query) => query.sql.includes("LIMIT $2"));
  assert.ok(intel, "the public intel query should be bounded");
  assert.equal(intel.params[1], 60);
});

test("快照带上今日计数，时区按站点自己的钟", async () => {
  const fake = pool();
  const board = await assembleDiscoverBoard(fake, {}, { timeZone: "Asia/Shanghai" });
  // 顶栏那一行读的就是这三项：今天发了多少条、最后一条的时间、日界。
  assert.deepEqual(board.counts, {
    posts: 12,
    lastPostAt: "2026-10-15T09:20:00.000Z",
    dayEndsAt: "2026-10-15T16:00:00.000Z",
  });
  const query = fake.queries.find((item) => item.sql.includes("AS start_at"));
  assert.ok(query, "今日计数应该发一次聚合查询");
  assert.deepEqual(query.params, ["Asia/Shanghai"]);
});

test("计数取不到时只少一行数字，信息流照旧写下来", async () => {
  // 首屏是读的人最先看到的东西，不能为了一行统计把整份快照拖没。
  const fake = pool();
  fake.countFails = true;
  const board = await assembleDiscoverBoard(fake);
  assert.equal(board.counts, null);
  assert.equal(board.information.length, 1);
});

test("公开快照关着时没有今日计数", async () => {
  installSystemPolicy({ guestBrowsing: false, registrationMode: "open", publicBoard: false });
  try {
    const board = await assembleDiscoverBoard(pool());
    assert.equal(board.counts, null);
  } finally {
    installSystemPolicy({ guestBrowsing: true, registrationMode: "open", publicBoard: true });
  }
});

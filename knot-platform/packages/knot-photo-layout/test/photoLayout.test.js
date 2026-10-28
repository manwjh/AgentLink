import assert from "node:assert/strict";
import test from "node:test";
import {
  LAYOUT_RULES,
  PHOTO_GAP,
  POSTER_LAYOUT_RULES,
  photoAspect,
  planPhotoBoxes,
  planPhotoLayout,
  planPhotoRows,
} from "../src/index.js";

const LANDSCAPE = 1920 / 1080;
const PORTRAIT = 1080 / 1440;

function rowsFor(aspect, count) {
  return planPhotoRows(Array(count).fill(aspect));
}

function counts(rows) {
  return rows.map((row) => row.cells.length);
}

function cellsOf(rows) {
  return rows.flatMap((row) => row.cells);
}

function assertCoversAll(rows, count) {
  assert.deepEqual(cellsOf(rows), Array.from({ length: count }, (_, index) => index));
  assert.ok(rows.every((row) => row.cells.length > 0));
}

test("a row keeps every cell the picture's own ratio", () => {
  assert.equal(photoAspect({ width: 1920, height: 1080 }), 1920 / 1080);
  assert.equal(photoAspect({ width: 0, height: 0 }), 4 / 3);
  assert.equal(photoAspect({}), 4 / 3);
  // 真实比例原样返回，极端的也保留：夹取只发生在排版的盒子形状上。
  assert.equal(photoAspect({ width: 400, height: 4000 }), 0.1);
  assert.equal(photoAspect({ width: 4000, height: 400 }), 10);
  // 盒子形状夹在 1:4 到 8:1 之间：再长的截图与 1:4 排成同一个盒子，再宽的全景与 8:1 一样。
  assert.equal(planPhotoRows([1 / 8])[0].height, planPhotoRows([1 / 4])[0].height);
  assert.equal(planPhotoRows([20])[0].height, planPhotoRows([8])[0].height);
  // 但裁切代价按真实比例算：1:8 比 1:4 多裁一截，20:1 比 8:1 多裁一截。
  assert.ok(planPhotoRows([1 / 8])[0].crop > planPhotoRows([1 / 4])[0].crop);
  assert.ok(planPhotoRows([20])[0].crop > planPhotoRows([8])[0].crop);
});

test("four landscape pictures take two rows instead of four squares", () => {
  const rows = rowsFor(LANDSCAPE, 4);
  assert.deepEqual(counts(rows), [2, 2]);
  assertCoversAll(rows, 4);
});

test("two landscape pictures share one row", () => {
  assert.deepEqual(counts(rowsFor(LANDSCAPE, 2)), [2]);
});

test("portrait pictures stay in one row while the row can still carry them", () => {
  assert.deepEqual(counts(rowsFor(PORTRAIT, 3)), [3]);
  assert.deepEqual(counts(rowsFor(PORTRAIT, 4)), [4]);
});

test("a crowded set falls into even rows of three", () => {
  for (const aspect of [LANDSCAPE, 1080 / 1080, PORTRAIT]) {
    assert.deepEqual(counts(rowsFor(aspect, 9)), [3, 3, 3]);
    assertCoversAll(rowsFor(aspect, 9), 9);
  }
  assert.deepEqual(counts(rowsFor(LANDSCAPE, 6)), [3, 3]);
  // 5 张横图：上面一行两张更大，下面一行三张，行高从上往下变小。
  assert.deepEqual(counts(rowsFor(LANDSCAPE, 5)), [2, 3]);
});

test("a tie puts the taller row on top", () => {
  // 3 张横图是「一张大图 + 下面两张」，不是反过来。
  assert.deepEqual(counts(rowsFor(LANDSCAPE, 3)), [1, 2]);
});

test("a row that would be too tall is cropped, not shrunk", () => {
  // 一张 1:2.5 的竖版长图：满宽一条，行高顶到 maxRow（2），多出来的下半截裁掉。
  const [tall] = planPhotoRows([1 / 2.5]);
  assert.equal(tall.cells.length, 1);
  assert.equal(tall.height, LAYOUT_RULES.maxRow);
  assert.ok(tall.cropped && tall.vertical);
  // 可见比例 = maxRow / 自然行高，1:2.5 的长图约看到八成。
  assert.ok(tall.height / tall.natural > 0.7);
  assert.ok(tall.height / tall.natural < 0.85);
  // 1:2 以内不裁：手机截图多在 1:2 附近，行高还没顶到上限。
  const [phone] = planPhotoRows([1 / 2]);
  assert.ok(!phone.cropped);
  assert.equal(phone.height, 2);

  // 更长的截图裁得更多，但行高不会超过同一个上限，也不会因为「太长」换一种排法：
  // 盒子形状先夹到 1:4，所以行高与 1:4 一样；裁切代价却按真实的 1:8 算（只留下四分之一）。
  const [long] = planPhotoRows([1 / 8]);
  assert.equal(long.height, LAYOUT_RULES.maxRow);
  assert.ok(long.cropped && long.vertical);
  assert.ok(Math.abs(long.crop - Math.log(4)) < 1e-9, `crop was ${long.crop}`);
});

test("a picture inside the rules is not cropped at all", () => {
  // 上限是 1:2：比它矮的竖图（1080x2160 之类）、方图、宽景、8:1 以内的全景都原样显示。
  for (const [width, height] of [[1920, 1080], [1080, 1080], [1200, 1400], [2400, 900], [1080, 2160], [4000, 1000], [5600, 800]]) {
    const [row] = planPhotoRows([width / height]);
    assert.equal(row.cells.length, 1);
    assert.ok(!row.cropped, `${width}x${height} was cropped`);
    assert.ok(Math.abs(row.height - height / width) < 1e-9);
  }
});

test("one picture always fills the card width", () => {
  // 单图也是一行一格：行的比例就是行高的倒数，单元格 flex-grow 等于自身比例，
  // 因此一格总是占满整行——不管它是横是竖，都不会再缩成中间一条窄图。
  for (const aspect of [LANDSCAPE, PORTRAIT, 0.4, 3.5]) {
    const [row] = planPhotoRows([aspect]);
    assert.equal(row.aspect.toFixed(4), (1 / row.height).toFixed(4));
    assert.ok(row.height >= LAYOUT_RULES.minRow && row.height <= LAYOUT_RULES.maxRow);
  }
});

test("no cell gets narrower than a finger can hit", () => {
  // 一格最少占行宽的 16%，328px 的窄屏上约 52px，够得上 44px 的可点下限。
  for (const [width, height] of [[1920, 1080], [900, 1200], [1080, 1080], [1600, 2000]]) {
    for (let count = 2; count <= 9; count++) {
      const aspects = Array.from({ length: count }, () => height / width);
      for (const row of planPhotoRows(aspects)) {
        const sum = row.cells.reduce((total, index) => total + aspects[index], 0);
        for (const index of row.cells) {
          assert.ok(
            aspects[index] / sum >= LAYOUT_RULES.minCell - 1e-9,
            `${count} pictures gave a cell of ${Math.round((aspects[index] / sum) * 100)}%`
          );
        }
      }
    }
  }
  // 常见的竖横混排也要守住：一竖三横、两横两竖、五张混着来。
  for (const aspects of [[0.75, 1.78, 1.78, 1.78], [1.78, 1.78, 0.75, 0.75], [0.75, 1.78, 1, 1.78, 0.75]]) {
    for (const row of planPhotoRows(aspects)) {
      const sum = row.cells.reduce((total, index) => total + aspects[index], 0);
      for (const index of row.cells) {
        assert.ok(
          aspects[index] / sum >= LAYOUT_RULES.minCell - 1e-9,
          `mixed set gave a cell of ${Math.round((aspects[index] / sum) * 100)}%`
        );
      }
    }
  }
});

test("a cell too narrow to tap is split off, not squeezed in", () => {
  // 极端比例被夹取之后，1:8 的长截图和 16:9 挤在一行只剩 12% 宽（326px 上约 40px），
  // 够不上 44px 的按动下限。这不是罚分能解决的事：宁可各占一行，也不留一格按不住。
  const sets = [[1 / 8, 1.78], [1 / 8, 1.78, 1.78, 1.78], [1 / 8, 1 / 8, 1.78, 1.78], [1.78, 1 / 4]];
  for (const aspects of sets) {
    const rows = planPhotoRows(aspects);
    assertCoversAll(rows, aspects.length);
    for (const row of rows) {
      for (const share of row.shares) {
        assert.ok(share >= LAYOUT_RULES.minTapShare - 1e-9, `${aspects} left a cell of ${Math.round(share * 326)}px`);
      }
    }
  }
  // 1:8 + 16:9：两行各一格，而不是一行里一格 40px。
  assert.deepEqual(counts(planPhotoRows([1 / 8, 1.78])), [1, 1]);
  // 正常比例的混排不受这条底线影响：一竖三横仍然排成 2+2。
  assert.deepEqual(counts(planPhotoRows([0.75, 1.78, 1.78, 1.78])), [2, 2]);
  assert.deepEqual(counts(planPhotoRows([0.75, 1.78, 1, 1.78, 0.75])), [2, 3]);
});

test("the poster's height budget is a ceiling; the card's is a soft target", () => {
  // 极端比例凑在一起时两份预算会做出不同选择：
  // 卡片要让每格都按得住，宁可一张一行、整组变高；海报不点，且必须塞进 maxCard，
  // 所以允许格子窄（两张极端图挤一行），整块不高。
  const aspects = [0.125, 10, 20, 1, 0.25, 10, 8, 20, 0.125];
  const height = (rows) => rows.reduce((sum, row) => sum + row.height, 0);
  const card = planPhotoRows(aspects);
  const poster = planPhotoRows(aspects, POSTER_LAYOUT_RULES);
  assertCoversAll(card, aspects.length);
  assertCoversAll(poster, aspects.length);
  assert.ok(height(poster) <= POSTER_LAYOUT_RULES.maxCard + 1e-9, `poster was ${height(poster).toFixed(2)} rows`);
  assert.ok(height(card) > height(poster));
  // 没开 strictCard 时同一个预算只是罚分，会为了少裁而超出去——海报的高度上限就守不住了。
  const soft = planPhotoRows(aspects, { ...POSTER_LAYOUT_RULES, strictCard: false });
  assert.ok(height(soft) > POSTER_LAYOUT_RULES.maxCard + 1e-9);
  // 普通比例的图两份预算排法一致，只有行高不同。
  for (const normal of [[0.75, 1.78, 1, 1.78, 0.75], [1.78, 0.75, 0.75], Array(9).fill(0.75)]) {
    assert.deepEqual(counts(planPhotoRows(normal, POSTER_LAYOUT_RULES)), counts(planPhotoRows(normal)));
  }
});

test("no row is longer than the rule allows", () => {
  for (const count of [2, 3, 4, 5, 6, 7, 8, 9]) {
    for (const row of rowsFor(PORTRAIT, count)) {
      assert.ok(row.cells.length <= LAYOUT_RULES.maxPerRow, `${count} pictures gave a row of ${row.cells.length}`);
    }
  }
});

test("a row's height is the inverse of its aspect sum unless it is cropped", () => {
  const sets = [
    Array(4).fill(LANDSCAPE),
    Array(9).fill(PORTRAIT),
    [PORTRAIT, LANDSCAPE, LANDSCAPE],
    [1.78, 0.75, 1, 1.78, 0.75],
    [1 / 1.6, 1.78, 1.78],
  ];
  for (const aspects of sets) {
    for (const row of planPhotoRows(aspects)) {
      const sum = row.cells.reduce((total, index) => total + aspects[index], 0);
      assert.ok(Math.abs(row.natural - 1 / sum) < 1e-9);
      if (!row.cropped) assert.ok(Math.abs(row.height - 1 / sum) < 1e-9);
      assert.ok(row.height >= LAYOUT_RULES.minRow - 1e-9 && row.height <= LAYOUT_RULES.maxRow + 1e-9);
      // 裁切方向：行高比自然值矮是裁上下，高是裁左右。
      if (row.cropped) assert.equal(row.vertical, row.height < row.natural);
    }
  }
});

test("a mixed set shares one row height", () => {
  const rows = planPhotoRows([PORTRAIT, LANDSCAPE, LANDSCAPE]);
  assert.deepEqual(counts(rows), [3]);
  assertCoversAll(rows, 3);
  const tall = planPhotoRows([LANDSCAPE, PORTRAIT, PORTRAIT, PORTRAIT]);
  assertCoversAll(tall, 4);
});

test("one picture is planned as a row of one", () => {
  const plan = planPhotoLayout([{ url: "/a", width: 1200, height: 1600 }]);
  assert.equal(plan.rows.length, 1);
  assert.deepEqual(plan.rows[0].cells, [0]);
  assert.ok(!plan.rows[0].cropped, "a 3:4 picture fits the 1:2 ceiling");
  // 超过 1:2 才裁：1:3 的截图顶到上限，只留下三分之二。
  const tall = planPhotoLayout([{ url: "/b", width: 1080, height: 3240 }]);
  assert.ok(tall.rows[0].cropped && tall.rows[0].vertical);
  assert.deepEqual(planPhotoLayout([]), { rows: [] });
});

test("pictures without a url are left out of the plan", () => {
  const plan = planPhotoLayout([{ url: "/a" }, { url: "" }, null, { url: "/b" }]);
  assert.deepEqual(plan.rows.map((row) => row.cells), [[0, 1]]);
});

test("a plan is stable and cheap enough for a feed", () => {
  const aspects = Array.from({ length: 9 }, (_, index) => (index % 2 ? LANDSCAPE : PORTRAIT));
  const started = process.hrtime.bigint();
  for (let run = 0; run < 200; run++) planPhotoRows(aspects);
  const each = Number(process.hrtime.bigint() - started) / 200 / 1e6;
  // 只是护栏：真跑起来是微秒级，比一帧的千分之一还小。
  assert.ok(each < 5, `one plan took ${each.toFixed(3)}ms`);
});

test("each row's shares add up to one", () => {
  // 份额归一之后，flex 才一定铺满整行（grow 之和小于 1 时浏览器会留下空档）。
  for (const aspects of [[1], [0.75], [LANDSCAPE, LANDSCAPE], [0.4, 1.78, 3.5, 1]]) {
    for (const row of planPhotoRows(aspects)) {
      const total = row.shares.reduce((sum, share) => sum + share, 0);
      assert.ok(Math.abs(total - 1) < 1e-9, `shares added up to ${total}`);
    }
  }
});

test("a planned row carries its cell shares", () => {
  // 卡片直接拿 row.shares 落 CSS；份额必须随行给出，不能靠调用方再传一遍比例。
  const [row] = planPhotoRows([0.5, 1.5]);
  assert.deepEqual(row.cells, [0, 1]);
  assert.ok(Math.abs(row.shares[0] - 0.25) < 1e-9);
  assert.ok(Math.abs(row.shares[1] - 0.75) < 1e-9);
  // 一张没尺寸的图按 4:3 参与份额，不会把整行宽度算给别人。
  const plan = planPhotoLayout([
    { url: "/a", width: 500, height: 1000 },
    { url: "/b", width: 1500, height: 1000 },
  ]);
  assert.ok(Math.abs(plan.rows[0].shares[0] - 0.25) < 1e-9);
  assert.ok(Math.abs(plan.rows[0].shares[1] - 0.75) < 1e-9);
});

test("boxes fill the width and stack in the planned rows", () => {
  const photos = [
    { width: 1920, height: 1080 },
    { width: 1080, height: 1440 },
    { width: 1080, height: 1080 },
    { width: 1200, height: 800 },
  ];
  const plan = planPhotoBoxes(photos, { width: 936, x: 72, y: 300 });
  assert.equal(plan.boxes.length, 4);
  // 每行首尾贴住内容区的左右边，宽度之和加上间隔正好是 936。
  let index = 0;
  for (const row of plan.rows) {
    const cells = plan.boxes.slice(index, index + row.cells.length);
    assert.equal(cells[0].x, 72);
    const last = cells[cells.length - 1];
    assert.equal(last.x + last.width, 72 + 936);
    const span = cells.reduce((sum, cell) => sum + cell.width, 0) + PHOTO_GAP * (cells.length - 1);
    assert.equal(span, 936);
    assert.ok(cells.every((cell) => cell.height === cells[0].height));
    index += row.cells.length;
  }
  // 行与行之间留 PHOTO_GAP，整块高度可以按行高算出来。
  const rowsHeight = plan.rows.reduce((sum, row) => sum + Math.round(row.height * 936), 0);
  assert.equal(plan.height, rowsHeight + PHOTO_GAP * (plan.rows.length - 1));
  // 第二行落在第一行下面，不会叠上去。
  const firstBottom = plan.boxes[0].y + plan.boxes[0].height;
  const secondRow = plan.boxes[plan.rows[0].cells.length];
  assert.equal(secondRow.y, firstBottom + PHOTO_GAP);
});

test("the poster budget keeps a portrait screenshot whole where the card crops it", () => {
  // 一张比卡片上限高、比海报上限矮的竖版截图：卡片裁一截，分享图整张放得下。
  // 取哪张图由两份预算算出来，不钉死某个比例——预算调了，这条自然换一张符合条件的图。
  const width = 598;
  const height = Math.round(width * ((LAYOUT_RULES.maxRow + POSTER_LAYOUT_RULES.maxRow) / 2));
  const tall = { width, height };
  const card = planPhotoBoxes([tall], { width: 936 });
  assert.equal(card.boxes[0].cropped, true);
  // 分享图的预算更宽：同一张图不裁，行高就是它的自然高度。
  const poster = planPhotoBoxes([tall], { width: 936, rules: POSTER_LAYOUT_RULES });
  assert.equal(poster.boxes[0].cropped, false);
  assert.equal(poster.boxes[0].height, Math.round((height / width) * 936));
});


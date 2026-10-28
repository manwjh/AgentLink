// 多图排版：先按图片比例把一组图切成若干行，再给每行定一个高度。
//
// 一行的高度（记作 h，单位是「容器宽的倍数」）决定两件事：
//   - 行内每格的宽度按盒子比例分配（比例先夹到 1:4–8:1），所以「不裁也不留边」的行高恰好是 1/Σa；
//   - 行高被夹在 [minRow, maxRow] 之间，夹住的那点差额由 cover 裁掉，裁多少逐格按真实比例算（见 rowCrop）。
//
// 夹取只改盒子的形状：1:8 的截图不会被当成 1:4，10:1 的全景也不会在账面上「没裁」。
// 于是「太高的图」不需要单独特判：自然行高超过 maxRow 就被夹住，自动变成满宽的一条，
// 上下裁掉一截；「太扁的图」同理，左右裁。代码里没有「单图」「长图」这类分支。
//
// 为什么不用量 DOM：行高只由「这一行比例之和」与规则决定，与容器绝对宽度无关，
// 所以整份排版可以只从图片尺寸算出来。渲染前就知道每行的比例，
// 图片下载完只是往同样大小的盒子里填，不重排、不跳版（CLS 为 0）。
//
// 分几行是穷举出来的：n 张图只切 n-1 个缝，最多 2^8 = 256 种。
// 先过两条硬条件——没有一格窄到按不住、海报要塞进自己的高度上限——再比代价：
// 行高偏离目标多远、整组是否过高、一行里最窄的那格还剩多宽、裁掉了多少。
//
// 这份算法同时给 WebUI 卡片（`PhotoGallery.vue`，用 CSS 比例排）和分享图
// （`sharePoster.js`，按像素框裁图再拼）用。预算都登记在这里，普通比例的相册两处排法一致；
// 极端比例凑在一起时，卡片为了每格都按得住会多分几行，海报则守自己的高度上限。

// 比例先夹住：1:4 的竖图和 8:1 的全景之外，再极端就跟内容无关了。
const MIN_ASPECT = 0.25;
const MAX_ASPECT = 8;
// 没有尺寸（旧记录、还没来得及量）时按 4:3 猜。猜错只是那一格被 cover 裁一点。
const DEFAULT_ASPECT = 4 / 3;
// 真实可见比例与 1 差到这个程度才算「裁过」，免得浮点误差把整格标成裁剪。
const CROP_EPSILON = 0.004;
// 多图之间的缝：卡片用 CSS gap，海报按像素拼图；两边读同一个数，宽高换算才一致。
export const PHOTO_GAP = 2;
// 比代价时的容差：两种切法的代价差在这个量级以内就算打平。
const EPS = 1e-9;

// target / targetDense：理想行高 = 容器宽的百分之多少。
// 少到四张时按 36% 排，图片够大；五张起按 25% 排，九宫格才压得进一屏。
// minRow / maxRow：一行最矮、最高的行高（相对容器宽）。maxRow 是「太高就裁」的唯一出处：
//   2 是竖版截图的预算——手机截图多在 1:2 附近，整张显示；再长才裁掉多余部分。
//   0.14 是全景的下限：328px 窄屏上约 46px，仍按得住 44px 的可点下限。
// maxCard：整组图的高度上限（相对容器宽）。软约束时超出的部分按 cardPenalty 计罚；
// strictCard 打开时，能塞进上限的切法一律优先（海报的像素预算必须守得住）。
// 这几个数是排版口味，不是精确值；要调整只改这里，组件和样式跟着走。
export const LAYOUT_RULES = {
  target: 0.36,
  targetDense: 0.25,
  denseFrom: 5,
  minRow: 0.14,
  maxRow: 2,
  maxCard: 2,
  maxPerRow: 4,
  // 一格理想上占这一行宽度的 16%（328px 窄屏上约 52px）。罚分把求解器往这个目标推。
  minCell: 0.16,
  minCellPenalty: 240,
  // 硬底线：一格窄于行宽的 13.5%（328px 卡片上正好 44px）就按不住了。
  // 这不是罚分，是换一种切法：先比「有没有一格窄到按不住」，再比代价。
  // 只有极端比例被夹取之后才会踩到（1:8 的长截图和 16:9 挤一行只剩 40px）。
  minTapShare: 0.135,
  rowPenalty: 0.45,
  cardPenalty: 6,
  // maxCard 是罚分还是硬约束。卡片上保持软约束（为了让每格都按得住，宁可高一点）；
  // 海报有自己的像素预算，那条必须硬。
  strictCard: false,
  crowdedPenalty: 40,
  // 裁掉的内容按「可见比例的平方」计罚：裁 10% 几乎不算，裁一半很贵。
  // 它让求解器在「多切一行」与「多裁一截」之间做选择，而不是永远选裁。
  cropPenalty: 6,
};

// 分享图是竖着看的整张长图：行高放到 3 倍内容宽，整块拼图默认 4 倍。
// 这里只是默认预算；Backend 会按自己的 MAX_HEIGHT、内容宽和固定区反推实际行数，
// 再覆盖 maxCard（见 sharePoster.js 的 POSTER_RULES）。单图天花板只认 maxRow，两处同源。
// 另两处不同：海报不点，minTapShare 归零（否则极端图逐张拆行会把拼图撑爆）；
// strictCard 打开，maxCard 就是拼图的高度上限。
export const POSTER_LAYOUT_RULES = {
  ...LAYOUT_RULES,
  maxRow: 3,
  maxCard: 4,
  minTapShare: 0,
  strictCard: true,
};

// 规则的版本。改夹取区间、行高上下限、目标行高或任何罚分，都在这里抬一档：
// 分享图的缓存键读这个号，已生成的图才会按新排法重画一次。号写在规则旁边，
// 改规则时不用再去 Backend 里找一个字符串（上一版就是在那儿写死的）。
export const LAYOUT_VERSION = 2;

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

function saneAspect(value) {
  const aspect = Number(value);
  return Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_ASPECT;
}

function clampAspect(value) {
  return clamp(saneAspect(value), MIN_ASPECT, MAX_ASPECT);
}

// 一张图的真实宽高比。卡片用的是显示图，宽高由后端随记录下发；缺了就退回 4:3。
// 夹取只发生在排版的盒子形状上（clampAspect），这里保留真实比例，裁切判断才准。
export function photoAspect(photo) {
  const width = Number(photo?.width) || 0;
  const height = Number(photo?.height) || 0;
  if (width <= 0 || height <= 0) return DEFAULT_ASPECT;
  return saneAspect(width / height);
}

// 一行盒子的形状：自然行高（按夹取后的比例算，不裁时的高度）与实际行高。
function rowShape(sum, rules) {
  const natural = 1 / sum;
  return { natural, height: clamp(natural, rules.minRow, rules.maxRow) };
}

// 一行实际被 cover 裁掉多少。盒子按夹取后的比例定，图片按真实比例填；
// 逐格求 cover 之后的可见比例，代价按每格累加，crop 取整行裁得最狠的那一格。
// 只有真实比例与盒子形状不一致时（比例超出夹取区间）两者才会出现差别。
function rowCrop(real, box, start, end, sum, height) {
  let penalty = 0;
  let crop = 0;
  let vertical = false;
  let cropped = false;
  for (let index = start; index < end; index += 1) {
    const cellAspect = box[index] / sum / height;
    const aspect = real[index];
    const visible = Math.min(1, aspect / cellAspect, cellAspect / aspect);
    const cut = visible < 1 ? -Math.log(visible) : 0;
    penalty += cut ** 2;
    if (cut > crop) crop = cut;
    if (cut > CROP_EPSILON) {
      cropped = true;
      // 图片比格子更窄（更高）⇒ 裁上下；反之裁左右。一格里竖裁的整行都保留顶部，
      // 横裁的格子在竖直方向刚好填满，object-position 对它没有影响。
      if (aspect < cellAspect) vertical = true;
    }
  }
  return { crop, cropped, vertical, penalty };
}

function measureRows(breaks, real, box, prefix, rules, photoCount) {
  const target = photoCount >= rules.denseFrom ? rules.targetDense : rules.target;
  let cost = 0;
  let totalHeight = 0;
  // 这一种切法里最窄的格离可点下限还差多少：0 表示每一格都还能按。
  let untappable = 0;
  // strictCard 下超出高度上限的部分；0 表示这一种切法塞得进预算。
  let budgetOver = 0;
  const rows = [];
  let start = 0;
  for (const end of breaks) {
    const count = end - start;
    const sum = prefix[end] - prefix[start];
    const shape = rowShape(sum, rules);
    const cut = rowCrop(real, box, start, end, sum, shape.height);
    let row = count * Math.log(shape.height / target) ** 2 + rules.rowPenalty;
    if (count > rules.maxPerRow) row += (count - rules.maxPerRow) * rules.crowdedPenalty;
    // 一行里最窄的那格：比例悬殊的图挤在一行时只剩几十像素，手机上按不准。
    // 先按软目标罚分，低于可点下限再升级成硬条件（见 beats）。
    let narrowest = Infinity;
    for (let index = start; index < end; index++) narrowest = Math.min(narrowest, box[index]);
    const share = narrowest / sum;
    if (share < rules.minCell) row += (rules.minCell - share) * rules.minCellPenalty;
    untappable = Math.max(untappable, (rules.minTapShare ?? 0) - share);
    // 裁掉的内容按真实可见比例计罚：一张 1:2.5 的长图单独一行时，这一项是它「裁掉一截」的代价，
    // 而拆成多行、每行不那么高，代价更小——是否值得，交给求解器算。
    row += cut.penalty * rules.cropPenalty;
    cost += row;
    totalHeight += shape.height;
    rows.push({ start, end, sum, ...shape, ...cut });
    start = end;
  }
  const excess = Math.max(0, totalHeight - rules.maxCard);
  if (rules.strictCard) budgetOver = excess;
  cost += excess * rules.cardPenalty;
  return { cost, rows, totalHeight, untappable, budgetOver };
}

// 两种切法谁更好：先看有没有一格窄到按不住（能避开就避开，哪怕代价高一些），
// 再看整组是否塞不进高度上限（strictCard 时），最后才比代价。
// 只有极端比例被夹取时才可能踩到前两条，普通相册的切法不受影响。
function beats(candidate, best) {
  if (!best) return true;
  if (candidate.untappable < best.untappable - EPS) return true;
  if (candidate.untappable > best.untappable + EPS) return false;
  if (candidate.budgetOver < best.budgetOver - EPS) return true;
  if (candidate.budgetOver > best.budgetOver + EPS) return false;
  if (candidate.cost < best.cost - EPS) return true;
  if (candidate.cost > best.cost + EPS) return false;
  // 代价相同的切分不少（一组等比例图，行序怎么排代价都一样），挑第一行更高的一种：
  // 大图在上、往下渐小，和常见相册的顺序一致，3 张也就排成 1+2 而不是 2+1。
  return candidate.rows[0].height > best.rows[0].height + EPS;
}

// 所有切分方式里挑一种最好的（顺序见 beats）。
export function planPhotoRows(aspects, rules = LAYOUT_RULES) {
  // real 是图片自己的比例（只用来算裁切），box 是排版的盒子形状；两者只在比例超出夹取区间时不同。
  const real = (aspects || []).map(saneAspect);
  const box = real.map(clampAspect);
  const count = real.length;
  if (!count) return [];
  const prefix = [0];
  for (const aspect of box) prefix.push(prefix[prefix.length - 1] + aspect);

  const gaps = count - 1;
  let best = null;
  for (let mask = 0; mask < 2 ** gaps; mask++) {
    const breaks = [];
    for (let i = 0; i < gaps; i++) if (mask & (1 << i)) breaks.push(i + 1);
    breaks.push(count);
    const candidate = measureRows(breaks, real, box, prefix, rules, count);
    if (beats(candidate, best)) best = candidate;
  }

  return best.rows.map((row) => {
    const cells = [];
    const shares = [];
    for (let index = row.start; index < row.end; index++) {
      cells.push(index);
      shares.push(box[index] / row.sum);
    }
    return {
      cells,
      shares,
      height: row.height,
      aspect: 1 / row.height,
      natural: row.natural,
      crop: row.crop,
      vertical: row.vertical,
      cropped: row.cropped,
    };
  });
}

// 卡片只需要一件事：把这组图切成若干行，每行给出行高、每格份额与裁切方向。
export function planPhotoLayout(photos, rules = LAYOUT_RULES) {
  const items = (photos || []).filter((photo) => photo && typeof photo.url === "string" && photo.url);
  return { rows: planPhotoRows(items.map(photoAspect), rules) };
}

// 分享图要的是像素框：每格贴在哪、多大。行高仍是「内容宽的倍数」，乘上宽度就是像素，
// 所以同一份计划既能在 CSS 里按比例排，也能在 sharp 里按坐标裁。
// 宽度按份额取整后，最后一格吃掉舍入误差，整行正好铺满 width。
export function planPhotoBoxes(photos, options = {}) {
  const { width, gap = PHOTO_GAP, rules = LAYOUT_RULES, x: originX = 0, y: originY = 0 } = options;
  const items = (photos || []).map((photo) => photo || {});
  const rows = planPhotoRows(items.map(photoAspect), rules);
  const boxes = [];
  let top = originY;
  rows.forEach((row) => {
    const height = Math.max(1, Math.round(row.height * width));
    const usable = Math.max(1, width - gap * (row.cells.length - 1));
    let acc = 0;
    row.cells.forEach((index, position) => {
      const left = originX + Math.round(acc * usable) + position * gap;
      acc += row.shares[position];
      const right = originX + Math.round(acc * usable) + position * gap;
      boxes.push({
        index,
        photo: items[index],
        x: left,
        y: top,
        width: Math.max(1, right - left),
        height,
        vertical: row.vertical,
        cropped: row.cropped,
      });
    });
    top += height + gap;
  });
  return { rows, boxes, height: boxes.length ? top - gap - originY : 0 };
}

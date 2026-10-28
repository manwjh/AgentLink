import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { access, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import sharp from "sharp";
import { keyEntry, resolve } from "@knot/config";
import { isMarkdown, toRuns } from "@knot/markdown";
import { LAYOUT_VERSION, POSTER_LAYOUT_RULES, planPhotoBoxes } from "@knot/photo-layout";
import { isAudioUpload, MAX_IMAGES, uploadName, visibleVerdict } from "./information.js";
import { loadBootstrapConfig } from "./config.js";
import { profileFilePath, readProfileSync } from "./profile.js";
import { derivedDir, readableBlobPath } from "./storage.js";
import { agentAvatarSlug, defaultAvatarIndex } from "./avatars.js";
// 退回单图时要从文件本身读宽高；同一份读取顺带把 EXIF 方向摆正，和入库时的口径一致。
import { readImageMeta } from "./uploadStore.js";

// 样例值也从 schema 取，不再在这里写第二份。
// 站点名与标语来自站点档案 sites/<站点>/profile.json。
const SCHEMA_CTX = { root: "", deployRoot: "", home: "" };
const schemaDefault = (key) => resolve(keyEntry(key), {}, SCHEMA_CTX);

export const SHARE_PAGE = schemaDefault("KNOT_PUBLIC_ORIGIN");
export const SHARE_HOST = new URL(SHARE_PAGE).host;
export const SHARE_NAME = "Knot";
// 站名下面那句标语：默认写成两行——第一行说这是什么，第二行说用什么搭的。
// 换行是显式给的，页脚的 wrapText 遇到 \n 就断行，所以在哪儿断不靠字数碰运气。
export const SHARE_LINE = "我在Agent时代的信息枢纽\n采用XKnot · AgentLink搭建";

// 站点档案只在落款里用到，但 shareSite() 每取一张图会走两次（锁 key 与画图）。
// 每次同步读一遍 profile.json 是白读；按文件 mtime + 大小记住上一次的结果，
// 档案改过（写了新的 mtime）自然重读（S12-13）。
let siteProfileCache = { key: "", site: null };
function cachedSiteProfile(env, config) {
  const file = profileFilePath(env, config.agentEnvDir);
  let stamp = "missing";
  try {
    const info = statSync(file);
    stamp = `${info.mtimeMs}:${info.size}`;
  } catch {
    /* 没有档案时走兜底文案 */
  }
  const key = `${file}\u0000${stamp}`;
  if (siteProfileCache.key === key) return siteProfileCache.site;
  const { site } = readProfileSync(file);
  siteProfileCache = { key, site: site || null };
  return siteProfileCache.site;
}

export function shareSite(env = process.env) {
  const config = loadBootstrapConfig(env);
  // 没有部署配置时回落到 schema 里的默认地址，测试和本地开发不受影响。
  const page = config.publicWebOrigin.replace(/\/$/, "");
  let host = SHARE_HOST;
  try {
    host = new URL(page).host || SHARE_HOST;
  } catch {
    /* 保留默认主机名 */
  }
  // 落款取自站点档案（自述区）；没填时用兜底文案，图不会缺字。
  const site = cachedSiteProfile(env, config);
  return {
    page,
    host,
    name: site?.name || SHARE_NAME,
    line: site?.tagline || SHARE_LINE,
  };
}

const WIDTH = 1080;
const PAD = 72;
const INNER = WIDTH - PAD * 2;
// 长图的成本不在 sharp 的单边上限（32767px），在解码内存和出海链路：
// 1080×6144 = 660 万像素，约 0.7MB、一秒画完；再长的帖子截到省略号，二维码指向原文。
export const MAX_HEIGHT = 6144;
// 图片格子的底色，也是透明图 flatten 过去的那一层：拼图和退回单图都用这一块，
// 不能一边垫白、一边让 JPEG 把透明区压成黑色。
const PHOTO_BACKDROP = "#F0F2F5";
// 中间层先按较高画质编码一次，最后由整张海报统一压到 75；两处用同一个数。
const PHOTO_LAYER_QUALITY = 90;
// 分享图是给人看一眼就存的，不是印刷品。90 档压出来两兆多，出海链路要传几十秒；
// 75 档加渐进式约省三分之一字节，手机上放大也看不出差别，所以画质让一步。
export const POSTER_JPEG_QUALITY = 75;
// 海报画法自身的版本：换宽度、页脚排布、贴图方式或画质都抬一档。
// 排版规则的变化由 @knot/photo-layout 的 LAYOUT_VERSION 负责，两者一起进缓存键。
const POSTER_VERSION = 7;

const GAP = 32;
const HOLD = 280;
const BODY_SIZE = 40;
const BODY_LEADING = 64;
const NAME_SIZE = 32;
const NAME_LEADING = 48;
// 8px 一个模块，1080 宽里 360px 的二维码在手机上仍能一眼扫上；静区保留标准的 4 模块。
// 版本高的码（子域长、id 全大写）自动缩到 7px 一模块，页脚不会被二维码撑高。
const QR_PIXEL = 8;
const QR_TARGET = 360;
const QR_QUIET = 4;
// 页脚两栏：左边站名、标语、地址，右边二维码。文字块通常比二维码矮，
// 所以固定区高度基本由二维码和白底、内边距决定，比原来的竖排省一半。
const FOOT_PAD = 36;
const FOOT_NAME = 40;
const FOOT_LINE = 26;
const FOOT_LINE_LEADING = 36;
const FOOT_HOST = 22;
const FOOT_GAP = 10;
const FOOT_PLATE = 12;
const FONT = "Hiragino Sans GB, Heiti SC, PingFang SC, Songti SC, sans-serif";
const MONO = "Menlo, Consolas, Monaco, monospace";
const H1_SIZE = 52;
const H1_LEADING = 74;
const H2_SIZE = 44;
const H2_LEADING = 62;
const H3_SIZE = 40;
const H3_LEADING = 58;
const CODE_SIZE = 30;
const CODE_LEADING = 46;
const LABEL = { video: "视频", image: "图片" };
const ACTOR_LABEL = { person: "人", personal_agent: "Agent", platform: "平台" };
const HEAD_AVATAR = 88;
const HEAD_NAME = 40;
const HEAD_META = 28;
const HEAD_TOP = 56;
const HEAD_BOTTOM = 28;
// 头像与称呼之间、称呼与下一行之间的距离。
const HEAD_TEXT_GAP = 28;
const HEAD_LINE_GAP = 14;

// 拼图行数从海报的高度预算反推，不再和 @knot/photo-layout 各写一个 4：
// 扣掉最高的一条头部、页脚的二维码块、至少四分之一高给正文，再留三处 GAP，
// 剩下的高度按内容宽换算成「最多几行图」。
const HEAD_BAND_MAX = HEAD_TOP + HEAD_AVATAR + HEAD_BOTTOM + GAP;
const FOOT_BAND_MAX = QR_TARGET + FOOT_PLATE * 2 + FOOT_PAD * 2;
const TEXT_BAND_MIN = Math.round(MAX_HEIGHT / 4);
const PHOTO_ROWS_MAX = Math.max(1, Math.floor((MAX_HEIGHT - HEAD_BAND_MAX - FOOT_BAND_MAX - TEXT_BAND_MIN - GAP * 3) / INNER));
const POSTER_RULES = { ...POSTER_LAYOUT_RULES, maxCard: PHOTO_ROWS_MAX };

const META_KEY = /^[0-9a-f]{16}$/;
const AVATAR_DIR = path.resolve(import.meta.dirname, "../../web/public/avatars");
const AGENT_AVATAR_DIR = path.join(AVATAR_DIR, "agents");

function defaultAvatarPath(index) {
  return path.join(AVATAR_DIR, `${String(index + 1).padStart(2, "0")}.svg`);
}

function agentAvatarPath(slug) {
  return path.join(AGENT_AVATAR_DIR, `${slug}.svg`);
}

export function shareUrl(intelId, site = shareSite()) {
  const base = site.page.replace(/\/$/, "");
  return intelId ? `${base}/discover?post=${intelId}` : base;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/i;
const inflight = new Map();

function xml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch]));
}

function clean(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

// 排版用的字宽只留这一份：正文折行、页脚折行、省略号和价格角标都用它。
// 以前正文按统一的 0.56 估算、页脚再用 sharp 量真实像素，同一条文案在两处会得到不同宽度；
// ASCII 按字形宽窄分组（按海报字体栈量出来的比例取整），CJK 与全角字符记 1。
// 宁可略宽一点：宽了只是早折一行，窄了会把字画出内容区。
const ASCII_NARROW = "|li.,:;'!I";
const ASCII_NARROW_2 = "j)])([`\"}{1";
const ASCII_NARROW_3 = "-*rtfJ/\\z";
const ASCII_MID = "ashknu<>~Fcxe_^5v?ELbgpy27doq$396#+=08PS";
const ASCII_WIDE = "B4ZKNRHTUDGYCXVOQ";
const ASCII_WIDER = "A&wmM%@";

function asciiUnits(ch) {
  if (ch === " ") return 0.28;
  if (ch === "W") return 0.98;
  if (ASCII_WIDER.includes(ch)) return 0.78;
  if (ASCII_WIDE.includes(ch)) return 0.68;
  if (ASCII_NARROW.includes(ch)) return 0.13;
  if (ASCII_NARROW_2.includes(ch)) return 0.26;
  if (ASCII_NARROW_3.includes(ch)) return 0.4;
  if (ASCII_MID.includes(ch)) return 0.55;
  return 0.56;
}

function charUnits(ch) {
  const code = ch.codePointAt(0) || 0;
  return code <= 0x02ff ? asciiUnits(ch) : 1;
}

// 600 字重比常规宽一点；只用来把行收紧，不追求像素级精确。
const BOLD_WIDTH = 1.04;

// weight 用于称呼、价格这类单行收紧；折行时 600 字重也按 BOLD_WIDTH 略放宽。
function textWidth(text, size, weight = "") {
  let used = 0;
  for (const ch of text) used += charUnits(ch) * size;
  return weight ? used * BOLD_WIDTH : used;
}

const STICKS = new Set([..."，。、！？：；,.!?;:）】》」』”’)]}"]);

// 按可用宽度收字后追加省略号。省略号自己也占宽度：只把 … 拼到原行尾，
// 最后一行会多吃掉一格，右边距就和别处不一致了。
function ellipsizeText(text, width, size, weight = "") {
  const value = String(text).replace(/…$/, "");
  let cut = value;
  while (cut && textWidth(`${cut}…`, size, weight) > width) cut = [...cut].slice(0, -1).join("");
  return `${cut}…`;
}

// 正文和 Markdown 行共用这一个折行器：同一套字宽、同一套「标点不另起一行」规则。
// chars 是 { ch, ...样式 } 的数组，返回值保留原对象，调用方再决定拼成字符串还是样式段。
// sticks 只给代码块关掉：代码里的逗号、括号换行时不该被粘回上一行。
function wrapChars(chars, width, size, maxLines = Infinity, options = {}) {
  const sticks = options.sticks !== false;
  const lines = [];
  let line = [];
  let used = 0;
  let cut = false;
  for (let index = 0; index < chars.length; index += 1) {
    const item = chars[index];
    if (item.ch === "\n") {
      lines.push(line);
      line = [];
      used = 0;
      if (lines.length === maxLines) {
        cut = index < chars.length - 1;
        break;
      }
      continue;
    }
    const next = charUnits(item.ch) * size * (item.bold || options.weight ? BOLD_WIDTH : 1);
    if (line.length && used + next > width) {
      if (sticks && STICKS.has(item.ch)) {
        line.push(item);
        used += next;
        continue;
      }
      lines.push(line);
      line = [];
      used = 0;
      if (lines.length === maxLines) {
        cut = true;
        break;
      }
    }
    line.push(item);
    used += next;
  }
  if (lines.length < maxLines) lines.push(line);
  else if (line.length) cut = true;
  return { lines, cut };
}

export function wrapText(text, width, size, maxLines = Infinity) {
  const chars = [...clean(text)].map((ch) => ({ ch }));
  const { lines, cut } = wrapChars(chars, width, size, maxLines);
  const result = lines.map((line) => line.map((item) => item.ch).join(""));
  if (cut && result.length) result[result.length - 1] = ellipsizeText(result[result.length - 1], width, size);
  return result.length ? result : [""];
}

function compressSegments(chars) {
  const segments = [];
  let current = null;
  for (const ch of chars) {
    const key = `${ch.bold ? 1 : 0}${ch.italic ? 1 : 0}${ch.code ? 1 : 0}${ch.link || ""}`;
    if (!current || current.key !== key) {
      current = { key, text: ch.ch, bold: ch.bold, italic: ch.italic, code: ch.code, link: ch.link };
      segments.push(current);
    } else {
      current.text += ch.ch;
    }
  }
  for (const segment of segments) delete segment.key;
  return segments;
}

function emptyInlineLine() {
  return [{ text: "", bold: false, italic: false, code: false, link: null }];
}

function wrapInline(segments, width, size, options = {}) {
  const chars = [];
  for (const segment of segments) {
    for (const ch of segment.text) chars.push({ ch, bold: segment.bold, italic: segment.italic, code: segment.code, link: segment.link });
  }
  const { lines } = wrapChars(chars, width, size, options.maxLines ?? Infinity, options);
  if (!lines.length) return [emptyInlineLine()];
  return lines.map((line) => (line.length ? compressSegments(line) : emptyInlineLine()));
}

// 海报的文字行由共享解析器给出，这里只负责字号、缩进和省略号。
export function markdownTexts(body, width = INNER, maxLines = Infinity) {
  const items = [];
  const add = (item) => {
    if (items.length >= maxLines) return false;
    items.push(item);
    return true;
  };
  const ellipsizeLast = () => {
    const last = items[items.length - 1];
    if (last) ellipsizeLine(last, width);
  };

  for (const run of toRuns(clean(body))) {
    if (items.length >= maxLines) break;

    if (run.type === "rule") {
      add({ rule: true, leading: GAP });
      continue;
    }

    if (run.type === "code") {
      for (const raw of run.lines) {
        const code = raw.replace(/\t/g, "  ");
        // 代码块和正文用同一个折行器，只是关掉标点粘连：一行代码再长也不该画出内容区。
        const segments = [{ text: code || " ", bold: false, italic: false, code: true, link: null }];
        for (const line of wrapInline(segments, width, CODE_SIZE, { sticks: false })) {
          const item = { segments: line, size: CODE_SIZE, leading: CODE_LEADING, fill: "#050505", code: true };
          if (!add(item)) break;
        }
        if (items.length >= maxLines) break;
      }
      continue;
    }

    if (run.type === "heading") {
      const level = Math.max(1, Math.min(3, run.level));
      const size = level === 1 ? H1_SIZE : level === 2 ? H2_SIZE : H3_SIZE;
      const leading = level === 1 ? H1_LEADING : level === 2 ? H2_LEADING : H3_LEADING;
      for (const line of wrapInline(run.segments, width, size, { weight: "600" })) {
        if (!add({ segments: line, size, leading, fill: "#050505", weight: "600" })) break;
      }
      continue;
    }

    const indent = run.indent || 0;
    const fill = run.quote ? "#65676B" : "#050505";
    const lines = wrapInline(run.segments, Math.max(1, width - indent), BODY_SIZE);
    for (let index = 0; index < lines.length; index += 1) {
      const item = { segments: lines[index], size: BODY_SIZE, leading: BODY_LEADING, fill, indent };
      if (index === 0 && run.prefix) item.prefix = run.prefix;
      if (run.quote) item.quote = true;
      if (!add(item)) break;
    }
  }

  if (items.length >= maxLines) ellipsizeLast();
  return items;
}

function renderRichLine(line, x, baseline) {
  if (!line.segments) {
    const weight = line.weight ? ` font-weight="${line.weight}"` : "";
    return `<text x="${x}" y="${baseline}" font-family="${FONT}" font-size="${line.size}" fill="${line.fill || "#050505"}"${weight}>${xml(line.text)}</text>`;
  }
  const weight = line.weight ? ` font-weight="${line.weight}"` : "";
  const spans = line.segments
    .map((segment) => {
      let attrs = "";
      if (segment.bold || line.weight) attrs += ' font-weight="600"';
      if (segment.italic) attrs += ' font-style="italic"';
      if (segment.code) attrs += ` font-family="${MONO}"`;
      const fill = segment.link ? "#0866FF" : segment.code ? "#65676B" : line.fill || "#050505";
      return `<tspan${attrs} fill="${fill}">${xml(segment.text)}</tspan>`;
    })
    .join("");
  return `<text x="${x}" y="${baseline}" font-family="${FONT}" font-size="${line.size}" fill="${line.fill || "#050505"}"${weight}>${spans}</text>`;
}

function linkName(list) {
  if (!Array.isArray(list)) return "";
  for (const item of list) {
    const name = clean(item?.name);
    if (name) return name;
  }
  return "";
}

function hasVideo(videos) {
  return (Array.isArray(videos) ? videos : []).some((item) => {
    const url = typeof item === "string" ? item : item?.url;
    return typeof url === "string" && url.trim();
  });
}

function fileKind(row) {
  const mime = String(row.mime || "");
  const name = uploadName(row.original_name);
  if (mime.startsWith("image/")) return { kind: "image", name };
  if (isAudioUpload({ mime, originalname: row.original_name })) return { kind: "audio", name };
  return { kind: "file", name };
}

export function shareContent(row, files = []) {
  const links = row?.links && typeof row.links === "object" && !Array.isArray(row.links) ? row.links : {};
  const stored = files.map(fileKind);
  const audioName = stored.find((file) => file.kind === "audio")?.name || linkName(links.audio);
  const fileName = stored.find((file) => file.kind === "file")?.name || linkName(links.attachments);
  const image = stored.some((file) => file.kind === "image");
  return {
    body: clean(row?.body),
    video: hasVideo(row?.videos),
    audioName: clean(audioName),
    fileName: clean(fileName),
    image,
  };
}

function qrRects(url) {
  const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const pixel = Math.max(4, Math.min(QR_PIXEL, Math.floor(QR_TARGET / (n + QR_QUIET * 2))));
  const parts = [];
  let dark = 0;
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      if (!qr.modules.get(row, col)) continue;
      dark += 1;
      const left = (col + QR_QUIET) * pixel;
      const top = (row + QR_QUIET) * pixel;
      parts.push(`<rect x="${left}" y="${top}" width="${pixel}" height="${pixel}" fill="#050505"/>`);
    }
  }
  return { svg: parts.join(""), size: (n + QR_QUIET * 2) * pixel, dark, pixel };
}

function hold(x, y, label, video) {
  const cx = x + INNER / 2 - (video ? 36 : 0);
  const cy = y + HOLD / 2;
  const play = video
    ? `<circle cx="${cx}" cy="${cy}" r="26" fill="none" stroke="#65676B" stroke-width="3"/><path d="M${cx - 8} ${cy - 12} L${cx + 14} ${cy} L${cx - 8} ${cy + 12} Z" fill="#65676B"/>`
    : "";
  const textX = video ? cx + 48 : x + INNER / 2;
  const anchor = video ? "start" : "middle";
  return `<rect x="${x}" y="${y}" width="${INNER}" height="${HOLD}" rx="12" fill="#F0F2F5"/>${play}<text x="${textX}" y="${cy + 10}" text-anchor="${anchor}" font-family="${FONT}" font-size="28" fill="#050505">${xml(label)}</text>`;
}

function textLine(value, x, baseline, size, fill, anchor = "start", weight = "") {
  const bold = weight ? ` font-weight="${weight}"` : "";
  return `<text x="${x}" y="${baseline}" text-anchor="${anchor}" font-family="${FONT}" font-size="${size}" fill="${fill}"${bold}>${xml(value)}</text>`;
}

export function formatPosted(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${pick("year")}年${pick("month")}月${pick("day")}日 ${pick("hour")}:${pick("minute")}`;
}

function postedIso(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function shareHead(row) {
  const price = Number(row?.price);
  const actor = ACTOR_LABEL[row?.actor] ? row.actor : "";
  return {
    author: clean(row?.display_name) || "用户",
    posted: postedIso(row?.created_at),
    actor,
    category: clean(row?.category),
    price: Number.isFinite(price) ? Math.max(0, Math.trunc(price)) : 0,
  };
}

export function shareMetaKey(card) {
  const head = card?.head || {};
  const site = shareSite();
  // 键里有三段会变的东西：这张海报的画法（画质、宽度、页脚排布、贴图方式）、排版包自己的版本
  // （改规则只抬那边的号）、以及落进图里的文字与头像。任一段变了，旧图就不再命中。
  const payload = [`${POSTER_VERSION}.${LAYOUT_VERSION}`, site.page, site.name, site.line, head.author || "", head.posted || "", head.actor || "", head.category || "", String(head.price ?? 0), head.avatarKey || ""].join("\u0001");
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function priceBox(label) {
  const size = 36;
  const coin = 34;
  const gap = 12;
  const padX = 22;
  const textW = Math.ceil(textWidth(label, size, "600"));
  return { size, coin, gap, padX, width: padX + coin + gap + textW + padX, height: 72, label };
}

// 0 元不画角标：和卡片一致，免费帖的价格没有信息量。
export function priceLabel(price) {
  const value = Number(price);
  if (!Number.isFinite(value)) return "";
  const points = Math.trunc(value);
  return points > 0 ? String(points) : "";
}

function drawPrice(box, x, y) {
  const coinCx = x + box.padX + box.coin / 2;
  const coinCy = y + box.height / 2;
  const radius = box.coin / 2;
  const textX = x + box.padX + box.coin + box.gap;
  const baseline = coinCy + Math.round(box.size * 0.35);
  return `<rect x="${x}" y="${y}" width="${box.width}" height="${box.height}" rx="${box.height / 2}" fill="#F0F2F5"/><circle cx="${coinCx}" cy="${coinCy}" r="${radius}" fill="none" stroke="#0866FF" stroke-width="3"/><circle cx="${coinCx}" cy="${coinCy}" r="${(radius * 0.62).toFixed(2)}" fill="none" stroke="#0866FF" stroke-width="2.5"/><line x1="${coinCx}" y1="${(coinCy - radius * 0.42).toFixed(2)}" x2="${coinCx}" y2="${(coinCy + radius * 0.42).toFixed(2)}" stroke="#0866FF" stroke-width="2.5" stroke-linecap="round"/>${textLine(box.label, textX, baseline, box.size, "#050505", "start", "600")}`;
}

function layoutHead(head) {
  const author = clean(head?.author) || "用户";
  const actor = ACTOR_LABEL[head?.actor] || "";
  const posted = formatPosted(head?.posted);
  const category = clean(head?.category);
  const label = priceLabel(head?.price);
  const box = label ? priceBox(label) : null;
  const textX = PAD + HEAD_AVATAR + HEAD_TEXT_GAP;
  const textMax = Math.max(160, WIDTH - PAD - (box ? box.width + 24 : 0) - textX);
  const actorWidth = actor ? textWidth(actor, HEAD_META) : 0;
  const actorGap = actor ? 20 : 0;
  const name = fitLine(author, Math.max(80, textMax - actorWidth - actorGap), HEAD_NAME, "600");
  const meta = fitLine([posted, category].filter(Boolean).join(" · "), textMax, HEAD_META);
  const textBlock = HEAD_NAME + (meta ? HEAD_LINE_GAP + HEAD_META : 0);
  const block = Math.max(HEAD_AVATAR, textBlock);
  const top = HEAD_TOP;
  const avatarY = top + (block - HEAD_AVATAR) / 2;
  const blockTop = top + (block - textBlock) / 2;
  const nameY = blockTop + HEAD_NAME;
  const metaY = nameY + HEAD_LINE_GAP + HEAD_META;
  const pillY = box ? Math.round(top + block / 2 - box.height / 2) : 0;
  const letter = [...name.replace(/…$/, "")][0] || "用";
  const avatarCy = avatarY + HEAD_AVATAR / 2;
  const parts = [
    `<circle cx="${PAD + HEAD_AVATAR / 2}" cy="${avatarCy}" r="${HEAD_AVATAR / 2}" fill="#E4E6EB"/>`,
    `<text x="${PAD + HEAD_AVATAR / 2}" y="${avatarCy}" text-anchor="middle" dominant-baseline="central" font-family="${FONT}" font-size="40" font-weight="600" fill="#050505">${xml(letter)}</text>`,
    textLine(name, textX, nameY, HEAD_NAME, "#050505", "start", "600"),
  ];
  if (actor) parts.push(textLine(actor, textX + textWidth(name, HEAD_NAME, "600") + actorGap, nameY - 4, HEAD_META, "#65676B"));
  if (meta) parts.push(textLine(meta, textX, metaY, HEAD_META, "#65676B"));
  if (box) parts.push(drawPrice(box, WIDTH - PAD - box.width, pillY));
  const bottom = top + block + HEAD_BOTTOM;
  parts.push(`<line x1="${PAD}" y1="${bottom}" x2="${WIDTH - PAD}" y2="${bottom}" stroke="#E4E6EB" stroke-width="2"/>`);
  return { svg: parts.join("\n  "), contentTop: bottom + GAP, avatarBox: { x: PAD, y: avatarY, size: HEAD_AVATAR } };
}

function fitLine(text, width, size, weight = "") {
  const value = clean(text);
  if (!value) return value;
  return textWidth(value, size, weight) <= width ? value : ellipsizeText(value, width, size, weight);
}

// 单图预览走的是同一张排版表：把这张图当成「一组只有一张的图」，框就由求解器给。
// 自己再乘一次比例、再夹一次上下限，等于养第二套算法——两张图的边界一旦对不齐，
// 同一张照片会在「有尺寸」和「没尺寸」两条路上画出不同的高度。
async function fittedPreview(preview) {
  if (!preview) return null;
  try {
    // 这里不能直接读 sharp 的 metadata：它给的是旋转前的宽高，而下面贴图时会 .rotate()。
    // 用入库时同一个读取口径，EXIF 竖拍照片的框才和拼图那条路一致。
    const meta = await readImageMeta(preview);
    if (!meta) return null;
    const plan = posterPhotos([{ file: preview, width: meta.width, height: meta.height }], 0);
    const box = plan?.boxes?.[0];
    if (!box || box.height < 1) return null;
    return { x: box.x, width: box.width, height: box.height, vertical: box.vertical };
  } catch {
    return null;
  }
}

// 一组图按卡片的拼法排进海报：切几行、每格多宽多高全由 @knot/photo-layout 给出，
// 这里只把「内容宽的倍数」乘成像素并加上左边距。返回的是坐标表，贴图在 renderSharePoster 里做。
export function posterPhotos(photos, top = 0) {
  const usable = (photos || []).filter((photo) => photo && photo.file && photo.width > 0 && photo.height > 0);
  if (!usable.length) return null;
  const plan = planPhotoBoxes(usable, { width: INNER, x: PAD, y: top, rules: POSTER_RULES });
  return { ...plan, top };
}

// 行尾省略号也占宽度：先按剩余宽度收字，再把 … 放进最后一个样式段。
// 只把 … 直接拼到原行尾，最后一行会多吃掉一格，右边距就和别处不一致了。
function segmentWeight(segment, weight) {
  return segment.bold || weight ? "600" : "";
}

function ellipsizeSegments(segments, width, size, weight = "") {
  // 省略号按粗体预留，宁可少留一个字，也不让 … 越出内容区。
  const ellipsis = textWidth("…", size, "600");
  const budget = Math.max(0, width - ellipsis);
  const kept = [];
  let used = 0;
  for (const segment of segments) {
    const style = segmentWeight(segment, weight);
    const text = String(segment.text || "");
    if (!text) {
      kept.push({ ...segment });
      continue;
    }
    const full = textWidth(text, size, style);
    if (used + full <= budget) {
      kept.push({ ...segment });
      used += full;
      continue;
    }
    let cut = text;
    while (cut && used + textWidth(cut, size, style) > budget) cut = [...cut].slice(0, -1).join("");
    if (cut) kept.push({ ...segment, text: cut });
    break;
  }
  const tail = kept.filter((segment) => segment.text).pop();
  if (!tail) return [{ ...(segments[0] || {}), text: "…" }];
  tail.text = `${tail.text.replace(/…$/, "")}…`;
  return kept;
}

// 高度到顶时，把最后一段有字的正文收尾成省略号；width 是这一行真正可用的宽度（缩进已扣）。
function ellipsizeLine(line, width = INNER) {
  if (line.rule) return false;
  const room = Math.max(1, width - (line.indent || 0));
  const size = line.size || BODY_SIZE;
  if (line.segments?.length) {
    line.segments = ellipsizeSegments(line.segments, room, size, line.weight);
    return true;
  }
  if (typeof line.text === "string" && line.text) {
    line.text = ellipsizeText(line.text, room, size, line.weight);
    return true;
  }
  return false;
}

// 只保留放得进 room 的行。放不下的部分不画，最后一句话用省略号收住。
function fitTexts(texts, room) {
  const kept = [];
  let used = 0;
  for (const line of texts) {
    if (used + line.leading > room) {
      for (let index = kept.length - 1; index >= 0; index -= 1) {
        if (ellipsizeLine(kept[index])) break;
      }
      return kept;
    }
    kept.push(line);
    used += line.leading;
  }
  return kept;
}

function posterPr(content, site) {
  const qr = qrRects(shareUrl(content?.id, site));
  const qrBox = qr.size + FOOT_PLATE * 2;
  // 两栏之间留一个 GAP，文字不会贴到二维码的白底上。
  const room = Math.max(160, WIDTH - PAD * 2 - qrBox - GAP);
  const name = fitLine(site.name, room, FOOT_NAME, "600");
  const host = fitLine(site.host, room, FOOT_HOST);
  const lines = wrapText(site.line, room, FOOT_LINE, 2).filter((line) => line);
  const textHeight = FOOT_NAME + lines.length * FOOT_LINE_LEADING + FOOT_HOST + FOOT_GAP * 2;
  return { qr, name, host, lines, textHeight, height: Math.max(textHeight, qrBox) + FOOT_PAD * 2 };
}

// 页脚两栏：左边站名、标语、地址，右边二维码。文字块垂直居中，二维码贴右内边距。
function footerPanel(pr, top) {
  const parts = [];
  let cursor = top + Math.round((pr.height - pr.textHeight) / 2) + FOOT_NAME;
  parts.push(textLine(pr.name, PAD, cursor, FOOT_NAME, "#0866FF", "start", "600"));
  cursor += FOOT_GAP;
  for (const line of pr.lines) {
    cursor += FOOT_LINE;
    parts.push(textLine(line, PAD, cursor, FOOT_LINE, "#050505", "start"));
    cursor += FOOT_LINE_LEADING - FOOT_LINE;
  }
  cursor += FOOT_GAP + FOOT_HOST;
  parts.push(textLine(pr.host, PAD, cursor, FOOT_HOST, "#1C1E21", "start"));
  return {
    parts,
    qrX: WIDTH - PAD - FOOT_PLATE - pr.qr.size,
    qrY: top + Math.round((pr.height - pr.qr.size) / 2),
  };
}

export async function buildSharePoster(content, site = shareSite()) {
  const body = clean(content.body);
  const audioName = clean(content.audioName);
  const fileName = clean(content.fileName);
  const texts = [];
  if (body) {
    if (isMarkdown(body)) {
      texts.push(...markdownTexts(body, INNER));
    } else {
      for (const line of wrapText(body, INNER, BODY_SIZE)) {
        texts.push({ text: line, size: BODY_SIZE, leading: BODY_LEADING, fill: "#050505" });
      }
    }
    if (audioName) texts.push({ text: fitLine(audioName, INNER, NAME_SIZE), size: NAME_SIZE, leading: NAME_LEADING, fill: "#65676B" });
    if (fileName) texts.push({ text: fitLine(fileName, INNER, NAME_SIZE), size: NAME_SIZE, leading: NAME_LEADING, fill: "#65676B" });
  } else {
    const stand = audioName || fileName;
    if (stand) texts.push({ text: fitLine(stand, INNER, BODY_SIZE), size: BODY_SIZE, leading: BODY_LEADING, fill: "#050505" });
  }

  const pr = posterPr(content, site);
  const head = layoutHead(content.head);
  const gallery = posterPhotos(content.photos, head.contentTop);
  // 有拼图就不再退回单图；没有尺寸的老记录才用预览图或「图片」占位。
  const previewBox = gallery ? null : await fittedPreview(content.preview);
  const imageHold = Boolean(content.image) && !gallery && !previewBox;

  let y = head.contentTop;
  const parts = [head.svg];
  let placedPreview = previewBox;
  if (gallery) {
    // 先铺一层底色：某张图贴失败时是一块灰，不是白洞。
    for (const box of gallery.boxes) {
      parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="${PHOTO_BACKDROP}"/>`);
    }
    y += gallery.height + GAP;
  }
  if (placedPreview) {
    placedPreview = { ...placedPreview, y };
    // 退回单图时也垫同一块底色：贴图失败或图片带透明区，看到的都是卡片上的那块灰。
    parts.push(`<rect x="${placedPreview.x}" y="${placedPreview.y}" width="${placedPreview.width}" height="${placedPreview.height}" fill="${PHOTO_BACKDROP}"/>`);
    y += placedPreview.height + GAP;
  }
  let videoY = 0;
  if (content.video) {
    videoY = y;
    parts.push(hold(PAD, y, LABEL.video, true));
    y += HOLD + GAP;
  }
  let imageY = 0;
  if (imageHold) {
    imageY = y;
    parts.push(hold(PAD, y, LABEL.image, false));
    y += HOLD + GAP;
  }
  // 正文按剩余高度收口，保证整张图不超过 MAX_HEIGHT。
  const fitted = fitTexts(texts, MAX_HEIGHT - GAP - pr.height - y);
  for (const line of fitted) {
    if (line.rule) {
      parts.push(`<line x1="${PAD}" y1="${y + Math.round(line.leading / 2)}" x2="${WIDTH - PAD}" y2="${y + Math.round(line.leading / 2)}" stroke="#E4E6EB" stroke-width="2"/>`);
      y += line.leading;
      continue;
    }
    const hasText = Boolean(line.text) || Boolean(line.segments && line.segments.some((segment) => segment.text));
    if (!hasText) {
      y += line.leading;
      continue;
    }
    if (line.quote) parts.push(`<rect x="${PAD}" y="${y + 4}" width="4" height="${line.size + 6}" rx="2" fill="#E4E6EB"/>`);
    if (line.code) parts.push(`<rect x="${PAD - 10}" y="${y + 2}" width="${INNER + 20}" height="${line.leading - 4}" rx="6" fill="#F0F2F5"/>`);
    if (line.prefix) parts.push(textLine(line.prefix, PAD + 8, y + line.size, line.size, line.fill, "start", "600"));
    const textX = line.indent ? PAD + line.indent : PAD;
    parts.push(renderRichLine(line, textX, y + line.size));
    y += line.leading;
  }
  const contentBottom = y;
  const footerTop = contentBottom + GAP;
  const height = footerTop + pr.height;
  const foot = footerPanel(pr, footerTop);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}">
  <rect width="${WIDTH}" height="${height}" fill="#FFFFFF"/>
  ${parts.join("\n  ")}
  <rect x="0" y="${footerTop}" width="${WIDTH}" height="${pr.height}" fill="#F0F2F5"/>
  ${foot.parts.join("\n  ")}
  <rect x="${foot.qrX - FOOT_PLATE}" y="${foot.qrY - FOOT_PLATE}" width="${pr.qr.size + FOOT_PLATE * 2}" height="${pr.qr.size + FOOT_PLATE * 2}" rx="20" fill="#FFFFFF"/>
  <g transform="translate(${foot.qrX} ${foot.qrY})">${pr.qr.svg}</g>
</svg>`;
  return {
    width: WIDTH,
    height,
    svg,
    previewBox: placedPreview,
    photoBoxes: gallery ? gallery.boxes : [],
    photoTop: gallery ? gallery.top : 0,
    photoHeight: gallery ? gallery.height : 0,
    avatarBox: head.avatarBox,
    qr: { x: foot.qrX, y: foot.qrY, size: pr.qr.size, dark: pr.qr.dark, pixel: pr.qr.pixel },
    footerTop,
    contentTop: head.contentTop,
    contentBottom,
    videoY,
    imageY,
  };
}

async function roundAvatar(input, size) {
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#FFFFFF"/></svg>`
  );
  return sharp(input)
    .rotate()
    .resize(size, size, { fit: "cover" })
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

// 一格图：按算法给的框 cover 进去。竖着裁的保留顶部（长截图的开头有标题），横着裁的居中。
// 拼图和退回单图都走这一份：透明区垫成卡片底色，读不出来的图留底色而不是让整张图失败。
async function photoLayer(file, box) {
  try {
    return await sharp(file)
      .rotate()
      .resize(box.width, box.height, { fit: "cover", position: box.vertical ? "top" : "centre" })
      .flatten({ background: PHOTO_BACKDROP })
      .jpeg({ quality: PHOTO_LAYER_QUALITY })
      .toBuffer();
  } catch {
    // 一张读不出来的图不该让整张分享图生不出来：那块留底色，其余照画。
    return null;
  }
}

export async function renderSharePoster(content) {
  const layout = await buildSharePoster(content);
  const composites = [];
  for (const box of layout.photoBoxes || []) {
    const layer = await photoLayer(box.photo.file, box);
    if (layer) composites.push({ input: layer, left: box.x, top: box.y });
  }
  if (layout.previewBox && content.preview) {
    const box = layout.previewBox;
    // 框由排版表给出，裁的方向也由它给：竖着裁的保留开头，横着裁的居中。
    const layer = await photoLayer(content.preview, box);
    if (layer) composites.push({ input: layer, left: box.x, top: box.y });
  }
  if (layout.avatarBox && content.avatarPath) {
    try {
      const layer = await roundAvatar(content.avatarPath, layout.avatarBox.size);
      composites.push({ input: layer, left: layout.avatarBox.x, top: layout.avatarBox.y });
    } catch {
      /* keep the letter fallback already drawn in the SVG */
    }
  }
  let image = sharp(Buffer.from(layout.svg));
  if (composites.length) image = image.composite(composites);
  return image.jpeg({ quality: POSTER_JPEG_QUALITY, progressive: true, mozjpeg: true }).toBuffer();
}

export function sharePosterPath(uploadDir, intelId, contentHash, metaKey) {
  const id = String(intelId || "").toLowerCase();
  const hash = String(contentHash || "").toLowerCase();
  const meta = String(metaKey || "").toLowerCase();
  if (!ID.test(id) || !HASH.test(hash) || !META_KEY.test(meta)) {
    const error = new Error("not_found");
    error.code = "not_found";
    throw error;
  }
  return path.join(derivedDir(uploadDir, "shares"), id, `${hash}-${meta}-poster.jpg`);
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function dropStale(dest) {
  const dir = path.dirname(dest);
  const keep = path.basename(dest);
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name !== keep && name.endsWith(".jpg"))
      .map((name) => rm(path.join(dir, name), { force: true }))
  );
}

async function writeOnce(dest, card, render) {
  if (await fileExists(dest)) return dest;
  const jpeg = await render(card);
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, jpeg);
    await rename(tmp, dest);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  await dropStale(dest);
  return dest;
}

export function storeSharePoster(uploadDir, card, render = renderSharePoster) {
  const dest = sharePosterPath(uploadDir, card.id, card.contentHash, shareMetaKey(card));
  const pending = inflight.get(dest);
  if (pending) return pending;
  const job = writeOnce(dest, card, render);
  inflight.set(dest, job);
  // 这里必须接住 job 的拒绝：finally 派生出的 promise 没人等，Node 会当成未处理拒绝退出进程。
  job
    .catch(() => {})
    .finally(() => {
      if (inflight.get(dest) === job) inflight.delete(dest);
    });
  return job;
}

function shareable(row) {
  if (!row) return false;
  if (row.kind !== "post" && row.kind !== "fastpost") return false;
  if (row.is_public === false) return false;
  if (row.verdict !== "pending" && row.verdict !== "passed") return false;
  return ID.test(String(row.id || "")) && HASH.test(String(row.content_hash || ""));
}

export async function loadShareCard(pool, intelId, uploadDir) {
  if (!ID.test(String(intelId || ""))) return null;
  // 分享图跟着帖子走，不跟着版本走：拿到旧地址也画最新那一版。
  const { rows } = await pool.query(
    `SELECT i.id, i.body, i.videos, i.links, i.content_hash, i.kind, i.is_public, i.verdict,
            i.actor, i.category, i.price, i.created_at, i.account_id, u.display_name, u.avatar_upload_id, u.role, u.agent_type
     FROM intel i
     LEFT JOIN accounts u ON u.id = i.account_id
     WHERE COALESCE(i.origin_id, i.id) = (SELECT COALESCE(origin_id, id) FROM intel WHERE id = $1::uuid)
       AND i.kind IN ('post', 'fastpost') AND i.is_public AND ${visibleVerdict("i.verdict")}
     ORDER BY i.version DESC
     LIMIT 1`,
    [intelId]
  );
  const row = rows[0];
  if (!shareable(row)) return null;
  const { rows: files } = await pool.query(
    `SELECT u.mime, u.original_name, u.storage_name, u.width, u.height
     FROM intel_files f
     JOIN uploads u ON u.id = f.upload_id
     WHERE f.intel_id = $1
     ORDER BY f.sort_order ASC, f.upload_id ASC`,
    [row.id]
  );
  // 分享图拼所有图片，不只是第一张：拼法就是卡片上的拼法（同一份 @knot/photo-layout）。
  // 少一张尺寸就退回单图：按 4:3 硬猜会把拼图裁歪，不如给一张完整的原图。
  const images = [];
  for (const file of files) {
    if (images.length >= MAX_IMAGES) break;
    if (!String(file.mime || "").startsWith("image/")) continue;
    const path = readableBlobPath(uploadDir, file.storage_name);
    if (!(await fileExists(path))) continue;
    images.push({ file: path, width: Number(file.width) || 0, height: Number(file.height) || 0 });
  }
  const sized = images.length > 0 && images.every((photo) => photo.width > 0 && photo.height > 0);
  const photos = sized ? images : [];
  const preview = sized ? "" : images[0]?.file || "";
  const head = shareHead(row);
  let avatarPath = "";
  let avatarKey = "";
  if (row.avatar_upload_id) {
    const { rows: avatars } = await pool.query(
      `SELECT storage_name FROM uploads WHERE id = $1`,
      [row.avatar_upload_id]
    );
    const storage = avatars[0]?.storage_name;
    if (storage) {
      avatarPath = readableBlobPath(uploadDir, storage);
      avatarKey = `upload:${String(row.avatar_upload_id).toLowerCase()}`;
    }
  } else if (row.account_id) {
    if (row.role === "agent") {
      const slug = agentAvatarSlug(row);
      avatarPath = agentAvatarPath(slug);
      avatarKey = `agent:${slug}`;
    } else {
      const index = defaultAvatarIndex(row.account_id);
      avatarPath = defaultAvatarPath(index);
      avatarKey = `default:${index}`;
    }
  }
  head.avatarKey = avatarKey;
  return {
    id: String(row.id).toLowerCase(),
    contentHash: String(row.content_hash).toLowerCase(),
    photos,
    preview,
    avatarPath,
    head,
    ...shareContent(row, files),
  };
}

export async function ensureSharePoster(pool, intelId, uploadDir = loadBootstrapConfig().uploadDir, render = renderSharePoster) {
  const card = await loadShareCard(pool, intelId, uploadDir);
  if (!card) return null;
  return storeSharePoster(uploadDir, card, render);
}

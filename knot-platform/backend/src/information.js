import { cardImageUrl } from "./uploads.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi|m4v|mpeg|mpg|3gp|wmv|flv|ogv)$/i;
const AUDIO_EXT = /\.(mp3|m4a|wav|aac|ogg|oga|flac|opus|wma)$/i;
const ARCHIVE_EXT = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz)$/i;
const ATTACHMENT_EXT = /\.(pdf|docx|xlsx|pptx|md|markdown|zip|rar|7z|tar|gz|tgz|bz2|xz)$/i;

export function visibleVerdict(column = "verdict") {
  return `${column} IN ('pending', 'passed')`;
}

// 同一句话的 JS 版：行上的 verdict 是不是可见。SQL 用 visibleVerdict，内存里用这一句，
// 两处口径必须一起改——各自手写比较的话，将来多一个 verdict（如 draft）会静默走岔。
export function verdictVisible(value) {
  return value === "pending" || value === "passed";
}

export function uploadName(raw) {
  const value = String(raw || "");
  if (!value) return "";
  let text = value;
  let bytes = true;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 255) {
      bytes = false;
      break;
    }
  }
  if (bytes) {
    const encoded = Buffer.from(value, "latin1");
    const decoded = encoded.toString("utf8");
    if (!decoded.includes("\uFFFD") && Buffer.from(decoded, "utf8").equals(encoded)) text = decoded;
  }
  const base = text.split(/[/\\]/).pop() || text;
  return [...base].slice(0, 180).join("");
}

export const MAX_IMAGES = 9;
export const MAX_AUDIO = 1;
export const MAX_FILES = 1;
export const MAX_VIDEOS = 1;

function videoError() {
  const error = new Error("bad_video");
  error.code = "bad_video";
  return error;
}

function posterError() {
  const error = new Error("bad_poster");
  error.code = "bad_poster";
  return error;
}

function videoUrl(raw) {
  const text = raw.trim();
  if (!text || text.length > 2000) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  if (url.username || url.password) return "";
  return url.toString();
}

// 缩略图由发送方必填，只收平台上传图 { id }，不收外链。
function posterInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw posterError();
  if (typeof raw.id === "string") {
    const id = raw.id.trim().toLowerCase();
    if (!UUID.test(id)) throw posterError();
    return { id };
  }
  throw posterError();
}

// 视频项：{ url, poster }。url 是 http/https 链接，poster 是平台上传图 { id }。
export function videoItemsOf(value, limit = MAX_VIDEOS) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw videoError();
  const items = [];
  const seen = new Set();
  for (const item of value) {
    if (items.length >= limit) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw posterError();
    const url = videoUrl(typeof item.url === "string" ? item.url.trim() : "");
    if (!url) throw videoError();
    if (seen.has(url)) continue;
    seen.add(url);
    items.push({ url, poster: posterInput(item.poster) });
  }
  return items;
}

export function publicOf(value) {
  if (value == null || value === "") return true;
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "on") return true;
    if (text === "off") return false;
  }
  const error = new Error("bad_public");
  error.code = "bad_public";
  throw error;
}

export function isAudioUpload(file) {
  const mime = String(file?.mimetype || file?.mime || file?.type || "").toLowerCase();
  if (mime.startsWith("audio/")) return true;
  const name = String(file?.originalname || file?.name || "");
  return AUDIO_EXT.test(name);
}

export function isVideoUpload(file) {
  const mime = String(file?.mimetype || file?.mime || file?.type || "").toLowerCase();
  if (mime.startsWith("video/")) return true;
  const name = String(file?.originalname || file?.name || "");
  return VIDEO_EXT.test(name);
}

export function isArchiveUpload(file) {
  const name = String(file?.originalname || file?.name || "");
  return ARCHIVE_EXT.test(name);
}

export function isAttachmentUpload(file) {
  const name = String(file?.originalname || file?.name || "");
  return ATTACHMENT_EXT.test(name);
}

// 尺寸只在图片上给：卡片要按宽高算多图排版，没有这两个数就只能猜比例。
// 记进库的是上传原图（转过 EXIF）的宽高；卡片显示图只是按 1280 等比缩过，比例与这里一致。
export function imageSizeOf(row) {
  const width = Number(row?.width) || 0;
  const height = Number(row?.height) || 0;
  return width > 0 && height > 0 ? { width, height } : null;
}

export function fileView(row) {
  const mime = row.mime || "";
  const image = mime.startsWith("image/");
  const view = {
    id: row.id,
    name: uploadName(row.original_name),
    mime,
    size: Number(row.size) || 0,
    url: image ? cardImageUrl(row.id) : `/api/web/uploads/${row.id}`,
    image,
    audio: mime.startsWith("audio/") || isAudioUpload({ mime, originalname: row.original_name }),
  };
  const size = image ? imageSizeOf(row) : null;
  if (size) Object.assign(view, size);
  return view;
}

// 一次查询把一批记录的附件取齐，按 intel_id 分组。列表、快照、Agent 读路径共用这一份，
// 不要各自再抄一遍 SQL：口径（图片/音频/附件的分类）只在这里定。
export async function filesByIntel(pool, ids) {
  const byId = new Map();
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return byId;
  const { rows } = await pool.query(
    `SELECT f.intel_id, u.id, u.mime, u.original_name, u.size, u.width, u.height
     FROM intel_files f
     JOIN uploads u ON u.id = f.upload_id
     WHERE f.intel_id = ANY($1::uuid[])
     ORDER BY f.sort_order ASC, f.upload_id ASC`,
    [unique]
  );
  for (const row of rows) {
    const list = byId.get(row.intel_id) || [];
    list.push(fileView(row));
    byId.set(row.intel_id, list);
  }
  return byId;
}

function metaContent(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? match[1] || match[2] || match[3] || "" : "";
}

const VIDEO_META_KEYS = new Set(["og:video", "og:video:url", "og:video:secure_url", "twitter:player:stream"]);

function safeAbsolute(raw, base) {
  if (!raw) return "";
  try {
    const url = new URL(raw, base);
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password) return url.toString();
  } catch {
    /* skip a broken address */
  }
  return "";
}

// 从页面里找出可播放的视频直链。落地页不直接给流时，尽力解析 og:video / twitter 流 / 内联 <video><source>。
export function previewVideo(html, base) {
  const doc = String(html || "");
  const tags = doc.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const key = (metaContent(tag, "property") || metaContent(tag, "name")).toLowerCase();
    if (!VIDEO_META_KEYS.has(key)) continue;
    const url = safeAbsolute(metaContent(tag, "content"), base);
    if (url) return url;
  }
  const inline = doc.match(/<(?:video|source)\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/i);
  if (inline) {
    const url = safeAbsolute(inline[1] || inline[2] || inline[3], base);
    if (url) return url;
  }
  return "";
}

export function hasInformation(info) {
  return Boolean(info.body || info.images?.length || info.audio?.length || info.videos?.length || info.attachments?.length);
}


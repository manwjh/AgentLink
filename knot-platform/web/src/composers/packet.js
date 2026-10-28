import { computed, onUnmounted, ref } from "vue";
import { HEIC_NAME, isHeicFile, looksLikeImage } from "../imageFile.js";
import { t } from "../i18n/index.js";
import { SHRINK_DECODE_EDGE, SHRINK_MAX_EDGE, fitEdge, imageMaxBytes, shrinkImage } from "../imageScale.js";
import { PACKET_LIMITS } from "../packet.js";

export const AUDIO_MAX = 8 * 1024 * 1024;
export const FILE_MAX = 50 * 1024 * 1024;
// 数量上限只有 packet.js 一份，这里 re-export 给组件用，避免两处各写一个 9。
export const MAX_IMAGES = PACKET_LIMITS.images;
export const MAX_FILES = PACKET_LIMITS.files;

const VIDEO_FILE = /^video\/|\.(mp4|webm|mov|mkv|avi|m4v|mpeg|mpg|3gp|wmv|flv|ogv)$/i;
const AUDIO_FILE = /^audio\/|\.(mp3|m4a|wav|aac|ogg|oga|flac|opus|wma)$/i;
const ATTACHMENT_FILE = /\.(pdf|docx|xlsx|pptx|md|markdown|zip|rar|7z|tar|gz|tgz|bz2|xz)$/i;
export const ATTACHMENT_ACCEPT = ".pdf,.docx,.xlsx,.pptx,.md,.markdown,.zip,.rar,.7z,.tar,.gz,.tgz,.bz2,.xz";

export function isVideoFile(file) {
  return VIDEO_FILE.test(`${file?.type || ""} ${file?.name || ""}`);
}

export function isAudioFile(file) {
  return AUDIO_FILE.test(`${file?.type || ""} ${file?.name || ""}`);
}

export function isAttachmentFile(file) {
  return ATTACHMENT_FILE.test(String(file?.name || ""));
}

// iOS 的相机/相册可能交出 HEIC/HEIF：后端只收 JPEG、PNG、WebP、GIF、AVIF，而服务端的
// sharp 没编进 HEVC 解码器（libde265），无法在服务端转码，所以只能在浏览器端转成 JPEG。
// 两条路：Safari/iOS 原生能解 HEIC，快、无依赖；Chrome/Firefox 解不了，落下 WASM 解码器
// （heic2any，动态 import，只在这条分支才拉那份 1.3MB 的 chunk）。都失败就退回原文件，
// 交给后端按 bad_mime 拒绝，至少不会把一个「看起来传上去了」的坏文件发出去。
function jpegFileFromBlob(blob, originalName) {
  const name = String(originalName || "image").replace(HEIC_NAME, "") + ".jpg";
  return new File([blob], name, { type: "image/jpeg" });
}

async function decodeHeicNatively(file) {
  // Safari 能直接解 HEIC：让 createImageBitmap 解文件本身，宽高已按 EXIF 摆正，
  // 也不像 <img> 那样在 DOM 里再存一份全尺寸位图（48MP 就是几百 MB）。
  if (typeof createImageBitmap === "function") {
    let bitmap = null;
    try {
      // 先按解码预算要位图：这一步只决定位图多大，最终仍按长边 2048 落盘。
      // 有的实现不认这些选项，认不出就退回不带宽高的那一次。
      try {
        bitmap = await createImageBitmap(file, { resizeWidth: SHRINK_DECODE_EDGE, resizeQuality: "high" });
      } catch {
        bitmap = await createImageBitmap(file);
      }
      return await encodeJpeg(bitmap, bitmap.width, bitmap.height);
    } catch {
      // 解不了或画不下，退回 <img>，再不行交给 WASM。
    } finally {
      try {
        bitmap?.close?.();
      } catch {
        // 关不掉就交给 GC。
      }
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("heic_decode_failed"));
      el.src = url;
    });
    return await encodeJpeg(img, img.naturalWidth || img.width || 0, img.naturalHeight || img.height || 0);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 转换时就按长边收一次：48MP 直接画到同尺寸 canvas 会超出部分移动浏览器的画布上限
// （toBlob 回 null）；收完也让后面的体积判断不必再压第二遍。
function encodeJpeg(source, width, height, quality = 0.92) {
  if (!width || !height) throw new Error("heic_decode_failed");
  const size = fitEdge(width, height, SHRINK_MAX_EDGE);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  // 透明区转 JPEG 会压成纯黑，先垫白底。
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.drawImage(source, 0, 0, size.width, size.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      canvas.width = 0;
      canvas.height = 0;
      if (blob) resolve(blob);
      else reject(new Error("heic_encode_failed"));
    }, "image/jpeg", quality);
  });
}

async function decodeHeicWasm(file) {
  const mod = await import("heic2any");
  const heic2any = typeof mod.default === "function" ? mod.default : mod.default?.default || mod;
  const out = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
  const blob = Array.isArray(out) ? out[0] : out;
  if (!blob || !blob.size) throw new Error("heic_decode_failed");
  return blob;
}

export async function normalizeImageFile(file) {
  if (!file || typeof file !== "object") return file;
  if (!isHeicFile(file)) return file;
  for (const decode of [decodeHeicNatively, decodeHeicWasm]) {
    try {
      const blob = await decode(file);
      if (blob && blob.size > 0) return jpegFileFromBlob(blob, file.name);
    } catch {
      // 换下一种解码方式。
    }
  }
  return file;
}

export function nameMark(user) {
  const name = String(user?.displayName || "").trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    const latin = parts.every((part) => /^[A-Za-z]/.test(part));
    if (latin && parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    if (latin) return parts[0].slice(0, 1).toUpperCase();
    const chars = Array.from(name.replace(/\s+/g, ""));
    return chars.slice(-2).join("");
  }
  const email = String(user?.email || "").trim();
  return email ? email.slice(0, 1).toUpperCase() : "";
}

// code 没有对应文案时用 fallback：同一个请求失败，不同位置想说的话不一样
// （例如取管理后台地址失败要说「管理后台」而不是泛泛的「请求失败」）。
export function errorText(code, policy = {}, fallback = "error.request_failed") {
  const key = `error.${code}`;
  if (code === "bad_price") {
    return t(key, { min: policy.priceMin ?? 0, max: policy.priceMax ?? 100 });
  }
  const message = t(key);
  return message === key ? t(fallback) : message;
}

export function requireSession(user) {
  if (user) return;
  const err = new Error("no_session");
  err.code = "no_session";
  throw err;
}

export function readVideoLink(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

// 商品价：必填、整数，至少 1 积分，落在站点价格区间内。
// 内容（post / fastpost）不走这里——它们不带价，也没有价格可填。
export function readItemPrice(raw, policy = {}) {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return { ok: false };
  const value = Number(text);
  const min = Math.max(1, Number(policy.priceMin) || 0);
  const max = Number(policy.priceMax) || 100;
  if (value < min || value > max) return { ok: false };
  return { ok: true, price: value };
}

// 单张图最多等这么久。解码或编码卡住不再返回时（WASM 解 HEIC 的极端情况），
// 「正在压缩」会一直为真，提交口子就永久关着，只能刷新页面——比压不动更糟。
// 到点就按「压不动」处理：退回原文件，交给后端判定。
export const PREPARE_TIMEOUT_MS = 20_000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("prepare_timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// policyOf 用来现读实例下发的大小上限：会话可能在组件挂载之后才回来，
// 所以传取值函数而不是值本身，免得把首帧的空 policy 钉死在闭包里。
export function usePacketMedia(policyOf = () => ({}), options = {}) {
  const prepareTimeoutMs = Number(options.prepareTimeoutMs) > 0 ? Number(options.prepareTimeoutMs) : PREPARE_TIMEOUT_MS;
  const images = ref([]);
  const previewUrls = ref([]);
  // 选图后要先解码再编码，一张几百毫秒到一两秒。这段时间置真，表单据此禁掉提交，
  // 否则发出去的内容里会缺掉正在压的那张。用计数而不是布尔：连续选图会重叠。
  const preparing = ref(0);
  const busyPreparing = computed(() => preparing.value > 0);
  // 压缩是异步的，回来时这份草稿可能已经被 reset 了：分享条收起、货架表单切到另一条、
  // 快拍关闭导致组件卸载。那一代的结果必须丢掉——否则图会落进已经清空的（或别人的）
  // 草稿里，而卸载之后新建的预览地址也没人回收。每次 reset/卸载让代数加一。
  let generation = 0;
  // 海报另算一代：压到一半又选了一张、或者点了移除，先前那次的结果都不该再写回来。
  // 不复用 generation，否则「删掉海报」会把同时还在压的那批图一起作废。
  let posterEpoch = 0;

  const files = ref([]);
  const audio = ref(null);
  const video = ref("");
  const videoOpen = ref(false);
  const posterFile = ref(null);
  const posterPreview = ref("");
  const price = ref("");
  const error = ref("");
  const hasUpload = computed(() => images.value.length > 0 || files.value.length > 0 || Boolean(audio.value));

  function clearPreviews() {
    for (const url of previewUrls.value) URL.revokeObjectURL(url);
    previewUrls.value = [];
  }

  function imageLimit() {
    return imageMaxBytes(policyOf());
  }

  // 先转格式（HEIC → JPEG），再按体积决定要不要缩：超过实例上限或体积偏大的
  // 先在浏览器里压到上限以内，用户看到的是「传上去了」，不再是一句「不能超过 N MB」。
  // 粘贴路径带 forceJpeg：不看体积，一律落到 JPEG。
  // 压不动（浏览器解不了、内存不够）时退回原文件，交给后端按体积与格式判定。
  // 这里连「抛异常」也一起收掉：一张图出意外不该让整批（最多九张）停在半路，
  // 更不该变成一次没人接的 rejection——界面上什么都看不到。
  // 超限与否交回调用方：这一代如果已经作废，就不该再往界面上写错误。
  async function prepareImage(file, options = {}) {
    const limit = imageLimit();
    try {
      // 超时要包住整条链：HEIC 转码（WASM）与解码编码都可能卡住，不只是后半段。
      const prepared = await withTimeout(
        (async () => {
          const normalized = await normalizeImageFile(file);
          const { file: shrunk } = await shrinkImage(normalized, {
            maxBytes: limit,
            forceJpeg: options.forceJpeg === true,
          });
          return shrunk;
        })(),
        prepareTimeoutMs
      );
      return { file: prepared, tooLarge: prepared.size > limit };
    } catch {
      // 超时或意外：用原文件，后端按体积与格式判定。压缩在后台继续跑也无妨，
      // 它的结果没人再用，不会追加进列表。
      return { file, tooLarge: Number(file.size) > limit };
    }
  }

  async function addImages(list, options = {}) {
    const token = generation;
    error.value = "";
    preparing.value += 1;
    try {
      for (const file of list) {
        if (token !== generation) break;
        if (images.value.length >= MAX_IMAGES) {
          // 静默丢弃会让「粘贴了 12 张」看起来只进去了 9 张却不说原因。
          error.value = t("error.image_too_many", { max: MAX_IMAGES });
          break;
        }
        // 选错了文件时给一句话，不静默跳过——静默跳过的结果就是「点了没反应」。
        if (!looksLikeImage(file)) {
          error.value = t("error.bad_mime");
          continue;
        }
        const prepared = await prepareImage(file, options);
        if (token !== generation) break;
        if (prepared.tooLarge) {
          error.value = t("error.image_too_large");
          continue;
        }
        // 压缩要等，这期间用户可能又选了一批，也可能删掉了其中一张。
        // 所以每轮都读当前数组再追加，不拿进入函数时的快照——否则后一次会覆盖前一次。
        if (images.value.length >= MAX_IMAGES) {
          error.value = t("error.image_too_many", { max: MAX_IMAGES });
          break;
        }
        images.value = [...images.value, prepared.file];
        // 逐张出预览：九张原图解码再编码要一两秒，等全部压完才显示，看起来像是卡住了。
        // 只追加新的那条，不重算已有预览——重算会撤销正在显示的 blob 地址。
        previewUrls.value = [...previewUrls.value, URL.createObjectURL(prepared.file)];
      }
    } finally {
      preparing.value = Math.max(0, preparing.value - 1);
    }
  }

  function removeImage(index) {
    // 只撤掉这一条预览。整组重建会让剩下每张都换一次 blob 地址、重下载一遍，
    // 九宫格里看得见地闪一下。
    const url = previewUrls.value[index];
    images.value = images.value.filter((_, i) => i !== index);
    previewUrls.value = previewUrls.value.filter((_, i) => i !== index);
    if (url) URL.revokeObjectURL(url);
  }

  function addFiles(list) {
    error.value = "";
    const next = [...files.value];
    for (const file of list) {
      if (next.length >= MAX_FILES) break;
      if (isVideoFile(file)) {
        error.value = t("error.bad_video");
        continue;
      }
      if (isAudioFile(file)) {
        error.value = t("error.bad_audio");
        continue;
      }
      if (!isAttachmentFile(file)) {
        error.value = t("error.bad_file");
        continue;
      }
      if (file.size > FILE_MAX) {
        error.value = t("error.file_too_large");
        continue;
      }
      next.push({ file, name: file.name });
    }
    files.value = next;
  }

  function removeFile(index) {
    files.value = files.value.filter((_, i) => i !== index);
  }

  function setAudio(file) {
    error.value = "";
    if (!file) return;
    if (!isAudioFile(file)) {
      error.value = t("error.bad_audio");
      return;
    }
    if (file.size > AUDIO_MAX) {
      error.value = t("error.audio_too_large");
      return;
    }
    audio.value = { file, name: file.name };
  }

  function removeAudio() {
    audio.value = null;
  }

  async function setPosterFile(file) {
    error.value = "";
    if (!file) return;
    if (!looksLikeImage(file)) {
      error.value = t("error.bad_mime");
      return;
    }
    const epoch = posterEpoch + 1;
    posterEpoch = epoch;
    preparing.value += 1;
    try {
      const prepared = await prepareImage(file);
      // 期间又选了另一张、点了移除、或整份草稿被清空：这一张已经不作数，错误也不必再写。
      if (epoch !== posterEpoch) return;
      if (prepared.tooLarge) {
        error.value = t("error.image_too_large");
        return;
      }
      clearPoster();
      posterFile.value = prepared.file;
      posterPreview.value = URL.createObjectURL(prepared.file);
    } finally {
      preparing.value = Math.max(0, preparing.value - 1);
    }
  }

  function clearPoster() {
    if (posterPreview.value) URL.revokeObjectURL(posterPreview.value);
    posterPreview.value = "";
    posterFile.value = null;
  }

  // 移除也算一代：删掉之后，先前那张压完了不该再自己冒出来。
  function removePoster() {
    posterEpoch += 1;
    clearPoster();
  }

  function reset() {
    // 让还在解码/编码的那几张作废，回来时不再往这份草稿里追加。
    generation += 1;
    images.value = [];
    files.value = [];
    audio.value = null;
    video.value = "";
    videoOpen.value = false;
    removePoster();
    price.value = "";
    error.value = "";
    clearPreviews();
  }

  onUnmounted(() => {
    generation += 1;
    clearPreviews();
    removePoster();
  });

  return {
    images,
    previewUrls,
    files,
    audio,
    video,
    videoOpen,
    posterFile,
    posterPreview,
    price,
    error,
    hasUpload,
    // 选图后正在压缩：表单据此禁掉提交，免得发出缺图的内容。
    preparing: busyPreparing,
    addImages,
    removeImage,
    addFiles,
    removeFile,
    setAudio,
    removeAudio,
    setPosterFile,
    removePoster,
    reset,
  };
}

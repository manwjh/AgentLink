// 选图后在浏览器里先缩再传。
//
// 两个理由：入口在境外，一张 6MB 的原图要跨一次境；而读者看到的卡片显示图只有
// 1280px（CARD_IMAGE_EDGE），分享海报宽 1080px，原图的像素对任何人都不产生可见收益。
// 服务端也留着上限（KNOT_UPLOAD_IMAGE_MAX_BYTES），客户端这一层不是信任边界，
// 只是把「超过上限就报错」换成「超过就先压」。
//
// 只压偏大的图，不重编码正常大小的图：截图与已经压过的 JPEG 原样上传，避免无谓的
// 二次有损压缩。

// 触发压缩的起点。低于这个体积、也没超过实例上限的文件原样上传。
export const SHRINK_TRIGGER_BYTES = 2 * 1024 * 1024;
// 压完的目标体积。一般第一档就到了；压不下去才继续降质量、缩长边。
export const SHRINK_TARGET_BYTES = Math.round(1.5 * 1024 * 1024);
// 长边上限。2048 比卡片显示图（1280）和分享海报（1080）都宽，留出余量。
export const SHRINK_MAX_EDGE = 2048;
// 解码预算。全尺寸解码失败时退到这一步取位图，比长边上限大得多：
// 4800 万像素的 8000×6000 落到 4096×3072，内存少一半以上，而正常照片不会被放大。
export const SHRINK_DECODE_EDGE = 4096;
// 实例上限的兜底值，与后端 KNOT_UPLOAD_IMAGE_MAX_BYTES 的登记缺省一致。
// 只在会话还没回来（或没连上）时用到；WebUI 不引后端配置包，所以这一份必须和后端对齐。
export const IMAGE_MAX_BYTES_FALLBACK = 16 * 1024 * 1024;
// 像素总数上限。超一亿像素的是 108MP/200MP 的满像素模式或 ProRAW，
// 解码本身就可能把手机浏览器顶掉；真正兜住这一点的是下面的解码预算
// （resizeWidth），这里只是解出来之后再核一次，不让一台已经解下大位图的机器
// 再为每一档编一张同尺寸的画布。
export const SHRINK_MAX_PIXELS = 100_000_000;

// 长边下限。再小就只剩缩略图了，与其交一张糊的，不如让用户换一张。
export const SHRINK_MIN_EDGE = 640;

// 依次尝试的档位：先按长边 2048 压到 0.85，不够再降质量，最后才继续缩边。
// 缩边比降质量更伤细节，所以放在后面。
export const SHRINK_ATTEMPTS = Object.freeze([
  { edge: 2048, quality: 0.85 },
  { edge: 2048, quality: 0.7 },
  { edge: 1600, quality: 0.7 },
  { edge: 1280, quality: 0.7 },
]);

// 粘贴进来的截图基本都是 PNG：一张 1–3MB，而卡片显示图只有 1280px。
// 这条路径不按体积触发，一律转 JPEG，所以第一档质量比普通压缩高一点，
// 免得截图里的文字先糊掉；收不住再按同样的顺序降。
export const FORCE_JPEG_ATTEMPTS = Object.freeze([
  { edge: 2048, quality: 0.92 },
  { edge: 2048, quality: 0.85 },
  { edge: 2048, quality: 0.75 },
  { edge: 1600, quality: 0.72 },
  { edge: 1280, quality: 0.7 },
]);

/**
 * 按长边等比缩放。`scale` 恒 ≤ 1：只缩不放。
 * 只依赖长边，所以 EXIF 方向把宽高对调时结论不变——这是这里不读方向的原因。
 * @returns {{ width: number, height: number, scale: number }}
 */
export function fitEdge(width, height, edge) {
  const w = Math.max(0, Math.floor(Number(width) || 0));
  const h = Math.max(0, Math.floor(Number(height) || 0));
  if (!w || !h) return { width: 0, height: 0, scale: 1 };
  const long = Math.max(w, h);
  const limit = Number(edge) || 0;
  if (!limit || long <= limit) return { width: w, height: h, scale: 1 };
  const scale = limit / long;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale,
  };
}

// 单张图片上限：跟实例走，由 /api/web/home 的 policy 下发。
// 拿不到时用与后端登记缺省一致的值，宁可压一次也不要让一张图被服务端退回来。
export function imageMaxBytes(policy = {}) {
  const value = Number(policy?.imageMaxBytes);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : IMAGE_MAX_BYTES_FALLBACK;
}

// 判断这一张要不要压：超出实例上限必须压，体积偏大也压。
export function shouldShrink(bytes, maxBytes) {
  const size = Number(bytes) || 0;
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : IMAGE_MAX_BYTES_FALLBACK;
  return size > limit || size > SHRINK_TRIGGER_BYTES;
}

// 重编码会丢掉全部元数据（含 GPS），文件名统一换成 .jpg。
// 扩展名按最后一段剥掉，长度放到 16：.heic-sequence 这类长后缀也要剥干净，
// 否则会留下 IMG_0001.heic-sequence.jpg 这样的名字。
export function asJpegFile(blob, originalName) {
  const raw = String(originalName || "").trim();
  // 末尾的孤立句点也要剥掉，否则 "photo." 会拼成 "photo..jpg"。
  const base = raw.replace(/\.[^./\\]{1,16}$/, "").replace(/\.+$/, "").trim();
  return new File([blob], `${base || "image"}.jpg`, { type: "image/jpeg" });
}

// 会动的格式不重编码：canvas 只解第一帧，压一次就把动画变成静图。
// 只有超过实例上限时才动它们——那时不压就发不出去，留一帧也好过被拒。
const ANIMATABLE_TYPE = /^image\/(gif|webp|avif)$/i;
// 已经是 JPEG 的图不再有损重编码一次：压不出多少体积，画质却白掉一档。
const JPEG_TYPE = /^image\/jpeg$/i;
// SVG 不转：平台本来就不收 SVG，转成 JPEG 反而把一份本该被拒的矢量图送过服务端。
// 交给后端按 bad_mime 拒绝，规则只有一处。
const VECTOR_TYPE = /^image\/svg\+xml$/i;

/**
 * 把过大的图片压到实例上限以内。
 *
 * `forceJpeg` 用于剪贴板粘贴：不看体积，一律落到 JPEG（已经够小的 JPEG 除外）。
 *
 * 任何一步失败都返回原文件：压不动不能变成发不出去，最终由后端按体积和格式判定。
 * @param {File|Blob} file 已经过 HEIC/HEIF 转换的文件
 * @param {{ maxBytes?: number, targetBytes?: number, forceJpeg?: boolean, attempts?: Array<{edge:number,quality:number}> }} [options]
 * @param {{ decode?: Function, encode?: Function, asFile?: Function }} [deps] 测试注入用
 * @returns {Promise<{ file: File|Blob, shrunk: boolean }>}
 */
export async function shrinkImage(file, options = {}, deps = {}) {
  if (!file || typeof file.size !== "number") return { file, shrunk: false };
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : IMAGE_MAX_BYTES_FALLBACK;
  // 目标体积不能比实例上限还宽松：上限设得比 1.5MB 更严时，按上限继续压，
  // 否则会出现「压到 1.4MB 就停手，仍超上限」这种明明还能再压却报错的情况。
  const targetBytes = Math.min(
    Number(options.targetBytes) > 0 ? Number(options.targetBytes) : SHRINK_TARGET_BYTES,
    maxBytes
  );
  const forced = options.forceJpeg === true;
  const attempts = Array.isArray(options.attempts) && options.attempts.length
    ? options.attempts
    : forced
      ? FORCE_JPEG_ATTEMPTS
      : SHRINK_ATTEMPTS;
  const type = String(file.type || "");
  // 矢量图转位图会把本该被后端拒绝的文件洗成合格上传，两种情况都不碰。
  if (VECTOR_TYPE.test(type)) return { file, shrunk: false };
  if (forced) {
    // 剪贴板里本来就是 JPEG、又没超上限：只可能是从别处复制的照片，
    // 再编码一次只掉画质，省不下体积。
    if (JPEG_TYPE.test(type) && file.size <= maxBytes) return { file, shrunk: false };
  } else {
    // 动图在没超上限时保持原样：体积换不来把动画压丢的代价。
    if (ANIMATABLE_TYPE.test(type) && file.size <= maxBytes) return { file, shrunk: false };
    if (!shouldShrink(file.size, maxBytes)) return { file, shrunk: false };
  }

  const decode = deps.decode || decodeBitmap;
  const encode = deps.encode || encodeCanvas;
  const makeFile = deps.asFile || asJpegFile;

  let bitmap;
  try {
    bitmap = await decode(file);
  } catch {
    return { file, shrunk: false };
  }

  try {
    const width = Number(bitmap?.width) || 0;
    const height = Number(bitmap?.height) || 0;
    if (!width || !height || width * height > SHRINK_MAX_PIXELS) return { file, shrunk: false };

    let best = null;
    let lastEdge = 0;
    for (const attempt of attempts) {
      const size = fitEdge(width, height, attempt.edge);
      if (!size.width || !size.height) continue;
      lastEdge = attempt.edge;
      let blob;
      try {
        blob = await encode(bitmap, size, attempt.quality);
      } catch {
        continue;
      }
      if (!blob || !blob.size) continue;
      if (!best || blob.size < best.size) best = blob;
      if (blob.size <= targetBytes) break;
    }

    // 实例上限比默认目标更严（例如站点把它压到 1MB）：上面的档位按 1.5MB 收的，
    // 到这儿可能仍超上限。继续按 0.8 倍缩边，进了上限或缩到长边下限就停。
    for (let tries = 0; best && best.size > maxBytes && tries < 4; tries += 1) {
      const edge = Math.round(lastEdge * 0.8 ** (tries + 1));
      if (edge < SHRINK_MIN_EDGE) break;
      const size = fitEdge(width, height, edge);
      if (!size.width || !size.height) break;
      let blob;
      try {
        blob = await encode(bitmap, size, 0.7);
      } catch {
        continue;
      }
      if (!blob || !blob.size) continue;
      if (!best || blob.size < best.size) best = blob;
      if (blob.size <= maxBytes) break;
    }

    if (!best) return { file, shrunk: false };
    // 普通路径：压完不比原图小（源图本来就压得很紧），保留原件，不为更差的结果重编码。
    // 粘贴路径例外：那里要的是「一定是 JPEG」，纯色截图压成 JPEG 反而更大也照转——
    // 否则同一个粘贴动作有时出 .jpg、有时出 .png，名字和类型跟着变的正是用户看到的那一份。
    if (!forced && best.size >= file.size) return { file, shrunk: false };
    return { file: makeFile(best, file.name), shrunk: true };
  } finally {
    try {
      bitmap?.close?.();
    } catch {
      // 关不掉就交给 GC。
    }
  }
}

// 现代浏览器在解码阶段就按 EXIF 方向摆正，位图的宽高与画出来的方向一致。
async function decodeBitmap(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // 4800 万像素以上的全尺寸解码可能直接顶到内存。让浏览器边解边缩到解码预算以内，
      // 再交给后面的档位取最终尺寸；预算大于长边上限，正常照片不会被这一步放大。
      return await createImageBitmap(file, { resizeWidth: SHRINK_DECODE_EDGE, resizeQuality: "high" });
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode_failed"));
      el.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function encodeCanvas(bitmap, size, quality) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, size.width);
  canvas.height = Math.max(1, size.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no_canvas");
  // 透明图直接转 JPEG 会把透明区压成纯黑，先垫白底（与头像裁图同一处理）。
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      // 编码已经完成，立刻把画布缩到 0：连续处理九张时，别让每块位图都留到 GC 才释放。
      canvas.width = 0;
      canvas.height = 0;
      if (blob) resolve(blob);
      else reject(new Error("encode_failed"));
    }, "image/jpeg", quality);
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  FORCE_JPEG_ATTEMPTS,
  IMAGE_MAX_BYTES_FALLBACK,
  SHRINK_MAX_PIXELS,
  SHRINK_TARGET_BYTES,
  SHRINK_TRIGGER_BYTES,
  asJpegFile,
  fitEdge,
  imageMaxBytes,
  shouldShrink,
  shrinkImage,
} from "./imageScale.js";

function blobOf(bytes, type = "image/jpeg") {
  return new Blob([new Uint8Array(bytes)], { type });
}

function fileOf(bytes, name = "photo.jpg", type = "image/jpeg") {
  return new File([new Uint8Array(bytes)], name, { type });
}

// 造一个解码结果：只有宽高，close 记一笔，验证用完就放。
function fakeBitmap(width, height) {
  return {
    width,
    height,
    closed: false,
    close() {
      this.closed = true;
    },
  };
}

test("a picture is scaled down by its long edge and never up", () => {
  assert.deepEqual(fitEdge(4000, 3000, 2048), { width: 2048, height: 1536, scale: 0.512 });
  // 竖拍：只看长边，宽高对调不影响结论。
  assert.deepEqual(fitEdge(3000, 4000, 2048), { width: 1536, height: 2048, scale: 0.512 });
  // 已经够小就原样返回，不做放大。
  assert.deepEqual(fitEdge(1600, 1200, 2048), { width: 1600, height: 1200, scale: 1 });
  // 极端比例至少留 1px，不产出 0 宽的画布。
  assert.equal(fitEdge(8000, 1, 2048).height, 1);
  assert.deepEqual(fitEdge(0, 0, 2048), { width: 0, height: 0, scale: 1 });
});

test("the image limit comes from the instance policy, with the backend default behind it", () => {
  assert.equal(imageMaxBytes({ imageMaxBytes: 4_000_000 }), 4_000_000);
  // 会话还没回来时读不到值：按后端缺省走，不另写一个数字。
  assert.equal(imageMaxBytes({}), IMAGE_MAX_BYTES_FALLBACK);
  assert.equal(imageMaxBytes({ imageMaxBytes: 0 }), IMAGE_MAX_BYTES_FALLBACK);
  assert.equal(imageMaxBytes({ imageMaxBytes: "big" }), IMAGE_MAX_BYTES_FALLBACK);
});

test("a picture is shrunk when it is heavy or over the instance limit", () => {
  assert.equal(shouldShrink(200 * 1024, 16 * 1024 * 1024), false);
  assert.equal(shouldShrink(SHRINK_TRIGGER_BYTES + 1, 16 * 1024 * 1024), true);
  // 实例把上限调小到 1MB 时，1.5MB 的文件虽然没到触发线也必须压。
  assert.equal(shouldShrink(1_500_000, 1_000_000), true);
  // 触发线与上限取更严的那个：上限 1MB 时，2MB 的文件照样超。
  assert.equal(shouldShrink(SHRINK_TRIGGER_BYTES - 1, 1_000_000), true);
});

test("a re-encoded picture keeps its name and becomes a jpeg", () => {
  const file = asJpegFile(blobOf(10), "IMG_0001.HEIC");
  assert.equal(file.name, "IMG_0001.jpg");
  assert.equal(file.type, "image/jpeg");
  assert.equal(asJpegFile(blobOf(10), "").name, "image.jpg");
  // 长后缀也要剥干净，不留 HEIC 的痕迹。
  assert.equal(asJpegFile(blobOf(10), "IMG_0001.heic-sequence").name, "IMG_0001.jpg");
  // 文件名里的点不当扩展名，只剥最后一段。
  assert.equal(asJpegFile(blobOf(10), "holiday.2024.10.jpeg").name, "holiday.2024.10.jpg");
  // 只有孤立句点的名字不能拼出两个点。
  assert.equal(asJpegFile(blobOf(10), "photo.").name, "photo.jpg");
  assert.equal(asJpegFile(blobOf(10), ".").name, "image.jpg");
});

test("a small picture is left untouched without decoding it", async () => {
  let decoded = false;
  const file = fileOf(300 * 1024);
  const result = await shrinkImage(
    file,
    { maxBytes: 16 * 1024 * 1024 },
    {
      decode: async () => {
        decoded = true;
        return fakeBitmap(1000, 1000);
      },
    }
  );
  assert.equal(result.file, file);
  assert.equal(result.shrunk, false);
  assert.equal(decoded, false);
});

test("a heavy picture lands inside the target on the first fitting attempt", async () => {
  const file = fileOf(9 * 1024 * 1024, "IMG_2019.jpg");
  const bitmap = fakeBitmap(6000, 4000);
  const calls = [];
  // 第一档就压到目标以内；后面的档位不该再试。
  const sizes = [900 * 1024, 400 * 1024, 300 * 1024, 200 * 1024];
  const result = await shrinkImage(
    file,
    { maxBytes: 16 * 1024 * 1024 },
    {
      decode: async () => bitmap,
      encode: async (_bitmap, size, quality) => {
        calls.push({ size, quality });
        return blobOf(sizes[calls.length - 1]);
      },
    }
  );
  assert.equal(result.shrunk, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { size: { width: 2048, height: 1365, scale: 2048 / 6000 }, quality: 0.85 });
  assert.ok(result.file.size <= SHRINK_TARGET_BYTES);
  assert.equal(result.file.name, "IMG_2019.jpg");
  assert.equal(result.file.type, "image/jpeg");
  // 用完的位图要放掉，不然连拍九张就顶到手机内存。
  assert.equal(bitmap.closed, true);
});

test("steps down quality then edge when the first attempt is still too heavy", async () => {
  const file = fileOf(12 * 1024 * 1024);
  const calls = [];
  const sizes = [3 * 1024 * 1024, 2_500 * 1024, 2 * 1024 * 1024, 1_200 * 1024];
  const result = await shrinkImage(
    file,
    { maxBytes: 16 * 1024 * 1024 },
    {
      decode: async () => fakeBitmap(6000, 4000),
      encode: async (_bitmap, size, quality) => {
        calls.push({ edge: Math.max(size.width, size.height), quality });
        return blobOf(sizes[calls.length - 1]);
      },
    }
  );
  assert.equal(result.shrunk, true);
  assert.deepEqual(calls, [
    { edge: 2048, quality: 0.85 },
    { edge: 2048, quality: 0.7 },
    { edge: 1600, quality: 0.7 },
    { edge: 1280, quality: 0.7 },
  ]);
  assert.equal(result.file.size, 1_200 * 1024);
});

test("a picture that cannot be shrunk keeps its original bytes", async () => {
  const file = fileOf(6 * 1024 * 1024);
  const decodeFails = await shrinkImage(file, {}, {
    decode: async () => {
      throw new Error("decode_failed");
    },
  });
  assert.equal(decodeFails.file, file);
  assert.equal(decodeFails.shrunk, false);

  const encodeFails = await shrinkImage(file, {}, {
    decode: async () => fakeBitmap(4000, 3000),
    encode: async () => {
      throw new Error("encode_failed");
    },
  });
  assert.equal(encodeFails.file, file);

  // 压完反而更大：源图本来就压得很紧，不能拿更差的结果替换原件。
  const bigger = await shrinkImage(file, {}, {
    decode: async () => fakeBitmap(4000, 3000),
    encode: async () => blobOf(file.size + 10),
  });
  assert.equal(bigger.file, file);
  assert.equal(bigger.shrunk, false);
});

test("an animated picture is not flattened into a still frame", async () => {
  const gif = fileOf(4 * 1024 * 1024, "fun.gif", "image/gif");
  let decoded = false;
  const untouched = await shrinkImage(gif, { maxBytes: 16 * 1024 * 1024 }, {
    decode: async () => {
      decoded = true;
      return fakeBitmap(800, 600);
    },
  });
  assert.equal(untouched.file, gif);
  assert.equal(decoded, false);

  // 超过实例上限时只能压：留一帧也好过发不出去。
  const over = await shrinkImage(gif, { maxBytes: 1024 * 1024 }, {
    decode: async () => fakeBitmap(800, 600),
    encode: async () => blobOf(200 * 1024),
  });
  assert.equal(over.shrunk, true);
  assert.equal(over.file.type, "image/jpeg");
});

test("an svg is not rasterized into a picture the server would then accept", async () => {
  const svg = fileOf(3 * 1024 * 1024, "logo.svg", "image/svg+xml");
  let decoded = false;
  const result = await shrinkImage(svg, { maxBytes: 16 * 1024 * 1024 }, {
    decode: async () => {
      decoded = true;
      return fakeBitmap(800, 600);
    },
  });
  assert.equal(result.file, svg);
  assert.equal(result.shrunk, false);
  assert.equal(decoded, false);
});

test("a tighter instance limit keeps shrinking instead of stopping short", async () => {
  const file = fileOf(12 * 1024 * 1024);
  const calls = [];
  // 前四档按默认目标收不住 500KB 的上限，后两档继续缩边。
  const sizes = [3 * 1024 * 1024, 2.5 * 1024 * 1024, 2 * 1024 * 1024, 1.2 * 1024 * 1024, 600 * 1024, 400 * 1024];
  const result = await shrinkImage(
    file,
    { maxBytes: 500 * 1024 },
    {
      decode: async () => fakeBitmap(6000, 4000),
      encode: async (_bitmap, size) => {
        calls.push(Math.max(size.width, size.height));
        return blobOf(sizes[calls.length - 1]);
      },
    }
  );
  assert.equal(result.shrunk, true);
  assert.ok(result.file.size <= 500 * 1024);
  // 1280 之后按 0.8 倍继续缩：1024、819。
  assert.deepEqual(calls, [2048, 2048, 1600, 1280, 1024, 819]);
});

test("the forced shrink gives up at the edge floor instead of going tiny", async () => {
  const file = fileOf(12 * 1024 * 1024);
  const calls = [];
  const result = await shrinkImage(
    file,
    { maxBytes: 100 * 1024 },
    {
      decode: async () => fakeBitmap(6000, 4000),
      encode: async (_bitmap, size) => {
        calls.push(Math.max(size.width, size.height));
        // 怎么压都到不了 100KB。
        return blobOf(400 * 1024);
      },
    }
  );
  // 基准四档 + 三轮缩边（1024、819、655）；再往下 524 已低于长边下限，不再压。
  assert.equal(calls.length, 7);
  assert.deepEqual(calls.slice(4), [1024, 819, 655]);
  // 压不下去时仍然是「原图 vs 最好结果」里较小的那个。
  assert.equal(result.file.size, 400 * 1024);
});

test("an absurd pixel count is not decoded twice over", async () => {
  const file = fileOf(5 * 1024 * 1024);
  let encoded = false;
  const result = await shrinkImage(file, {}, {
    decode: async () => fakeBitmap(20000, 20000),
    encode: async () => {
      encoded = true;
      return blobOf(1024);
    },
  });
  assert.equal(result.file, file);
  assert.equal(encoded, false);
  assert.ok(20000 * 20000 > SHRINK_MAX_PIXELS);
});

test("a pasted screenshot is re-encoded even when it is under the trigger", async () => {
  const png = fileOf(300 * 1024, "image.png", "image/png");
  const calls = [];
  const result = await shrinkImage(
    png,
    { forceJpeg: true },
    {
      decode: async () => fakeBitmap(2560, 1440),
      encode: async (_bitmap, size, quality) => {
        calls.push({ edge: Math.max(size.width, size.height), quality });
        return blobOf(140 * 1024);
      },
    }
  );
  assert.equal(result.shrunk, true);
  // 第一档就够小，不继续降质量；质量从 0.92 起，截图文字没那么容易糊。
  assert.deepEqual(calls, [{ edge: 2048, quality: FORCE_JPEG_ATTEMPTS[0].quality }]);
  assert.equal(result.file.type, "image/jpeg");
  assert.equal(result.file.name, "image.jpg");
});

test("a small jpeg from the clipboard is not re-encoded a second time", async () => {
  const jpeg = fileOf(200 * 1024, "photo.jpg");
  let decoded = false;
  const result = await shrinkImage(jpeg, { forceJpeg: true }, {
    decode: async () => {
      decoded = true;
      return fakeBitmap(1200, 900);
    },
  });
  assert.equal(result.file, jpeg);
  assert.equal(result.shrunk, false);
  assert.equal(decoded, false);
});

test("a forced conversion lands on jpeg even when the jpeg is bigger", async () => {
  const png = fileOf(120 * 1024, "flat.png", "image/png");
  const result = await shrinkImage(png, { forceJpeg: true }, {
    decode: async () => fakeBitmap(800, 600),
    encode: async () => blobOf(200 * 1024),
  });
  // 粘贴路径承诺的是「一定是 JPEG」：纯色截图的 PNG 比 JPEG 小也照转，
  // 否则同一个动作会时而交 .jpg、时而交 .png。
  assert.equal(result.file.type, "image/jpeg");
  assert.equal(result.file.name, "flat.jpg");
  assert.equal(result.shrunk, true);
});

test("a vector file is never rasterized even on the paste path", async () => {
  const svg = fileOf(300 * 1024, "logo.svg", "image/svg+xml");
  let decoded = false;
  const result = await shrinkImage(svg, { forceJpeg: true }, {
    decode: async () => {
      decoded = true;
      return fakeBitmap(800, 600);
    },
  });
  assert.equal(result.file, svg);
  assert.equal(decoded, false);
});

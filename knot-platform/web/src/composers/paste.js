// 剪贴板里的图片。
//
// Chrome / Safari 把截图放在 items（kind=file，带 type），个别实现只填 files；
// 同一张图两处都出现时按 name+size+type 去重，否则粘贴一次会出现两张。

function keyOf(file) {
  return `${file.name || ""}:${file.size || 0}:${file.type || ""}`;
}

function pushFile(out, seen, file) {
  if (!file) return;
  const type = String(file.type || "");
  const name = String(file.name || "");
  // 有类型就以类型为准；没有类型时至少要像一张图，纯文本不会被当成图片。
  if (!type.startsWith("image/") && !/\.(jpe?g|png|webp|gif|avif|hei[cf](-sequence)?)$/i.test(name)) return;
  const key = keyOf(file);
  if (seen.has(key)) return;
  seen.add(key);
  out.push(file);
}

/**
 * 从 paste 事件的 clipboardData 里取图片文件。
 * 没有图片时返回空数组，调用方据此决定要不要 preventDefault。
 * @param {DataTransfer | null | undefined} data
 * @returns {File[]}
 */
export function imageFilesFromClipboard(data) {
  const out = [];
  const seen = new Set();
  const items = data?.items ? Array.from(data.items) : [];
  for (const item of items) {
    if (!item || item.kind !== "file") continue;
    if (!String(item.type || "").startsWith("image/")) continue;
    pushFile(out, seen, item.getAsFile?.());
  }
  if (data?.files) {
    for (const file of Array.from(data.files)) pushFile(out, seen, file);
  }
  return out;
}

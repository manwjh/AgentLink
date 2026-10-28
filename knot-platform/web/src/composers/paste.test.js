import assert from "node:assert/strict";
import test from "node:test";
import { imageFilesFromClipboard } from "./paste.js";

function fileOf(name, type, bytes = 3) {
  return new File([new Uint8Array(bytes)], name, { type });
}

function itemOf(file) {
  return { kind: "file", type: file.type, getAsFile: () => file };
}

test("a pasted screenshot is picked up from clipboard items", () => {
  const shot = fileOf("image.png", "image/png");
  const files = imageFilesFromClipboard({ items: [itemOf(shot)], files: [shot] });
  // items 与 files 各出现一次，只能算一张。
  assert.equal(files.length, 1);
  assert.equal(files[0], shot);
});

test("clipboardData.files is the fallback when items carry no file", () => {
  const shot = fileOf("image.png", "image/png");
  const files = imageFilesFromClipboard({ items: [{ kind: "string", type: "text/plain" }], files: [shot] });
  assert.deepEqual(files, [shot]);
});

test("text and html never become attachments", () => {
  const text = fileOf("note.txt", "text/plain");
  const files = imageFilesFromClipboard({
    items: [
      { kind: "string", type: "text/plain" },
      { kind: "file", type: "text/plain", getAsFile: () => text },
    ],
    files: [text],
  });
  assert.deepEqual(files, []);
});

test("an image without a mime type is still recognized by its name", () => {
  const shot = fileOf("screenshot.PNG", "");
  assert.deepEqual(imageFilesFromClipboard({ files: [shot] }), [shot]);
});

test("several screenshots keep their order", () => {
  const one = fileOf("one.png", "image/png", 1);
  const two = fileOf("two.jpg", "image/jpeg", 2);
  assert.deepEqual(imageFilesFromClipboard({ files: [one, two] }), [one, two]);
});

test("a missing clipboard payload is not an error", () => {
  assert.deepEqual(imageFilesFromClipboard(null), []);
  assert.deepEqual(imageFilesFromClipboard({}), []);
  // 拿不到文件对象的 item 直接跳过。
  assert.deepEqual(imageFilesFromClipboard({ items: [{ kind: "file", type: "image/png", getAsFile: () => null }] }), []);
});

import assert from "node:assert/strict";
import test from "node:test";
import { fitTextarea } from "./autoGrow.js";

function textarea(scrollHeight) {
  return { tagName: "TEXTAREA", scrollHeight, style: {} };
}

test("the height follows the content, both up and down", () => {
  const el = textarea(120);
  fitTextarea(el);
  assert.equal(el.style.height, "120px");
  // 删掉一段后重新量，框跟着缩回去。
  el.scrollHeight = 44;
  fitTextarea(el);
  assert.equal(el.style.height, "44px");
});

test("a hidden textarea is not pinned to zero height", () => {
  const el = textarea(0);
  fitTextarea(el);
  // 量不到内容时留在 auto，等可见后再量，不写死 0。
  assert.equal(el.style.height, "auto");
});

test("anything that is not a textarea is left alone", () => {
  const input = { tagName: "INPUT", scrollHeight: 120, style: {} };
  fitTextarea(input);
  assert.equal(input.style.height, undefined);
  fitTextarea(null);
});

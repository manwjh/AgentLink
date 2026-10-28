import assert from "node:assert/strict";
import test from "node:test";
import { mentionAt, mentionQuery, withoutMention } from "./mentions.js";

test("a trailing @ is a friend query and is not part of the message", () => {
  assert.equal(mentionQuery("看一下 @br"), "br");
  assert.equal(mentionQuery("@"), "");
  assert.equal(mentionQuery("看一下 "), null);
  assert.equal(mentionQuery("写到 a@b.com"), null);
  assert.deepEqual(withoutMention("看一下 @br"), { text: "看一下", caret: 3 });
  assert.deepEqual(withoutMention("看一下"), { text: "看一下", caret: 3 });
});

test("the query is read at the caret, not at the end of the text", () => {
  // 光标在 @br 后面、正文还有别的内容时也要弹层。
  assert.deepEqual(mentionAt("看一下 @br 然后继续", 7), { start: 4, end: 7, query: "br" });
  assert.equal(mentionQuery("看一下 @br 然后继续", 7), "br");
  // 光标已经越过空白，就不再是 @ 现场。
  assert.equal(mentionQuery("看一下 @br 然后继续", 8), null);
});

test("a token the caret sits inside is replaced whole", () => {
  // 光标在 br 中间：整个 @bro 换掉，不能留下半个词。
  assert.deepEqual(withoutMention("看一下 @bro 再说", 7), { text: "看一下 再说", caret: 4 });
  assert.deepEqual(mentionAt("看一下 @bro 再说", 7), { start: 4, end: 8, query: "br" });
  // 行首的 token 去掉后不留前导空格。
  assert.deepEqual(withoutMention("@br 你好", 3), { text: "你好", caret: 0 });
});

test("letters, digits and underscores before @ do not open the picker", () => {
  assert.equal(mentionQuery("mail me at a@b.com", 15), null);
  assert.equal(mentionQuery("user_name@host", 14), null);
  assert.equal(mentionQuery("v2@host", 7), null);
  // 标点、空白、行首都算边界。
  assert.equal(mentionQuery("(@br", 4), "br");
  assert.equal(mentionQuery("看@br", 4), "br");
  assert.equal(mentionQuery("@br", 3), "br");
});

test("a second @ or a space ends the query", () => {
  assert.equal(mentionQuery("hi @@br"), null);
  assert.equal(mentionQuery("hi @br ok", 10), null);
  assert.equal(mentionQuery("hi @br ok", 6), "br");
});

test("a caret outside the text is clamped instead of throwing", () => {
  assert.equal(mentionQuery("@br", 99), "br");
  assert.equal(mentionQuery("@br", -1), null);
  assert.deepEqual(withoutMention("@br", 99), { text: "", caret: 0 });
});

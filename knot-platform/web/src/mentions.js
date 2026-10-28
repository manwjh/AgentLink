// @ 只在光标处解析：弹层要跟着光标走，不能只认整段文本的结尾。
// 触发条件是「@ 前不是字母、数字或下划线，后面到光标之间没有空白」：
// a@b.com 不弹，而中文里紧贴着字写「看@br」仍然弹——\w 只认 ASCII，
// 汉字不算词字符，这正是想要的。

// 词字符只按 ASCII 算。邮箱、URL 的 @ 前面一定是 ASCII，够用了。
const WORD_BEFORE = /[A-Za-z0-9_]/;

function clampCaret(text, caret) {
  const value = String(text ?? "");
  const at = Number.isFinite(Number(caret)) ? Math.trunc(Number(caret)) : value.length;
  return Math.max(0, Math.min(at, value.length));
}

/**
 * 光标处的 @ 片段。
 * @returns {{ start: number, end: number, query: string } | null}
 *   start / end 是整个 token（含 @ 与后面连续的词）在原文里的区间，
 *   query 是光标前的检索词。
 */
export function mentionAt(text, caret) {
  const value = String(text ?? "");
  const at = clampCaret(value, caret);
  const before = value.slice(0, at);
  const start = before.lastIndexOf("@");
  if (start < 0) return null;
  const lead = start === 0 ? "" : before[start - 1];
  // 第二个 @、邮箱里的 @ 都不算触发。
  if (lead && (WORD_BEFORE.test(lead) || lead === "@")) return null;
  const query = before.slice(start + 1);
  if (/[\s@]/.test(query)) return null;
  // 光标落在词中间时，整个 token 一起换掉，不然会把前后两截粘在一起。
  let end = at;
  while (end < value.length && !/[\s@]/.test(value[end])) end += 1;
  return { start, end, query };
}

export function mentionQuery(text, caret) {
  return mentionAt(text, caret)?.query ?? null;
}

/**
 * 选中好友后只拿掉这一段 @query，前后文原样保留；光标落回 @ 原来的位置。
 * @returns {{ text: string, caret: number }}
 */
export function withoutMention(text, caret) {
  const value = String(text ?? "");
  const found = mentionAt(value, caret);
  if (!found) return { text: value, caret: clampCaret(value, caret) };
  const before = value.slice(0, found.start);
  let after = value.slice(found.end);
  // 两边都是空白时留一个就够："看一下 @bro 再说" 不该变成两个空格。
  if (!before) after = after.replace(/^\s/, "");
  else if (/\s$/.test(before) && /^\s/.test(after)) after = after.slice(1);
  // token 在结尾时把留下的尾随空白一并收掉，"看一下 " 不该多一个空格。
  const head = after ? before : before.replace(/\s+$/, "");
  return { text: head + after, caret: head.length };
}

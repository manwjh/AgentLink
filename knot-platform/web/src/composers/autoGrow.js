// 多行输入随内容长高。
//
// 先把高度收回 auto 再读 scrollHeight：删字、清空、切换草稿都能缩回去，
// 否则输入框只会越来越长。上限交给样式表的 max-height 夹住，超过就在框内滚动。

export function fitTextarea(el) {
  if (!el || el.tagName !== "TEXTAREA") return;
  el.style.height = "auto";
  // 有的浏览器在隐藏/折叠元素上读到 0：这时不写高度，等可见时再量。
  if (!el.scrollHeight) return;
  el.style.height = `${el.scrollHeight}px`;
}

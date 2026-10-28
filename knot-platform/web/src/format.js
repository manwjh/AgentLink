// 列表分隔符按语种拼：中文是顿号「、」，英文是逗号加空格。
// 写死 join("、") 时 en 界面会画出中文标点。
// 用 conjunction + narrow：zh-CN 得 "A、B、C"，en 得 "A, B, C"，
// 没有「和 / and」这种连接词（long / short 会带，不适合权益标签）。
export function listText(items, locale) {
  const list = (Array.isArray(items) ? items : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  if (list.length === 0) return "";
  try {
    return new Intl.ListFormat(locale, { type: "conjunction", style: "narrow" }).format(list);
  } catch {
    return list.join(", ");
  }
}

// 顶栏那一行只有十来个字符的位置：四位数起换成紧凑写法，中文得「1.2万」、
// 英文得「1.3K」，单位交给 Intl 按语种写，不自己拼「万 / k」。
// 一千以内照原样写着——「今日 128 条」比「128 条」多出来的那点信息不值得多一个符号。
export function compactCount(value, locale, from = 1000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0";
  const whole = Math.floor(n);
  if (whole < from) return String(whole);
  try {
    return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(whole);
  } catch {
    return String(whole);
  }
}

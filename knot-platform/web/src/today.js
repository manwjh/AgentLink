// 顶栏那一行「今日」的纯逻辑。
//
// 数字由实例按**站点本地日**算好（backend 的 countTodayIntel），页面只做两件事：
// 把它画成一行字，以及在跨过日界之后自己归零。客户端不推算时区——
// `dayEndsAt` 就是那一天的结束点，谁在哪都认同同一个时刻。

// 十五分钟内还有新帖，才让那颗脉冲点亮着。窗口比轮询间隔长，
// 数字跳动时点一定亮着；停发之后最多再亮一轮就熄，不会一直假装有人在发。
export const LIVE_WINDOW_MS = 15 * 60 * 1000;

/** 把服务端 / 快照里的那一小块收成要么完整、要么不存在。 */
export function sanitizeCounts(raw) {
  if (!raw || typeof raw !== "object") return null;
  const posts = Number(raw.posts);
  const dayEndsAt = Date.parse(String(raw.dayEndsAt ?? ""));
  // 没有条数或没有日界，就不算知道今天：界面画「—」，不画 0。
  if (!Number.isFinite(posts) || posts < 0 || !Number.isFinite(dayEndsAt)) return null;
  const lastPostAt = Date.parse(String(raw.lastPostAt ?? ""));
  return {
    posts: Math.floor(posts),
    lastPostAt: Number.isFinite(lastPostAt) ? new Date(lastPostAt).toISOString() : null,
    dayEndsAt: new Date(dayEndsAt).toISOString(),
  };
}

/**
 * 这一刻顶栏该显示什么。
 *
 * - 没有数（快照还没下来、站点关了公开快照、这一次没取到）：`known: false`，画「—」。
 * - 过了 `dayEndsAt`：新的一天从 0 起算，不拿昨天的数继续用；
 *   没有新快照也能自己翻页，这是只用日界、不用时区换来的。
 */
export function todayView(counts, at = Date.now()) {
  const unknown = { known: false, posts: 0, live: false };
  if (!counts) return unknown;
  const endsAt = Date.parse(counts.dayEndsAt);
  if (!Number.isFinite(endsAt)) return unknown;
  const now = Number(at);
  if (now >= endsAt) return { known: true, posts: 0, live: false };
  const lastAt = Date.parse(counts.lastPostAt || "");
  // 服务端时钟比浏览器快时 lastAt 可能落在「未来」，那不是「刚刚有人发」，不算活。
  const live = Number.isFinite(lastAt) && now >= lastAt && now - lastAt <= LIVE_WINDOW_MS;
  return { known: true, posts: counts.posts, live };
}

/**
 * 各语种把数字放在不同的位置（「今日 128 条」/「128 posts today」），
 * 所以不拼前缀后缀：让译文用占位符标出数字在哪，这里把那一处切开，
 * 模板只给数字加粗。译文没带占位符时整句原样画出来，不加粗也不错位。
 */
export function splitNumber(text, token = "\u0000") {
  const at = String(text).indexOf(token);
  if (at < 0) return { before: String(text), after: "" };
  return {
    before: text.slice(0, at),
    after: text.slice(at + token.length),
  };
}

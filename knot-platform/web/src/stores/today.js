import { defineStore } from "pinia";
import { getToday } from "../api.js";
import { browserStorage, readBoardCache } from "../boardCache.js";
import { readDiscoverMemory } from "../discoverBoard.js";
import { sanitizeCounts } from "../today.js";

// 顶栏中部那一行「今日」。它是一个站的量，不是某个人的：
// 访客与登录的人看到同一个数，退出登录也不清。
export const useTodayStore = defineStore("today", {
  state: () => ({
    counts: null,
    // 「这一次没取到」与「今天本来就是 0 条」是两件事：
    // 失败时保留上一次的数字，不退回「今日 0 条」——那是最容易被读成「这个站死了」的一句话。
    failed: false,
  }),
  actions: {
    // 公开快照里带着同一份计数：有它就不必为了第一帧先穿一次隧道。
    seed() {
      if (this.counts) return;
      const board = readDiscoverMemory() || readBoardCache(browserStorage());
      const counts = sanitizeCounts(board?.counts);
      if (counts) this.counts = counts;
    },
    async poll() {
      try {
        const data = await getToday();
        // 服务端回 null 是「没有这个数」（公开快照关着），照实清掉；
        // 取失败走 catch，保留上一次的值。
        this.counts = sanitizeCounts(data?.counts);
        this.failed = false;
      } catch {
        this.failed = true;
      }
    },
  },
});

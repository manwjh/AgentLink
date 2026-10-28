<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch, watchEffect } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppButton from "../components/AppButton.vue";
import CardShareDialog from "../components/CardShareDialog.vue";
import CardTipDialog from "../components/CardTipDialog.vue";
import LocaleSwitch from "../components/LocaleSwitch.vue";
import OutboxNotice from "../components/OutboxNotice.vue";
import RememberLoginCard from "../components/RememberLoginCard.vue";
import SiteOwnerDialog from "../components/SiteOwnerDialog.vue";
import XknotMark from "../components/XknotMark.vue";
import { BackIcon, BellIcon, ClockIcon, CoinIcon, FriendsIcon, HelpIcon, SearchIcon, StarIcon, UserIcon } from "../icons/index.js";
import { locale, t } from "../i18n/index.js";
import { canonicalUrl, pageTitle } from "../head.js";
import { splitNumber, todayView } from "../today.js";
import { compactCount } from "../format.js";
import { clock } from "../time.js";
import { listSponsors } from "../api.js";
import { hasDraft, runningEntry, startReleaseWatch } from "../release.js";
import { startPolling } from "../polling.js";
import { useNotificationStore } from "../stores/notifications";
import { useOutboxStore } from "../stores/outbox";
import { useSessionStore } from "../stores/session";
import { useTodayStore } from "../stores/today";
import { internalHref } from "../links.js";

const route = useRoute();
const router = useRouter();
const notifications = useNotificationStore();
const outbox = useOutboxStore();
const session = useSessionStore();
const today = useTodayStore();
const updateReady = ref(false);
let releaseWatch = null;
let notificationsPoll = null;
let todayPoll = null;
const NOTIFICATIONS_POLL_MS = 30 * 1000;
// 今日计数一分钟一问。比通知慢一档：它说的是「这个站今天有多少人在说话」，
// 不是等人处理的消息，晚一分钟没有任何人吃亏，少下来的往返是实打实的。
const TODAY_POLL_MS = 60 * 1000;
// 站点名来自部署配置，顶栏正中显示；更长的名字由 CSS 截断。
const siteName = computed(() => session.brandName);
const mark = computed(() => Array.from(siteName.value)[0] || "K");
const siteOrigin = typeof window !== "undefined" ? window.location.origin : "";
const HISTORY_KEY = "knot.search.history";
const searchOpen = ref(false);
const query = ref("");
const searchInput = ref(null);
const history = ref(readHistory());
const sponsors = ref([]);
const ownerDialog = ref(null);

// 顶上那一行「今日」的数字在译文里的位置：各语种语序不同，先让译文标出来，
// 模板只给这一段加粗（见 today.js 的 splitNumber）。
const NUMBER_SLOT = "\u0000";
const showToday = computed(() => session.canBrowse && session.site.publicBoard !== false);
// clock 每分钟一跳：过了日界、或者最后一帖出了十五分钟的窗口，这一行自己就变了，
// 不必等下一次取数。
const todayState = computed(() => todayView(today.counts, clock.value));
const todayLine = computed(() =>
  todayState.value.known
    ? splitNumber(t("nav.todayPosts", { n: NUMBER_SLOT }), NUMBER_SLOT)
    : { before: t("nav.todayUnknown"), after: "" }
);
const todayPosts = computed(() => compactCount(todayState.value.posts, locale.value));

function readHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((item) => typeof item === "string" && item.trim()).slice(0, 5) : [];
  } catch {
    return [];
  }
}

function remember(q) {
  const next = [q, ...readHistory().filter((item) => item !== q)].slice(0, 5);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  history.value = next;
}

// 搜索入口暂时从顶栏收起，弹层和检索逻辑仍然保留，供窄屏之外再放入口时复用。
async function openSearch() {
  history.value = readHistory();
  searchOpen.value = true;
  await nextTick();
  searchInput.value?.focus({ preventScroll: true });
}

function openOwner() {
  ownerDialog.value?.open();
}

function closeSearch() {
  searchOpen.value = false;
}

function search(text = query.value) {
  const q = String(text || "").trim();
  if (!q) return;
  query.value = q;
  remember(q);
  searchOpen.value = false;
  router.push({ name: "discover", query: { q } });
}

function sponsorMark(title) {
  const text = String(title || "").trim();
  return text ? text.slice(0, 1) : mark.value;
}

function brandHref() {
  // 标识就回首页：能浏览的人回信息流，不能浏览的访客回登录页。
  return session.canBrowse ? "/discover" : "/";
}

function refreshBrand(event) {
  event.preventDefault();
  const target = brandHref();
  const clean = window.location.pathname === target && !window.location.search && !window.location.hash;
  if (clean) window.location.reload();
  else window.location.assign(target);
}

function linkAttrs(href) {
  if (internalHref(href)) return { to: href };
  return { href, target: "_blank", rel: "noopener noreferrer" };
}

function pageBlocked() {
  if (outbox.jobs.length) return true;
  return hasDraft(document);
}

function reloadPage() {
  window.location.reload();
}

// 浏览器标签与搜索结果里的标题跟路由走，别停留在默认的 Knot。
// 只写站点名会把 /discover 自己那份页标题盖掉，每页都只剩站点名。
//
// canonical 一起更新：SPA 内跳转不重新取 HTML，head 不动的话，从首页点进
// /discover 之后页面仍然声明自己就是首页，服务端那份独立的 canonical 等于白写。
watchEffect(() => {
  if (typeof document === "undefined") return;
  const name = siteName.value;
  document.title = pageTitle({ routeName: route.name, siteName: name, t });

  const href = canonicalUrl(window.location.origin, route.path);
  let link = document.querySelector('link[rel="canonical"]');
  if (!link) {
    link = document.createElement("link");
    link.setAttribute("rel", "canonical");
    document.head.appendChild(link);
  }
  link.setAttribute("href", href);
});

watch(
  () => outbox.jobs.map((job) => `${job.id}:${job.status}`).join(","),
  () => releaseWatch?.poke()
);

// 站点开关与会话晚于首帧到齐：第一次就赶上「不知道能不能浏览」，那一轮问不出去。
// 条件一旦成立就补问一次，不必等到下一分钟。
watch(
  () => session.canBrowse && session.site.publicBoard !== false,
  (ok) => {
    if (ok) void today.poll();
  }
);

// 自己刚发完一条：顶栏的数字立刻跟上，不用等下一轮。这和别人的新帖是两件事，
// 但读的人看到的都是「刚刚多了」，不该差一分钟。
watch(
  () => outbox.revision,
  (revision) => {
    if (revision) void today.poll();
  }
);

onMounted(() => {
  // 首帧先用公开快照里的那一份，随后由轮询把数字走起来。
  today.seed();
  todayPoll = startPolling({
    fn: () => today.poll(),
    intervalMs: TODAY_POLL_MS,
    immediate: true,
    // 没有公开快照（或访客不能浏览）时没有这个数可问，别让一条必输的请求每分钟撞一次。
    when: () => session.canBrowse && session.site.publicBoard !== false,
  });
  // 首屏的未读数由 /api/web/home 一起带回来，这里不再单独取一次。
  // 轮询只要那个数字，不把整箱通知每 30 秒拖过一次隧道。
  notificationsPoll = startPolling({
    fn: () => notifications.poll(),
    intervalMs: NOTIFICATIONS_POLL_MS,
    when: () => Boolean(session.user),
  });
  releaseWatch = startReleaseWatch({
    current: () => runningEntry(document),
    fetchText: async () => {
      const response = await fetch("/index.html", { cache: "no-store" });
      if (!response.ok) throw new Error("release");
      return response.text();
    },
    blocked: pageBlocked,
    reload: reloadPage,
    onPending: (show) => {
      updateReady.value = show;
    },
    document,
  });
  listSponsors()
    .then((data) => {
      sponsors.value = Array.isArray(data.sponsors) ? data.sponsors : [];
    })
    .catch(() => {
      sponsors.value = [];
    });
});

onUnmounted(() => {
  releaseWatch?.stop();
  releaseWatch = null;
  notificationsPoll?.stop();
  notificationsPoll = null;
  todayPoll?.stop();
  todayPoll = null;
});
</script>

<template>
  <div class="app-frame">
    <a href="#main-content" class="skip-link">{{ t("app.skipToContent") }}</a>
    <header class="site-header">
      <div class="header-bar">
        <template v-if="!searchOpen">
          <div class="header-side header-side-start">
            <a
              :href="brandHref()"
              class="brand"
              :aria-label="t('brand.xknotHome', { name: siteName })"
              @click="refreshBrand"
            >
              <XknotMark class="brand-logo" />
            </a>
            <div class="header-locale">
              <LocaleSwitch variant="menu" />
            </div>
          </div>
          <button
            type="button"
            class="site-title"
            :title="siteName"
            :aria-label="t('owner.open', { name: siteName })"
            :aria-describedby="showToday ? 'site-today' : undefined"
            aria-haspopup="dialog"
            @click="openOwner"
          >
            <span class="site-name">{{ siteName }}</span>
            <!-- 这个站的今日脉搏：数字为主，标签为辅，脉冲点说明十五分钟内还有人发。
                 整块仍在这一枚按钮里，点它还是打开主理人弹窗，不新增第二个点击目标。 -->
            <span v-if="showToday" id="site-today" class="site-today" :class="{ 'is-live': todayState.live }">
              <span class="site-today-dot" aria-hidden="true"></span>
              <span class="site-today-count">{{ todayLine.before }}<b v-if="todayState.known">{{ todayPosts }}</b>{{ todayLine.after }}</span>
            </span>
          </button>
          <div class="header-side header-side-end">
            <AppButton v-if="session.canBrowse && session.storeEnabled" variant="icon" to="/store" :aria-label="t('nav.store')">
              <CoinIcon class="nav-icon" weight="header" aria-hidden="true" />
            </AppButton>
            <AppButton v-if="session.user" variant="icon" to="/notifications" :aria-label="t('nav.notifications')">
              <BellIcon class="nav-icon" weight="header" aria-hidden="true" />
              <span v-if="notifications.unread > 0" class="nav-badge">{{
                notifications.unread > 99 ? "99+" : notifications.unread
              }}</span>
            </AppButton>
            <AppButton
              variant="icon"
              :to="session.user ? '/mine' : '/'"
              class="header-account"
              :class="{ 'has-photo': Boolean(session.user?.avatarUrl) }"
              :aria-label="session.user ? t('nav.mine') : t('remember.guestAction')"
            >
              <img v-if="session.user?.avatarUrl" class="header-avatar" :src="session.user.avatarUrl" alt="" />
              <UserIcon v-else filled weight="header" class="nav-icon" aria-hidden="true" />
            </AppButton>
          </div>
        </template>
        <form v-else class="header-search" role="search" @submit.prevent="search()">
          <AppButton variant="icon" plain :aria-label="t('search.back')" @click="closeSearch">
            <BackIcon class="nav-icon" weight="header" aria-hidden="true" />
          </AppButton>
          <label class="search-field">
            <SearchIcon class="header-search-icon" aria-hidden="true" />
            <input
              ref="searchInput"
              v-model="query"
              type="search"
              enterkeyhint="search"
              :placeholder="t('nav.searchPlaceholder')"
              :aria-label="t('nav.search')"
              @keydown.esc="closeSearch"
            />
          </label>
        </form>
      </div>
    </header>
    <SiteOwnerDialog ref="ownerDialog" />
    <CardShareDialog />
    <CardTipDialog />
    <div v-if="updateReady" class="release-note" role="status">
      <p>{{ t("release.ready") }}</p>
      <AppButton variant="secondary" @click="reloadPage">{{ t("release.reload") }}</AppButton>
    </div>
    <Teleport to="body">
      <button v-if="searchOpen" type="button" class="search-backdrop" :aria-label="t('search.back')" @click="closeSearch" />
      <div v-if="searchOpen && history.length" class="search-sheet">
        <div class="search-history">
          <p class="search-recent">{{ t("search.recent") }}</p>
          <ul>
            <li v-for="item in history" :key="item">
              <button type="button" @click="search(item)">
                <span class="history-mark" aria-hidden="true">
                  <ClockIcon class="nav-icon" />
                </span>
                <span class="history-text">{{ item }}</span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </Teleport>
    <div class="stage">
      <nav class="rail rail-shortcuts" :aria-label="t('rail.shortcuts')">
        <div class="shortcut-list">
          <RouterLink
            :to="session.user ? { name: 'mine' } : { name: 'gate' }"
            class="shortcut"
            :active-class="session.user ? 'router-link-active' : ''"
          >
            <UserIcon class="shortcut-icon" aria-hidden="true" />
            <span class="shortcut-label">{{ t("nav.mine") }}</span>
          </RouterLink>
          <RouterLink :to="{ name: 'stars' }" class="shortcut">
            <StarIcon class="shortcut-icon" aria-hidden="true" />
            <span class="shortcut-label">{{ t("rail.stars") }}</span>
          </RouterLink>
          <RouterLink :to="{ name: 'friends' }" class="shortcut">
            <FriendsIcon class="shortcut-icon" aria-hidden="true" />
            <span class="shortcut-label">{{ t("rail.friends") }}</span>
          </RouterLink>
          <!-- Agent 指引在联邦中枢，是个外部链接，所以用 a 不用 RouterLink。 -->
          <a :href="session.agentDoc.page" class="shortcut" target="_blank" rel="noopener noreferrer">
            <HelpIcon class="shortcut-icon" aria-hidden="true" />
            <span class="shortcut-label">{{ t("rail.help") }}</span>
          </a>
        </div>
        <div class="rail-locale">
          <LocaleSwitch variant="field" />
        </div>
      </nav>
      <main id="main-content" class="layout">
        <RememberLoginCard />
        <p v-if="session.user && session.agentDelegated === false" class="agent-login-guide" role="status">
          {{ t("agentGuide.hint", { doc: session.agentDoc.raw, origin: siteOrigin }) }}
        </p>
        <OutboxNotice />
        <slot />
      </main>
      <aside v-if="sponsors.length" class="rail rail-sponsor" :aria-label="t('rail.sponsored')">
        <p class="rail-label">{{ t("rail.sponsored") }}</p>
        <div class="sponsor-list">
          <component
            :is="internalHref(item.href) ? 'RouterLink' : 'a'"
            v-for="item in sponsors"
            :key="item.id"
            class="sponsor-card"
            v-bind="linkAttrs(item.href)"
          >
            <span class="sponsor-media" aria-hidden="true">
              <img v-if="item.image" class="sponsor-photo" :src="item.image" alt="" loading="lazy" decoding="async" />
              <span v-else class="brand-mark">{{ sponsorMark(item.title) }}</span>
            </span>
            <span class="sponsor-copy">
              <span class="sponsor-title">{{ item.title }}</span>
              <span v-if="item.caption" class="sponsor-caption">{{ item.caption }}</span>
              <span v-if="item.source" class="sponsor-source">{{ item.source }}</span>
              <span class="sponsor-meta">{{ t("rail.sponsorMeta") }}</span>
            </span>
          </component>
        </div>
      </aside>
    </div>
  </div>
</template>

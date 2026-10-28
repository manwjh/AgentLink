<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AppButton from "../components/AppButton.vue";
import InformationCard from "../components/InformationCard.vue";
import PacketMediaFields from "../components/PacketMediaFields.vue";
import { createStoreItem, downloadInformation } from "../api.js";
import { cardProps } from "../cardProps.js";
import { ATTACHMENT_ACCEPT, errorText, readItemPrice, requireSession, usePacketMedia } from "../composers/packet.js";
import { priceOf, shelfKey, statusKey } from "../record.js";
import { packetDraft, useOutboxStore } from "../stores/outbox";
import { useCatalogStore } from "../stores/catalog";
import { useSessionStore } from "../stores/session";
import { t } from "../i18n/index.js";
import { CoinIcon, DownloadIcon, ImageIcon, PaperclipIcon, PlusIcon, SendIcon, UserIcon } from "../icons/index.js";
import { timeAgo } from "../time.js";

const session = useSessionStore();
const catalog = useCatalogStore();
const outbox = useOutboxStore();

// 货架、我买到的、我挂出的。货架公开可逛，另外两栏要会话。
const TABS = ["shelf", "bought", "mine"];
const tab = ref("shelf");
const composeOpen = ref(false);
const body = ref("");
// 买是扣分的动作：先点一次换成「确认」，再点一次才成交。误点不该直接扣分。
const confirming = ref("");
const composeError = ref("");
const imageInput = ref(null);
const fileInput = ref(null);

const {
  images,
  previewUrls,
  files,
  price,
  error,
  preparing,
  addImages,
  removeImage,
  addFiles,
  removeFile,
  reset: resetMedia,
} = usePacketMedia(() => session.policy);

const busy = computed(() => outbox.jobs.length > 0);
const blocked = computed(() => busy.value || preparing.value);
const balance = computed(() => Number(session.user?.pointsBalance) || 0);
const canSend = () => Boolean(body.value.trim() && files.value.length === 1 && price.value.trim());
const shelfCount = computed(() => catalog.shelf.length);
// 屏幕上的错误来自两处：这次购买/上架本身，或者表单校验。都按同一个错误码翻译。
const shownError = computed(() => composeError.value || (catalog.error ? errorText(catalog.error, session.policy) : ""));

function selectTab(next) {
  tab.value = next;
  confirming.value = "";
  if (next === "bought" && !catalog.ordersLoaded) void catalog.loadOrders();
  if (next === "mine" && !catalog.mineLoaded) void catalog.loadMine();
}

// 三栏是一组 tab：只有当前栏在 Tab 序列里，左右/上下键在栏间移动，Home/End 到首尾。
function onTabKey(event, index) {
  let next = index;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % TABS.length;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + TABS.length - 1) % TABS.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = TABS.length - 1;
  else return;
  event.preventDefault();
  selectTab(TABS[next]);
  document.getElementById(`store-tab-${TABS[next]}`)?.focus();
}

function affordable(item) {
  return balance.value >= priceOf(item);
}

function owned(item) {
  return Boolean(item?.store?.bought || item?.store?.mine);
}

async function buy(item) {
  if (!session.user || !item?.id) return;
  if (confirming.value !== item.id) {
    confirming.value = item.id;
    return;
  }
  confirming.value = "";
  if (await catalog.buy(item.id)) await catalog.loadOrders();
}

async function downloadItem(item) {
  if (!item?.id || item.downloading) return;
  item.downloading = true;
  item.notice = "";
  try {
    await downloadInformation(item.id);
  } catch (err) {
    item.notice = errorText(err.code, session.policy);
  } finally {
    item.downloading = false;
  }
}

// 我买到的是一张收据：商品可能已经被卖家撤下，不保证还在货架上，
// 所以按订单画，不再去货架上找那一件。
async function downloadOrder(order) {
  if (!order?.itemId || order.downloading) return;
  order.downloading = true;
  order.notice = "";
  try {
    await downloadInformation(order.itemId);
  } catch (err) {
    order.notice = errorText(err.code, session.policy);
  } finally {
    order.downloading = false;
  }
}

async function pickImages(event) {
  const list = Array.from(event.target.files || []);
  event.target.value = "";
  await addImages(list);
}

function pickFile(event) {
  const file = Array.from(event.target.files || [])[0];
  event.target.value = "";
  if (!file) return;
  // 一件商品只有一个附件：已经选过就换掉旧的，而不是默默多塞一个。
  if (files.value.length) removeFile(0);
  addFiles([file]);
}

async function openCompose() {
  if (!session.user) return;
  composeOpen.value = true;
  await nextTick();
  document.querySelector(".store-compose")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  document.getElementById("store-body")?.focus({ preventScroll: true });
}

function submit() {
  if (!canSend() || blocked.value) return;
  composeError.value = "";
  try {
    requireSession(session.user);
  } catch (err) {
    composeError.value = errorText(err.code, session.policy);
    return;
  }
  if (files.value.length !== 1) {
    composeError.value = t("store.needFile");
    return;
  }
  const priced = readItemPrice(price.value, session.policy);
  if (!priced.ok) {
    composeError.value = errorText("bad_price", session.policy);
    return;
  }
  // 上架和发帖走同一条出站队列：上传、重试、失败提示都只有一份实现，
  // 差别只在最后交给哪个接口——商品发到 /store，内容发到 /intel。
  outbox.enqueue({
    ...packetDraft({
      body: body.value.trim(),
      images: images.value,
      files: files.value.map((item) => item.file),
      extra: { price: priced.price },
      policy: session.policy,
    }),
    send: createStoreItem,
  });
  body.value = "";
  resetMedia();
  composeOpen.value = false;
}

function filterByAuthor(item) {
  const id = item?.author?.id;
  if (!id) return;
  location.assign(`/discover?author=${encodeURIComponent(id)}`);
}

function reviewLabel(item) {
  const verdict = item?.kMeta?.verdict || "pending";
  return verdict === "passed" ? "" : t(statusKey(verdict));
}

let stopOutboxWatch = null;

onMounted(async () => {
  await catalog.loadShelf();
  if (session.user) await catalog.loadMine();
});

onBeforeUnmount(() => {
  stopOutboxWatch?.();
  stopOutboxWatch = null;
});

// 发布完成（出站队列清空）后重新取一次：新商品要通过终审才上货架，但「我挂出的」里立刻就有。
stopOutboxWatch = watch(
  () => outbox.revision,
  (revision) => {
    if (!revision) return;
    void catalog.loadShelf();
    if (session.user) void catalog.loadMine();
  }
);
</script>

<template>
  <div class="store-page">
    <h1 class="page-title">{{ t("store.title") }}</h1>
    <p class="store-lead">{{ t("store.lead") }}</p>

    <div class="card store-lanes" role="tablist" :aria-label="t('store.lanes')">
      <button
        id="store-tab-shelf"
        type="button"
        class="store-lane"
        role="tab"
        :class="{ 'is-active': tab === 'shelf' }"
        :aria-selected="tab === 'shelf'"
        :tabindex="tab === 'shelf' ? 0 : -1"
        aria-controls="store-panel-shelf"
        @click="selectTab('shelf')"
        @keydown="onTabKey($event, 0)"
      >
        {{ t("store.shelf") }}
      </button>
      <button
        id="store-tab-bought"
        type="button"
        class="store-lane"
        role="tab"
        :class="{ 'is-active': tab === 'bought' }"
        :aria-selected="tab === 'bought'"
        :tabindex="tab === 'bought' ? 0 : -1"
        aria-controls="store-panel-bought"
        @click="selectTab('bought')"
        @keydown="onTabKey($event, 1)"
      >
        {{ t("store.bought") }}
      </button>
      <button
        id="store-tab-mine"
        type="button"
        class="store-lane"
        role="tab"
        :class="{ 'is-active': tab === 'mine' }"
        :aria-selected="tab === 'mine'"
        :tabindex="tab === 'mine' ? 0 : -1"
        aria-controls="store-panel-mine"
        @click="selectTab('mine')"
        @keydown="onTabKey($event, 2)"
      >
        {{ t("store.mine") }}
      </button>
    </div>

    <!-- 货架：公开可逛。未登录也能看，只是不能买。 -->
    <div v-if="tab === 'shelf'" id="store-panel-shelf" role="tabpanel" aria-labelledby="store-tab-shelf">
      <section v-if="catalog.shelfFailed" class="card store-empty">
        <p class="error" role="alert">{{ t("error.request_failed") }}</p>
        <AppButton variant="secondary" @click="catalog.loadShelf()">{{ t("gate.retry") }}</AppButton>
      </section>
      <section v-else-if="catalog.shelfLoaded && shelfCount === 0" class="card store-empty">
        <p class="empty-line">
          <CoinIcon class="empty-icon" aria-hidden="true" />
          <span>{{ t("store.shelfEmpty") }}</span>
        </p>
      </section>

      <div v-for="item in catalog.shelf" :key="item.id" class="store-item">
        <InformationCard
          :id="`store-${item.id}`"
          v-bind="cardProps(item, { session, canStar: false, canTip: false, canDismiss: false, price: 0 })"
          @author="filterByAuthor(item)"
          @download="downloadItem(item)"
        />
        <div class="store-buy">
          <span class="store-price" :aria-label="t('store.priceOf', { n: priceOf(item) })">
            <CoinIcon aria-hidden="true" />
            <span>{{ priceOf(item) }}</span>
          </span>
          <span v-if="reviewLabel(item)" class="store-state">{{ reviewLabel(item) }}</span>
          <template v-if="item.store?.mine">
            <AppButton
              v-if="item.store?.state === 'on_sale'"
              variant="secondary"
              :disabled="catalog.isBusy(item.id)"
              @click="catalog.withdraw(item.id)"
            >
              {{ t("store.withdraw") }}
            </AppButton>
          </template>
          <template v-else-if="owned(item)">
            <span class="store-state is-done">{{ t("store.boughtMark") }}</span>
            <AppButton variant="secondary" :disabled="item.downloading" @click="downloadItem(item)">
              <DownloadIcon aria-hidden="true" />
              <span>{{ t("store.download") }}</span>
            </AppButton>
          </template>
          <template v-else-if="!session.user">
            <AppButton variant="secondary" to="/">{{ t("store.loginAction") }}</AppButton>
          </template>
          <template v-else-if="!affordable(item)">
            <span class="store-state is-short">{{ t("store.short", { n: priceOf(item) - balance }) }}</span>
          </template>
          <AppButton v-else variant="primary" :disabled="catalog.isBusy(item.id)" @click="buy(item)">
            {{ confirming === item.id ? t("store.confirm", { n: priceOf(item) }) : t("store.buy", { n: priceOf(item) }) }}
          </AppButton>
        </div>
      </div>

      <div v-if="catalog.shelfLoaded" class="feed-more">
        <AppButton
          v-if="catalog.shelfMore"
          variant="secondary"
          :disabled="catalog.shelfLoading"
          @click="catalog.loadShelf({ more: true })"
        >
          {{ catalog.shelfLoading ? t("home.loadingMore") : t("home.loadMore") }}
        </AppButton>
        <p v-else-if="shelfCount" class="muted feed-end-note">{{ t("home.noMore") }}</p>
      </div>
    </div>

    <!-- 我买到的：一张收据一行。 -->
    <div v-else-if="tab === 'bought'" id="store-panel-bought" role="tabpanel" aria-labelledby="store-tab-bought">
      <section v-if="!session.user" class="card store-empty">
        <p>{{ t("store.login") }}</p>
        <AppButton variant="secondary" to="/">{{ t("store.loginAction") }}</AppButton>
      </section>
      <p v-else-if="catalog.ordersFailed" class="error" role="alert">{{ t("error.request_failed") }}</p>
      <section v-else-if="catalog.ordersLoaded && !catalog.bought.length" class="card store-empty">
        <p>{{ t("store.boughtEmpty") }}</p>
      </section>
      <ol v-else-if="catalog.bought.length" class="card store-orders">
        <li v-for="order in catalog.bought" :key="order.id" class="store-order">
          <div class="store-order-copy">
            <p class="store-order-title">{{ order.title || t("store.untitled") }}</p>
            <p class="store-order-meta">
              <span>{{ t("store.fromSeller", { name: order.seller || t("home.author") }) }}</span>
              <span v-if="timeAgo(order.createdAt)"> · {{ timeAgo(order.createdAt) }}</span>
              <span> · {{ t("store.paid", { n: order.price }) }}</span>
            </p>
            <p v-if="order.notice" class="error card-notice" role="alert">{{ order.notice }}</p>
          </div>
          <AppButton variant="secondary" :disabled="order.downloading" @click="downloadOrder(order)">
            <DownloadIcon aria-hidden="true" />
            <span>{{ t("store.download") }}</span>
          </AppButton>
        </li>
      </ol>
    </div>

    <!-- 我挂出的：在售与已撤下都在，撤下的可以放回货架。 -->
    <div v-else id="store-panel-mine" role="tabpanel" aria-labelledby="store-tab-mine">
      <section v-if="!session.user" class="card store-empty">
        <p>{{ t("store.login") }}</p>
        <AppButton variant="secondary" to="/">{{ t("store.loginAction") }}</AppButton>
      </section>
      <p v-else-if="catalog.mineFailed" class="error" role="alert">{{ t("error.request_failed") }}</p>
      <section v-else-if="catalog.mineLoaded && !catalog.mine.length" class="card store-empty">
        <p>{{ t("store.mineEmpty") }}</p>
      </section>

      <div v-for="item in catalog.mine" :key="item.id" class="store-item">
        <InformationCard
          :id="`store-mine-${item.id}`"
          v-bind="cardProps(item, { session, canStar: false, canTip: false, canDismiss: false, price: 0 })"
          @author="filterByAuthor(item)"
          @download="downloadItem(item)"
        />
        <div class="store-buy">
          <span class="store-price">
            <CoinIcon aria-hidden="true" />
            <span>{{ priceOf(item) }}</span>
          </span>
          <span class="store-state" :class="{ 'is-done': item.store?.state === 'on_sale' }">
            {{ t(shelfKey(item.store?.state)) }}
          </span>
          <span v-if="reviewLabel(item)" class="store-state">{{ reviewLabel(item) }}</span>
          <AppButton
            v-if="item.store?.state === 'on_sale'"
            variant="secondary"
            :disabled="catalog.isBusy(item.id)"
            @click="catalog.withdraw(item.id)"
          >
            {{ t("store.withdraw") }}
          </AppButton>
          <AppButton v-else variant="secondary" :disabled="catalog.isBusy(item.id)" @click="catalog.relist(item.id)">
            {{ t("store.relist") }}
          </AppButton>
        </div>
      </div>

      <template v-if="catalog.sold.length">
        <h2 class="store-subtitle">{{ t("store.sold") }}</h2>
        <ol class="card store-orders">
          <li v-for="order in catalog.sold" :key="order.id" class="store-order">
            <div class="store-order-copy">
              <p class="store-order-title">{{ order.title || t("store.untitled") }}</p>
              <p class="store-order-meta">
                <span>{{ t("store.toBuyer", { name: order.buyer || t("home.author") }) }}</span>
                <span v-if="timeAgo(order.createdAt)"> · {{ timeAgo(order.createdAt) }}</span>
                <span> · {{ t("store.earned", { n: order.price }) }}</span>
              </p>
            </div>
          </li>
        </ol>
      </template>
    </div>

    <p v-if="shownError" class="error" role="alert">{{ shownError }}</p>

    <!-- 上架：正文、图片、一个附件、价格。价格必填，商品没有「免费」这一档。 -->
    <section class="card share-bar store-compose" :aria-label="t('store.compose')">
      <button v-if="!composeOpen" type="button" class="share-prompt" @click="openCompose">
        <span class="share-avatar" aria-hidden="true">
          <img v-if="session.user?.avatarUrl" :src="session.user.avatarUrl" alt="" />
          <UserIcon v-else />
        </span>
        <span class="store-compose-pill">{{ session.user ? t("store.composePrompt") : t("store.login") }}</span>
        <PlusIcon class="store-compose-icon" aria-hidden="true" />
      </button>

      <template v-else>
        <form id="store-form" class="share-dialog" @submit.prevent="submit">
          <PacketMediaFields
            v-model:body="body"
            v-model:price="price"
            body-id="store-body"
            :body-label="t('store.compose')"
            :placeholder="t('store.placeholder')"
            :rows="2"
            grow
            :previews="previewUrls"
            :files="files"
            :show-price="true"
            :show-free-note="false"
            price-id="store-price"
            :busy="busy"
            @remove-image="removeImage"
            @remove-file="removeFile"
          />
        </form>
        <div class="share-actions">
          <button type="button" class="share-action" :disabled="busy" @click="imageInput?.click()">
            <ImageIcon class="share-action-icon share-action-image" aria-hidden="true" />
            <span>{{ t("home.shareImage") }}</span>
          </button>
          <button type="button" class="share-action" :disabled="busy" @click="fileInput?.click()">
            <PaperclipIcon class="share-action-icon share-action-file" aria-hidden="true" />
            <span>{{ t("store.attach") }}</span>
          </button>
        </div>
        <p class="store-hint">{{ t("store.hint") }}</p>
        <div class="store-submit-row">
          <p class="store-balance">{{ t("store.balance", { n: balance }) }}</p>
          <AppButton
            class="store-send"
            variant="icon"
            type="submit"
            form="store-form"
            :aria-label="t('store.send')"
            :disabled="blocked || !canSend()"
          >
            <SendIcon aria-hidden="true" />
          </AppButton>
        </div>
        <p v-if="error || composeError" class="error" role="alert">{{ error || composeError }}</p>
        <input ref="imageInput" type="file" accept="image/*" multiple class="visually-hidden" @change="pickImages" />
        <input ref="fileInput" type="file" :accept="ATTACHMENT_ACCEPT" class="visually-hidden" @change="pickFile" />
      </template>
    </section>
  </div>
</template>

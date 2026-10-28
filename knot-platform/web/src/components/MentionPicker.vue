<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { t } from "../i18n/index.js";
import { CloseIcon, UserIcon } from "../icons/index.js";
import { mentionAt, withoutMention } from "../mentions.js";
import { useFriendStore } from "../stores/friends";

const mentions = defineModel({ default: () => [] });
const body = defineModel("body", { type: String, default: "" });
const open = defineModel("open", { type: Boolean, default: false });
const emit = defineEmits(["picked", "active"]);

const props = defineProps({
  disabled: { type: Boolean, default: false },
  // 光标位置。没有光标信息时退化成「整段文本的结尾」。
  caret: { type: Number, default: -1 },
  // 浮在光标下方，还是留在文档流里（快拍沿用后者）。
  floating: { type: Boolean, default: false },
  listId: { type: String, default: "mention-list" },
  // 浮层测量用：输入框元素本身。浮层相对它所在的定位祖先定位。
  anchor: { type: Object, default: null },
});

const friends = useFriendStore();
const menuEl = ref(null);
const activeIndex = ref(0);
const anchorLeft = ref(0);
const anchorTop = ref(0);
const anchorWidth = ref(0);

const caretAt = computed(() => {
  const value = String(body.value || "");
  const at = Number(props.caret);
  return at >= 0 && at <= value.length ? at : value.length;
});
const query = computed(() => mentionAt(body.value, caretAt.value)?.query ?? null);
const visible = computed(() =>
  friends.items.filter((friend) => {
    if (mentions.value.some((item) => item.id === friend.id)) return false;
    const q = String(query.value || "").trim().toLowerCase();
    if (!q) return true;
    return (friend.displayName || "").toLowerCase().includes(q);
  })
);

// 出现 @ 时才去问好友：连续打字不再一次一字地重复请求，只在刚进入 @ 时取一次。
// 取回来后 visible 变长，下面的 watch 会把列表弹出来。
watch(query, (value, prev) => {
  if (value === null) return;
  if (prev === null || !friends.loaded) friends.load();
});

// 有 @ 且确实有可选的人，才弹这个面板。空面板只是盖住正文，什么也没给：
// 没有好友、搜不到、没登录，都按「什么都没发生」处理，Enter 照常发出去。
watch(
  [query, () => visible.value.length],
  ([value, count]) => {
    open.value = value !== null && count > 0;
    if (open.value) activeIndex.value = 0;
  }
);

watch(
  () => visible.value.length,
  (length) => {
    if (!length) activeIndex.value = 0;
    else if (activeIndex.value >= length) activeIndex.value = length - 1;
  }
);

watch(
  [() => open.value, activeIndex, () => visible.value.map((friend) => friend.id).join(",")],
  ([isOpen]) => emit("active", isOpen ? optionId(visible.value[activeIndex.value]) : ""),
  { immediate: true }
);

// 浮层跟着光标行：展开的输入框里，菜单停在正在打字的下一行，而不是整块输入的末尾。
function measureCaret(el) {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  const style = window.getComputedStyle(el);
  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "0";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.overflow = "hidden";
  mirror.style.height = "auto";
  mirror.style.boxSizing = style.boxSizing;
  mirror.style.width = `${el.offsetWidth}px`;
  mirror.style.font = style.font;
  mirror.style.lineHeight = style.lineHeight;
  mirror.style.letterSpacing = style.letterSpacing;
  mirror.style.padding = style.padding;
  mirror.style.border = style.border;
  mirror.textContent = String(el.value || "").slice(0, caretAt.value);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  try {
    return {
      top: marker.offsetTop - el.scrollTop,
      height: marker.offsetHeight || parseFloat(style.lineHeight) || 20,
    };
  } finally {
    mirror.remove();
  }
}

function placeMenu() {
  if (!props.floating) return;
  const el = props.anchor;
  const menu = menuEl.value;
  if (!el || !menu) return;
  const point = measureCaret(el);
  const line = point?.height || 20;
  // 坐标相对最近的定位祖先（.share-body-wrap）算，菜单与输入框共用同一个祖先。
  anchorTop.value = el.offsetTop + (point ? point.top + line : el.clientHeight) + 4;
  anchorLeft.value = el.offsetLeft;
  anchorWidth.value = el.offsetWidth;
}

watch(
  [open, () => query.value, () => caretAt.value, () => props.anchor],
  async () => {
    if (!open.value) return;
    await nextTick();
    placeMenu();
  }
);

onMounted(() => {
  if (props.floating) window.addEventListener("resize", placeMenu);
});
onBeforeUnmount(() => {
  if (props.floating) window.removeEventListener("resize", placeMenu);
});

function optionId(friend) {
  return friend ? `${props.listId}-${friend.id}` : "";
}

function nameOf(friend) {
  return friend.displayName || t("home.author");
}

function pick(friend) {
  if (!friend) return false;
  if (!mentions.value.some((item) => item.id === friend.id)) {
    mentions.value = [...mentions.value, { id: friend.id, displayName: friend.displayName || "" }];
  }
  // 正文只留下前后文，@ 不写进去；光标回到原来 @ 的位置。
  const next = withoutMention(body.value, caretAt.value);
  body.value = next.text;
  open.value = false;
  emit("active", "");
  emit("picked", next.caret);
  return true;
}

function remove(id) {
  mentions.value = mentions.value.filter((item) => item.id !== id);
}

function move(delta) {
  const count = visible.value.length;
  if (!count) return;
  activeIndex.value = (activeIndex.value + delta + count) % count;
}

function selectActive() {
  return pick(visible.value[activeIndex.value]);
}

function dismiss() {
  open.value = false;
}

defineExpose({ move, selectActive, dismiss });
</script>

<template>
  <div v-if="mentions.length || open" class="mention-box">
    <ul v-if="mentions.length" class="mention-chips">
      <li v-for="friend in mentions" :key="friend.id">
        <button
          type="button"
          class="mention-chip"
          :disabled="disabled"
          :aria-label="t('home.mentionRemove', { name: nameOf(friend) })"
          @click="remove(friend.id)"
        >
          <span>@{{ nameOf(friend) }}</span>
          <CloseIcon aria-hidden="true" />
        </button>
      </li>
    </ul>
    <ul
      v-if="open && visible.length"
      :id="listId"
      ref="menuEl"
      class="mention-menu"
      :class="{ 'is-floating': floating }"
      :style="floating ? { top: `${anchorTop}px`, left: `${anchorLeft}px`, width: `${anchorWidth}px` } : undefined"
      role="listbox"
      :aria-label="t('home.mention')"
    >
      <li v-for="(friend, index) in visible" :key="friend.id" role="presentation">
        <button
          :id="optionId(friend)"
          type="button"
          class="mention-option"
          :class="{ 'is-active': index === activeIndex }"
          role="option"
          :aria-selected="index === activeIndex"
          tabindex="-1"
          :disabled="disabled"
          @mousedown.prevent
          @click="pick(friend)"
        >
          <span class="mention-avatar" aria-hidden="true">
            <img v-if="friend.avatarUrl" :src="friend.avatarUrl" alt="" />
            <UserIcon v-else />
          </span>
          <span>{{ nameOf(friend) }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

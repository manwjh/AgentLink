<script setup>
import { computed, nextTick, ref, watch } from "vue";
import AppButton from "./AppButton.vue";
import MentionPicker from "./MentionPicker.vue";
import { fitTextarea } from "../composers/autoGrow.js";
import { MAX_IMAGES, errorText, requireSession, usePacketMedia } from "../composers/packet.js";
import { t } from "../i18n/index.js";
import { CameraIcon, CloseIcon, PlusIcon } from "../icons/index.js";
import { packetDraft, useOutboxStore } from "../stores/outbox";
import { useSessionStore } from "../stores/session";

const emit = defineEmits(["close", "done"]);

const session = useSessionStore();
const outbox = useOutboxStore();
const body = ref("");
const mentions = ref([]);
const mentionOpen = ref(false);
// @ 弹层要认光标，不然在正文中间打 @ 时查的是整段结尾的词。
const caret = ref(0);
const mentionPicker = ref(null);
const activeMentionId = ref("");
const composing = ref(false);
// 预览图的生命周期与数量/体积上限都交给 usePacketMedia：快拍和分享条用的是同一套规则，
// 两处各写一份的话改一处就会两边筛得不一样。
const { images, previewUrls, error, preparing, addImages, removeImage } = usePacketMedia(() => session.policy);
const photoIndex = ref(0);
const isPublic = ref(true);
const sending = ref(false);
// 压缩期间只收紧「提交」这一个口子：正文、切换、删除、关闭都不该被冻住——
// 九张图要压十几秒，整张表单失去响应只会让人以为卡死了。
const busy = computed(() => sending.value);
const blocked = computed(() => busy.value || preparing.value);
const imageInput = ref(null);
const captionInput = ref(null);
const formEl = ref(null);
const photoActive = computed(() => {
  const last = previewUrls.value.length - 1;
  if (last < 0) return 0;
  return Math.min(photoIndex.value, last);
});
const canSend = computed(() => images.value.length > 0 || Boolean(body.value.trim()));

function syncCaret(event) {
  const el = event?.target;
  const at = Number(el?.selectionStart);
  caret.value = Number.isFinite(at) ? at : body.value.length;
}

function onCaptionInput(event) {
  // 高度交给下面的 watch(body)：v-model 先写值，DOM 更新完再量才准。
  syncCaret(event);
}

function onCompositionEnd(event) {
  composing.value = false;
  syncCaret(event);
}

// 正文会在两个位置出现（浮在照片上 / 落在取景框下），宽度一变换行就变，得重新量。
watch(
  () => previewUrls.value.length,
  async () => {
    await nextTick();
    fitTextarea(captionInput.value);
  }
);

// 选中好友、清空草稿这类程序改动也要重算高度。
watch(body, async () => {
  await nextTick();
  fitTextarea(captionInput.value);
});

// 弹层打开时键盘归它：Enter/Tab 选中好友，方向键移动，Esc 收起。
// 没有可选项时 Enter 回到正文里换行（发布用下方的发送键），Tab 照常切换焦点。
function onCaptionKeydown(event) {
  if (composing.value || event.isComposing) return;
  if (!mentionOpen.value) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    mentionPicker.value?.move(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    const picked = mentionPicker.value?.selectActive?.();
    if (picked) {
      event.preventDefault();
      return;
    }
    if (event.key === "Tab") return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    mentionPicker.value?.dismiss?.();
  }
}

function onMentionPicked(index) {
  caret.value = Number(index) || 0;
  nextTick(() => {
    const el = captionInput.value;
    if (!el) return;
    el.focus();
    el.setSelectionRange(caret.value, caret.value);
  });
}

function openCamera() {
  if (images.value.length >= MAX_IMAGES) return;
  imageInput.value?.click();
}

// 好友列表落在取景框下方：正文浮在照片上部，中间隔着一张图。
// 手机键盘把可视区压小后它可能露不出来，所以一展开就把这一条带进视野；
// nearest 只在真的看不见时才滚，桌面上一动都不动。
watch(mentionOpen, async (open) => {
  if (!open) return;
  await nextTick();
  formEl.value?.querySelector(".mention-menu")?.scrollIntoView({ block: "nearest" });
});

async function pickPhoto(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  if (!files.length) return;
  await addImages([files[0]]);
  photoIndex.value = Math.max(0, images.value.length - 1);
  // 贴完图直接把光标放进正文：相机/相册刚让出屏幕，这时接着写字最顺，
  // 也不用先找输入框在哪。滚动留一帧，等键盘把可视区改小之后再对齐。
  nextTick(() => {
    captionInput.value?.focus();
    requestAnimationFrame(() => captionInput.value?.scrollIntoView({ block: "center" }));
  });
}

function removePhoto(index) {
  removeImage(index);
  if (photoIndex.value > index) photoIndex.value -= 1;
}

function submit() {
  if (!canSend.value || blocked.value) return;
  error.value = "";
  try {
    requireSession(session.user);
  } catch (err) {
    error.value = errorText(err.code, session.policy);
    return;
  }
  const extra = { kind: "fastpost", public: isPublic.value };
  if (mentions.value.length) extra.mentions = mentions.value.map((friend) => friend.id);
  sending.value = true;
  outbox.enqueue(packetDraft({
    body: body.value.trim(),
    images: images.value,
    extra,
    policy: session.policy,
  }));
  emit("done");
}

nextTick(openCamera);
</script>

<template>
  <section class="card composer intel-compose is-photo" :aria-label="t('home.storyCreate')">
    <form ref="formEl" class="composer-dialog intel-photo-form" @submit.prevent="submit">
      <input
        ref="imageInput"
        type="file"
        accept="image/*"
        capture="environment"
        class="visually-hidden"
        @change="pickPhoto"
      />
      <div class="intel-photo-stage">
        <div class="intel-photo-frame" :class="{ 'has-photo': previewUrls.length }">
          <img v-if="previewUrls.length" :src="previewUrls[photoActive]" :alt="t('home.image')" class="intel-photo-frame-img" />
          <button v-else type="button" class="intel-photo-empty" :disabled="busy" @click="openCamera">
            <CameraIcon class="intel-camera-icon" aria-hidden="true" />
            <span>{{ t("home.intelCapture") }}</span>
          </button>
          <AppButton
            variant="icon"
            type="button"
            class="intel-photo-close"
            :disabled="busy"
            :aria-label="t('home.dismiss')"
            @click="emit('close')"
          >
            <CloseIcon aria-hidden="true" />
          </AppButton>
          <AppButton
            v-if="previewUrls.length"
            variant="icon"
            type="button"
            class="intel-photo-remove"
            :disabled="busy"
            :aria-label="t('home.remove')"
            @click="removePhoto(photoActive)"
          >
            <CloseIcon aria-hidden="true" />
          </AppButton>
        </div>
        <!-- 正文浮在照片上部、角落两个按钮下面：贴完图不用往下滑就看得见输入框。 -->
        <div class="intel-photo-caption" :class="{ 'is-draft': !previewUrls.length }">
          <label class="visually-hidden" for="intel-photo-caption">{{ t("home.intelPhotoCaption") }}</label>
          <textarea
            id="intel-photo-caption"
            ref="captionInput"
            v-model="body"
            rows="1"
            class="intel-photo-caption-input"
            :placeholder="t('home.intelPhotoCaption')"
            :disabled="busy"
            role="combobox"
            aria-haspopup="listbox"
            aria-autocomplete="list"
            :aria-expanded="mentionOpen ? 'true' : 'false'"
            :aria-controls="mentionOpen ? 'snap-mention-list' : undefined"
            :aria-activedescendant="mentionOpen && activeMentionId ? activeMentionId : undefined"
            @input="onCaptionInput"
            @click="syncCaret"
            @keyup="syncCaret"
            @select="syncCaret"
            @keydown="onCaptionKeydown"
            @compositionstart="composing = true"
            @compositionend="onCompositionEnd"
          />
        </div>
      </div>
      <MentionPicker
        ref="mentionPicker"
        v-model="mentions"
        v-model:body="body"
        v-model:open="mentionOpen"
        :caret="caret"
        :disabled="busy"
        list-id="snap-mention-list"
        @picked="onMentionPicked"
        @active="activeMentionId = $event"
      />
      <div class="intel-photo-bar">
        <div v-if="previewUrls.length" class="intel-photo-strip" :aria-label="t('home.intelCapture')">
          <button
            v-for="(url, index) in previewUrls"
            :key="url"
            type="button"
            class="intel-photo-thumb"
            :class="{ 'is-active': index === photoActive }"
            :aria-pressed="index === photoActive"
            :aria-label="t('home.storyPhotoNth', { n: index + 1 })"
            :disabled="busy"
            @click="photoIndex = index"
          >
            <img :src="url" :alt="t('home.image')" />
          </button>
          <AppButton
            v-if="images.length < MAX_IMAGES"
            variant="icon"
            type="button"
            :disabled="busy"
            :aria-label="t('home.intelAddPhoto')"
            @click="openCamera"
          >
            <PlusIcon aria-hidden="true" />
          </AppButton>
          <span class="intel-photo-count">{{ t("home.storyPhotoCount", { n: previewUrls.length, max: MAX_IMAGES }) }}</span>
        </div>
        <div class="intel-photo-actions">
          <label class="share-public">
            <input v-model="isPublic" type="checkbox" :disabled="busy" />
            <span>{{ isPublic ? t("home.publicOn") : t("home.publicOff") }}</span>
          </label>
          <AppButton type="submit" :disabled="blocked || !canSend">{{ t("home.send") }}</AppButton>
        </div>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </form>
  </section>
</template>

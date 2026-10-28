<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AppButton from "./AppButton.vue";
import MentionPicker from "./MentionPicker.vue";
import { fitTextarea } from "../composers/autoGrow.js";
import { imageFilesFromClipboard } from "../composers/paste.js";
import { ATTACHMENT_ACCEPT, errorText, nameMark, readVideoLink, requireSession, usePacketMedia } from "../composers/packet.js";
import { t } from "../i18n/index.js";
import { AudioIcon, CloseIcon, ImageIcon, PaperclipIcon, SendIcon, UserIcon, VideoIcon } from "../icons/index.js";
import { packetDraft, useOutboxStore } from "../stores/outbox";
import { useSessionStore } from "../stores/session";

const props = defineProps({
  active: { type: Boolean, default: false },
  focusKind: { type: String, default: "text" },
  focusNonce: { type: Number, default: 0 },
});

const emit = defineEmits(["activate", "close", "done"]);

const session = useSessionStore();
const outbox = useOutboxStore();
const body = ref("");
const mentions = ref([]);
const mentionOpen = ref(false);
const activeMentionId = ref("");
const isPublic = ref(false);
const sending = ref(false);
const composing = ref(false);
const caret = ref(0);
const bodyInput = ref(null);
const mentionPicker = ref(null);
const videoInput = ref(null);
const imageInput = ref(null);
const fileInput = ref(null);
const audioInput = ref(null);
const posterInput = ref(null);
const {
  images,
  previewUrls,
  files,
  audio,
  video,
  videoOpen,
  posterFile,
  posterPreview,
  error,
  preparing,
  addImages,
  removeImage,
  addFiles,
  removeFile,
  setAudio,
  removeAudio,
  setPosterFile,
  removePoster,
  reset: resetMedia,
} = usePacketMedia(() => session.policy);
// 压缩期间只收紧提交：正文、附件、删除、关闭都不该被冻住，否则一批九张图压十几秒，
// 表单看起来就是卡死了。提交口子必须在压缩结束前关着，否则会发出缺图的内容。
const busy = computed(() => sending.value);
const blocked = computed(() => busy.value || preparing.value);
const mark = computed(() => nameMark(session.user));
const hasComposerMedia = computed(
  () =>
    previewUrls.value.length > 0 ||
    preparing.value ||
    Boolean(video.value) ||
    videoOpen.value ||
    Boolean(posterPreview.value) ||
    Boolean(audio.value) ||
    files.value.length > 0
);
const canSend = computed(() =>
  isPublic.value &&
  Boolean(
    body.value.trim() ||
      video.value.trim() ||
      images.value.length ||
      files.value.length ||
      audio.value
  )
);

function resetAll() {
  body.value = "";
  mentions.value = [];
  mentionOpen.value = false;
  activeMentionId.value = "";
  isPublic.value = false;
  sending.value = false;
  caret.value = 0;
  resetMedia();
  nextTick(() => fitTextarea(bodyInput.value));
}

function syncCaret(event) {
  const el = event?.target || bodyInput.value;
  const at = Number(el?.selectionStart);
  caret.value = Number.isFinite(at) ? at : body.value.length;
}

async function applyFocus(kind) {
  await nextTick();
  if (kind === "image") {
    imageInput.value?.click();
    return;
  }
  if (kind === "file") {
    fileInput.value?.click();
    return;
  }
  if (kind === "audio") {
    audioInput.value?.click();
    return;
  }
  if (kind === "video") {
    videoOpen.value = true;
    await nextTick();
    videoInput.value?.focus();
    return;
  }
  const el = bodyInput.value;
  el?.focus();
  // 展开后按当前内容量一次：收起时宽度不同，行数会跟着变。
  fitTextarea(el);
  if (el) caret.value = el.value.length;
}

function onBodyFocus() {
  if (!props.active) emit("activate", "text");
}

function onBodyInput(event) {
  // 收起时直接打字也该展开：没有这一步，写了字却看不到插入键和发布键。
  if (!props.active) emit("activate", "text");
  syncCaret(event);
  fitTextarea(event.target);
}

function onCompositionEnd(event) {
  composing.value = false;
  syncCaret(event);
  fitTextarea(event.target);
}

watch(
  () => [props.active, props.focusNonce],
  async ([active, nonce], prev) => {
    if (!active) {
      if (prev?.[0]) resetAll();
      return;
    }
    const opened = !prev || !prev[0] || prev[1] !== nonce;
    if (opened) await applyFocus(props.focusKind);
  }
);

// 正文被程序改动（选中好友、清空草稿）时也重新量高度。
watch(body, async () => {
  await nextTick();
  fitTextarea(bodyInput.value);
});

function onMentionPicked(index) {
  caret.value = Number(index) || 0;
  nextTick(() => {
    const el = bodyInput.value;
    if (!el) return;
    el.focus();
    el.setSelectionRange(caret.value, caret.value);
    fitTextarea(el);
  });
}

function onBodyKeydown(event) {
  // 中文输入法选词时的回车不是「发送」，也不是「选中好友」。
  if (composing.value || event.isComposing) return;
  if (mentionOpen.value) {
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
      // 没有可选项时 Enter 仍按发送处理，Tab 留给焦点。
      if (event.key === "Tab") return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      mentionPicker.value?.dismiss?.();
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    // Enter 发送、Shift+Enter 换行：正文按 Markdown 解析，换行要留一个入口。
    event.preventDefault();
    submit();
  }
}

function onMedia(kind) {
  if (!props.active) {
    emit("activate", kind);
    return;
  }
  if (kind === "image") imageInput.value?.click();
  else if (kind === "file") fileInput.value?.click();
  else if (kind === "audio") audioInput.value?.click();
  else if (kind === "video") {
    videoOpen.value = true;
    nextTick(() => videoInput.value?.focus());
  }
}

async function pickImages(event) {
  const list = Array.from(event.target.files || []);
  // 先清空再等压缩：同一张图压完前又选一次时，input 的值没清就不会触发 change。
  event.target.value = "";
  await addImages(list);
}

function onPaste(event) {
  const pasted = imageFilesFromClipboard(event.clipboardData);
  // 没有图就不拦：文本和链接照常粘进正文。
  if (!pasted.length) return;
  // 有图时连同一份剪贴板里的 HTML、文件名一起丢掉，正文只留用户自己写的内容。
  event.preventDefault();
  if (!props.active) emit("activate", "text");
  // 粘贴的截图统一转 JPEG：不看体积，剪贴板里的 PNG 往往比卡片需要的尺寸大得多。
  void addImages(pasted, { forceJpeg: true });
}

function pickFiles(event) {
  addFiles(Array.from(event.target.files || []));
  event.target.value = "";
}

function pickAudio(event) {
  const file = Array.from(event.target.files || [])[0];
  event.target.value = "";
  if (file) setAudio(file);
}

async function pickPoster(event) {
  const file = Array.from(event.target.files || [])[0];
  event.target.value = "";
  if (file) await setPosterFile(file);
}

function submit() {
  if (!canSend.value || blocked.value || composing.value) return;
  error.value = "";
  const link = readVideoLink(video.value);
  if (link === null) {
    error.value = t("home.badVideo");
    return;
  }
  let videoPayload = null;
  if (link) {
    if (!posterFile.value) {
      error.value = t("home.badPoster");
      return;
    }
    videoPayload = { url: link, posterFile: posterFile.value };
  }
  try {
    requireSession(session.user);
  } catch (err) {
    error.value = errorText(err.code, session.policy);
    return;
  }
  // 内容不带价：post / fastpost 永远是 0，附件免费取。
  const extra = { kind: "post", public: isPublic.value };
  if (mentions.value.length) extra.mentions = mentions.value.map((friend) => friend.id);
  sending.value = true;
  outbox.enqueue(packetDraft({
    body: body.value.trim(),
    images: images.value,
    files: files.value.map((item) => item.file),
    audio: audio.value?.file || null,
    video: videoPayload,
    extra,
    policy: session.policy,
  }));
  emit("done");
}

onMounted(() => window.addEventListener("resize", onWindowResize));
onBeforeUnmount(() => window.removeEventListener("resize", onWindowResize));

function onWindowResize() {
  fitTextarea(bodyInput.value);
}
</script>

<template>
  <section class="card share-bar" :class="{ 'is-open': active }" :aria-label="t('home.sharePrompt')">
    <form id="share-form" class="share-form" @submit.prevent="submit" @paste="onPaste">
      <div class="share-body-wrap">
        <div class="share-prompt">
          <span class="share-avatar" aria-hidden="true">
            <img v-if="session.user?.avatarUrl" :src="session.user.avatarUrl" alt="" />
            <span v-else-if="mark">{{ mark }}</span>
            <UserIcon v-else />
          </span>
          <label class="visually-hidden" for="share-body">{{ t("home.shareKindPacket") }}</label>
          <!-- 上：文本输入。随内容长高，到上限后在框内滚动。 -->
          <textarea
            id="share-body"
            ref="bodyInput"
            v-model="body"
            rows="1"
            class="share-body"
            :placeholder="t('home.sharePlaceholder')"
            :disabled="busy"
            role="combobox"
            aria-haspopup="listbox"
            aria-autocomplete="list"
            :aria-expanded="mentionOpen ? 'true' : 'false'"
            :aria-controls="mentionOpen ? 'share-mention-list' : undefined"
            :aria-activedescendant="mentionOpen && activeMentionId ? activeMentionId : undefined"
            @focus="onBodyFocus"
            @input="onBodyInput"
            @click="syncCaret"
            @keyup="syncCaret"
            @select="syncCaret"
            @keydown="onBodyKeydown"
            @compositionstart="composing = true"
            @compositionend="onCompositionEnd"
          />
        </div>

        <MentionPicker
          ref="mentionPicker"
          v-model="mentions"
          v-model:body="body"
          v-model:open="mentionOpen"
          :caret="caret"
          :disabled="busy"
          floating
          list-id="share-mention-list"
          :anchor="bodyInput"
          @active="activeMentionId = $event"
          @picked="onMentionPicked"
        />
      </div>

      <!-- 中：已经插入的内容。空的时候整块不占位。 -->
      <div v-if="active && hasComposerMedia" class="composer-media">
        <!-- 和货架表单共用一套照片格：三列等宽、方形裁切，换位置不会换观感。 -->
        <div v-if="previewUrls.length || preparing" class="share-photos">
          <div v-for="(url, index) in previewUrls" :key="url" class="share-photo">
            <img :src="url" :alt="t('home.image')" />
            <AppButton
              variant="icon"
              type="button"
              class="share-photo-remove"
              :aria-label="t('home.remove')"
              :disabled="busy"
              @click="removeImage(index)"
            >
              <CloseIcon aria-hidden="true" />
            </AppButton>
          </div>
          <div v-if="preparing" class="share-photo is-pending" role="status">
            <span>{{ t("home.imagePreparing") }}</span>
          </div>
        </div>
        <div v-if="videoOpen || video" class="composer-video">
          <label class="visually-hidden" for="share-video">{{ t("home.shareVideo") }}</label>
          <input
            id="share-video"
            ref="videoInput"
            v-model="video"
            type="text"
            inputmode="url"
            class="share-video"
            :placeholder="t('home.videoPlaceholder')"
            :disabled="busy"
          />
          <div class="composer-video-foot">
            <AppButton variant="secondary" type="button" :disabled="busy" @click="posterInput?.click()">
              {{ t("home.posterPick") }}
            </AppButton>
            <span v-if="posterPreview" class="share-poster-thumb">
              <img :src="posterPreview" :alt="t('home.formVideo')" />
              <AppButton
                variant="icon"
                type="button"
                :aria-label="t('home.remove')"
                :disabled="busy"
                @click="removePoster"
              >
                <CloseIcon aria-hidden="true" />
              </AppButton>
            </span>
          </div>
        </div>
        <ul v-if="audio" class="chat-pending share-files">
          <li class="chat-pending-item">
            <span class="chat-file-name share-file-name">{{ audio.name }}</span>
            <AppButton variant="secondary" type="button" :disabled="busy" @click="removeAudio">
              {{ t("home.remove") }}
            </AppButton>
          </li>
        </ul>
        <ul v-if="files.length" class="chat-pending share-files">
          <li v-for="(item, index) in files" :key="`${item.name}-${index}`" class="chat-pending-item">
            <span class="chat-file-name share-file-name">{{ item.name }}</span>
            <AppButton variant="secondary" type="button" :disabled="busy" @click="removeFile(index)">
              {{ t("home.remove") }}
            </AppButton>
          </li>
        </ul>
      </div>

      <!-- 底：同意声明 + 插入按钮 + 发布。 -->
      <div v-if="active" class="share-consent-row">
        <label class="share-consent">
          <input v-model="isPublic" type="checkbox" :disabled="busy" />
          <span>{{ t("home.shareConsent") }}</span>
        </label>
      </div>

      <div v-if="active" class="share-actions">
        <button type="button" class="share-action" :disabled="busy" @click="onMedia('image')">
          <ImageIcon class="share-action-icon share-action-image" aria-hidden="true" />
          <span>{{ t("home.shareImage") }}</span>
        </button>
        <button type="button" class="share-action" :disabled="busy" @click="onMedia('video')">
          <VideoIcon class="share-action-icon share-action-video" aria-hidden="true" />
          <span>{{ t("home.shareVideo") }}</span>
        </button>
        <button type="button" class="share-action" :disabled="busy" @click="onMedia('audio')">
          <AudioIcon class="share-action-icon share-action-audio" aria-hidden="true" />
          <span>{{ t("home.shareAudio") }}</span>
        </button>
        <button type="button" class="share-action" :disabled="busy" @click="onMedia('file')">
          <PaperclipIcon class="share-action-icon share-action-file" aria-hidden="true" />
          <span>{{ t("home.shareFile") }}</span>
        </button>
        <AppButton
          class="share-send"
          variant="icon"
          type="submit"
          :aria-label="t('home.send')"
          :disabled="blocked || !canSend"
        >
          <SendIcon aria-hidden="true" />
        </AppButton>
      </div>

      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <input ref="imageInput" type="file" accept="image/*" multiple class="visually-hidden" @change="pickImages" />
      <input ref="fileInput" type="file" :accept="ATTACHMENT_ACCEPT" multiple class="visually-hidden" @change="pickFiles" />
      <input ref="audioInput" type="file" accept="audio/*" class="visually-hidden" @change="pickAudio" />
      <input ref="posterInput" type="file" accept="image/*" class="visually-hidden" @change="pickPoster" />
    </form>
  </section>
</template>

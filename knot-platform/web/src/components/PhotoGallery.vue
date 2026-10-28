<script setup>
import { computed, ref } from "vue";
import PhotoLightbox from "./PhotoLightbox.vue";
import { t } from "../i18n/index.js";
import { photoAlt } from "../mediaLabel.js";
// 排版算法在 @knot/photo-layout：卡片与分享图各有一套预算，但切行与裁剪的判断只有那一份。
import { PHOTO_GAP, planPhotoLayout } from "@knot/photo-layout";

const props = defineProps({
  // [{ url, width, height }]。宽高用来算多图的切分与行高，缺了就按 4:3 猜。
  photos: { type: Array, default: () => [] },
  // 同一条记录的正文摘要。没有独立替代文本字段，拿它当 alt 的底。
  label: { type: String, default: "" },
});

const open = ref(false);
const index = ref(0);

// 只认带字符串地址的图，和 planPhotoLayout 同一口径：两边筛得不一样，下标就会错位。
const items = computed(() => (props.photos || []).filter((photo) => typeof photo?.url === "string" && photo.url));
const plan = computed(() => planPhotoLayout(items.value));
const urls = computed(() => items.value.map((photo) => photo.url));

// 行高与裁切方向都由 @knot/photo-layout 算好，这里只把数字落到 CSS 变量上，不做「单图/长图」这类判断。
// 每格的份额也随行给出（一行加起来正好 1）：行宽按份额分给各格，
// 格子宽高比因此等于图片比例；行高被规则夹住时，差额由 cover 裁掉，is-vertical 只决定往哪头对齐。
const rows = computed(() =>
  plan.value.rows.map((row) => ({
    key: row.cells.join("-"),
    aspect: row.aspect.toFixed(4),
    cropped: row.cropped,
    vertical: row.vertical,
    cells: row.cells.map((position, offset) => ({
      position,
      url: items.value[position].url,
      share: row.shares[offset].toFixed(4),
      alt: photoAlt(t, props.label, position, items.value.length),
    })),
  }))
);

function openAt(position) {
  index.value = position;
  open.value = true;
}
</script>

<template>
  <div v-if="items.length" class="information-images" :style="{ '--photo-gap': `${PHOTO_GAP}px` }">
    <div
      v-for="row in rows"
      :key="row.key"
      class="information-photo-row"
      :class="{ 'is-cropped': row.cropped, 'is-vertical': row.vertical }"
      :style="{ '--row-aspect': row.aspect }"
    >
      <button
        v-for="cell in row.cells"
        :key="cell.position"
        type="button"
        class="information-photo-btn"
        :style="{ '--photo-share': cell.share }"
        :aria-label="t('home.enlargeImageNth', { n: cell.position + 1, total: items.length })"
        @click="openAt(cell.position)"
      >
        <img :src="cell.url" :alt="cell.alt" class="information-photo" loading="lazy" decoding="async" />
      </button>
    </div>
  </div>
  <PhotoLightbox :photos="urls" :label="props.label" :open="open" :index="index" @close="open = false" />
</template>

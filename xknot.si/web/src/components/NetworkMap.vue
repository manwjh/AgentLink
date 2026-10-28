// 联邦地图：把清单里的实例按国家中心点放到一张世界底图上。
//
// 为什么不是环形图：环上的位置只跟清单顺序有关，看起来像「一圈站点」，
// 看不出联邦在哪些时区、哪些大陆。这里位置由经纬度决定，
// 相邻的实例之间连一条弧，读出来才是一张网，而不是一份列表。
//
// 位置只到国家（见 lib/world.js 的 COUNTRY_AT），所以同一个出口出来的
// 几个实例会算出同一个坐标。落点排布交给 lib/placement.js：同点簇向外散开，
// 再用引线指回真实位置，而不是原地上下排成一列。

<script setup>
import { computed } from "vue";

import { placePoints } from "../lib/placement.js";
import { hueOf } from "../lib/hue.js";
import { centroidOf, LAND_PATH, project, WORLD } from "../lib/world.js";
import BrandMark from "./BrandMark.vue";

const props = defineProps({
  items: { type: Array, default: () => [] },
  activeId: { type: String, default: null },
  t: { type: Function, required: true },
});

const emit = defineEmits(["select"]);

const VIEW = { width: WORLD.width, height: WORLD.height };

// 底图：经线每 30°、纬线每 30°，裁剪范围内只画得下四条纬线。
const GRATICULE = (() => {
  const lines = [];
  for (let lon = -150; lon <= 150; lon += 30) {
    const x = project(lon, 0).x;
    lines.push(`M${x.toFixed(1)} 0V${VIEW.height}`);
  }
  for (let lat = -30; lat <= 60; lat += 30) {
    const y = project(0, lat).y;
    lines.push(`M0 ${y.toFixed(1)}H${VIEW.width}`);
  }
  return lines.join("");
})();

const EQUATOR = project(0, 0).y.toFixed(1);

// 落点排布见 lib/placement.js：同点簇向外散开，锚点是真实坐标。
const placement = computed(() => {
  const points = [];
  for (const item of props.items) {
    const center = centroidOf(item.regions);
    if (!center) continue;
    const point = project(center.lon, center.lat);
    if (!point) continue;
    points.push({ ...item, x: point.x, y: point.y });
  }
  return placePoints(points, VIEW);
});

// 每个点带上自己的色相：点、引线、朝中枢的弧、实例间直连都用它。
// 一处算、四处用，颜色才对得上——同一个站在哪儿都是同一个色。
const placed = computed(() =>
  placement.value.points.map((point) => ({ ...point, hue: hueOf(point.id) }))
);

const spokes = computed(() => {
  const hues = new Map(placed.value.map((point) => [point.id, point.hue]));
  return placement.value.spokes.map((spoke) => ({ ...spoke, hue: hues.get(spoke.id) ?? 210 }));
});

const anchors = computed(() => placement.value.anchors);

const unplaced = computed(() => {
  const out = [];
  for (const item of props.items) {
    if (!centroidOf(item.regions)) out.push(item);
  }
  return out;
});

// 联邦中枢：不落在任何经纬度上，悬在地图上方。所有实例朝它连。
// 位置只跟画布有关，跟清单顺序无关，所以加站、减站都不会让中心漂移。
// y 取在画布上缘之上：所有弧线的交汇点藏在徽标后面，不在地图上留下一个结。
const HUB = { x: VIEW.width / 2, y: -8 };

// 每个实例一条弧线飞向联邦中枢。弧线朝中轴外侧鼓一点，
// 十根线才不会在中心下方挤成一根柱子。
//
// 弧线的颜色跟着站点走：出站那一头就是那个点的颜色，到了中枢一侧收成中枢的橙。
// 十几根线都汇在一个点上，只靠颜色才分得清哪根属于哪个点。
const links = computed(() =>
  placed.value.map((point, index) => {
    // down / unknown 不参与这套配色：线本来就是淡的，再染色等于把它说成很强。
    const tinted = point.status === "up" || point.status === "degraded";
    return {
      id: point.id,
      status: point.status,
      d: fanArc(point),
      // 延迟错开，避免十根线上的光点同时起步。
      delay: `${(-(index * 0.9)).toFixed(1)}s`,
      hue: point.hue,
      gradient: tinted
        ? { id: arcGradientId(point.id), x1: point.x, y1: point.y, x2: HUB.x, y2: HUB.y }
        : null,
    };
  })
);

// 站点 id 里有连字符、下划线，还有可能来自清单的任意字符：做进 url(#…) 之前
// 只留安全字符，否则一个点号就能让整条引用失效。
function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function arcGradientId(id) {
  return `arc-${safeId(id)}`;
}

function peerGradientId(key) {
  return `peer-${safeId(key).replace(/:/g, "_")}`;
}

// 只有染色的那几条需要渐变；down / unknown 走纯 CSS 的淡线。
const arcGradients = computed(() => links.value.filter((link) => link.gradient));

function fanArc(point) {
  const dx = HUB.x - point.x;
  const dy = HUB.y - point.y;
  const distance = Math.hypot(dx, dy) || 1;
  // 单位法线，再按实例在中轴的哪一侧取向外的那一边。
  const nx = -dy / distance;
  const ny = dx / distance;
  const outward = point.x >= HUB.x ? 1 : -1;
  const sign = nx * outward >= 0 ? 1 : -1;
  const bow = Math.min(52, distance * 0.13);
  const cx = (point.x + HUB.x) / 2 + nx * sign * bow;
  const cy = (point.y + HUB.y) / 2 + ny * sign * bow;
  return `M${point.x.toFixed(1)} ${point.y.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${HUB.x} ${HUB.y}`;
}

// 实例之间：将来按协议直接交换数据，不必每一条都绕到中枢。
// 这里先把那张网的样子画出来——每个站挑最近的 2–4 个邻居连上，
// 连几个按清单顺序轮流取，刷新、悬停都不会改变连法。
const PEER_DEGREES = [2, 3, 4];

const mesh = computed(() => {
  const points = placed.value;
  const seen = new Set();
  const edges = [];
  points.forEach((point, index) => {
    const degree = PEER_DEGREES[index % PEER_DEGREES.length];
    const neighbours = points
      .map((other, otherIndex) => ({
        otherIndex,
        distance: Math.hypot(other.x - point.x, other.y - point.y),
      }))
      .filter((entry) => entry.otherIndex !== index)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, degree);

    for (const { otherIndex } of neighbours) {
      // 两个站互相选中时只画一条，A–B 和 B–A 是同一根线。
      const low = Math.min(index, otherIndex);
      const high = Math.max(index, otherIndex);
      const key = `${low}:${high}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const from = points[low];
      const to = points[high];
      edges.push({
        id: key,
        a: from.id,
        b: to.id,
        // 两头有一头没应答，这条交换路径此刻也只是理论上的。
        status: from.status === "down" || to.status === "down" ? "down" : "up",
        // 直连画直线：朝中心的弧是弯的，形状上就把两套语义分开了。
        d: `M${from.x.toFixed(1)} ${from.y.toFixed(1)}L${to.x.toFixed(1)} ${to.y.toFixed(1)}`,
        // 两端各取一头站点的颜色：线在谁那一端，就是谁的颜色。
        gradient: {
          id: peerGradientId(key),
          x1: from.x,
          y1: from.y,
          x2: to.x,
          y2: to.y,
          hueA: from.hue,
          hueB: to.hue,
        },
      });
    }
  });
  return edges;
});

const online = computed(
  () => props.items.filter((item) => item.status === "up" || item.status === "degraded").length
);

// 图例只列出现过的状态，颜色之外再给文字和数量。
const legend = computed(() =>
  ["up", "degraded", "down", "unknown"]
    .map((key) => ({ key, count: props.items.filter((item) => item.status === key).length }))
    .filter((entry) => entry.count > 0)
);

const ariaLabel = computed(() =>
  props.t("map.label", {
    total: props.items.length,
    online: online.value,
    peers: mesh.value.length,
  })
);

function label(item) {
  return `${item.name} · ${item.groupLabel} · ${props.t(`status.${item.status}`)} · ${item.localTime}`;
}

function place(point) {
  return {
    left: `${((point.x / VIEW.width) * 100).toFixed(2)}%`,
    top: `${((point.y / VIEW.height) * 100).toFixed(2)}%`,
    // 正常时点用站点自己的色相（与卡片徽记同一套哈希），异常时下面几条 CSS 规则
    // 会把它换成红/黄：颜色先回答「谁」，出问题时再回答「怎么了」。
    "--pin-hue": String(point.hue),
  };
}

// 与 NodeCard.vue 的徽记同源：同一个站在任何语种、任何快照下都是同一个色相。

function tipClass(point) {
  return [
    point.y > VIEW.height * 0.42 ? "above" : "below",
    point.x < VIEW.width * 0.12 ? "left" : point.x > VIEW.width * 0.88 ? "right" : "center",
  ];
}

function activate(id) {
  emit("select", id);
}
</script>

<template>
  <section class="map" role="group" :aria-label="ariaLabel">
    <header class="map-head">
        <h2 class="map-kicker">
          <span class="map-ping" aria-hidden="true" />
          {{ t("map.title") }}
        </h2>
      <ul class="legend">
        <li v-for="entry in legend" :key="entry.key" :class="entry.key">
          <i class="legend-dot" aria-hidden="true" />
          <span>{{ t(`status.${entry.key}`) }}</span>
          <span class="legend-count">{{ entry.count }}</span>
        </li>
      </ul>
    </header>

    <div class="stage">
      <svg
        class="world"
        :viewBox="`0 0 ${VIEW.width} ${VIEW.height}`"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <pattern id="xk-land-dots" width="11" height="11" patternUnits="userSpaceOnUse">
            <circle class="land-dot" cx="2.4" cy="2.4" r="1.55" />
          </pattern>
          <!-- 弧线的渐变：出站那一头是站点自己的颜色，到中枢一侧收成中枢的橙。 -->
          <linearGradient
            v-for="link in arcGradients"
            :id="link.gradient.id"
            :key="`g-${link.id}`"
            gradientUnits="userSpaceOnUse"
            :x1="link.gradient.x1"
            :y1="link.gradient.y1"
            :x2="link.gradient.x2"
            :y2="link.gradient.y2"
          >
            <stop offset="0" class="arc-from" :style="{ '--pin-hue': link.hue }" />
            <stop offset="1" class="arc-to" />
          </linearGradient>
          <!-- 直连的渐变：两端各是一个站点的颜色。 -->
          <linearGradient
            v-for="peer in mesh"
            :id="peer.gradient.id"
            :key="`pg-${peer.id}`"
            gradientUnits="userSpaceOnUse"
            :x1="peer.gradient.x1"
            :y1="peer.gradient.y1"
            :x2="peer.gradient.x2"
            :y2="peer.gradient.y2"
          >
            <stop offset="0" class="mesh-stop" :style="{ '--pin-hue': peer.gradient.hueA }" />
            <stop offset="1" class="mesh-stop" :style="{ '--pin-hue': peer.gradient.hueB }" />
          </linearGradient>
        </defs>

        <path class="graticule" :d="GRATICULE" />
        <line class="equator" x1="0" :y1="EQUATOR" :x2="VIEW.width" :y2="EQUATOR" />

        <path class="land" :d="LAND_PATH" />
        <path class="land-edge" :d="LAND_PATH" vector-effect="non-scaling-stroke" />

        <!-- 实例之间：浅绿直线，表示协议直连、可就地交换数据。
             画在橙色弧线下面，先有网，再谈汇入中枢。 -->
        <g class="mesh">
          <path
            v-for="peer in mesh"
            :key="peer.id"
            class="peer"
            :class="[peer.status, { active: activeId === peer.a || activeId === peer.b }]"
            :d="peer.d"
            :style="{ stroke: `url(#${peer.gradient.id})` }"
            vector-effect="non-scaling-stroke"
          />
        </g>

        <g class="links">
          <g v-for="link in links" :key="link.id">
            <path
              class="link"
              :class="[link.status, { active: activeId === link.id }]"
              :d="link.d"
              :style="link.gradient ? { stroke: `url(#${link.gradient.id})` } : null"
              vector-effect="non-scaling-stroke"
            />
            <path
              class="glint"
              :class="[link.status, { active: activeId === link.id }]"
              :d="link.d"
              pathLength="100"
              :style="{ animationDelay: link.delay }"
              vector-effect="non-scaling-stroke"
            />
          </g>
        </g>

        <!-- 同一个落点的实例：散开的点各有一条引线指回真实坐标，
             锚点本身留一个小空心圈，读起来是「这四个都在这一处」，
             而不是四个地方。 -->
        <g class="spreads">
          <line
            v-for="spoke in spokes"
            :key="spoke.id"
            class="spoke"
            :style="{ '--pin-hue': spoke.hue }"
            :x1="spoke.x1"
            :y1="spoke.y1"
            :x2="spoke.x2"
            :y2="spoke.y2"
            vector-effect="non-scaling-stroke"
          />
          <circle
            v-for="anchor in anchors"
            :key="`${anchor.x}:${anchor.y}`"
            class="anchor"
            :cx="anchor.x"
            :cy="anchor.y"
            r="2.6"
            vector-effect="non-scaling-stroke"
          />
        </g>
      </svg>

      <!-- 联邦中枢：悬在地图上方的徽标，标识由 BrandMark 按三档取图。 -->
      <div class="hub">
        <span class="hub-shadow" aria-hidden="true" />
        <span class="hub-body">
          <BrandMark class="hub-logo" :size="24" />
          <span class="hub-text">
            <span class="hub-name">XKNOT</span>
            <span class="hub-role">{{ t("map.hub") }}</span>
          </span>
        </span>
      </div>

      <button
        v-for="point in placed"
        :key="point.id"
        type="button"
        class="pin"
        :class="[point.status, { muted: !point.visible, active: point.id === activeId }]"
        :style="place(point)"
        :aria-label="label(point)"
        @click="activate(point.id)"
      >
        <span class="dot" aria-hidden="true"><span class="halo" /></span>
        <span class="tip" :class="tipClass(point)" aria-hidden="true">
          <span class="tip-name">{{ point.name }}</span>
          <span class="tip-meta">{{ point.groupLabel }} · {{ point.localTime }}</span>
        </span>
      </button>
    </div>

    <div class="map-foot">
      <p class="hint">
        <span>{{ t("map.hint") }}</span>
        <span class="peer-key">
          <i class="peer-swatch" aria-hidden="true" />
          {{ t("map.peer") }}
        </span>
      </p>
      <p v-if="unplaced.length" class="unplaced">
        <span class="unplaced-label">{{ t("map.global") }}</span>
        <button
          v-for="point in unplaced"
          :key="point.id"
          type="button"
          class="unplaced-chip"
          :class="point.status"
          :aria-label="label(point)"
          @click="activate(point.id)"
        >
          <i class="chip-dot" aria-hidden="true" />
          {{ point.name }}
        </button>
      </p>
    </div>
  </section>
</template>

<style scoped>
.map {
  width: 100%;
  min-width: 0;
  /* 这里没有用到 cqw/cqi，也没有 @container 查询：尺寸容器只会让布局多一次
     尺寸计算，拿掉不影响显示。 */
}

.map-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem 1rem;
  flex-wrap: wrap;
  padding-bottom: 0.45rem;
}

.map-kicker {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
  font-family: var(--font-mono);
  font-size: 0.66rem;
  font-weight: 500;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--muted);
}

.map-ping {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 0 3px rgba(11, 122, 84, 0.14);
}

.stage {
  position: relative;
  width: 100%;
  aspect-ratio: 960 / 379;
  /* 上方留出联邦中枢悬空的位置，它和地图不是同一层 */
  margin-top: 3.3rem;
}

.world {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}

/* 经纬网 */
.graticule {
  fill: none;
  stroke: var(--grid-line);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.equator {
  stroke: var(--tier-line);
  stroke-width: 1;
  stroke-dasharray: 3 5;
  vector-effect: non-scaling-stroke;
}

/* 陆地：点阵填充，和右栏的点阵球同一个语汇 */
.land {
  fill: url(#xk-land-dots);
}

.land-dot {
  fill: var(--map-land);
}

.land-edge {
  fill: none;
  stroke: var(--map-edge);
  stroke-width: 1;
}

/* 实例之间：细实线，直的。弧线弯着朝中心，直连点对点，形状即语义。
   颜色取自两端的站点：线在谁那一端就是谁的颜色，与点对得上。 */
.peer {
  fill: none;
  stroke: var(--map-peer);
  stroke-width: 1;
}

.peer.active {
  stroke-width: 1.6;
  /* 渐变定义在 <defs> 里，不能用祖先选择器提亮，只能在元素上整体提一点。 */
  filter: brightness(1.22) saturate(1.1);
}

/* 两端有一头没应答，这条交换路径此刻也只是理论上的 */
.peer.down {
  opacity: 0.4;
}

/* 渐变的两个端点色：站点色相 + 与原来同级的透明度。
   透明度写在 stop 上，整条线的浓淡就和改造前一致。 */
.mesh-stop {
  stop-color: hsl(var(--pin-hue, 210) 62% 40%);
  stop-opacity: 0.4;
}

:root[data-theme="dark"] .mesh-stop {
  stop-color: hsl(var(--pin-hue, 210) 68% 62%);
  stop-opacity: 0.26;
}

/* 同一落点的簇：引线指回真实坐标，锚点留一个空心圈。
   比直连更淡 —— 它说的不是「两台机器之间有链路」，只是「这几个点在同一处」。
   颜色跟着点走，一眼看得出这根线属于哪个点。 */
.spoke {
  stroke: hsl(var(--pin-hue, 210) 62% 40% / 0.42);
  stroke-width: 1;
}

:root[data-theme="dark"] .spoke {
  stroke: hsl(var(--pin-hue, 210) 68% 62% / 0.34);
}

.anchor {
  fill: none;
  stroke: var(--map-anchor);
  stroke-width: 1;
}

/* 链路：长划线，从每个实例拉到联邦中枢。
   颜色本身带 alpha，不靠整条 path 压不透明度，虚线才不会糊成一团。
   染色的那几条用渐变（站点色 → 中枢橙），down / unknown 走下面这条淡线。 */
.link {
  fill: none;
  stroke: var(--map-link-line);
  stroke-width: 1.2;
  stroke-dasharray: 10 5;
}

.arc-from {
  stop-color: hsl(var(--pin-hue, 210) 62% 40%);
  stop-opacity: 0.85;
}

.arc-to {
  stop-color: var(--map-link);
  stop-opacity: 0.55;
}

:root[data-theme="dark"] .arc-from {
  stop-color: hsl(var(--pin-hue, 210) 68% 62%);
  stop-opacity: 0.75;
}

:root[data-theme="dark"] .arc-to {
  stop-color: var(--map-link);
  stop-opacity: 0.5;
}

.link.active {
  stroke-width: 1.4;
  stroke-dasharray: 12 4;
}

.link.down {
  stroke: var(--map-link-line);
  opacity: 0.45;
}

/* 沿线飞向中心的一小段亮色，只是韵律，不是第二根线 */
.glint {
  fill: none;
  stroke: var(--map-link-spark);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-dasharray: 6 94;
  opacity: 0;
  animation: fly 6.5s linear infinite;
}

.glint.active {
  opacity: 1;
  animation-duration: 2.6s;
}

.glint.down {
  animation: none;
}

/* 光点从实例飞向联邦中枢：pathLength 已归一为 100，偏移正好一圈 */
@keyframes fly {
  0% {
    stroke-dashoffset: 0;
    opacity: 0;
  }
  8%,
  78% {
    opacity: 0.75;
  }
  100% {
    stroke-dashoffset: -100;
    opacity: 0;
  }
}

/* 联邦中枢：悬在地图上方，不落经纬度。
   底下一层投影落在底图上，随呼吸收放，读起来才是「浮着」。 */
.hub {
  position: absolute;
  z-index: 3;
  top: 0;
  left: 50%;
  transform: translate(-50%, -74%);
  pointer-events: none;
}

.hub-body {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.8rem 0.4rem 0.55rem;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--surface);
  box-shadow: var(--hub-shadow);
  animation: hover 7s ease-in-out infinite;
}

.hub-shadow {
  position: absolute;
  left: 50%;
  bottom: -16px;
  width: 76%;
  height: 14px;
  transform: translateX(-50%);
  border-radius: 50%;
  /* 柔和靠渐变本身：同样的观感，不必每帧再算一次 blur。
     投影跟着 cast 一起缩放，只是 transform + opacity，可以交给合成器。 */
  background: radial-gradient(
    52% 52% at 50% 50%,
    var(--hub-cast) 0%,
    transparent 88%
  );
  animation: cast 7s ease-in-out infinite;
}

.hub-logo {
  display: block;
  width: 24px;
  height: 24px;
}

.hub-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1.05;
}

.hub-name {
  font-family: var(--font-display);
  font-size: 0.76rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  color: var(--ink);
}

.hub-role {
  font-family: var(--font-mono);
  font-size: 0.55rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
}

@keyframes hover {
  50% {
    transform: translateY(-3px);
  }
}

@keyframes cast {
  50% {
    transform: translateX(-50%) scaleX(0.9);
    opacity: 0.72;
  }
}

/* 实例按钮 */
.pin {
  position: absolute;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  padding: 0;
  margin: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--unknown);
  transform: translate(-50%, -50%);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

/* 正常时用站点自己的色相：颜色先回答「谁」，一眼能把同簇的几台分开。
   异常时不靠颜色区分身份，直接切到状态色——「点变红」这条验收保持不变。 */
.pin.up {
  color: hsl(var(--pin-hue, 200) 62% 40%);
}
/* 深色底上 40% 的亮度发闷，抬到 62% 才和两边的状态色一样亮。 */
:root[data-theme="dark"] .pin.up {
  color: hsl(var(--pin-hue, 200) 68% 62%);
}
.pin.degraded {
  color: var(--warn);
}
.pin.down {
  color: var(--bad);
}
.pin.unknown {
  color: var(--unknown);
}

.pin.muted {
  opacity: 0.32;
}

.dot {
  position: relative;
  display: grid;
  place-items: center;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 1.5px var(--surface);
  transition: transform 180ms ease;
}

.pin.up .dot,
.pin.degraded .dot {
  box-shadow:
    0 0 0 1.5px var(--surface),
    0 0 12px -1px currentColor;
}

.halo {
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  border: 1px solid currentColor;
  opacity: 0;
}

.pin.up .halo {
  animation: ping 4.2s ease-out infinite;
}

.pin.degraded .halo {
  animation: ping 4.2s ease-out infinite;
  animation-delay: 1.2s;
}

.pin:hover .dot,
.pin:focus-visible .dot,
.pin.active .dot {
  transform: scale(1.55);
}

.pin:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 0;
}

/* 悬停标签 */
.tip {
  position: absolute;
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.34rem 0.5rem 0.38rem;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  background: var(--surface);
  box-shadow: var(--card-shadow);
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 140ms ease;
}

.pin:hover .tip,
.pin:focus-visible .tip,
.pin.active .tip {
  opacity: 1;
}

.tip.center.above {
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
}

.tip.center.below {
  top: 24px;
  left: 50%;
  transform: translateX(-50%);
}

.tip.left.above,
.tip.left.below {
  left: -6px;
}

.tip.right.above,
.tip.right.below {
  right: -6px;
}

.tip-name {
  font-family: var(--font-display);
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--ink);
  letter-spacing: 0.01em;
}

.tip-meta {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  letter-spacing: 0.06em;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}

/* 图例与脚注 */
.legend {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  margin: 0;
  padding: 0;
  list-style: none;
  font-family: var(--font-mono);
  font-size: 0.62rem;
  letter-spacing: 0.06em;
  color: var(--dim);
}

.legend li {
  display: inline-flex;
  align-items: center;
  gap: 0.28rem;
  white-space: nowrap;
}

.legend-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--unknown);
}

.legend li.up .legend-dot {
  /* 正常的点各用自己站点的色相，图例就用一圈色环代表「不是一个颜色」。 */
  background: conic-gradient(
    hsl(0 62% 45%),
    hsl(60 62% 45%),
    hsl(120 62% 45%),
    hsl(180 62% 45%),
    hsl(240 62% 45%),
    hsl(300 62% 45%),
    hsl(360 62% 45%)
  );
}
.legend li.degraded .legend-dot {
  background: var(--warn);
}
.legend li.down .legend-dot {
  background: var(--bad);
}

.legend-count {
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}

.map-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.45rem 1rem;
  flex-wrap: wrap;
  padding-top: 0.2rem;
}

.hint {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem 0.7rem;
  flex-wrap: wrap;
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.06em;
  color: var(--dim);
}

/* 绿线的图注：一小段线 + 一句解释，跟状态图例分开，不混进点的颜色里 */
.peer-key {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.peer-swatch {
  width: 14px;
  height: 2px;
  border-radius: 1px;
  /* 直连的颜色取自两端站点，图例只给一段两端不同色的线段。 */
  background: linear-gradient(90deg, hsl(160 62% 42%), hsl(280 62% 42%));
  flex: none;
}

/* 没有固定区域的实例（例如只做跳转的 root）：放到脚注，不硬塞到地图上 */
.unplaced {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin: 0;
}

.unplaced-label {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--faint);
}

.unplaced-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-height: 26px;
  padding: 0.1rem 0.5rem;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--surface);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 0.66rem;
  cursor: pointer;
}

.unplaced-chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.chip-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--unknown);
}

.unplaced-chip.up .chip-dot {
  background: var(--ok);
}
.unplaced-chip.degraded .chip-dot {
  background: var(--warn);
}
.unplaced-chip.down .chip-dot {
  background: var(--bad);
}

@keyframes ping {
  0% {
    transform: scale(0.5);
    opacity: 0.8;
  }
  65%,
  100% {
    transform: scale(2.1);
    opacity: 0;
  }
}

/* 手机上点会挨得近：收小命中区，站名留在悬停/点击出的提示里 */
@media (max-width: 640px) {
  .pin {
    width: 30px;
    height: 30px;
  }

  .map-head {
    padding-bottom: 0.3rem;
  }

  .map-kicker {
    font-size: 0.6rem;
    letter-spacing: 0.12em;
  }

  .legend {
    font-size: 0.58rem;
    gap: 0.5rem;
  }

  .hint {
    font-size: 0.6rem;
  }

  /* 手机上这条飞线要整段重绘：14 条一起跑，PSI 量的就是这一段。
     默认停在起点（不画），只有当前查看的那条才飞。 */
  .glint {
    animation: none;
  }

  .glint.active {
    animation: fly 2.6s linear infinite;
  }
}

@media (prefers-reduced-motion: reduce) {
  .pin .halo {
    animation: none;
  }

  .glint {
    display: none;
  }

  .hub-body,
  .hub-shadow {
    animation: none;
  }
}
</style>

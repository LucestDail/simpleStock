<!--
  📈 자산 vs 벤치마크 (2026-10-12 — 성과 화면에서 **이 하나만** 건져 왔다)

  성과 리포트(ReportView)를 없애면서 그 화면에만 있던 것을 옮긴다.
  🔴 **옮길 가치가 있는 이유**: 포트폴리오의 자산 추이는 *"내 돈이 얼마나 늘었나"* 를
     보여주고, 이 차트는 *"시장보다 잘했나"* 를 보여준다. **다른 질문이다.**

  ⚠️ 첫 관측일 = 100 으로 정규화한다. 절대 금액으로는 ₩2천만과 지수 7000 을 한 축에 못 그린다.
  ⚠️ 벤치가 `null` 인 날은 **선에서 건너뛴다**(0 으로 그리면 폭락으로 보인다).
-->
<template>
  <div v-if="chart.lines.length" class="bc">
    <svg class="bc__svg" :viewBox="`0 0 ${CW} ${CH}`" role="img" aria-label="자산과 벤치마크 추이">
      <!-- y 눈금 -->
      <g class="bc__grid">
        <line v-for="t in chart.yTicks" :key="`y${t.label}`"
              :x1="PAD_L" :y1="t.y" :x2="CW - PAD_R" :y2="t.y" />
        <text v-for="t in chart.yTicks" :key="`yl${t.label}`"
              :x="PAD_L - 6" :y="t.y + 3" class="bc__ylbl">{{ t.label }}</text>
      </g>
      <!-- x 눈금 -->
      <text v-for="t in chart.xTicks" :key="`x${t.label}`"
            :x="t.x" :y="CH - 6" class="bc__xlbl"
            :text-anchor="t.end ? 'end' : t.mid ? 'middle' : 'start'">{{ t.label }}</text>
      <!-- 선 -->
      <polyline v-for="l in chart.built" :key="l.name" class="bc__line"
                :points="l.points" :style="{ stroke: l.color }" />
      <!-- 끝점 + 라벨 -->
      <g v-for="l in chart.built" :key="`e${l.name}`">
        <circle :cx="l.lastX" :cy="l.lastY" r="2.5" :style="{ fill: l.color }" />
        <text :x="l.lastX + 7" :y="l.labelY + 3" class="bc__elbl" :style="{ fill: l.color }">
          {{ l.name }} {{ l.lastV }}
        </text>
      </g>
    </svg>
    <p class="bc__foot">
      첫 관측일 = 100 · {{ chart.firstDay }} ~ {{ chart.lastDay }}
      <span v-if="chart.excess != null" class="bc__ex" :class="chart.excess >= 0 ? 'up' : 'down'">
        나스닥 대비 {{ chart.excess >= 0 ? '+' : '' }}{{ chart.excess }}%p
      </span>
    </p>
  </div>
  <p v-else class="bc__empty">
    {{ (series || []).length ? '관측이 하루치뿐입니다 — 이틀째부터 그립니다.' : '자산 스냅샷이 아직 없습니다.' }}
  </p>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  /** `/api/performance` 의 `series` — `[{ day, totalKrw, kospi, qqq }]` */
  series: { type: Array, default: () => [] },
});

const CW = 640; const CH = 200;
/* PAD_L 44: y 눈금 라벨이 플롯 **밖** 왼쪽에 산다(좁으면 라벨이 선 위에 얹힌다) */
const PAD_L = 44; const PAD_R = 124; const PAD_T = 16; const PAD_B = 26;
const LBL_GAP = 14; /* 끝 라벨 최소 세로 간격 */
const DEF = [
  { key: 'totalKrw', name: '내 계좌', color: 'var(--color-primary)' },
  { key: 'kospi', name: 'KOSPI', color: 'var(--color-warn)' },
  { key: 'qqq', name: '나스닥', color: 'var(--color-ai)' },
];

const chart = computed(() => {
  const rows = Array.isArray(props.series) ? props.series : [];
  if (rows.length < 2) return { lines: [], built: [], yTicks: [], xTicks: [] };

  const lines = [];
  for (const def of DEF) {
    const base = Number(rows.find((r) => Number(r[def.key]) > 0)?.[def.key]);
    if (!(base > 0)) continue;
    const pts = [];
    rows.forEach((r, i) => {
      const v = Number(r[def.key]);
      if (v > 0) pts.push({ i, v: (v / base) * 100 });
    });
    if (pts.length >= 2) lines.push({ ...def, pts });
  }
  if (!lines.length) return { lines: [], built: [], yTicks: [], xTicks: [] };

  const all = lines.flatMap((l) => l.pts.map((p) => p.v));
  let min = Math.min(...all, 100); let max = Math.max(...all, 100);
  if (max - min < 0.5) { min -= 1; max += 1; }
  const span = max - min;
  const x = (i) => PAD_L + (i * (CW - PAD_L - PAD_R)) / (rows.length - 1);
  const y = (v) => PAD_T + (1 - (v - min) / span) * (CH - PAD_T - PAD_B);
  const r1 = (v) => Math.round(v * 10) / 10;

  const yTicks = [];
  for (const v of [...new Set([r1(max), 100, r1(min)])].sort((a, b) => b - a)) {
    const yy = y(v);
    if (yTicks.some((t) => Math.abs(t.y - yy) < LBL_GAP)) continue;
    yTicks.push({ y: yy, label: String(v) });
  }

  const md = (day) => String(day || '').slice(5);
  const xTicks = [{ x: PAD_L, label: md(rows[0].day) }];
  if (rows.length >= 5) {
    const mi = Math.floor((rows.length - 1) / 2);
    xTicks.push({ x: x(mi), label: md(rows[mi].day), mid: true });
  }
  xTicks.push({ x: CW - PAD_R, label: md(rows[rows.length - 1].day), end: true });

  /**
   * 끝 라벨 배치 — ① 선 기울기의 **반대쪽**에서 시작(다가오는 선을 피한다)
   *                ② 세로 충돌 회피(위에서부터 LBL_GAP 보장, 바닥 넘치면 위로 조임)
   */
  const built = lines.map((l) => {
    const last = l.pts[l.pts.length - 1];
    const prev = l.pts[l.pts.length - 2];
    const lastY = y(last.v);
    const prevY = prev == null ? lastY : y(prev.v);
    const slopeOff = prevY > lastY ? LBL_GAP : prevY < lastY ? -LBL_GAP : 0;
    return {
      name: l.name, color: l.color,
      points: l.pts.map((p) => `${x(p.i)},${y(p.v)}`).join(' '),
      lastX: x(last.i), lastY, lastV: r1(last.v), labelY: lastY + slopeOff,
    };
  });
  const order = [...built].sort((a, b) => a.labelY - b.labelY);
  for (let i = 1; i < order.length; i += 1) {
    if (order[i].labelY - order[i - 1].labelY < LBL_GAP) order[i].labelY = order[i - 1].labelY + LBL_GAP;
  }
  const bottom = CH - PAD_B;
  const over = order.length ? order[order.length - 1].labelY - bottom : 0;
  if (over > 0) for (const o of order) o.labelY -= over;

  /** 🔴 나스닥 대비 초과수익 — 없으면 `null`(0 으로 채우면 "시장과 같았다" 로 읽힌다) */
  const mine = built.find((b) => b.name === '내 계좌');
  const nas = built.find((b) => b.name === '나스닥');
  const excess = mine && nas ? Math.round((mine.lastV - nas.lastV) * 10) / 10 : null;

  return {
    lines, built, yTicks, xTicks, excess,
    firstDay: rows[0].day, lastDay: rows[rows.length - 1].day,
  };
});
</script>

<style scoped>
.bc { display: flex; flex-direction: column; gap: 4px; }
.bc__svg { display: block; width: 100%; height: 210px; }
.bc__grid line { stroke: var(--color-hairline-soft); stroke-width: 1; }
.bc__ylbl { fill: var(--color-faint); font-size: 10px; text-anchor: end; font-variant-numeric: tabular-nums; }
.bc__xlbl { fill: var(--color-faint); font-size: 10px; font-variant-numeric: tabular-nums; }
.bc__line { fill: none; stroke-width: 1.6; vector-effect: non-scaling-stroke; }
.bc__elbl { font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.bc__foot { margin: 0; font-size: var(--text-xs); color: var(--color-muted); display: flex; gap: var(--space-sm); align-items: baseline; }
.bc__ex { margin-left: auto; font-weight: 600; font-variant-numeric: tabular-nums; }
.bc__empty { margin: 0; font-size: var(--text-xs); color: var(--color-muted); }
.up { color: var(--color-up); }
.down { color: var(--color-down); }
</style>

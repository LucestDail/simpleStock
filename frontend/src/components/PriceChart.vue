<script setup>
import { ref, watch, onMounted, onBeforeUnmount, shallowRef } from 'vue';
import { createChart, ColorType, CrosshairMode } from 'lightweight-charts';
import { apiFetch } from '../lib/apiClient';

/**
 * 종목 차트 (2026-09-21)
 *
 * 토스 `/api/v1/candles` — `1m`·`1d`, 최대 200봉. 서버가 **오래된 것부터** 정렬해 준다.
 *
 * ⚠️ 차트는 DOM 크기에 의존한다. 패널이 접혀 있거나 폭이 0일 때 만들면 **빈 캔버스**가 되고,
 *    그건 "데이터가 없다" 로 보인다 ⇒ ResizeObserver 로 실제 크기가 생긴 뒤에 맞춘다.
 * ⚠️ 차트 인스턴스는 **반응형으로 감싸지 않는다**(shallowRef) — Vue 가 내부를 프록시로 감싸면
 *    라이브러리가 자기 객체를 못 알아본다.
 */
const props = defineProps({
  symbol: { type: String, default: '' },
  name: { type: String, default: '' },
});

const el = ref(null);
const chart = shallowRef(null);
const series = shallowRef(null);
const volSeries = shallowRef(null);
const interval = ref('1d');
const loading = ref(false);
const error = ref('');
const count = ref(0);
let ro = null;

function cssVar(name, fallback) {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function makeChart() {
  if (!el.value || chart.value) return;
  chart.value = createChart(el.value, {
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: cssVar('--color-muted', '#6f7a8d'),
      fontFamily: cssVar('--font-sans', 'system-ui'),
      fontSize: 11,
    },
    grid: {
      vertLines: { color: cssVar('--color-hairline-soft', 'rgba(255,255,255,.04)') },
      horzLines: { color: cssVar('--color-hairline-soft', 'rgba(255,255,255,.04)') },
    },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: interval.value === '1m' },
    crosshair: { mode: CrosshairMode.Normal },
    handleScale: { axisPressedMouseMove: false },
  });
  series.value = chart.value.addCandlestickSeries({
    upColor: cssVar('--color-up', '#2fbf8f'),
    downColor: cssVar('--color-down', '#f2545b'),
    borderVisible: false,
    wickUpColor: cssVar('--color-up', '#2fbf8f'),
    wickDownColor: cssVar('--color-down', '#f2545b'),
  });
  volSeries.value = chart.value.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: 'vol',
  });
  chart.value.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

  ro = new ResizeObserver(() => {
    if (!el.value || !chart.value) return;
    const { width, height } = el.value.getBoundingClientRect();
    if (width > 0 && height > 0) chart.value.applyOptions({ width, height });
  });
  ro.observe(el.value);
}

/** 토스 timestamp(ISO+09:00) → lightweight-charts 의 UTCTimestamp(초) */
function toTime(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

async function load() {
  if (!props.symbol) return;
  loading.value = true;
  error.value = '';
  try {
    const res = await apiFetch(
      `/api/toss/candles?symbol=${encodeURIComponent(props.symbol)}&interval=${interval.value}&count=200`
    );
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      // 🔴 조용히 비우지 않는다 — 특히 ip-denied·429 는 화면에서 바로 알아야 한다
      throw new Error(b.error || `차트를 불러오지 못했습니다 (${res.status})`);
    }
    const data = await res.json();
    const rows = (data.rows || []).filter((r) => toTime(r.t) != null);
    count.value = rows.length;
    makeChart();
    series.value.setData(rows.map((r) => ({ time: toTime(r.t), open: r.o, high: r.h, low: r.l, close: r.c })));
    volSeries.value.setData(
      rows.map((r) => ({
        time: toTime(r.t),
        value: r.v,
        color: r.c >= r.o ? cssVar('--color-up-soft', 'rgba(47,191,143,.13)') : cssVar('--color-down-soft', 'rgba(242,84,91,.13)'),
      }))
    );
    chart.value.timeScale().fitContent();
    chart.value.applyOptions({ timeScale: { timeVisible: interval.value === '1m' } });
  } catch (e) {
    error.value = e.message || '차트 오류';
    count.value = 0;
  } finally {
    loading.value = false;
  }
}

watch(() => [props.symbol, interval.value], load);
onMounted(load);
onBeforeUnmount(() => {
  if (ro) ro.disconnect();
  if (chart.value) chart.value.remove();
  chart.value = null;
});
</script>

<template>
  <section class="chart">
    <header class="chart__head">
      <div class="chart__title">
        <span class="chart__name">{{ name || symbol || '종목을 고르세요' }}</span>
        <span v-if="symbol" class="chart__sym mono-num">{{ symbol }}</span>
      </div>
      <div class="chart__tabs">
        <button
          v-for="iv in ['1d', '1m']"
          :key="iv"
          class="chart__tab"
          :class="{ 'chart__tab--on': interval === iv }"
          @click="interval = iv"
        >{{ iv === '1d' ? '일봉' : '분봉' }}</button>
      </div>
    </header>

    <p v-if="!symbol" class="chart__empty">보유·관심 종목을 누르면 차트가 나옵니다.</p>
    <p v-else-if="error" class="chart__err">{{ error }}</p>
    <div v-show="symbol && !error" ref="el" class="chart__canvas" />
    <footer v-if="symbol && !error" class="chart__foot">
      <span v-if="loading">불러오는 중…</span>
      <!-- ⚠️ 몇 봉을 그렸는지 밝힌다 — 0 이면 "빈 차트" 가 아니라 **못 받은 것**이다 -->
      <span v-else class="mono-num">{{ count }}봉</span>
    </footer>
  </section>
</template>

<style scoped>
.chart {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: var(--space-base);
  min-height: 300px;
}
.chart__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
.chart__title { display: flex; align-items: baseline; gap: var(--space-sm); min-width: 0; }
.chart__name { font-size: var(--text-base); font-weight: 700; color: var(--color-ink); }
.chart__sym { font-size: var(--text-xs); color: var(--color-faint); }
.chart__tabs { display: flex; gap: 2px; background: var(--color-surface-sunken); padding: 2px; border-radius: var(--rounded-md); }
.chart__tab {
  border: 0; background: transparent; color: var(--color-muted);
  font-size: var(--text-xs); font-weight: 600; padding: 4px 10px;
  border-radius: var(--rounded-sm); cursor: pointer;
}
.chart__tab--on { background: var(--color-primary-soft); color: var(--color-primary); }
.chart__canvas { flex: 1; min-height: 240px; }
.chart__empty, .chart__err {
  margin: auto; font-size: var(--text-md); color: var(--color-muted); text-align: center; padding: var(--space-lg);
}
.chart__err { color: var(--color-down); }
.chart__foot { font-size: var(--text-xs); color: var(--color-faint); text-align: right; }
</style>

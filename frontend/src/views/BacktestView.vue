<!--
  📜 백테스트 결과 (D-4) — 2026-10-12 신설 · `docs/wireframe-2026-10-12.html`

  🔴 종전에는 백테스트 결과가 **터미널 출력과 `backtest-last.json` 한 개**로만 존재했다.
     다음 회차가 돌면 앞 회차가 덮여서 **전략 둘을 비교할 수가 없었다.**
     이제 `backtestStore` 가 회차를 누적 보관하고 이 화면이 그것을 읽는다.

  ⚠️ **모의 거래는 실주문과 색·라벨을 분명히 다르게 둔다** — 시뮬레이션 결과가
     실제 체결처럼 읽히면 안 된다.
-->
<template>
  <div class="page">
    <header class="page__head">
      <RouterLink to="/lab" class="back">← 전략 연구소</RouterLink>
      <h1>백테스트 결과</h1>
      <span class="gap"></span>
      <span class="sim">모의 — 실주문 아님</span>
    </header>

    <p v-if="error" class="banner banner--error">{{ error }}</p>
    <p v-else-if="busy" class="banner banner--empty">회차를 불러오는 중…</p>

    <template v-if="run">
      <section class="card">
        <div class="meta">
          <div><dt>시나리오</dt><dd>{{ run.scenario || '—' }}</dd></div>
          <div><dt>실행</dt><dd class="mono-num">{{ fmtTime(run.at) }}</dd></div>
          <div><dt>결과</dt><dd :class="run.ok ? 'up' : 'down'">{{ run.ok ? '완주' : '실패' }}</dd></div>
          <div v-if="run.onlyScenarios?.length"><dt>발동 제한</dt><dd>{{ run.onlyScenarios.join(' · ') }}</dd></div>
        </div>
      </section>

      <!-- ① 지표 -->
      <div class="kcards">
        <div class="kcard">
          <small>최종 수익률</small>
          <b class="mono-num" :class="dirClass(result?.final)">{{ pctText(result?.final) }}</b>
        </div>
        <div class="kcard">
          <small>벤치마크</small>
          <b class="mono-num" :class="dirClass(result?.bench)">{{ pctText(result?.bench) }}</b>
        </div>
        <div class="kcard">
          <small>초과 수익</small>
          <b class="mono-num" :class="dirClass(excess)">{{ excess == null ? '—' : signedPct(excess) }}</b>
        </div>
        <div class="kcard">
          <small>최대 낙폭</small>
          <b class="mono-num" :class="mdd == null ? '' : 'down'">{{ mdd == null ? '—' : pctText(mdd) }}</b>
          <em v-if="mdd == null" class="mut">시계열이 없어 못 잼</em>
        </div>
      </div>

      <!-- ② 자산 곡선 -->
      <section class="card">
        <h2>자산 곡선</h2>
        <p v-if="!series.length" class="mut">
          시계열(SERIES)이 결과에 없습니다 — 숫자 둘(최종·벤치)로만 판정할 수 있습니다.
        </p>
        <template v-else>
          <svg class="chart" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img"
               aria-label="백테스트 자산 곡선">
            <path :d="areaPath" class="chart__area" />
            <path :d="linePath" class="chart__line" />
            <line :x1="0" :y1="zeroY" :x2="W" :y2="zeroY" class="chart__zero" />
          </svg>
          <div class="chart__legend">
            <span class="mut mono-num">{{ series.length }}개 구간</span>
            <span class="gap"></span>
            <span class="mut mono-num">최고 {{ pctText(maxV) }} · 최저 {{ pctText(minV) }}</span>
          </div>
        </template>
      </section>

      <!-- ③ 실행 원문 -->
      <section class="card">
        <h2>실행 원문 <small class="mut">마지막 40줄</small></h2>
        <p v-if="result?.error" class="banner banner--error">{{ result.error }}</p>
        <pre v-if="result?.tail" class="tail">{{ result.tail }}</pre>
        <p v-else class="mut">원문이 남아 있지 않습니다.</p>
      </section>
    </template>

    <!-- 목록 -->
    <section class="card">
      <h2>보관된 회차 <small class="mut">{{ runs.length }}건</small></h2>
      <p v-if="!runs.length" class="mut">보관된 회차가 없습니다 — 전략 연구소에서 백테스트를 실행하세요.</p>
      <div v-else class="tblwrap">
        <table class="tbl">
          <thead>
            <tr><th>실행</th><th>시나리오</th><th class="r">최종</th><th class="r">벤치</th><th class="r">초과</th><th>결과</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in runs" :key="r.id" class="row--click" :class="{ 'row--on': r.id === run?.id }"
                @click="open(r.id)">
              <td class="mono-num">{{ fmtTime(r.at) }}</td>
              <td>{{ r.scenario || '—' }}</td>
              <td class="r mono-num" :class="dirClass(r.final)">{{ pctText(r.final) }}</td>
              <td class="r mono-num" :class="dirClass(r.bench)">{{ pctText(r.bench) }}</td>
              <td class="r mono-num" :class="dirClass(diff(r))">{{ diff(r) == null ? '—' : signedPct(diff(r)) }}</td>
              <td :class="r.ok ? 'up' : 'down'">{{ r.ok ? '완주' : '실패' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { apiFetch } from '../lib/apiClient';

const route = useRoute();
const router = useRouter();
const runs = ref([]);
const run = ref(null);
const error = ref('');
const busy = ref(false);

const result = computed(() => run.value?.result || null);
const series = computed(() => {
  const s = result.value?.series;
  return Array.isArray(s) ? s.map((x) => Number(x)).filter((n) => Number.isFinite(n)) : [];
});
const excess = computed(() => diff(run.value));
function diff(r) {
  const f = Number(r?.final); const b = Number(r?.bench);
  return Number.isFinite(f) && Number.isFinite(b) ? Math.round((f - b) * 100) / 100 : null;
}

/**
 * 🔴 **MDD 는 시계열이 있을 때만 잰다.** 없으면 `null` — 0 으로 채우면
 *    "낙폭이 없었다" 로 읽힌다(검사 못 함 ≠ 통과).
 */
const mdd = computed(() => {
  const s = series.value;
  if (s.length < 2) return null;
  let peak = s[0]; let worst = 0;
  for (const v of s) {
    if (v > peak) peak = v;
    const dd = v - peak;
    if (dd < worst) worst = dd;
  }
  return Math.round(worst * 100) / 100;
});

const W = 600; const H = 120;
const maxV = computed(() => (series.value.length ? Math.max(...series.value, 0) : 0));
const minV = computed(() => (series.value.length ? Math.min(...series.value, 0) : 0));
function pointsOf() {
  const s = series.value;
  if (s.length < 2) return [];
  const hi = maxV.value; const lo = minV.value;
  const span = hi - lo || 1;
  return s.map((v, i) => [
    (i / (s.length - 1)) * W,
    H - ((v - lo) / span) * H,
  ]);
}
const linePath = computed(() => {
  const p = pointsOf();
  return p.length ? p.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ') : '';
});
const areaPath = computed(() => {
  const p = pointsOf();
  if (!p.length) return '';
  return `${linePath.value} L${W} ${H} L0 ${H} Z`;
});
const zeroY = computed(() => {
  const hi = maxV.value; const lo = minV.value;
  const span = hi - lo || 1;
  return (H - ((0 - lo) / span) * H).toFixed(1);
});

const fmt = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });
function pctText(v) { return Number.isFinite(Number(v)) ? `${fmt.format(Number(v))}%` : '—'; }
function signedPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${fmt.format(n)}%`;
}
function dirClass(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '';
  return n > 0 ? 'up' : 'down';
}
function fmtTime(iso) {
  try { return new Date(iso).toLocaleString('ko-KR', { hour12: false }); } catch { return '—'; }
}

async function loadList() {
  try {
    const r = await apiFetch('/api/backtest/runs');
    const b = await r.json();
    runs.value = b?.items || [];
  } catch (e) { error.value = `회차 목록 실패: ${e.message}`; }
}

async function loadRun(id) {
  if (!id) { run.value = null; return; }
  busy.value = true; error.value = '';
  try {
    const r = await apiFetch(`/api/backtest/runs/${encodeURIComponent(id)}`);
    const b = await r.json();
    if (!r.ok || b?.ok === false) { error.value = b?.error || `회차를 못 읽었습니다 (HTTP ${r.status}).`; run.value = null; return; }
    run.value = b;
  } catch (e) {
    error.value = `회차 읽기 실패: ${e.message}`;
  } finally { busy.value = false; }
}

function open(id) {
  router.push({ name: 'backtest', params: { id } });
}

onMounted(async () => {
  await loadList();
  // id 가 없으면 **가장 최근 회차**를 연다 — 빈 화면보다 낫다
  const id = route.params.id || runs.value[0]?.id;
  if (id && !route.params.id) router.replace({ name: 'backtest', params: { id } });
  else await loadRun(id);
});
watch(() => route.params.id, (id) => loadRun(id));
</script>

<style scoped>
.page { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-base); display: flex; flex-direction: column; gap: var(--space-base); }
.page__head { display: flex; align-items: center; gap: var(--space-sm); }
.page__head h1 { margin: 0; font-size: var(--text-lg); color: var(--color-ink); }
.gap { flex: 1; }
.mut { color: var(--color-muted); font-size: var(--text-xs); }
.back { color: var(--color-primary); text-decoration: none; font-size: var(--text-sm); }
.back:hover { text-decoration: underline; }
/* 🔴 모의임을 상단에 못박는다 — 실거래 배지와 색을 분명히 다르게(경고 계열) */
.sim { font-size: var(--text-2xs); color: var(--color-warn); border: 1px solid var(--color-warn); background: var(--color-warn-soft); border-radius: var(--rounded-pill); padding: 2px 10px; }

.card { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-base); display: flex; flex-direction: column; gap: var(--space-sm); }
.card h2 { margin: 0; font-size: var(--text-md); color: var(--color-ink); display: flex; gap: var(--space-sm); align-items: baseline; }

.meta { display: flex; gap: var(--space-lg, 24px); flex-wrap: wrap; }
.meta dt { font-size: var(--text-2xs); color: var(--color-faint); }
.meta dd { margin: 0; color: var(--color-ink); font-weight: 600; }

.kcards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--space-sm); }
.kcard { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-sm) var(--space-base); display: flex; flex-direction: column; gap: 2px; }
.kcard small { color: var(--color-faint); font-size: var(--text-2xs); }
.kcard b { font-size: var(--text-lg); color: var(--color-ink); }
.kcard em { font-style: normal; }

.chart { width: 100%; height: 150px; display: block; }
.chart__area { fill: var(--color-primary-soft); }
.chart__line { fill: none; stroke: var(--color-primary); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.chart__zero { stroke: var(--color-hairline-strong); stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
.chart__legend { display: flex; align-items: center; }

.tail { margin: 0; padding: var(--space-sm); background: var(--color-surface-sunken); border: 1px solid var(--color-hairline-soft); border-radius: var(--rounded-md); font-family: var(--font-mono); font-size: var(--text-2xs); color: var(--color-body); overflow-x: auto; white-space: pre; }

.tblwrap { overflow-x: auto; }
.tbl { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.tbl th { text-align: left; font-size: var(--text-2xs); color: var(--color-faint); padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline); white-space: nowrap; }
.tbl td { padding: 6px var(--space-sm); border-bottom: 1px solid var(--color-hairline-soft); }
.tbl th.r, .tbl td.r { text-align: right; }
.row--click { cursor: pointer; }
.row--click:hover { background: var(--color-surface-hover); }
.row--on { background: var(--color-primary-soft); }

.up { color: var(--color-up); }
.down { color: var(--color-down); }
.banner { padding: var(--space-sm) var(--space-base); border-radius: var(--rounded-md); border: 1px solid var(--color-hairline); }
.banner--error { border-color: var(--color-danger); background: var(--color-danger-soft); color: var(--color-ink); }
.banner--empty { color: var(--color-muted); }
</style>

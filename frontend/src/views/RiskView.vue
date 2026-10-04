<!--
  D-8 포트폴리오·리스크 (2026-10-03 와이어프레임 준용)
  한도 대비 현재 위치(게이지) + 비중 도넛 대신 바(기존 언어 유지) + 보유 테이블.
  스트레스 테스트 = `/api/risk/stress`(10-04 신설) — 지수 쇼크 × 레버리지 근사(베타 1 가정 명시).
-->
<template>
  <div class="page">
    <header class="page__head"><h1>포트폴리오·리스크</h1>
      <span v-if="asOf" class="chip mono-num">{{ new Date(asOf).toLocaleTimeString('ko-KR') }} 기준</span></header>
    <p v-if="error" class="banner banner--error">{{ error }}</p>
    <template v-else-if="weights">
      <section class="card">
        <h2>한도 대비 현재 위치</h2>
        <div class="gauges">
          <div class="gauge" v-for="g in gauges" :key="g.label">
            <div class="gauge__head"><span>{{ g.label }}</span>
              <b class="mono-num" :class="{ down: g.over }">{{ g.now }}% <small>/ {{ g.limit }}%</small></b></div>
            <div class="gauge__bar"><span :style="{ width: Math.min(100, g.pct) + '%' }" :class="{ 'gauge__fill--warn': g.pct >= 80 }" class="gauge__fill"></span></div>
          </div>
        </div>
      </section>
      <section class="card">
        <h2>자산 구성</h2>
        <div class="mix">
          <div v-for="w in weights.holdings" :key="w.symbol" class="mix__row">
            <RouterLink class="mix__sym mix__sym--link" :to="`/symbol/${w.symbol}`">{{ w.symbol }}<small v-if="w.leverage >= 2" class="lev">{{ w.leverage }}x</small></RouterLink>
            <div class="mix__bar"><span :style="{ width: w.pct + '%' }"></span></div>
            <b class="mono-num">{{ w.pct }}%</b>
          </div>
          <div class="mix__row">
            <span class="mix__sym">현금</span>
            <div class="mix__bar mix__bar--cash"><span :style="{ width: weights.cashPct + '%' }"></span></div>
            <b class="mono-num">{{ weights.cashPct }}%</b>
          </div>
        </div>
      </section>
      <section class="card">
        <h2>스트레스 테스트 <small class="mut">지수 쇼크 시 예상 손실</small></h2>
        <template v-if="stress?.ok">
          <table class="tbl">
            <thead><tr><th>시나리오</th><th>예상 손실</th><th>가장 큰 자리</th></tr></thead>
            <tbody><tr v-for="sc in stress.scenarios" :key="sc.shockPct">
              <td>지수 {{ sc.shockPct }}%</td>
              <td class="mono-num down">{{ fmtKrw(sc.lossKrw) }}</td>
              <td class="mono-num">{{ worst(sc) }}</td>
            </tr></tbody>
          </table>
          <p class="mut">⚠️ {{ stress.assumption }}</p>
        </template>
        <p v-else class="mut">{{ stress?.error || '스트레스 테스트를 읽는 중…' }}</p>
        <p class="mut">업종 분류는 토스 API 가 업종을 주지 않아 지어낼 수 없다.</p>
      </section>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { apiFetch } from '../lib/apiClient';

const weights = ref(null);
const asOf = ref(null);
const error = ref('');

/** 한도는 운용 규칙과 같은 어원 — 레버리지 기준치는 playbook 쪽이지만 여기선 표시용 상한만 */
const LIMITS = { leverage: 30, single: 20, cashMin: 10 };

const gauges = computed(() => {
  const w = weights.value; if (!w) return [];
  const top = (w.holdings || []).reduce((a, b) => (b.pct > (a?.pct || 0) ? b : a), null);
  return [
    { label: '레버리지 노출', now: w.leveragePct, limit: LIMITS.leverage, pct: (w.leveragePct / LIMITS.leverage) * 100, over: w.leveragePct > LIMITS.leverage },
    { label: `단일 종목 최대${top ? ` · ${top.symbol}` : ''}`, now: top?.pct ?? 0, limit: LIMITS.single, pct: ((top?.pct ?? 0) / LIMITS.single) * 100, over: (top?.pct ?? 0) > LIMITS.single },
    { label: '현금 비중 (최소 유지)', now: w.cashPct, limit: LIMITS.cashMin, pct: (w.cashPct / LIMITS.cashMin) * 100, over: w.cashPct < LIMITS.cashMin },
  ];
});

const stress = ref(null);
const fmtKrw = (n) => (Number.isFinite(n) ? `₩${Math.abs(Math.round(n)).toLocaleString()}` : '—');
const worst = (sc) => {
  const w = (sc.perHolding || []).reduce((a, b) => (Math.abs(b.lossKrw) > Math.abs(a?.lossKrw || 0) ? b : a), null);
  return w ? `${w.symbol} ${fmtKrw(w.lossKrw)}` : '—';
};
onMounted(async () => {
  try { const r = await apiFetch('/api/risk/stress'); stress.value = await r.json(); }
  catch (e) { stress.value = { ok: false, error: e.message }; }
  try {
    const r = await apiFetch('/api/portfolio');
    const b = await r.json();
    weights.value = b?.weights || null;
    asOf.value = b?.asOf || null;
    if (!weights.value) error.value = '비중 데이터가 없습니다 — 포트폴리오 동기화를 확인하세요.';
  } catch (e) { error.value = `읽기 실패: ${e.message}`; }
});
</script>

<style scoped>
.page { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-base); display: flex; flex-direction: column; gap: var(--space-sm); }
.page__head { display: flex; align-items: center; gap: var(--space-sm); }
.page__head h1 { margin: 0; font-size: var(--text-lg); color: var(--color-ink); }
.chip { border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 2px 10px; font-size: var(--text-xs); color: var(--color-body); }
.card { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-base); }
.card h2 { margin: 0 0 8px; font-size: var(--text-md); color: var(--color-ink); }
.mut { margin: 0; font-size: var(--text-sm); color: var(--color-muted); }
.gauges { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-base); }
.gauge { min-width: 0; }
.gauge__head { display: flex; justify-content: space-between; font-size: var(--text-sm); margin-bottom: 4px; }
.gauge__bar { height: 10px; border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); overflow: hidden; }
.gauge__fill { display: block; height: 100%; background: var(--color-primary); }
.gauge__fill--warn { background: var(--color-warn); }
.mix { display: flex; flex-direction: column; gap: 6px; }
.mix__row { display: grid; grid-template-columns: 110px 1fr 60px; align-items: center; gap: var(--space-sm); font-size: var(--text-sm); }
.mix__sym { font-weight: 600; color: var(--color-ink); }
.mix__bar { height: 12px; border: 1px solid var(--color-hairline); border-radius: var(--rounded-xs); overflow: hidden; }
.mix__bar span { display: block; height: 100%; background: var(--color-ink); }
.mix__bar--cash span { background: repeating-linear-gradient(45deg, var(--color-surface) 0 4px, var(--color-hairline) 4px 6px); }
.mix__sym--link { color: var(--color-primary); text-decoration: none; }
.mix__sym--link:hover { text-decoration: underline; }
.mix__row b { text-align: right; }
.tbl { width: 100%; border-collapse: collapse; font-size: var(--text-sm); margin-bottom: 6px; }
.tbl th { text-align: left; font-size: var(--text-2xs); color: var(--color-faint); padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline); }
.tbl td { padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline-soft); }
.lev { margin-left: 4px; padding: 0 4px; border: 1px solid var(--color-warn); color: var(--color-warn); border-radius: var(--rounded-xs); font-size: var(--text-2xs); }
</style>

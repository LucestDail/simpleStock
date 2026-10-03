<!--
  D-8 포트폴리오·리스크 (2026-10-03 와이어프레임 준용)
  한도 대비 현재 위치(게이지) + 비중 도넛 대신 바(기존 언어 유지) + 보유 테이블.
  ⚠️ 스트레스 테스트(지수 -5% 시나리오)는 **백엔드 계산이 없어** 이번엔 안 그린다 — 명시한다.
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
            <span class="mix__sym">{{ w.symbol }}<small v-if="w.leverage >= 2" class="lev">{{ w.leverage }}x</small></span>
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
        <h2>이 화면이 아직 못 보여주는 것</h2>
        <p class="mut">스트레스 테스트(지수 -5%/-10% 시나리오별 예상 손실) — 계산 백엔드가 없다.
          업종 분류 — 토스 API 가 업종을 주지 않아 지어낼 수 없다. (없는 숫자를 그리지 않는다.)</p>
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

onMounted(async () => {
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
.mix__row b { text-align: right; }
.lev { margin-left: 4px; padding: 0 4px; border: 1px solid var(--color-warn); color: var(--color-warn); border-radius: var(--rounded-xs); font-size: var(--text-2xs); }
</style>

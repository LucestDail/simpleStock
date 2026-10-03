<!--
  D-10 성과 리포트 (2026-10-03 와이어프레임 준용 — **있는 데이터만**)
  와이어프레임의 핵심 축 = "사용자 개입 효과"(승인/거절/만료) — 감사 집계로 그대로 됨.
  ⚠️ 수익률·벤치마크 비교·월별 표는 **스냅샷 이력 백엔드가 없어** 이번엔 안 그린다.
     빈 차트를 그리는 것보다 "무엇이 없는지" 를 적는 쪽이 이 저장소 규율이다.
-->
<template>
  <div class="page">
    <header class="page__head"><h1>성과 리포트</h1><span class="chip">생애 · 감사 기준</span></header>
    <p v-if="!stats" class="banner banner--empty">감사 데이터를 읽는 중…</p>
    <template v-else>
      <div class="kcards">
        <div class="kcard"><small>제안</small><b class="mono-num">{{ stats.proposed }}</b></div>
        <div class="kcard"><small>승인</small><b class="mono-num">{{ stats.approved + stats.executed }}</b></div>
        <div class="kcard"><small>거절</small><b class="mono-num" :class="{ down: rejectRate >= 50 }">{{ stats.rejected }} · {{ rejectRate }}%</b></div>
        <div class="kcard"><small>만료</small><b class="mono-num">{{ stats.expired }}</b></div>
        <div class="kcard"><small>실주문 체결</small><b class="mono-num">{{ stats.executed }}</b></div>
        <div class="kcard"><small>차단(가드·정지)</small><b class="mono-num">{{ stats.blocked ?? 0 }}</b></div>
      </div>
      <section class="card">
        <h2>사용자 개입 효과</h2>
        <p class="mut">자율 모드 해금의 전제 = **거절률이 내려가는 추세**. 지금 {{ rejectRate }}% —
          에이전트 제안의 품질이 올라가면 이 수치가 먼저 움직인다.</p>
      </section>
      <section class="card">
        <h2>이 리포트가 아직 못 보여주는 것</h2>
        <p class="mut">수익률 vs KOSPI · 월별 성과 표 · "승인 없이 운용했다면" 가정 수익 —
          **일별 자산 스냅샷 이력이 없어** 계산할 수 없다. 스냅샷 적재를 시작하면 여기 채워진다.
          (없는 숫자를 그리지 않는다.)</p>
      </section>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { apiFetch } from '../lib/apiClient';
const stats = ref(null);
const rejectRate = computed(() => {
  const s = stats.value; if (!s) return 0;
  const d = (s.approved || 0) + (s.executed || 0) + (s.rejected || 0);
  return d ? Math.round((s.rejected / d) * 100) : 0;
});
onMounted(async () => {
  try { const r = await apiFetch('/api/orders/stats'); const b = await r.json(); stats.value = b?.ok ? b : null; }
  catch { stats.value = null; }
});
</script>

<style scoped>
.page { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-base); display: flex; flex-direction: column; gap: var(--space-sm); }
.page__head { display: flex; align-items: center; gap: var(--space-sm); }
.page__head h1 { margin: 0; font-size: var(--text-lg); color: var(--color-ink); }
.chip { border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 2px 10px; font-size: var(--text-xs); color: var(--color-body); }
.kcards { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: var(--space-sm); }
.kcard { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-sm) var(--space-base); display: flex; flex-direction: column; }
.kcard small { font-size: var(--text-2xs); color: var(--color-faint); }
.kcard b { font-size: var(--text-xl); color: var(--color-ink); }
.card { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-base); }
.card h2 { margin: 0 0 4px; font-size: var(--text-md); color: var(--color-ink); }
.mut { margin: 0; font-size: var(--text-sm); color: var(--color-muted); }
</style>

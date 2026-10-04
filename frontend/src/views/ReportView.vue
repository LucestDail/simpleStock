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
        <p class="mut">자율 모드 해금의 전제 = 거절률이 내려가는 추세. 지금 {{ rejectRate }}% —
          에이전트 제안의 품질이 올라가면 이 수치가 먼저 움직인다.</p>
      </section>
      <section class="card">
        <h2>수익률 <small class="mut" v-if="perf?.days">{{ perf.firstDay }} ~ {{ perf.lastDay }} · {{ perf.days }}일</small></h2>
        <template v-if="perf?.returns">
          <dl class="rets">
            <div><dt>내 계좌</dt><dd class="mono-num" :class="tone(perf.returns.totalPct)">{{ sign(perf.returns.totalPct) }}%</dd></div>
            <div><dt>KOSPI</dt><dd class="mono-num">{{ sign(perf.returns.kospiPct) }}%</dd></div>
            <div><dt>나스닥</dt><dd class="mono-num">{{ sign(perf.returns.qqqPct) }}%</dd></div>
            <div v-if="perf.returns.kospiPct != null"><dt>KOSPI 대비</dt>
              <dd class="mono-num" :class="tone(perf.returns.totalPct - perf.returns.kospiPct)">{{ sign(round2(perf.returns.totalPct - perf.returns.kospiPct)) }}%p</dd></div>
          </dl>
          <table class="tbl" v-if="perf.monthly.length">
            <thead><tr><th>월</th><th>관측일</th><th>내 계좌</th><th>KOSPI</th><th>나스닥</th></tr></thead>
            <tbody><tr v-for="m in perf.monthly" :key="m.month">
              <td class="mono-num">{{ m.month }}</td><td class="mono-num">{{ m.days }}</td>
              <td class="mono-num" :class="tone(m.returnPct)">{{ sign(m.returnPct) }}%</td>
              <td class="mono-num">{{ sign(m.kospiPct) }}%</td>
              <td class="mono-num">{{ sign(m.qqqPct) }}%</td>
            </tr></tbody>
          </table>
        </template>
        <p v-else class="mut">
          일일 스냅샷 적재를 {{ perf?.days ? `시작했다 (${perf.days}일째)` : '오늘 시작했다' }} —
          2일째부터 수익률이 계산된다. 한 점으로 수익률을 지어내지 않는다.
        </p>
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
const perf = ref(null);
const sign = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + v);
const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const round2 = (v) => Math.round(v * 100) / 100;
onMounted(async () => {
  try { const r = await apiFetch('/api/orders/stats'); const b = await r.json(); stats.value = b?.ok ? b : null; }
  catch { stats.value = null; }
  try { const r = await apiFetch('/api/performance'); perf.value = await r.json(); }
  catch { perf.value = null; }
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
.rets { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: var(--space-sm); margin: 0 0 8px; }
.rets dt { font-size: var(--text-2xs); color: var(--color-faint); }
.rets dd { margin: 0; font-size: var(--text-lg); font-weight: 700; color: var(--color-ink); }
.tbl { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.tbl th { text-align: left; font-size: var(--text-2xs); color: var(--color-faint); padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline); }
.tbl td { padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline-soft); }
</style>

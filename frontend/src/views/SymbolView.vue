<!--
  D-7 종목 상세 (2026-10-04 와이어프레임 준용)
  차트(PriceChart 재사용) · 내 포지션 · 에이전트 견해(최근 보고서의 그 종목 판단) ·
  이 종목의 거래 이력(감사에서) · 뉴스. 수동 주문은 대시보드 제안 경로를 쓴다 —
  주문 입구를 둘 만들면 한도 검사가 갈라진다.
-->
<template>
  <div class="page">
    <header class="page__head">
      <RouterLink to="/risk" class="mut">포트폴리오</RouterLink><span class="mut">/</span>
      <h1>{{ name || symbol }}</h1>
      <span class="chip mono-num">{{ symbol }}</span>
      <span v-if="held" class="chip">보유 {{ held.quantity }}주</span>
    </header>

    <section class="card card--chart"><PriceChart :symbol="symbol" :name="name || symbol" /></section>

    <div class="cols">
      <section class="card" v-if="held">
        <h2>내 포지션</h2>
        <dl class="grid">
          <div><dt>수량</dt><dd class="mono-num">{{ held.quantity }}주</dd></div>
          <div><dt>평균 단가</dt><dd class="mono-num">{{ held.avgPrice }}</dd></div>
          <div><dt>현재가</dt><dd class="mono-num">{{ held.lastPrice }}</dd></div>
          <div><dt>평가손익</dt><dd class="mono-num" :class="held.profit >= 0 ? 'up' : 'down'">{{ held.profit }} ({{ held.profitRate }}%)</dd></div>
        </dl>
      </section>
      <section class="card">
        <h2>에이전트 견해 <small class="mut" v-if="viewAt">{{ viewAt.slice(0, 16) }} 분석</small></h2>
        <template v-if="agentView">
          <p><b :class="agentView.stance === 'BUY' ? 'up' : agentView.stance === 'SELL' ? 'down' : ''">{{ agentView.stance }}</b>
            <small class="mut"> · 확신도 {{ agentView.confidence }}</small></p>
          <p class="body">{{ agentView.rationale }}</p>
          <p v-if="agentView.scenarioUp" class="sc">▲ {{ agentView.scenarioUp }}</p>
          <p v-if="agentView.scenarioDown" class="sc">▼ {{ agentView.scenarioDown }}</p>
        </template>
        <p v-else class="mut">최근 분석에 이 종목 판단이 없습니다 — 보유·후보가 아니면 분석 대상이 아닙니다.</p>
      </section>
    </div>

    <section class="card">
      <h2>이 종목의 제안·주문 이력 <small class="mut">감사 기준</small></h2>
      <table v-if="history.length" class="tbl">
        <thead><tr><th>시각</th><th>이벤트</th><th>방향</th></tr></thead>
        <tbody><tr v-for="(h, i) in history" :key="i">
          <td class="mono-num">{{ new Date(h.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }}</td>
          <td>{{ h.event }}</td><td>{{ h.side || '—' }}</td>
        </tr></tbody>
      </table>
      <p v-else class="mut">이 종목으로 만들어진 제안이 아직 없습니다.</p>
    </section>

    <section class="card">
      <h2>뉴스</h2>
      <ul v-if="news.length" class="news"><li v-for="(n, i) in news" :key="i">
        <a :href="n.url || '#'" target="_blank" rel="noopener">{{ n.title }}</a>
        <small v-if="n.when" class="mut"> · {{ n.when }}</small>
      </li></ul>
      <p v-else class="mut">{{ newsNote || '뉴스를 불러오는 중…' }}</p>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { apiFetch } from '../lib/apiClient';
import PriceChart from '../components/PriceChart.vue';

const route = useRoute();
const symbol = computed(() => String(route.params.code || '').toUpperCase());
const name = ref('');
const held = ref(null);
const agentView = ref(null);
const viewAt = ref(null);
const history = ref([]);
const news = ref([]);
const newsNote = ref('');

onMounted(async () => {
  try {
    const r = await apiFetch('/api/portfolio'); const b = await r.json();
    held.value = (b.items || []).find((h) => String(h.symbol).toUpperCase() === symbol.value) || null;
    if (held.value) name.value = held.value.name;
  } catch { /* 포지션 없이도 페이지는 선다 */ }
  try {
    const r = await apiFetch('/api/analyst/last'); const b = await r.json();
    viewAt.value = b?.at || null;
    agentView.value = (b?.positions || []).find((p) => String(p.symbol).toUpperCase() === symbol.value) || null;
  } catch { /* 견해 없음으로 */ }
  try {
    const r = await apiFetch('/api/orders/stats'); const b = await r.json();
    history.value = (b?.recent || []).filter((x) => String(x.symbol).toUpperCase() === symbol.value);
  } catch { /* 이력 없음으로 */ }
  try {
    const q = new URLSearchParams({ symbol: symbol.value, name: name.value || symbol.value });
    const r = await apiFetch(`/api/news?${q}`); const b = await r.json();
    news.value = b?.items || [];
    if (!b?.ok) newsNote.value = b?.error || '뉴스를 못 받았습니다.';
  } catch (e) { newsNote.value = `뉴스 실패: ${e.message}`; }
});
</script>

<style scoped>
.page { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-base); display: flex; flex-direction: column; gap: var(--space-sm); }
.page__head { display: flex; align-items: center; gap: var(--space-sm); }
.page__head h1 { margin: 0; font-size: var(--text-lg); color: var(--color-ink); }
.mut { font-size: var(--text-xs); color: var(--color-muted); text-decoration: none; }
.chip { border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 2px 10px; font-size: var(--text-xs); color: var(--color-body); }
.card { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-base); }
.card--chart { height: 380px; display: flex; flex-direction: column; }
.card h2 { margin: 0 0 6px; font-size: var(--text-md); color: var(--color-ink); }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--space-sm); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: var(--space-xs); margin: 0; }
.grid dt { font-size: var(--text-2xs); color: var(--color-faint); }
.grid dd { margin: 0; font-weight: 600; color: var(--color-ink); }
.body { font-size: var(--text-sm); }
.sc { font-size: var(--text-xs); color: var(--color-muted); margin: 2px 0; }
.tbl { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.tbl th { text-align: left; font-size: var(--text-2xs); color: var(--color-faint); padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline); }
.tbl td { padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline-soft); }
.news { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: var(--text-sm); }
.news a { color: var(--color-body); }
</style>

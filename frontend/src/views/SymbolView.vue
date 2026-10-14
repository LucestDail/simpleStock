<!--
  D-7 종목 상세 (2026-10-04 와이어프레임 준용)
  차트(PriceChart 재사용) · 내 포지션 · 에이전트 견해(최근 보고서의 그 종목 판단) ·
  이 종목의 거래 이력(감사에서) · 뉴스. 수동 주문은 대시보드 제안 경로를 쓴다 —
  주문 입구를 둘 만들면 한도 검사가 갈라진다.
-->
<template>
  <div class="page">
    <header class="page__head">
      <RouterLink to="/portfolio" class="mut">포트폴리오</RouterLink><span class="mut">/</span>
      <h1>{{ name || symbol }}</h1>
      <span v-if="name && name !== symbol" class="chip mono-num">{{ symbol }}</span>
      <span v-if="held" class="chip">보유 {{ held.quantity }}주</span>
    </header>

    <section class="card card--chart"><PriceChart :symbol="symbol" :name="name || symbol" /></section>

    <div class="cols">
      <section class="card" v-if="held">
        <h2>내 포지션</h2>
        <dl class="grid">
          <div><dt>수량</dt><dd class="mono-num">{{ held.quantity }}주</dd></div>
          <div><dt>평균 단가</dt><dd class="mono-num">{{ money(held.avgPrice) }}</dd></div>
          <div><dt>현재가</dt><dd class="mono-num">{{ money(held.lastPrice) }}</dd></div>
          <div><dt>평가손익</dt><dd class="mono-num" :class="held.profit >= 0 ? 'up' : 'down'">{{ money(held.profit, true) }} ({{ Number(held.profitRate).toFixed(2) }}%)</dd></div>
        </dl>
      </section>
      <section class="card">
        <h2>에이전트 견해 <small class="mut" v-if="viewAt">{{ when(viewAt) }} 분석</small></h2>
        <!--
          ⛔ **2026-10-14 — BUY/SELL 배지와 시나리오를 들어냈다** (사용자 지시: 보고서만 쓴다).
             `stance`·`scenarioUp`·`scenarioDown` 은 **스키마에서 사라졌다**.
          🔴 `agentView.stance === 'BUY'` 같은 비교는 undefined 에 안전하지만,
             **값이 늘 비어 배지가 빈칸으로 남는다** — 죽은 마크업이다.
          ⚠️ 대신 **관측 서술**을 싣는다.
        -->
        <template v-if="agentView">
          <p v-if="agentView.confidence" class="mut">근거 충실도 {{ agentView.confidence }}</p>
          <p class="body">{{ agentView.rationale }}</p>
          <p v-if="agentView.trend" class="sc">추세 · {{ agentView.trend }}</p>
          <p v-if="agentView.relative" class="sc">상대강도 · {{ agentView.relative }}</p>
          <p v-if="agentView.volatility" class="sc">변동성 · {{ agentView.volatility }}</p>
          <p v-if="agentView.watchPoint" class="sc">관찰 · {{ agentView.watchPoint }}</p>
        </template>
        <p v-else class="mut">최근 분석에 이 종목 판단이 없습니다 — 보유·후보가 아니면 분석 대상이 아닙니다.</p>
      </section>
    </div>

    <!--
      🧪 **종목 평가** (2026-10-12 신설) — 서버에 `/api/rate/:symbol` 이 있는데
         **화면이 한 번도 안 불렀다**(호출 0곳). 와이어프레임 D-5 가 약속한 자리다.
      ⚠️ 이 자리에는 종전 *"이 종목의 제안·주문 이력"* 표가 있었다 — 주문 집행이 사라져
         **영원히 빈 표**가 됐으므로 들어내고 평가를 넣는다.
      🔴 **ETF 는 점수가 없다** — 결손이 아니라 설계다. 점수 대신 성격·한 줄 설명을 보여준다.
    -->
    <section class="card">
      <h2>종목 평가
        <small v-if="rating?.type" class="mut">{{ rating.type }}{{ rating.leverage > 1 ? ` · ${rating.leverage}배` : '' }}</small>
      </h2>
      <p v-if="ratingErr" class="mut">{{ ratingErr }}</p>
      <p v-else-if="!rating" class="mut">평가를 불러오는 중…</p>
      <template v-else>
        <p v-if="rating.oneLiner" class="body">{{ rating.oneLiner }}</p>
        <p v-if="rating.total != null" class="rate__score">
          <b class="mono-num">{{ rating.total }}</b><span class="mut"> / {{ rating.maxTotal || 100 }}</span>
          <span v-if="rating.opinion" class="rate__op">{{ rating.opinion }}</span>
        </p>
        <!-- ⚠️ 마크다운은 여기서 렌더되지 않는다 — `**…**` 는 별표 그대로 찍힌다(실화면에서 확인) -->
        <p v-else class="mut">기업 점수 <b>해당 없음</b> — {{ rating.type }}는 100점 채점 대상이 아닙니다.</p>
        <!--
          🔴 **`strengths`·`weaknesses` 는 배열이 아니라 문자열이다**(서버 스키마 `type:'string'`).
             종전엔 `v-for` 로 돌려서 **글자 하나하나가 항목**이 됐다(`+ 단` `+ 기` `+ 적` …).
             `(문자열).length > 0` 이라 `v-if` 도 멀쩡히 통과해 **아무도 못 막았다.**
          ⇒ 받는 자리에서 **모양을 정규화**(`asList`)하고, 화면은 그 결과만 돌린다.
        -->
        <ul v-if="strengthList.length" class="rate__list">
          <li v-for="(t, i) in strengthList" :key="`s${i}`"><span class="up">+</span> {{ t }}</li>
        </ul>
        <ul v-if="weaknessList.length" class="rate__list">
          <li v-for="(t, i) in weaknessList" :key="`w${i}`"><span class="down">−</span> {{ t }}</li>
        </ul>
      </template>
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
const rating = ref(null);
const ratingErr = ref('');
const news = ref([]);

/**
 * 서술 필드를 **목록으로** 정규화한다.
 *
 * 서버(`stockRating`)는 `strengths`/`weaknesses` 를 **문자열**로 준다
 * (스키마 `type:'string'` · 여러 개면 `' · '` 나 빈 줄로 이어 붙인다).
 * 🔴 그런데 화면이 배열로 착각해 `v-for` 를 돌려 **글자가 항목이 됐다.**
 *
 * ⚠️ 서버가 **배열을 줄 때도 있다**(2026-09-21 실측 — 스키마는 지시일 뿐 강제가 아니다).
 *    그래서 **둘 다 받는다.** 모양을 추측하지 않고, 받은 것을 보고 정한다.
 * ⚠️ 쉼표로는 쪼개지 않는다 — 한 문장 안의 쉼표까지 끊어 버린다.
 */
function asList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v)
    .split(/\n{2,}|\n|\s·\s|\s\u2022\s/)       // 빈 줄 · 줄바꿈 · 가운뎃점 · 불릿
    .map((t) => t.replace(/^[-–—•*+]\s*/, '').trim()) // 앞에 붙은 불릿 기호 제거
    .filter(Boolean);
}
const strengthList = computed(() => asList(rating.value?.strengths));
const weaknessList = computed(() => asList(rating.value?.weaknesses));
const newsNote = ref('');

/** 활동 로그와 같은 압축 시각 — "10. 4. 오전 12:11" 장황체의 재발 방지 */
const when = (at) => {
  if (!at) return '';
  const d = new Date(at); const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
/** 통화 포맷 — raw float(71.778191)가 그대로 화면에 나왔다 */
const money = (v, sign = false) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const cur = held.value?.currency === 'KRW' ? '₩' : '$';
  const abs = cur === '₩' ? Math.abs(Math.round(n)).toLocaleString('ko-KR')
    : Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign ? (n >= 0 ? '+' : '−') : n < 0 ? '−' : ''}${cur}${abs}`;
};

onMounted(async () => {
  try {
    const r = await apiFetch('/api/portfolio'); const b = await r.json();
    held.value = (b.items || []).find((h) => String(h.symbol).toUpperCase() === symbol.value) || null;
    if (held.value) name.value = held.value.name;
  } catch { /* 포지션 없이도 페이지는 선다 */ }
  try {
    const r = await apiFetch('/api/analyst/last'); const b = await r.json();
    // 🔴 응답은 {report:{...}} 로 싸여 있다 — b.positions 로 읽어 견해가 항상 비었다(2026-10-04 실화면)
    const rep = b?.report || b || {};
    viewAt.value = rep.at || null;
    agentView.value = (rep.positions || []).find((p) => String(p.symbol).toUpperCase() === symbol.value) || null;
  } catch { /* 견해 없음으로 */ }
  try {
    const r = await apiFetch(`/api/rate/${encodeURIComponent(symbol.value)}`);
    const b = await r.json();
    if (b && !b.error) rating.value = b;
    else ratingErr.value = b?.error || '평가를 불러오지 못했습니다.';
  } catch (e) { ratingErr.value = `평가 실패: ${e.message}`; }
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
/* 🔴 2026-10-04 사용자: "width 100% 늘이지 말고 배치를 고민" — 초광폭(1700px+)에서
   카드가 끝까지 퍼져 황량했다. 스크롤 컨테이너(.page)는 전폭을 유지하되(스크롤바가
   오른쪽 끝에 있게) **콘텐츠만** 읽기 좋은 폭에서 멈춘다. */
/* 🔄 10-05: 좌측 고정 1280 은 초광폭에서 오른쪽만 비어 보였다("오른쪽 여백 너무 많이 남고")
   ⇒ 1440 으로 넓히고 **중앙 정렬** — 남는 공간이 양쪽으로 갈라져 여백이 디자인으로 읽힌다. */
.page > * { width: 100%; max-width: 1440px; margin-inline: auto; }

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
.rate__score { margin: 6px 0; display: flex; align-items: baseline; gap: var(--space-sm); }
.rate__score b { font-size: var(--text-xl); color: var(--color-ink); }
.rate__op { font-size: var(--text-sm); color: var(--color-primary); }
.rate__list { margin: 4px 0 0; padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; font-size: var(--text-sm); }
.tbl { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.tbl th { text-align: left; font-size: var(--text-2xs); color: var(--color-faint); padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline); }
.tbl td { padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline-soft); }
.news { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: var(--text-sm); }
.news a { color: var(--color-body); }
</style>

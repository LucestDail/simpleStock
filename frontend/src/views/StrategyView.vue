<!--
  D-9 전략 연구소 (2026-10-04 와이어프레임 준용)
  와이어프레임: "전략을 켜고 끄고, 배분과 파라미터를 바꾸고, 바꾸기 전에 백테스트합니다."
  이 제품의 전략은 **플레이북(32 시나리오) + 퀀트 게이트** — 그 구성을 보여주고,
  백테스트는 verify/backtest.js(제품과 같은 판정·같은 프롬프트)를 그대로 태운다.
  🔴 백테스트는 LLM 을 실제로 태운다(수 분·토큰) — 버튼에 그 사실을 적고 동시 1개.
-->
<template>
  <div class="page">
    <header class="page__head"><h1>전략 연구소</h1>
      <span class="chip">판정 = 제품과 같은 코드 (decideOnContext)</span></header>

    <section class="card">
      <h2>운용 중인 전략 구성</h2>
      <div class="strats">
        <div class="strat strat--on"><b>국면 플레이북</b><small>KR·US 추세 × VIX 로 시나리오 발동{{ regimeNow ? ` — 지금: ${regimeNow}` : '' }}</small></div>
        <div class="strat strat--on"><b>퀀트 게이트</b><small>20일선 위 · 정배열 우선 · 상한 6종 — 수치 미달은 LLM 에 안 간다</small></div>
        <div class="strat strat--on"><b>VIX 사다리</b><small>20/25/30/35 전이 시 현금 10/20/30/40% 기계 매수 제안</small></div>
      </div>
      <p class="mut">배분 비율·파라미터 편집은 <code>config/playbook.json</code>·<code>config/etf-catalog.json</code> 이 정본 —
        화면 편집기는 다음 단계다(설정 파일을 화면에서 고치면 검증 없이 라이브가 바뀐다).</p>
    </section>

    <section class="card">
      <h2>백테스트 <small class="mut">— 합성 시나리오 75일 · 제품과 같은 판정 경로</small></h2>
      <p class="warn">🔴 실행하면 <b>LLM 을 실제로 태웁니다</b>(수 분 + 토큰). 동시 1개만 돕니다.</p>
      <div class="btrow">
        <button v-for="s in scenarios" :key="s" class="btn btn--sm" :disabled="Boolean(running)" @click="run(s)">
          {{ LABEL[s] || s }}
        </button>
        <span v-if="running" class="chip">⏳ {{ LABEL[running.scenario] }} 실행 중 — {{ since(running.startedAt) }}</span>
      </div>
      <div v-if="last" class="btres">
        <h3>마지막 결과 — {{ LABEL[last.scenario] }} <small class="mut">{{ when(last.finishedAt) }}</small></h3>
        <table v-if="last.ok" class="tbl">
          <tr><td>운용 (판정 경로)</td><td class="mono-num" :class="tone(last.final)">$10,000 → ${{ fmt(last.final) }}</td></tr>
          <tr><td>벤치마크 QQQ 보유</td><td class="mono-num">$10,000 → ${{ fmt(last.bench) }}</td></tr>
          <tr><td>초과</td><td class="mono-num" :class="tone(last.final - last.bench)">{{ last.final - last.bench >= 0 ? '+' : '−' }}${{ fmt(Math.abs(last.final - last.bench)) }}</td></tr>
        </table>
        <p v-else class="banner banner--error">실패: {{ last.error }}</p>
        <details><summary>실행 기록 원문 (무엇을 샀는지)</summary><pre class="btlog">{{ last.tail }}</pre></details>
        <p class="mut">⚠️ 합성 데이터 — 과거 성과도 아니고 미래 보장은 더더욱 아니다. <b>판정 로직의 성질</b>(하락장에서 벤치보다 덜 깨지는가)을 재는 도구다.</p>
      </div>
      <p v-else-if="!running" class="banner banner--empty">아직 실행한 백테스트가 없습니다.</p>
    </section>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { apiFetch } from '../lib/apiClient';

const LABEL = { vshape: 'V자 반등', bull: '지속 상승', bear: '지속 하락', chop: '횡보' };
const scenarios = ref([]);
const running = ref(null);
const last = ref(null);
/** 지금 국면 한 줄 — 비어 보이던 자리(regimeInfo 미정의)의 교체. 못 받으면 조용히 생략 */
const regimeNow = ref('');
/** ISO 의 T 가 그대로 보였다 — 사람용 압축(로컬 시각) */
const when = (at) => {
  if (!at) return '';
  const d = new Date(at); const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
apiFetch('/api/regime').then((r) => r.json()).then((b) => {
  const st = b?.state || b;
  const t = (v) => (v === 'up' ? '상승' : v === 'down' ? '하락' : '횡보');
  if (!st?.us?.trend && !st?.kr?.trend) return;
  // ⚠️ vix 는 {value, band, stale} 객체다 — 그대로 찍으면 [object Object](실화면에서 확인)
  const vix = st.vix?.value ?? st.vix;
  regimeNow.value = `US ${t(st.us?.trend)} · KR ${t(st.kr?.trend)} · VIX ${Number.isFinite(Number(vix)) ? vix : '?'}${st.vix?.stale ? '(낡음)' : ''}`;
}).catch(() => {});

const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString() : '—');
const tone = (n) => (n >= 0 ? 'up' : 'down');
const since = (at) => `${Math.round((Date.now() - Date.parse(at)) / 60000)}분`;

async function load() {
  try {
    const r = await apiFetch('/api/backtest/status');
    const b = await r.json();
    scenarios.value = b.scenarios || [];
    running.value = b.running;
    last.value = b.last;
  } catch { /* 페이지 자체 오류 배너는 과하다 — 다음 폴링에 */ }
}
async function run(s) {
  await apiFetch('/api/backtest/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: s }) });
  await load();
}
let timer = null;
onMounted(() => { load(); timer = setInterval(load, 10_000); });
onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
.page { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-base); display: flex; flex-direction: column; gap: var(--space-sm); }
.page__head { display: flex; align-items: center; gap: var(--space-sm); }
.page__head h1 { margin: 0; font-size: var(--text-lg); color: var(--color-ink); }
.chip { border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 2px 10px; font-size: var(--text-xs); color: var(--color-body); }
.card { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-base); }
.card h2 { margin: 0 0 8px; font-size: var(--text-md); color: var(--color-ink); }
.mut { font-size: var(--text-xs); color: var(--color-muted); }
.warn { font-size: var(--text-xs); color: var(--color-warn); margin: 0 0 6px; }
.strats { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-sm); margin-bottom: 6px; }
.strat { border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-sm); display: flex; flex-direction: column; gap: 2px; }
.strat b { color: var(--color-ink); font-size: var(--text-sm); }
.strat small { color: var(--color-muted); font-size: var(--text-xs); }
.strat--on { border-color: var(--color-ai-line); }
.btrow { display: flex; gap: var(--space-xs); align-items: center; flex-wrap: wrap; margin-bottom: var(--space-sm); }
.btres h3 { margin: 0 0 4px; font-size: var(--text-sm); color: var(--color-ink); }
.tbl { border-collapse: collapse; font-size: var(--text-sm); margin-bottom: 6px; }
.tbl td { padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline-soft); }
.btlog { font-size: var(--text-2xs); background: var(--color-surface-sunken); border: 1px solid var(--color-hairline); border-radius: var(--rounded-sm); padding: var(--space-sm); overflow-x: auto; max-height: 300px; }
</style>

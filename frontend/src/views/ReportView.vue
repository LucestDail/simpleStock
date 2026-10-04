<!--
  D-10 성과 리포트 = 7단계 수명주기 (2026-10-04 재구축)
  사용자 정의 7단계(사전탐색→시행준비→수행배치→업무수행→절차마감→사후대비→업무종료)를
  /api/report/lifecycle(10-04 신설) 집계로 그린다 — 기존 데이터를 단계 프레임으로 읽을 뿐,
  새 기록 체계를 만들지 않는다.
  🔴 note("실주문 0 — 데이터 없음" 류)는 정직 표기라 반드시 보인다 — 빈 차트를 채우면 거짓말이 된다.
  유지: 생애 집계 카드(/api/orders/stats) · 수익률(내 계좌/KOSPI/나스닥 + 월별 표, /api/performance).
-->
<template>
  <div class="page">
    <header class="page__head"><h1>성과 리포트</h1><span class="chip">생애 · 감사 기준</span></header>

    <!-- ① 7단계 수명주기 파이프라인 띠 -->
    <section class="card">
      <h2>매매 수명주기 7단계 <small class="mut" v-if="life">{{ fmtAt(life.asOf) }} 기준</small></h2>
      <p v-if="lifeErr" class="banner banner--error">{{ lifeErr }}</p>
      <div v-else-if="life" class="stages">
        <article v-for="(st, i) in life.stages" :key="st.key" class="stage">
          <header class="stage__head">
            <span class="stage__no mono-num">{{ i + 1 }}</span>
            <b class="stage__name">{{ st.name }}</b>
          </header>
          <p class="stage__desc">{{ st.desc }}</p>
          <dl class="stage__metrics">
            <div v-for="m in st.metrics" :key="m.label" class="stage__metric">
              <dt>{{ m.label }}</dt><dd class="mono-num">{{ mval(m.value) }}</dd>
            </div>
          </dl>
          <!-- 🔴 note 는 "실주문 0 — 데이터 없음" 류의 정직 표기 — 숨기지 않는다 -->
          <p v-if="st.note" class="stage__note">⚠️ {{ st.note }}</p>
        </article>
      </div>
      <p v-else class="mut">수명주기 집계를 읽는 중…</p>
    </section>

    <!-- ② 자산·벤치 추이 (첫 관측일 = 100 정규화) -->
    <section class="card">
      <h2>자산·벤치 추이 <small class="mut" v-if="bench && bench.lines.length">첫 관측일 = 100 · {{ bench.firstDay }} ~ {{ bench.lastDay }}</small></h2>
      <template v-if="bench && bench.lines.length">
        <svg class="linechart" :viewBox="`0 0 ${CW} ${CH}`" role="img" aria-label="자산과 벤치마크 정규화 추이">
          <line class="linechart__grid" :x1="PAD_L" :y1="bench.yMax" :x2="CW - PAD_R" :y2="bench.yMax" />
          <line class="linechart__grid" :x1="PAD_L" :y1="bench.yBase" :x2="CW - PAD_R" :y2="bench.yBase" />
          <line class="linechart__grid" :x1="PAD_L" :y1="bench.yMin" :x2="CW - PAD_R" :y2="bench.yMin" />
          <text class="linechart__lbl" :x="PAD_L" :y="bench.yMax - 3">{{ bench.max }}</text>
          <text class="linechart__lbl" :x="PAD_L" :y="bench.yBase - 3">100</text>
          <text class="linechart__lbl" :x="PAD_L" :y="bench.yMin + 11">{{ bench.min }}</text>
          <g v-for="l in bench.lines" :key="l.name">
            <polyline class="linechart__line" :points="l.points" fill="none" :stroke="l.color" />
            <circle :cx="l.lastX" :cy="l.lastY" r="3" :fill="l.color" />
            <text class="linechart__lbl linechart__lbl--series" :x="l.lastX + 6" :y="l.lastY + 3" :fill="l.color">{{ l.name }} {{ l.lastV }}</text>
          </g>
          <text class="linechart__lbl" :x="PAD_L" :y="CH - 6">{{ bench.firstDay }}</text>
          <text class="linechart__lbl linechart__lbl--end" :x="CW - PAD_R" :y="CH - 6">{{ bench.lastDay }}</text>
        </svg>
        <ul class="clegend">
          <li v-for="l in bench.lines" :key="l.name" class="clegend__item">
            <span class="clegend__swatch" :style="{ background: l.color }"></span>{{ l.name }}
          </li>
        </ul>
      </template>
      <p v-else-if="lifeErr" class="mut">수명주기 집계를 못 읽어 추이도 못 그린다 — 위 오류를 먼저 해결할 것.</p>
      <p v-else class="mut">이력 2일째부터 그려집니다{{ life ? ` (지금 ${(life.series || []).length}일째)` : '' }}.</p>
    </section>

    <!-- ③ 생애 집계 카드 (유지) -->
    <p v-if="statsErr" class="banner banner--error">{{ statsErr }}</p>
    <p v-else-if="!stats" class="banner banner--empty">감사 데이터를 읽는 중…</p>
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
    </template>

    <!-- ④ 실매매 손익 -->
    <section class="card">
      <h2>실매매 손익</h2>
      <template v-if="life && life.trades && life.trades.length">
        <table class="tbl">
          <thead><tr><th>시각</th><th>종목</th><th>방향</th></tr></thead>
          <tbody><tr v-for="(t, i) in life.trades" :key="t.at + t.symbol + i">
            <td class="mono-num">{{ fmtAt(t.at) }}</td>
            <td class="mono-num">{{ t.symbol || '—' }}</td>
            <td :class="sideTone(t.side)">{{ sideLabel(t.side) }}</td>
          </tr></tbody>
        </table>
        <p class="mut">체결별 손익 금액은 감사가 담지 않는다 — 계좌 수익률(아래)로 본다.</p>
      </template>
      <p v-else class="mut">실주문 0 — 체결이 생기면 손익 추이가 여기 쌓입니다.</p>
    </section>

    <!-- ⑤ 수익률 (유지) -->
    <section class="card">
      <h2>수익률 <small class="mut" v-if="perf?.days">{{ perf.firstDay }} ~ {{ perf.lastDay }} · {{ perf.days }}일</small></h2>
      <p v-if="perfErr" class="banner banner--error">{{ perfErr }}</p>
      <template v-else-if="perf?.returns">
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
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { apiFetch } from '../lib/apiClient';

/* ── 공통 포맷 ─────────────────────────────── */
const fmtAt = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const sign = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + v);
const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const round2 = (v) => Math.round(v * 100) / 100;
/* metrics value 는 숫자('감사 레코드 수')와 문자열('5분 주기')이 섞인다 — 숫자만 세 자리 구분 */
const mval = (v) => (typeof v === 'number' ? v.toLocaleString() : (v ?? '—'));
const sideLabel = (s) => (s === 'BUY' ? '매수' : s === 'SELL' ? '매도' : (s || '—'));
const sideTone = (s) => (s === 'BUY' ? 'up' : s === 'SELL' ? 'down' : 'flat');

/* ── ① 7단계 수명주기 ─────────────────────── */
const life = ref(null);
const lifeErr = ref('');

/* ── ② 자산·벤치 정규화 추이 (SVG 직접) ────── */
const CW = 640; const CH = 190;
const PAD_L = 10; const PAD_R = 118; const PAD_T = 16; const PAD_B = 24;
const SERIES_DEF = [
  { key: 'totalKrw', name: '내 계좌', color: 'var(--color-primary)' },
  { key: 'kospi', name: 'KOSPI', color: 'var(--color-warn)' },
  { key: 'qqq', name: '나스닥', color: 'var(--color-ai)' },
];
const bench = computed(() => {
  const rows = life.value?.series || [];
  if (rows.length < 2) return { lines: [] };
  const lines = [];
  for (const def of SERIES_DEF) {
    /* 정규화 기준 = 그 시리즈의 첫 유효값. 벤치가 null 인 날은 선에서 건너뛴다(0 으로 그리지 않는다) */
    const base = Number(rows.find((r) => Number(r[def.key]) > 0)?.[def.key]);
    if (!(base > 0)) continue;
    const pts = [];
    rows.forEach((r, i) => {
      const v = Number(r[def.key]);
      if (v > 0) pts.push({ i, v: (v / base) * 100 });
    });
    if (pts.length >= 2) lines.push({ ...def, pts });
  }
  if (!lines.length) return { lines: [] };
  const all = lines.flatMap((l) => l.pts.map((p) => p.v));
  let min = Math.min(...all, 100); let max = Math.max(...all, 100);
  if (max - min < 0.5) { min -= 1; max += 1; }
  const span = max - min;
  const x = (i) => PAD_L + (i * (CW - PAD_L - PAD_R)) / (rows.length - 1);
  const y = (v) => PAD_T + (1 - (v - min) / span) * (CH - PAD_T - PAD_B);
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    firstDay: rows[0].day,
    lastDay: rows[rows.length - 1].day,
    min: r1(min), max: r1(max), yMin: y(min), yMax: y(max), yBase: y(100),
    lines: lines.map((l) => {
      const last = l.pts[l.pts.length - 1];
      return {
        name: l.name, color: l.color,
        points: l.pts.map((p) => `${x(p.i)},${y(p.v)}`).join(' '),
        lastX: x(last.i), lastY: y(last.v), lastV: r1(last.v),
      };
    }),
  };
});

/* ── ③ 생애 집계 (유지) ───────────────────── */
const stats = ref(null);
const statsErr = ref('');
const rejectRate = computed(() => {
  const s = stats.value; if (!s) return 0;
  const d = (s.approved || 0) + (s.executed || 0) + (s.rejected || 0);
  return d ? Math.round((s.rejected / d) * 100) : 0;
});

/* ── ⑤ 수익률 (유지) ─────────────────────── */
const perf = ref(null);
const perfErr = ref('');

onMounted(async () => {
  try {
    const r = await apiFetch('/api/report/lifecycle');
    const b = await r.json();
    if (b?.ok) life.value = b;
    else lifeErr.value = b?.error || '수명주기 집계를 불러오지 못했습니다.';
  } catch (e) { lifeErr.value = `수명주기 읽기 실패: ${e.message}`; }
  try {
    const r = await apiFetch('/api/orders/stats');
    const b = await r.json();
    if (b?.ok) stats.value = b;
    else statsErr.value = b?.error || '감사 집계를 불러오지 못했습니다.';
  } catch (e) { statsErr.value = `감사 집계 읽기 실패: ${e.message}`; }
  try { const r = await apiFetch('/api/performance'); perf.value = await r.json(); }
  catch (e) { perfErr.value = `수익률 읽기 실패: ${e.message}`; }
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

/* ── 7단계 띠 — 가로 배치, 좁으면 자기 영역 안에서만 가로 스크롤 ── */
.stages { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(180px, 1fr); gap: var(--space-sm); overflow-x: auto; padding-bottom: 4px; }
.stage { border: 1px solid var(--color-hairline); border-radius: var(--rounded-sm); padding: var(--space-sm); display: flex; flex-direction: column; gap: 6px; min-width: 0; background: var(--color-surface-raised); }
.stage__head { display: flex; align-items: center; gap: 6px; }
.stage__no { width: 18px; height: 18px; border-radius: var(--rounded-pill); background: var(--color-primary-soft); color: var(--color-primary); font-size: var(--text-2xs); display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; }
.stage__name { font-size: var(--text-sm); color: var(--color-ink); }
.stage__desc { margin: 0; font-size: var(--text-2xs); color: var(--color-muted); }
.stage__metrics { margin: 0; display: flex; flex-direction: column; gap: 2px; }
.stage__metric { display: flex; justify-content: space-between; gap: 6px; font-size: var(--text-xs); }
.stage__metric dt { color: var(--color-faint); min-width: 0; }
.stage__metric dd { margin: 0; color: var(--color-ink); font-weight: 600; white-space: nowrap; }
.stage__note { margin: auto 0 0; font-size: var(--text-2xs); color: var(--color-warn); }

/* ── 꺾은선 ── */
.linechart { display: block; width: 100%; height: auto; }
.linechart__grid { stroke: var(--color-hairline-soft); stroke-width: 1; }
.linechart__line { stroke-width: 2; }
.linechart__lbl { font-size: 10px; fill: var(--color-faint); }
.linechart__lbl--end { text-anchor: end; }
.linechart__lbl--series { font-weight: 700; }
.clegend { margin: 4px 0 0; padding: 0; list-style: none; display: flex; gap: var(--space-base); flex-wrap: wrap; }
.clegend__item { display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-xs); color: var(--color-body); }
.clegend__swatch { width: 10px; height: 10px; border-radius: var(--rounded-xs); }

/* ── 집계 카드 ── */
.kcards { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: var(--space-sm); }
.kcard { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-sm) var(--space-base); display: flex; flex-direction: column; }
.kcard small { font-size: var(--text-2xs); color: var(--color-faint); }
.kcard b { font-size: var(--text-xl); color: var(--color-ink); }

/* ── 수익률 ── */
.rets { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: var(--space-sm); margin: 0 0 8px; }
.rets dt { font-size: var(--text-2xs); color: var(--color-faint); }
.rets dd { margin: 0; font-size: var(--text-lg); font-weight: 700; color: var(--color-ink); }
.tbl { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.tbl th { text-align: left; font-size: var(--text-2xs); color: var(--color-faint); padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline); }
.tbl td { padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline-soft); }
</style>

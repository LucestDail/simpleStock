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
          <!-- 📜 숫자 아래 최근 이력 2줄 (2026-10-05 — "이력은 안 보이고 숫자만") -->
          <ul v-if="st.recent && st.recent.length" class="stage__recent">
            <li v-for="(r, j) in st.recent.slice(0, 2)" :key="st.key + j" :title="r.text">
              <span class="stage__rat mono-num">{{ fmtAt(r.at) }}</span>
              <span class="stage__rtx">{{ r.text }}</span>
            </li>
          </ul>
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
        <!-- 🔄 2026-10-05 라벨 겹침 해소: ① y 눈금을 플롯 밖 왼쪽으로(값 위에 안 얹는다)
             ② 선 끝 라벨은 세로 충돌 회피(12px 최소 간격) + 밀린 라벨은 리더선으로 점과 잇는다
             ③ 하단 날짜 눈금 MM-DD 2~3개 — 데이터 2점뿐이어도 축이 상태를 말해 준다 -->
        <svg class="linechart" :viewBox="`0 0 ${CW} ${CH}`" role="img" aria-label="자산과 벤치마크 정규화 추이">
          <g v-for="t in bench.yTicks" :key="'y' + t.label">
            <line class="linechart__grid" :x1="PAD_L" :y1="t.y" :x2="CW - PAD_R" :y2="t.y" />
            <text class="linechart__lbl linechart__lbl--y" :x="PAD_L - 6" :y="t.y + 3">{{ t.label }}</text>
          </g>
          <g v-for="l in bench.lines" :key="l.name">
            <polyline class="linechart__line" :points="l.points" fill="none" :stroke="l.color" />
            <circle :cx="l.lastX" :cy="l.lastY" r="3" :fill="l.color" />
            <!-- 라벨이 점에서 밀려났으면 가는 리더선으로 어느 점의 라벨인지 잇는다 -->
            <line v-if="l.leader" class="linechart__leader" :x1="l.lastX + 4" :y1="l.lastY" :x2="l.lastX + 10" :y2="l.labelY" :stroke="l.color" />
            <text class="linechart__lbl linechart__lbl--series" :x="l.lastX + 12" :y="l.labelY + 3" :fill="l.color">{{ l.name }} {{ l.lastV }}</text>
          </g>
          <text v-for="t in bench.xTicks" :key="'x' + t.label + t.x" class="linechart__lbl" :class="{ 'linechart__lbl--end': t.end, 'linechart__lbl--mid': t.mid }" :x="t.x" :y="CH - 6">{{ t.label }}</text>
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
/* PAD_L 44: y 눈금 라벨이 플롯 밖 왼쪽에 산다(10 이던 때는 라벨이 선·그리드 위에 얹혔다) */
const PAD_L = 44; const PAD_R = 118; const PAD_T = 16; const PAD_B = 24;
const LBL_GAP = 12; /* 선 끝 라벨 최소 세로 간격(px) — 10px 글자 + 숨구멍 */
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

  /* y 눈금 — min·100·max. 서로 너무 붙으면(라벨 높이 미만) 하나로 접는다 */
  const yTicks = [];
  for (const v of [...new Set([r1(max), 100, r1(min)])].sort((a, b) => b - a)) {
    const yy = y(v);
    if (yTicks.some((t) => Math.abs(t.y - yy) < LBL_GAP)) continue;
    yTicks.push({ y: yy, label: String(v) });
  }

  /* x 눈금 — 첫날·마지막날(+5일 이상이면 가운데 하루). MM-DD 로 짧게 */
  const md = (day) => String(day || '').slice(5);
  const xTicks = [{ x: PAD_L, label: md(rows[0].day) }];
  if (rows.length >= 5) {
    const mi = Math.floor((rows.length - 1) / 2);
    xTicks.push({ x: x(mi), label: md(rows[mi].day), mid: true });
  }
  xTicks.push({ x: CW - PAD_R, label: md(rows[rows.length - 1].day), end: true });

  /* 선 끝 라벨 세로 충돌 회피 — 값이 비슷한 날(실측: 2일차) 라벨이 포개지던 자리.
     y 로 정렬해 위에서부터 최소 LBL_GAP 을 보장하고, 바닥을 넘치면 전체를 위로 민다 */
  const built = lines.map((l) => {
    const last = l.pts[l.pts.length - 1];
    return {
      name: l.name, color: l.color,
      points: l.pts.map((p) => `${x(p.i)},${y(p.v)}`).join(' '),
      lastX: x(last.i), lastY: y(last.v), lastV: r1(last.v),
      labelY: y(last.v), leader: false,
    };
  });
  const order = [...built].sort((a, b) => a.lastY - b.lastY);
  let prevY = PAD_T - LBL_GAP;
  for (const l of order) { l.labelY = Math.max(l.lastY, prevY + LBL_GAP); prevY = l.labelY; }
  /* 아래로 밀다 바닥을 넘쳤으면, 바닥에서 위로 한 번 더 조여 플롯 안에 가둔다 */
  let floor = CH - PAD_B;
  for (let i = order.length - 1; i >= 0; i -= 1) {
    order[i].labelY = Math.min(order[i].labelY, floor);
    floor = order[i].labelY - LBL_GAP;
  }
  for (const l of built) l.leader = Math.abs(l.labelY - l.lastY) > 4;

  return {
    firstDay: rows[0].day,
    lastDay: rows[rows.length - 1].day,
    yTicks, xTicks,
    lines: built,
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
/* 🔴 2026-10-04 사용자: "width 100% 늘이지 말고 배치를 고민" — 초광폭(1700px+)에서
   카드가 끝까지 퍼져 황량했다. 스크롤 컨테이너(.page)는 전폭을 유지하되(스크롤바가
   오른쪽 끝에 있게) **콘텐츠만** 읽기 좋은 폭에서 멈춘다. */
/* 🔄 10-05: 좌측 고정 1280 은 초광폭에서 오른쪽만 비어 보였다("오른쪽 여백 너무 많이 남고")
   ⇒ 1440 으로 넓히고 **중앙 정렬** — 남는 공간이 양쪽으로 갈라져 여백이 디자인으로 읽힌다. */
.page > * { width: 100%; max-width: 1440px; margin-inline: auto; }

.page__head { display: flex; align-items: center; gap: var(--space-sm); }
.page__head h1 { margin: 0; font-size: var(--text-lg); color: var(--color-ink); }
.chip { border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 2px 10px; font-size: var(--text-xs); color: var(--color-body); }
.card { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-base); }
.card h2 { margin: 0 0 8px; font-size: var(--text-md); color: var(--color-ink); }
.mut { margin: 0; font-size: var(--text-sm); color: var(--color-muted); }

/* ── 7단계 띠 — 가로 배치, 좁으면 자기 영역 안에서만 가로 스크롤 ── */
.stages { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(180px, 1fr); gap: var(--space-sm); overflow-x: auto; padding-bottom: 4px; }
.stage { border: 1px solid var(--color-hairline); border-radius: var(--rounded-sm); padding: var(--space-sm); display: flex; flex-direction: column; gap: 6px; min-width: 0; background: var(--color-surface-raised);; min-height: 190px; display: flex; flex-direction: column; }
.stage__head { display: flex; align-items: center; gap: 6px; }
.stage__no { width: 18px; height: 18px; border-radius: var(--rounded-pill); background: var(--color-primary-soft); color: var(--color-primary); font-size: var(--text-2xs); display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; }
.stage__name { font-size: var(--text-sm); color: var(--color-ink); }
.stage__desc { margin: 0; font-size: var(--text-2xs); color: var(--color-muted); }
.stage__metrics { margin: 0; display: flex; flex-direction: column; gap: 2px; }
.stage__metric { display: flex; justify-content: space-between; gap: 6px; font-size: var(--text-xs); }
.stage__metric dt { color: var(--color-faint); min-width: 0; }
.stage__metric dd { margin: 0; color: var(--color-ink); font-weight: 600; white-space: nowrap; }
/* 숫자 아래 최근 이력 2줄 — 한 줄 = 시각 + 한 줄 요약(넘치면 말줄임, 전문은 title) */
.stage__recent { margin: auto 0 0; padding: 4px 0 0; list-style: none; border-top: 1px dashed var(--color-hairline-soft); display: flex; flex-direction: column; gap: 2px; }
.stage__recent li { display: flex; gap: 6px; align-items: baseline; font-size: var(--text-2xs); min-width: 0; }
.stage__rat { color: var(--color-faint); flex: 0 0 auto; }
.stage__rtx { color: var(--color-body); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.stage__note { margin: 4px 0 0; font-size: var(--text-2xs); color: var(--color-warn); }
/* recent 가 없는 카드(이력 0건)는 note 가 바닥 정렬을 이어받는다 — desc·metrics 바로 뒤의 note */
.stage__metrics + .stage__note { margin-top: auto; }

/* ── 꺾은선 ── */
.linechart { display: block; width: 100%; height: auto; }
.linechart__grid { stroke: var(--color-hairline-soft); stroke-width: 1; }
.linechart__line { stroke-width: 2; }
.linechart__lbl { font-size: 10px; fill: var(--color-faint); }
.linechart__lbl--end { text-anchor: end; }
.linechart__lbl--mid { text-anchor: middle; }
.linechart__lbl--y { text-anchor: end; }
.linechart__lbl--series { font-weight: 700; }
.linechart__leader { stroke-width: 1; opacity: .5; }
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

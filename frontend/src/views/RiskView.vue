<!--
  D-8 포트폴리오·리스크 (2026-10-04 심화 재구축)
  유지: 한도 게이지 3종 · 스트레스 표 · /symbol 링크.
  확장: 자산 구성 도넛(SVG 직접) · 리스크 지표(/api/risk/metrics — 현물 환산 그릭스) ·
        밸런스 판정(issues) · 자산 추이 꺾은선(/api/performance) · 관심 종목 관리(대시보드에서 이사).
  🔴 null 은 '—' 로 그린다 — 감마·세타는 "해당 없음(현물)" 이 정답이지 0 이 아니다.
  🔴 각 절은 자기 오류를 자기 자리에서 말한다(.banner--error) — 조용히 빈 화면 금지.
-->
<template>
  <div class="page">
    <header class="page__head"><h1>포트폴리오·리스크</h1>
      <span v-if="asOf" class="chip mono-num">{{ fmtAt(asOf) }} 기준</span></header>
    <p v-if="error" class="banner banner--error">{{ error }}</p>

    <!-- ① 자산 구성 도넛 -->
    <section v-if="weights" class="card">
      <h2>자산 구성</h2>
      <div class="donutwrap">
        <div class="donutbox">
          <svg class="donut" viewBox="0 0 42 42" role="img" aria-label="자산 구성 도넛">
            <circle class="donut__track" cx="21" cy="21" :r="DONUT_R" fill="none" stroke-width="6.5" />
            <g transform="rotate(-90 21 21)">
              <circle
                v-for="s in donut"
                :key="s.key"
                cx="21" cy="21" :r="DONUT_R" fill="none" stroke-width="6.5"
                :stroke="s.color"
                :stroke-dasharray="dashOf(s)"
                :stroke-dashoffset="-s.start"
              />
            </g>
          </svg>
          <div class="donut__center">
            <small>총평가액</small>
            <b class="mono-num">{{ fmtKrw(totalKrw) }}</b>
          </div>
        </div>
        <ul class="dlegend">
          <li v-for="s in donut" :key="s.key" class="dlegend__row">
            <span class="dlegend__dot" :style="{ background: s.color }"></span>
            <RouterLink v-if="s.link" class="dlegend__sym" :to="`/symbol/${s.key}`">{{ s.label }}</RouterLink>
            <span v-else class="dlegend__sym dlegend__sym--plain">{{ s.label }}</span>
            <span v-if="s.leverage >= 2" class="lev">{{ s.leverage }}x</span>
            <small v-if="s.category" class="dlegend__cat">{{ s.category }}</small>
            <b class="mono-num">{{ s.pct }}%</b>
          </li>
        </ul>
      </div>
    </section>

    <!-- ② 한도 대비 현재 위치 (유지) -->
    <section v-if="weights" class="card">
      <h2>한도 대비 현재 위치</h2>
      <div class="gauges">
        <div class="gauge" v-for="g in gauges" :key="g.label">
          <div class="gauge__head"><span>{{ g.label }}</span>
            <b class="mono-num" :class="{ down: g.over }">{{ g.now }}% <small>/ {{ g.limit }}%</small></b></div>
          <!-- 🔴 경고색은 위반일 때만 — 현금(최소 유지)은 바가 가득해도 정상이다(2026-10-04 실화면) -->
          <div class="gauge__bar"><span :style="{ width: Math.min(100, g.pct) + '%' }" :class="{ 'gauge__fill--warn': g.over }" class="gauge__fill"></span></div>
        </div>
      </div>
    </section>

    <!-- ③ 리스크 지표 (2026-10-04 신설 /api/risk/metrics) -->
    <section class="card">
      <h2>리스크 지표 <small class="mut">현물 환산 그릭스 · 20일 실현 변동성</small></h2>
      <p v-if="metricsErr" class="banner banner--error">{{ metricsErr }}</p>
      <template v-else-if="metrics">
        <div class="mstats">
          <div class="mstat mstat--hero">
            <small>지수 델타</small>
            <b class="mono-num">{{ nval(metrics.indexDelta) }}</b>
            <small class="mstat__sub">지수 1% → 포트폴리오 ≈ {{ nval(metrics.indexDelta) }}%</small>
          </div>
          <div class="mstat"><small>포트폴리오 변동성 (연)</small><b class="mono-num">{{ pval(metrics.portfolioVolAnnPct) }}</b></div>
          <div class="mstat"><small>VaR95 (1일)</small><b class="mono-num">{{ pval(metrics.portfolioVar95DayPct) }}</b></div>
          <!-- 🔴 감마·세타는 null — 숫자로 그리지 않는다. 현물엔 해당 없음이 정답이다 -->
          <div class="mstat"><small>감마</small><b class="mstat__na">해당 없음 — 현물</b></div>
          <div class="mstat"><small>세타</small><b class="mstat__na">해당 없음 — 현물</b></div>
        </div>
        <table v-if="metrics.per && metrics.per.length" class="rtbl">
          <thead><tr>
            <th>종목</th><th>비중</th><th>레버리지</th><th>변동성(연)</th><th>하방(연)</th><th>VaR95(1일)</th><th>감쇠/일</th>
          </tr></thead>
          <tbody><tr v-for="p in metrics.per" :key="p.symbol">
            <td><RouterLink class="symlink" :to="`/symbol/${p.symbol}`">{{ p.symbol }}</RouterLink></td>
            <td class="num mono-num">{{ pval(p.weightPct) }}</td>
            <td class="num mono-num">{{ p.leverage }}x</td>
            <td class="num mono-num">{{ pval(p.vol20dAnnPct) }}</td>
            <td class="num mono-num">{{ pval(p.downsideAnnPct) }}</td>
            <td class="num mono-num">{{ pval(p.var95DayPct) }}</td>
            <td class="num mono-num">{{ pval(p.decayDayPct) }}</td>
          </tr></tbody>
        </table>
        <p v-else class="mut">종목별 지표가 비어 있다 — 캔들 10개 이상부터 계산된다.</p>
        <p class="mut">※ {{ metrics.greeksNote }}</p>
        <p class="mut">※ {{ metrics.volNote }}</p>
      </template>
      <p v-else class="mut">리스크 지표를 읽는 중…</p>
    </section>

    <!-- ④ 밸런스 판정 -->
    <section v-if="metrics" class="card">
      <h2>밸런스 판정 <small class="mut">보완 필요한 축</small></h2>
      <p v-if="!metrics.issues || !metrics.issues.length" class="issue issue--ok">한도 위반 없음 — 레버리지·종목 집중·현금 모두 한도 안이다.</p>
      <ul v-else class="issues">
        <li v-for="(i, idx) in metrics.issues" :key="idx" class="issue" :class="issueClass(i)">
          <span class="issue__tag">{{ issueTag(i) }}</span>{{ i.msg }}
        </li>
      </ul>
    </section>

    <!-- ⑤ 스트레스 테스트 (유지) -->
    <section v-if="weights" class="card">
      <h2>스트레스 테스트 <small class="mut">지수 쇼크 시 예상 손실</small></h2>
      <template v-if="stress && stress.ok">
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
      <p v-else class="mut">{{ (stress && stress.error) || '스트레스 테스트를 읽는 중…' }}</p>
    </section>

    <!-- ⑥ 자산 추이 (일일 스냅샷) -->
    <section class="card">
      <h2>자산 추이 <small class="mut" v-if="trend && trend.points.length">{{ trend.firstDay }} ~ {{ trend.lastDay }}</small></h2>
      <p v-if="perfErr" class="banner banner--error">{{ perfErr }}</p>
      <template v-else-if="trend && trend.points.length >= 2">
        <svg class="linechart" :viewBox="`0 0 ${CW} ${CH}`" role="img" aria-label="총평가액 추이">
          <line class="linechart__grid" :x1="PAD_L" :y1="trend.yMax" :x2="CW - PAD_R" :y2="trend.yMax" />
          <line class="linechart__grid" :x1="PAD_L" :y1="trend.yMin" :x2="CW - PAD_R" :y2="trend.yMin" />
          <text class="linechart__lbl" :x="PAD_L" :y="trend.yMax - 3">{{ fmtKrw(trend.max) }}</text>
          <text class="linechart__lbl" :x="PAD_L" :y="trend.yMin + 11">{{ fmtKrw(trend.min) }}</text>
          <polyline class="linechart__line linechart__line--total" :points="trend.pointsStr" fill="none" />
          <circle class="linechart__dot" :cx="trend.lastX" :cy="trend.lastY" r="3" />
          <text class="linechart__lbl linechart__lbl--end" :x="trend.lastX - 6" :y="trend.lastY - 7">{{ fmtKrw(trend.last) }}</text>
          <text class="linechart__lbl" :x="PAD_L" :y="CH - 6">{{ trend.firstDay }}</text>
          <text class="linechart__lbl linechart__lbl--end" :x="CW - PAD_R" :y="CH - 6">{{ trend.lastDay }}</text>
        </svg>
      </template>
      <p v-else class="mut">이력 2일째부터 그려집니다{{ trend ? ` (지금 ${trend.points.length}일째)` : '' }}.</p>
    </section>

    <!-- ⑦ 관심 종목 관리 (대시보드에서 이사 — useWatchlist 공용 모듈 그대로) -->
    <section class="card">
      <h2>관심 종목 관리 <small class="mut">감시를 켠 종목만 모멘텀 분석이 깨운다</small></h2>
      <p v-if="wlError" class="banner banner--error">{{ wlError }}</p>
      <div class="waddgroup">
        <input v-model="newGroupName" class="input input--xs" placeholder="새 테마 그룹 이름" @keyup.enter="onAddGroup" />
        <button class="btn btn--xs btn--soft" :disabled="busy" @click="onAddGroup">그룹 추가</button>
      </div>
      <p v-if="wlLoading && !groups.length" class="mut">관심종목을 불러오는 중…</p>
      <div class="wgrid">
        <article v-for="group in groups" :key="group.id" class="wcard">
          <header class="wcard__head">
            <span class="wcard__name">{{ group.name }}</span>
            <span class="wcard__count mono-num">{{ (group.tickers && group.tickers.length) || 0 }}</span>
            <button class="iconbtn" title="그룹 삭제" @click="onDeleteGroup(group)">×</button>
          </header>
          <ul class="wlist">
            <li v-for="t in group.tickers" :key="t.symbol + t.market" class="wrow" :class="{ 'wrow--watch': t.watch }">
              <RouterLink class="wrow__sym" :to="`/symbol/${t.symbol}`">{{ t.name || t.symbol }}</RouterLink>
              <span class="wrow__tick mono-num">{{ t.symbol }}</span>
              <button
                class="wrow__w"
                :class="{ 'wrow__w--on': t.watch }"
                :title="t.watch ? '감시 중 — 끄려면 클릭' : '감시 켜기'"
                @click="onToggleWatch(group, t)"
              >{{ t.watch ? '감시중' : '감시' }}</button>
              <button class="iconbtn" title="삭제" @click="onRemoveTicker(group, t)">×</button>
            </li>
            <li v-if="!group.tickers || !group.tickers.length" class="wrow wrow--empty">비어 있음</li>
          </ul>
          <div class="wadd">
            <input v-model="ensureInput(group.id).query" class="input input--xs" placeholder="티커/종목명" @keyup.enter="onAddTicker(group)" />
            <button class="btn btn--xs btn--soft" :disabled="busy" @click="onAddTicker(group)">+</button>
          </div>
        </article>
      </div>
      <p class="mut">숏 플로팅·업종 분류는 토스 API 가 주지 않는다 — 데이터 미제공(지어내지 않는다).</p>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { apiFetch } from '../lib/apiClient';
import { useWatchlist } from '../composables/useWatchlist';
import { useUi } from '../composables/useUi';

/* ── 공통 포맷 ─────────────────────────────── */
const fmtKrw = (n) => (Number.isFinite(n) ? `₩${Math.round(n).toLocaleString()}` : '—');
const pval = (v) => (v == null ? '—' : `${v}%`);
const nval = (v) => (v == null ? '—' : v);
const fmtAt = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/* ── ① 포트폴리오(비중·총평가액) ─────────────── */
const weights = ref(null);
const summary = ref(null);
const asOf = ref(null);
const error = ref('');
const totalKrw = computed(() => {
  const v = Number(summary.value?.value?.krw);
  return Number.isFinite(v) && v > 0 ? v : null;
});

/* 도넛 — 외부 라이브러리 없이 stroke-dasharray. 둘레 100 이 되는 반지름이라 pct 를 그대로 쓴다. */
const DONUT_R = 15.9155;
/* 색은 지위(수익색)가 아니라 정체성 — up/down 토큰은 손익 전용이라 쓰지 않는다. 고정 순서. */
const DONUT_PALETTE = [
  'var(--color-primary)',
  'var(--color-ai)',
  'var(--color-warn)',
  'var(--color-flat)',
  'var(--color-muted)',
  'var(--color-primary-line)',
];
const donut = computed(() => {
  const w = weights.value; if (!w) return [];
  const items = (w.holdings || []).map((h, i) => ({
    key: h.symbol, label: h.symbol, pct: Number(h.pct) || 0,
    leverage: Number(h.leverage) || 1, category: h.category || null,
    color: DONUT_PALETTE[Math.min(i, DONUT_PALETTE.length - 1)], link: true,
  }));
  if (w.cashPct != null) {
    items.push({ key: 'CASH', label: '현금', pct: Number(w.cashPct) || 0, leverage: 1, category: null, color: 'var(--color-hairline-strong)', link: false });
  }
  let acc = 0;
  return items.filter((s) => s.pct > 0).map((s) => { const start = acc; acc += s.pct; return { ...s, start }; });
});
/* 조각 사이 1(둘레의 1%) 틈 — 아주 작은 조각은 틈을 포기한다(사라지면 안 된다) */
const dashOf = (s) => {
  const gap = s.pct > 2 ? 1 : 0;
  const len = Math.max(0.4, s.pct - gap);
  return `${len} ${100 - len}`;
};

/* ── ② 한도 게이지 (유지) ─────────────────── */
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

/* ── ③·④ 리스크 지표 + 밸런스 판정 ─────────── */
const metrics = ref(null);
const metricsErr = ref('');
const issueClass = (i) => (i.level === 'warn' ? 'issue--warn' : 'issue--bad');
const issueTag = (i) => {
  const axis = { leverage: '레버리지', single: '종목 집중', cash: '현금', decay: '감쇠' }[i.axis] || i.axis;
  return i.symbol ? `${axis} · ${i.symbol}` : axis;
};

/* ── ⑤ 스트레스 (유지) ────────────────────── */
const stress = ref(null);
const worst = (sc) => {
  const w = (sc.perHolding || []).reduce((a, b) => (Math.abs(b.lossKrw) > Math.abs(a?.lossKrw || 0) ? b : a), null);
  return w ? `${w.symbol} ${fmtKrw(w.lossKrw)}` : '—';
};

/* ── ⑥ 자산 추이 꺾은선 ───────────────────── */
const CW = 640; const CH = 170;
const PAD_L = 10; const PAD_R = 76; const PAD_T = 16; const PAD_B = 24;
const perf = ref(null);
const perfErr = ref('');
const trend = computed(() => {
  if (!perf.value) return null;
  const rows = (perf.value.series || []).filter((r) => Number(r.totalKrw) > 0);
  if (rows.length < 2) return { points: rows };
  const vals = rows.map((r) => Number(r.totalKrw));
  let min = Math.min(...vals); let max = Math.max(...vals);
  if (max - min < 1) { min -= 1; max += 1; }
  const span = max - min;
  const x = (i) => PAD_L + (i * (CW - PAD_L - PAD_R)) / (rows.length - 1);
  const y = (v) => PAD_T + (1 - (v - min) / span) * (CH - PAD_T - PAD_B);
  return {
    points: rows,
    firstDay: rows[0].day, lastDay: rows[rows.length - 1].day,
    min, max, yMin: y(min), yMax: y(max),
    pointsStr: rows.map((r, i) => `${x(i)},${y(Number(r.totalKrw))}`).join(' '),
    lastX: x(rows.length - 1), lastY: y(vals[vals.length - 1]), last: vals[vals.length - 1],
  };
});

/* ── ⑦ 관심 종목 관리 — WorkspaceView(HEAD~3) 의 핸들러를 그대로 이식 ── */
const {
  groups, loading: wlLoading, error: wlError, load: wlLoad,
  createGroup, deleteGroup, addTicker, removeTicker,
} = useWatchlist();
const { notify, confirmAction } = useUi();
const newGroupName = ref('');
const tickerInputs = ref({}); // groupId -> { query, market }
const busy = ref(false);

function ensureInput(groupId) {
  if (!tickerInputs.value[groupId]) tickerInputs.value[groupId] = { query: '', market: '' };
  return tickerInputs.value[groupId];
}

async function onAddGroup() {
  const name = newGroupName.value.trim();
  if (!name) return;
  busy.value = true;
  try {
    await createGroup(name);
    newGroupName.value = '';
    notify({ message: `'${name}' 그룹을 추가했습니다.`, tone: 'success' });
  } catch (e) {
    notify({ message: e.message || '그룹 추가 실패', tone: 'error' });
  } finally {
    busy.value = false;
  }
}

async function onDeleteGroup(group) {
  const ok = await confirmAction({
    title: '그룹 삭제',
    message: `'${group.name}' 그룹과 포함된 ${(group.tickers && group.tickers.length) || 0}개 종목을 삭제할까요?`,
    confirmLabel: '삭제',
    tone: 'danger',
  });
  if (!ok) return;
  try {
    await deleteGroup(group.id);
    notify({ message: '그룹을 삭제했습니다.', tone: 'success' });
  } catch (e) {
    notify({ message: e.message || '그룹 삭제 실패', tone: 'error' });
  }
}

async function onAddTicker(group) {
  const input = ensureInput(group.id);
  const query = String(input.query || '').trim();
  if (!query) return;
  busy.value = true;
  try {
    // 심볼처럼 보이면 symbol, 아니면 종목명(query)로 전송.
    const looksLikeSymbol = /^[A-Za-z0-9.\-]{1,12}$/.test(query);
    const payload = looksLikeSymbol
      ? { symbol: query, market: input.market || undefined }
      : { query, market: input.market || undefined };
    const r = await addTicker(group.id, payload);
    input.query = '';
    if (r && r.added === false) {
      notify({ message: '이미 그룹에 있는 종목입니다.', tone: 'info' });
    } else {
      const sym = r?.ticker?.symbol || query;
      notify({ message: `${sym} 추가됨. 시세를 불러오는 중…`, tone: 'success' });
    }
  } catch (e) {
    notify({ message: e.message || '종목 추가 실패', tone: 'error' });
  } finally {
    busy.value = false;
  }
}

async function onRemoveTicker(group, ticker) {
  try {
    await removeTicker(group.id, ticker.symbol);
  } catch (e) {
    notify({ message: e.message || '종목 삭제 실패', tone: 'error' });
  }
}

/**
 * 🔴 감시 표시 토글 — 이것만 모멘텀 분석을 부른다.
 * ⚠️ 실패를 조용히 넘기지 않는다 — 별이 켜진 줄 알았는데 안 켜졌으면 알림이 안 온다.
 */
async function onToggleWatch(group, t) {
  try {
    const res = await apiFetch(
      `/api/watchlist/groups/${encodeURIComponent(group.id)}/tickers/${encodeURIComponent(t.symbol)}/watch`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: !t.watch }) }
    );
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '감시 설정 실패');
    t.watch = !t.watch;
  } catch (e) {
    notify({ message: e.message || '감시 설정 실패', tone: 'error' });
  }
}

/* ── 적재 — 절마다 독립 실패(한 API 가 죽어도 나머지는 그린다) ── */
onMounted(async () => {
  try { const r = await apiFetch('/api/risk/stress'); stress.value = await r.json(); }
  catch (e) { stress.value = { ok: false, error: e.message }; }
  try {
    const r = await apiFetch('/api/portfolio');
    const b = await r.json();
    weights.value = b?.weights || null;
    summary.value = b?.summary || null;
    asOf.value = b?.asOf || null;
    if (!weights.value) error.value = b?.error || '비중 데이터가 없습니다 — 포트폴리오 동기화를 확인하세요.';
  } catch (e) { error.value = `읽기 실패: ${e.message}`; }
  try {
    const r = await apiFetch('/api/risk/metrics');
    const b = await r.json();
    if (b?.ok) metrics.value = b;
    else metricsErr.value = b?.error || '리스크 지표를 불러오지 못했습니다.';
  } catch (e) { metricsErr.value = `리스크 지표 읽기 실패: ${e.message}`; }
  try { const r = await apiFetch('/api/performance'); perf.value = await r.json(); }
  catch (e) { perfErr.value = `자산 추이 읽기 실패: ${e.message}`; }
  wlLoad();
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

/* ── 도넛 ── */
.donutwrap { display: flex; align-items: center; gap: var(--space-lg); flex-wrap: wrap; }
.donutbox { position: relative; width: 180px; flex: 0 0 auto; }
.donut { display: block; width: 100%; height: auto; }
.donut__track { stroke: var(--color-surface-sunken); }
.donut__center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; pointer-events: none; }
.donut__center small { font-size: var(--text-2xs); color: var(--color-faint); }
.donut__center b { font-size: var(--text-sm); color: var(--color-ink); }
.dlegend { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; min-width: 220px; flex: 1; }
.dlegend__row { display: flex; align-items: center; gap: 6px; font-size: var(--text-sm); }
.dlegend__dot { width: 10px; height: 10px; border-radius: var(--rounded-pill); flex: 0 0 auto; }
.dlegend__sym { font-weight: 600; color: var(--color-primary); text-decoration: none; }
.dlegend__sym:hover { text-decoration: underline; }
.dlegend__sym--plain { color: var(--color-ink); }
.dlegend__cat { color: var(--color-faint); font-size: var(--text-2xs); }
.dlegend__row b { margin-left: auto; color: var(--color-ink); }
.lev { padding: 0 4px; border: 1px solid var(--color-warn); color: var(--color-warn); border-radius: var(--rounded-xs); font-size: var(--text-2xs); }

/* ── 게이지 ── */
.gauges { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-base); }
.gauge { min-width: 0; }
.gauge__head { display: flex; justify-content: space-between; font-size: var(--text-sm); margin-bottom: 4px; }
.gauge__bar { height: 10px; border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); overflow: hidden; }
.gauge__fill { display: block; height: 100%; background: var(--color-primary); }
.gauge__fill--warn { background: var(--color-warn); }

/* ── 리스크 지표 ── */
.mstats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--space-sm); margin-bottom: var(--space-sm); }
.mstat { border: 1px solid var(--color-hairline); border-radius: var(--rounded-sm); padding: var(--space-sm); display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mstat small { font-size: var(--text-2xs); color: var(--color-faint); }
.mstat b { font-size: var(--text-lg); color: var(--color-ink); }
.mstat--hero { border-color: var(--color-primary-line); background: var(--color-primary-soft); }
.mstat--hero b { font-size: var(--text-2xl); }
.mstat__sub { color: var(--color-muted); }
.mstat__na { font-size: var(--text-sm); font-weight: 600; color: var(--color-muted); }
.rtbl { width: 100%; border-collapse: collapse; font-size: var(--text-sm); margin-bottom: 6px; }
.rtbl th { text-align: left; font-size: var(--text-2xs); color: var(--color-faint); padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline); }
.rtbl td { padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline-soft); }
.rtbl td.num { text-align: right; }
.num { text-align: right; }
.symlink { color: var(--color-primary); text-decoration: none; font-weight: 600; }
.symlink:hover { text-decoration: underline; }

/* ── 밸런스 판정 ── */
.issues { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.issue { border: 1px solid var(--color-hairline); border-radius: var(--rounded-sm); padding: var(--space-sm); font-size: var(--text-sm); color: var(--color-body); display: block; }
.issue--bad { background: var(--color-danger-soft); border-color: var(--color-danger); }
.issue--warn { background: var(--color-warn-soft); border-color: var(--color-warn); }
.issue--ok { background: var(--color-up-soft); border-color: var(--color-up); margin: 0; }
.issue__tag { display: inline-block; margin-right: 6px; padding: 0 6px; border-radius: var(--rounded-xs); font-size: var(--text-2xs); font-weight: 700; background: var(--color-surface); border: 1px solid var(--color-hairline); color: var(--color-ink); }

/* ── 스트레스 표 ── */
.tbl { width: 100%; border-collapse: collapse; font-size: var(--text-sm); margin-bottom: 6px; }
.tbl th { text-align: left; font-size: var(--text-2xs); color: var(--color-faint); padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline); }
.tbl td { padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline-soft); }

/* ── 꺾은선 ── */
.linechart { display: block; width: 100%; height: auto; }
.linechart__grid { stroke: var(--color-hairline-soft); stroke-width: 1; }
.linechart__line { stroke-width: 2; }
.linechart__line--total { stroke: var(--color-primary); }
.linechart__dot { fill: var(--color-primary); }
.linechart__lbl { font-size: 10px; fill: var(--color-faint); }
.linechart__lbl--end { text-anchor: end; }

/* ── 관심 종목 관리 ── */
.waddgroup { display: flex; gap: 6px; margin-bottom: var(--space-sm); max-width: 360px; }
.wgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--space-sm); margin-bottom: var(--space-sm); }
.wcard { border: 1px solid var(--color-hairline); border-radius: var(--rounded-sm); padding: var(--space-sm); display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.wcard__head { display: flex; align-items: center; gap: 6px; }
.wcard__name { font-weight: 700; font-size: var(--text-sm); color: var(--color-ink); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wcard__count { font-size: var(--text-2xs); color: var(--color-faint); }
.wlist { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
.wrow { display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: var(--text-sm); border-bottom: 1px solid var(--color-hairline-soft); }
.wrow--watch { background: var(--color-primary-soft); }
.wrow--empty { color: var(--color-faint); border-bottom: 0; }
.wrow__sym { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-ink); text-decoration: none; }
.wrow__sym:hover { color: var(--color-primary); text-decoration: underline; }
.wrow__tick { font-size: var(--text-2xs); color: var(--color-faint); }
.wrow__w { border: 1px solid var(--color-hairline); background: var(--color-surface); color: var(--color-muted); border-radius: var(--rounded-xs); font-size: var(--text-2xs); padding: 1px 6px; cursor: pointer; }
.wrow__w--on { border-color: var(--color-primary); color: var(--color-primary); background: var(--color-primary-soft); }
.wadd { display: flex; gap: 6px; }
.input--xs { height: 26px; font-size: var(--text-xs); padding: 0 6px; }
</style>

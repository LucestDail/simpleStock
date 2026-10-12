<!--
  🎯 포트폴리오 (2026-10-12 **통합** — 사용자: *"리스크/전략연구소/포트폴리오를 합쳐서
     포트폴리오/전략연구소로. 리스크 내용이 거의 포트폴리오랑 연계되는 내용 같은데."*)

  리스크 화면과 포트폴리오 화면이 **같은 것을 두 번** 보여주고 있었다 —
  자산 구성 ↔ 비중 구성 · 한도 게이지 ↔ 기준선 초과 · 자산 추이(둘 다).
  ⇒ 한 화면으로 합치고 중복을 걷었다.

  🔴 **한도 하드코딩을 걷어냈다.** 이 화면은 `LIMITS = { leverage: 30, single: 20, cashMin: 10 }`
     을 **복제해 들고 있어서**, 포트폴리오 화면이 *"기준 40%"* 라고 할 때 여기는 *"30%"* 라고
     **다른 말을 했다**(사용자 스크린샷에서 드러났다). 이제 서버 `rules.checks` 를 그대로 쓴다.
     ⇒ 기준선을 쥐는 곳은 `server/portfolioRules.js` **하나**다.

  ⚠️ **관심 종목 관리 절은 설정으로 갔다** — 설정 화면에 같은 것이 있어 중복이었다.
  유지: 한도 게이지 3종 · 스트레스 표 · /symbol 링크.
  확장: 자산 구성 도넛(SVG 직접) · 리스크 지표(/api/risk/metrics — 현물 환산 그릭스) ·
        밸런스 판정(issues) · 자산 추이 꺾은선(/api/performance) · 관심 종목 관리(대시보드에서 이사).
  🔴 null 은 '—' 로 그린다 — 감마·세타는 "해당 없음(현물)" 이 정답이지 0 이 아니다.
  🔴 각 절은 자기 오류를 자기 자리에서 말한다(.banner--error) — 조용히 빈 화면 금지.
-->
<template>
  <div class="page">
    <header class="page__head"><h1>포트폴리오</h1>
      <span v-if="asOf" class="chip mono-num">{{ fmtAt(asOf) }} 기준</span></header>
    <p v-if="error" class="banner banner--error">{{ error }}</p>

    <!-- ① 요약 4칸 -->
    <div class="kcards">
      <div class="kcard">
        <small>총자산</small>
        <b class="mono-num">{{ money(summary?.value?.krw) }}</b>
        <em v-if="summary?.value?.usd" class="mut mono-num">${{ num(summary.value.usd) }}</em>
      </div>
      <div class="kcard">
        <small>평가손익</small>
        <!--
          🔴 **필드명을 또 지어냈다**(2026-10-12). 실제 계약은 `summary.profit`·`profitRate` 인데
             `profitLoss.amount` 로 써서 화면에 **"—"** 가 떴다. 없는 필드는 조용히 빈다.
          ⚠️ `profitRateDerived` 는 증권사 값과 부호가 어긋날 때 우리가 계산한 값이다 —
             **원본을 먼저 쓰고**, 어긋나면 그 사실을 따로 말한다(10-01 결정).
        -->
        <!--
          🔴 **같은 실수를 두 번 했다** — `summary.profit` 은 **숫자가 아니라 객체**
             (`{ krw, usd, converted }`)다. 반면 **보유 행의 `h.profit` 은 숫자**다.
             같은 이름이 층에 따라 다른 모양이라 더 잘 틀린다 ⇒ 둘 다 실물로 확인하고 쓴다.
        -->
        <b class="mono-num" :class="dirClass(summary?.profit?.krw)">{{ money(summary?.profit?.krw) }}</b>
        <em class="mut mono-num">{{ pctText(summary?.profitRate) }}</em>
      </div>
      <div class="kcard">
        <small>보유 종목</small>
        <b class="mono-num">{{ items.length }}</b>
        <em class="mut">{{ rulesText('positions') }}</em>
      </div>
      <div class="kcard">
        <small>현금 비중</small>
        <b class="mono-num">{{ pctText(weights?.cashPct) }}</b>
        <em class="mut">{{ rulesText('cash') }}</em>
      </div>
    </div>


    <!-- 기준선 초과 — 서버 판정(`portfolioRules`)을 그대로 쓴다. 화면이 한도를 복제하지 않는다 -->
    <section v-if="overRules.length" class="card card--warn">
      <h2>기준선 초과 {{ overRules.length }}건</h2>
      <ul class="over">
        <li v-for="c in overRules" :key="c.key">
          <b>{{ c.label }}</b>
          <span class="mono-num">{{ c.actual }}{{ c.unit }}</span>
          <small class="mut">기준 {{ c.limit }}{{ c.unit }}{{ c.direction === 'min' ? ' 이상' : ' 이하' }}</small>
        </li>
      </ul>
      <p class="mut over__note">⚠️ 막지 않습니다 — 기준선 밖이라는 사실만 알립니다.</p>
    </section>

    <div class="flow">
    <!-- ① 자산 구성 도넛 -->
    <section class="card">
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

    <!-- ② 한도 대비 현재 위치 — 자산 구성과 한 행(2026-10-04: 각자 풀폭으로 퍼지던 것을 묶음) -->
    <section class="card">
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

    <!-- ③·④ 리스크 지표 + 밸런스 판정 — 한 행(2026-10-06: 세로 한 열로 흐르던 것을 다단으로) -->
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
        <!-- ⚠️ 래퍼 — 표가 길어도 **카드 안에서** 스크롤한다(페이지를 늘리지 않는다) -->
        <div v-if="metrics.per && metrics.per.length" class="mtblwrap">
        <table class="rtbl">
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
        </div>
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

      <!--
        ⚠️ **2026-10-12 — 목표 배분 한 줄 요약을 뺐다.** 바로 아래에 「목표 배분 괴리」 **표**가
           통째로 들어왔다(리스크와 합치면서). 같은 것을 요약과 표로 두 번 보여주면
           **한쪽만 고치는 일이 시작된다** — 그리고 그 링크는 이미 `/rules`(없는 주소)를 가리켰다.
      -->
    </section>

    <!-- ⑤·⑥ 스트레스 + 자산 추이 — 한 행 -->
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

    <!-- ③ 보유 종목 -->
    <section class="card">
      <h2>보유 종목</h2>
      <p v-if="!items.length" class="mut">보유 종목이 없습니다.</p>
      <div v-else class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>종목</th><th class="r">수량</th><th class="r">평단</th><th class="r">현재가</th>
              <th class="r">손익</th><th class="r">비중</th><th class="r">목표 대비</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="h in items" :key="h.symbol" class="row--click" @click="goSymbol(h.symbol)">
              <!--
                🔴 **이름이 티커와 같으면 안 적는다** (2026-10-12 — 화면에 `DIADIA`·`QQQMQQQM`
                   처럼 붙어 나왔다). 증권사가 이름 칸에 티커를 그대로 주는 종목이 있다.
                ⚠️ 띄어쓰기도 없어 `O리얼티 인컴` 으로 읽혔다 — 줄을 나눈다.
              -->
              <td class="symcell">
                <b>{{ h.symbol }}</b>
                <small v-if="h.name && h.name !== h.symbol" class="mut">{{ h.name }}</small>
              </td>
              <td class="r mono-num">{{ num(h.quantity) }}</td>
              <td class="r mono-num">{{ num(h.avgPrice) }}</td>
              <td class="r mono-num">{{ num(h.lastPrice) }}</td>
              <td class="r mono-num" :class="dirClass(h.profit)">{{ signed(h.profit) }}</td>
              <td class="r mono-num">{{ pctText(weightOf(h.symbol)) }}</td>
              <td class="r mono-num" :class="dirClass(gapOf(h.symbol))">{{ gapText(h.symbol) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>


    <section class="card">
      <h2>목표 배분 괴리</h2>
      <p v-if="!targetRows.length" class="mut">
        {{ parts.target === 'ok' ? '목표 배분이 설정되지 않았습니다.' : '목표 배분을 읽지 못했습니다.' }}
      </p>
      <ul v-else class="wts">
        <li v-for="b in targetRows" :key="b.key">
          <span class="wts__k">{{ b.name || b.key }}</span>
          <span class="wts__v mono-num">{{ pctText(b.currentPct) }} / {{ pctText(b.targetPct) }}</span>
          <span class="wts__gap mono-num" :class="dirClass(b.gapPct)">{{ signedPct(b.gapPct) }}</span>
        </li>
      </ul>
      <!--
        🔴 **미분류를 숨기지 않는다** (2026-10-12 사용자: *"이거 맞아?"*).
           버킷 합이 31.5% 인데 미분류가 **68.5%** 였다 — 그걸 안 보여주니 괴리 숫자가
           거짓말처럼 보인다. **목표 밖에 자산의 2/3 가 있다는 것이 진짜 정보다.**
      -->
      <!--
        🔴🔴 **목표가 낡았을 수 있다는 것을 먼저 말한다** (2026-10-12 사용자 지적).
           화면이 *"코어 공격(QLD) −30%p 부족"* 이라고 했는데 **사용자는 QLD 를 다 팔았다.**
           목표 배분은 **사람이 정하는 값**이라, 낡으면 괴리·부족 표시가 **전부 거짓**이 된다.
           ⇒ 자산의 절반 이상이 목표 밖이면 **괴리를 읽기 전에** 그 사실을 띄운다.
      -->
      <p v-if="targetStale" class="stalebox">
        ⚠️ <b>목표 배분이 지금 포트폴리오와 많이 다릅니다</b>(자산의 {{ pctText(unclassifiedPct) }}가 목표 밖).
        위 괴리 숫자는 <b>낡은 목표</b> 기준일 수 있습니다 — <RouterLink to="/settings">설정에서 목표 배분</RouterLink>을 갱신하세요.
      </p>
      <div v-if="unclassified.length" class="unc">
        <div class="unc__head">
          <b>목표 배분 밖 {{ pctText(unclassifiedPct) }}</b>
          <small class="mut">아래 종목은 어느 버킷에도 없습니다 — 괴리 합이 안 맞는 이유입니다.
            <b>정리하라는 뜻이 아닙니다</b> — 목표에 아직 안 넣은 것일 수 있습니다.</small>
        </div>
        <ul class="unc__list">
          <li v-for="u in unclassified" :key="u.symbol">
            <span>{{ u.symbol }}</span><span class="mono-num">{{ pctText(u.pct) }}</span>
          </li>
        </ul>
      </div>
    </section>


      <!--
        📈 **자산 vs 벤치마크** (2026-10-12 — 성과 화면을 없애며 이 하나만 건져 왔다)
        🔴 종전 자산 추이 스파크라인을 **대체**한다 — 같은 `/api/performance` 데이터인데
           *"내 돈이 늘었나"* 에 *"시장보다 잘했나"* 가 더해진다. 둘을 따로 그릴 이유가 없다.
      -->
      <section class="card">
        <h2>자산 추이 <small class="mut">내 계좌 · KOSPI · 나스닥</small></h2>
        <BenchChart :series="perfSeries" />
      </section>



    <section v-if="income" class="card">
      <h2>배당</h2>
      <dl class="dl">
        <div><dt>수령 누적</dt><dd class="mono-num">${{ num(income.dividendUsd) }}</dd></div>
        <div><dt>적립 재원</dt><dd class="mono-num">${{ num(income.accrualBudgetUsd) }}</dd></div>
      </dl>
      <p v-if="income.estimatedNote" class="mut">{{ income.estimatedNote }}</p>
    </section>

    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { apiFetch } from '../lib/apiClient';
import BenchChart from '../components/BenchChart.vue';

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

/* ── ② 한도 게이지 — **서버가 쥔 기준선을 그대로 쓴다** ─────── */
/**
 * 🔴 **2026-10-12 — 하드코딩을 걷어냈다.** 이 화면(옛 리스크)은
 *    `LIMITS = { leverage: 30, single: 20, cashMin: 10 }` 을 **복제해 들고 있었다.**
 *    그래서 포트폴리오 화면이 *"기준 40%"* 라고 할 때 여기는 *"30%"* 라고 **다른 말을 했다**
 *    (사용자 스크린샷에서 드러났다). ⇒ 기준선을 쥐는 곳은 `server/portfolioRules.js` **하나**다.
 * ⚠️ 서버가 못 주면 막대를 **안 그린다** — 복제값으로 메우면 또 갈라진다.
 */
const gauges = computed(() => {
  const checks = rules.value?.checks || [];
  const top = (weights.value?.holdings || []).reduce((a, b) => (b.pct > (a?.pct || 0) ? b : a), null);
  const LABEL = {
    leverage: '레버리지 노출',
    concentration: `단일 종목 최대${top ? ` · ${top.symbol}` : ''}`,
    cash: '현금 비중 (최소 유지)',
    positions: '보유 종목 수',
  };
  return checks
    .filter((c) => c.status !== 'unknown') // 못 잰 것은 막대로 그리지 않는다
    .map((c) => ({
      label: LABEL[c.key] || c.label,
      now: c.actual,
      limit: c.limit,
      unit: c.unit,
      pct: c.limit > 0 ? (Number(c.actual) / c.limit) * 100 : 0,
      over: c.status === 'over',
    }));
});

/* ── ③·④ 리스크 지표 + 밸런스 판정 ─────────── */
const metrics = ref(null);
const metricsErr = ref('');
const issueClass = (i) => (i.level === 'over' || i.level === 'under' ? 'issue--bad' : 'issue--warn');
const issueTag = (i) => ({ leverage: '레버', single: '집중', cash: '현금', decay: '감쇠' }[i.axis] || i.axis);

/* ── 🎯 포트폴리오 요약 (2026-10-12 — 리스크와 합치며 들어왔다) ──
 * 한 라우트에서 보유·비중·목표·기준선을 함께 받는다 — 조각마다 따로 치면
 * 하나가 느릴 때 화면 절반이 빈 채로 뜬다.
 */
const router = useRouter();
const psum = ref(null);
const items = computed(() => psum.value?.items || []);
const income = computed(() => psum.value?.income || null);
const parts = computed(() => psum.value?.parts || {});
const rules = computed(() => psum.value?.rules || null);
const overRules = computed(() => (rules.value?.checks || []).filter((c) => c.status === 'over'));
const unclassified = computed(() => {
  const u = psum.value?.target?.unclassified;
  return Array.isArray(u) ? u : [];
});
const unclassifiedPct = computed(() => unclassified.value.reduce((a, u) => a + (Number(u.pct) || 0), 0));
const targetRows = computed(() => {
  const rows = psum.value?.target?.buckets;
  return Array.isArray(rows) ? rows : [];
});
/** 🔴 자산의 절반 이상이 목표 밖이면 목표가 낡은 것이다 — 괴리를 읽기 **전에** 말해야 한다 */
const targetStale = computed(() => targetRows.value.length > 0 && unclassifiedPct.value >= 50);
const perfSeries = computed(() => {
  const rows = perf.value?.series;
  return Array.isArray(rows) ? rows.filter((r) => Number.isFinite(Number(r.totalKrw))) : [];
});

function weightOf(symbol) {
  const sy = String(symbol || '').toUpperCase();
  return (weights.value?.holdings || []).find((h) => String(h.symbol).toUpperCase() === sy)?.pct ?? null;
}
function gapOf(symbol) {
  const sy = String(symbol || '').toUpperCase();
  const row = targetRows.value.find((b) => (b.symbols || []).map((x) => String(x).toUpperCase()).includes(sy));
  return row?.gapPct ?? null;
}
function gapText(symbol) {
  const g = gapOf(symbol);
  return g == null ? '—' : signedPct(g);
}
function goSymbol(symbol) {
  if (symbol) router.push(`/symbol/${encodeURIComponent(symbol)}`);
}

const fmtNum = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });
function num(v) { return Number.isFinite(Number(v)) ? fmtNum.format(Number(v)) : '—'; }
function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n < 0 ? '-' : ''}₩${fmtNum.format(Math.abs(Math.round(n)))}`;
}
function signed(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${fmtNum.format(Math.round(n))}`;
}
function pctText(v) { return Number.isFinite(Number(v)) ? `${fmtNum.format(Number(v))}%` : '—'; }
function signedPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${fmtNum.format(n)}%`;
}
function dirClass(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '';
  return n > 0 ? 'up' : 'down';
}
/** 기준선 한 줄 — 요약 칸 밑에 붙는 설명. 서버가 안 주면 **빈 문자열**(지어내지 않는다) */
function rulesText(key) {
  const c = (rules.value?.checks || []).find((x) => x.key === key);
  if (!c) return '';
  if (c.status === 'unknown') return '기준선 판정 불가';
  return `기준 ${c.limit}${c.unit}${c.direction === 'min' ? ' 이상' : ' 이하'}`;
}

async function loadPortfolioSummary() {
  try {
    const r = await apiFetch('/api/portfolio/summary');
    const b = await r.json();
    if (r.ok && b?.ok !== false) {
      psum.value = b;
      weights.value = b.weights || weights.value;
      summary.value = b.summary || summary.value;
      asOf.value = b.at || asOf.value;
    } else {
      error.value = b?.error || `보유 현황을 불러오지 못했습니다 (HTTP ${r.status}).`;
    }
  } catch (e) { error.value = `보유 현황 읽기 실패: ${e.message}`; }
}

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

/* ⚠️ 관심 종목 관리는 **설정 화면**이 전담한다(2026-10-12 — 여기 있던 것은 중복이었다) */

/* ── 적재 — 절마다 독립 실패(한 API 가 죽어도 나머지는 그린다) ── */
onMounted(async () => {
  /**
   * 🔴 **병렬로 받는다** — 종전엔 `await` 로 줄을 세워 뒤쪽 패널이 한참 비어 있었다.
   * ⚠️ 절마다 독립 실패 — 한 API 가 죽어도 나머지는 그린다.
   */
  await Promise.all([
    loadPortfolioSummary(),
    (async () => {
      try { const r = await apiFetch('/api/risk/stress'); stress.value = await r.json(); }
      catch (e) { stress.value = { ok: false, error: e.message }; }
    })(),
    (async () => {
      try {
        const r = await apiFetch('/api/risk/metrics');
        const b = await r.json();
        if (b?.ok) metrics.value = b;
        else metricsErr.value = b?.error || '리스크 지표를 불러오지 못했습니다.';
      } catch (e) { metricsErr.value = `리스크 지표 읽기 실패: ${e.message}`; }
    })(),
    (async () => {
      try { const r = await apiFetch('/api/performance'); perf.value = await r.json(); }
      catch (e) { perfErr.value = `자산 추이 읽기 실패: ${e.message}`; }
    })(),
  ]);
});
</script>

<style scoped>
/* ⚠️ 상하 여백을 줄인 것은 **28px 를 맞추려는 것**이다(실측값). 좌우는 그대로 둔다 — 
   좌우를 줄이면 카드가 화면 가장자리에 붙어 읽기가 나빠지는데, 세로는 그런 손해가 없다. */
.page { flex: 1; min-height: 0; overflow-y: auto; padding: 10px var(--space-base) 8px; display: flex; flex-direction: column; gap: 8px; }

/**
 * 🔴 **2026-10-12 — 행(grid)을 흐름(columns)으로 바꿨다.**
 *
 * 종전 `.rowflow` 는 카드를 **두 개씩 한 행에** 묶었다. 그러면 행의 높이는 **둘 중 큰 쪽**이
 * 정하고, 짧은 카드 아래가 통째로 빈다 — 사용자가 찍어 보낸 *"뭐냐 이건 대체"* 스크린샷의
 * **왼쪽 열이 비고 오른쪽만 이어지던** 그 모양이다.
 *
 * ⚠️ 행을 안 만들면 그 빈칸도 안 생긴다. `columns` 는 카드를 **세로로 흘려 담아** 열 높이를
 *    스스로 맞춘다(석조 쌓기). `break-inside: avoid` 가 카드가 열 경계에서 쪼개지는 것을 막는다.
 * ⚠️ 읽는 순서가 "왼쪽 위→아래→오른쪽 위" 가 된다 — **중요한 것을 맨 앞에** 두면 그대로 맨 위다.
 *    그래서 요약·기준선 초과는 `.page__lead` 로 흐름 **밖**에 두고 전폭을 준다.
 */
/**
 * 🔴 **2026-10-12 저녁 (사용자 네 번째 지적: *"내가 한 화면에 다 보이게 구성하라고 했지"*)**
 *
 * 460px 열 폭은 1920 화면에서 **세 열**이라 아홉 장이 세로로 길게 늘어섰다.
 * 340px 로 좁히면 같은 폭에서 **네 열**이 되고, 열마다 쌓이는 높이가 1/4 로 준다.
 * ⚠️ 폭만 줄이면 카드가 **옆으로** 좁아질 뿐이라 안 된다 — **밀도**(아래 `.flow` 안 규칙)와
 *    **긴 표의 상한**(`.tblwrap`·`.mtbl`)을 함께 줄여야 세로가 실제로 준다.
 */
.flow { columns: 340px; column-gap: var(--space-xs, 8px); }
.flow > .card { break-inside: avoid; margin: 0 0 var(--space-xs, 8px); padding: 10px 12px; gap: 6px; }
.flow > .card h2 { font-size: var(--text-sm); }

/* 표는 **카드 안에서** 스크롤한다 — 페이지를 늘리지 않는다 */
/* ⚠️ 표는 **세로로 자르고 가로로 흘린다** — 340px 열에 7컬럼 표를 욱여넣으면
   헤더 글자가 세로로 쪼개져(`레/버/리/지`) 읽을 수 없다(스크린샷에서 확인). */
.flow .tblwrap, .flow .mtblwrap { max-height: 160px; overflow: auto; }
.flow .rtbl { min-width: 430px; }
.flow .tblwrap .tbl { min-width: 380px; }
.flow .tbl th, .flow .tbl td,
.flow .rtbl th, .flow .rtbl td { padding: 3px 6px; font-size: var(--text-xs); }
.flow .tbl thead th,
.flow .rtbl thead th { position: sticky; top: 0; background: var(--color-surface); z-index: 1; }
/* 긴 목록(밸런스 판정·미분류)도 같은 규칙 */
.flow .issues { max-height: 150px; overflow: auto; }
.flow .wts { max-height: 176px; overflow: auto; }
.flow .gauges { gap: 6px; }
.flow .mstats { gap: 5px; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
.flow .mstat { padding: 5px 8px; }
.flow .mstat--hero b { font-size: var(--text-lg); }
.flow .bc__svg { height: 150px; }
.page__lead { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: var(--space-sm); align-items: start; }
.page__lead > .card { min-width: 0; }

.page__head { display: flex; align-items: center; gap: var(--space-sm); }
.page__head h1 { margin: 0; font-size: var(--text-lg); color: var(--color-ink); }
.chip { border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 2px 10px; font-size: var(--text-xs); color: var(--color-body); }
.card { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-base); }
.card h2 { margin: 0 0 8px; font-size: var(--text-md); color: var(--color-ink); }
.mut { margin: 0; font-size: var(--text-sm); color: var(--color-muted); }

/* ── 도넛 ── */
.row2 { display: grid; grid-template-columns: minmax(380px, 520px) 1fr; gap: var(--space-sm); align-items: stretch; }
.row2 > .card { display: flex; flex-direction: column; min-width: 0; }
.donutwrap { display: flex; align-items: center; gap: var(--space-lg); flex-wrap: wrap; }
.donutbox { position: relative; width: 180px; flex: 0 0 auto; }
.donut { display: block; width: 100%; height: auto; }
.donut__track { stroke: var(--color-surface-sunken); }
.donut__center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; pointer-events: none; }
.donut__center small { font-size: var(--text-2xs); color: var(--color-faint); }
.donut__center b { font-size: var(--text-sm); color: var(--color-ink); }
.dlegend { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; min-width: 200px; flex: 1; max-width: 300px; }
.dlegend__row { display: flex; align-items: center; gap: 6px; font-size: var(--text-sm); }
.dlegend__dot { width: 10px; height: 10px; border-radius: var(--rounded-pill); flex: 0 0 auto; }
.dlegend__sym { font-weight: 600; color: var(--color-primary); text-decoration: none; }
.dlegend__sym:hover { text-decoration: underline; }
.dlegend__sym--plain { color: var(--color-ink); }
.dlegend__cat { color: var(--color-faint); font-size: var(--text-2xs); }
.dlegend__row b { margin-left: auto; color: var(--color-ink); }
.lev { padding: 0 4px; border: 1px solid var(--color-warn); color: var(--color-warn); border-radius: var(--rounded-xs); font-size: var(--text-2xs); }

/* ── 게이지 ── */
/* 우열 카드 안에서는 세로 스택 — 카드가 도넛 카드와 같은 높이(stretch)가 되므로
   게이지 3개를 **세로로 고르게 분배**해 아래가 비지 않게 한다(2026-10-04 "우측이 좀 비거나") */
/* 🔴 2026-10-12 — **내 첫 수정이 더 나빴다.** `grid + align-content: start` 로 바꿨더니
   게이지 셋이 위로 몰리고 **카드 아래 2/3 가 비었다**(사용자: "개기냐?").
   원래 문제는 *열 수* 가 아니라 **막대가 카드 전폭이라 길어 보이는 것**이었다.
   ⇒ 세로 1열로 되돌리되 **막대 폭을 제한**하고 활자를 줄인다. 카드 높이는 균등 분배. */
.gauges { display: flex; flex-direction: column; justify-content: space-evenly; gap: var(--space-sm); flex: 1; min-height: 0; }
.gauge { min-width: 0; }
.gauge__head { display: flex; justify-content: space-between; align-items: baseline; font-size: var(--text-xs); margin-bottom: 3px; gap: 6px; }
.gauge__head span { color: var(--color-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gauge__head b { font-size: var(--text-sm); }
.gauge__head small { font-size: var(--text-2xs); color: var(--color-faint); }
/* ⚠️ 420px 상한 — 사용자: *"한도 대비 현재 위치 width 너무 길어"*. 전폭 막대는 길이 차이를 못 읽게 한다 */
.gauge__bar { max-width: 420px; height: 6px; border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); overflow: hidden; }
.gauge__fill { display: block; height: 100%; background: var(--color-primary); }
.gauge__fill--warn { background: var(--color-warn); }

/* ── 리스크 지표 ── */
.mstats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 210px)); gap: var(--space-sm); margin-bottom: var(--space-sm); }
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

/* ── 🎯 목표 배분 괴리 한 줄 (상세는 /rules) ── */

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
/* 🔄 2026-10-04 사용자: "좌우로 스크롤 주고 계속 밑으로 길어지게 하지마" —
   테마 18개가 세로로 무한히 쌓이던 그리드를 **가로 스트립**으로. 카드 폭·높이 고정,
   카드 안 종목 목록만 자체 세로 스크롤. */
.wgrid {
  display: flex; gap: var(--space-sm); overflow-x: auto; padding-bottom: 6px;
  margin-bottom: var(--space-sm);
}
.wgrid > * { flex: 0 0 280px; }
.wcard { border: 1px solid var(--color-hairline); border-radius: var(--rounded-sm); padding: var(--space-sm); display: flex; flex-direction: column; gap: 6px; min-width: 0;; height: 300px; display: flex; flex-direction: column; }
.wcard__head { display: flex; align-items: center; gap: 6px; }
.wcard__name { font-weight: 700; font-size: var(--text-sm); color: var(--color-ink); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wcard__count { font-size: var(--text-2xs); color: var(--color-faint); }
.wlist { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column;; overflow-y: auto; flex: 1; min-height: 0; }
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

/* ══ 포트폴리오 패널 (2026-10-12 — 리스크와 합치며 그대로 들고 왔다) ══════════
   ⚠️ `cssTableAlign` 가드가 **템플릿만 옮기고 CSS 를 두고 온 것**을 그 자리에서 잡았다
      (클래스 16개가 규칙 없이 맨몸으로 나갈 뻔했다). 옮길 때 짝을 세는 자가 있어야 한다. */
.kcards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-sm); }
.kcard { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-sm) var(--space-base); display: flex; flex-direction: column; gap: 2px; }
.kcard small { color: var(--color-faint); font-size: var(--text-2xs); }
.kcard b { font-size: var(--text-lg); color: var(--color-ink); }
.kcard em { font-style: normal; }
.card--warn { border-color: var(--color-warn); background: var(--color-warn-soft); }
.tblwrap { overflow-x: auto; }
.tbl th.r, .tbl td.r { text-align: right; }
.row--click { cursor: pointer; }
.row--click:hover { background: var(--color-surface-hover); }
/**
 * 🔴 **2026-10-12 — 기준선 초과를 한 줄로 접었다.** 세 건에 세로 140px 를 쓰고 있었고,
 *    그 높이가 **아래 아홉 장 전부를 밀어내** 사용자가 *"한 화면에 다 보이게"* 라고 한
 *    요구를 혼자서 깨고 있었다. 내용은 그대로 두고 **배치만** 가로로 바꾼다.
 * ⚠️ 경고를 작게 만든 것이 아니다 — 카드 테두리(`card--warn`)와 색은 그대로다.
 */
.over { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: baseline; }
.over li { display: flex; align-items: baseline; gap: 5px; white-space: nowrap; }
.over li b { font-size: var(--text-xs); }
.over li .mono-num { font-size: var(--text-sm); }
.wts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.wts li { display: flex; align-items: center; gap: var(--space-sm); font-size: var(--text-sm); }
.wts__k { flex: 0 0 7rem; color: var(--color-body); }
.wts__v { color: var(--color-ink); }
.wts__gap { min-width: 4rem; text-align: right; }
.stalebox { margin: 0; padding: 8px 10px; border-radius: var(--rounded-md); border: 1px solid var(--color-danger); background: var(--color-danger-soft); color: var(--color-ink); font-size: var(--text-sm); }
.stalebox a { color: var(--color-primary); }
.unc { border: 1px solid var(--color-warn); background: var(--color-warn-soft); border-radius: var(--rounded-md); padding: var(--space-sm); display: flex; flex-direction: column; gap: 4px; }
.unc__head { display: flex; flex-direction: column; gap: 1px; }
.unc__head b { color: var(--color-warn); font-size: var(--text-sm); }
.unc__list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: var(--text-xs); }
.unc__list li { display: flex; gap: 6px; color: var(--color-body); }
.dl { display: flex; gap: var(--space-lg, 24px); margin: 0; flex-wrap: wrap; }
.dl dt { font-size: var(--text-2xs); color: var(--color-faint); }
.dl dd { margin: 0; font-weight: 600; color: var(--color-ink); }
.symcell b { display: block; line-height: 1.15; }
.symcell small { display: block; line-height: 1.1; }
.over__note { font-size: var(--text-2xs); margin: 2px 0 0; }
</style>

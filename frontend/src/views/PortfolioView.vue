<!--
  🎯 포트폴리오 (D-1) — 2026-10-12 신설 · `docs/wireframe-2026-10-12.html`

  🔴 **첫 화면이 바뀌었다.** 종전 대시보드는 *"무엇을 살까"* 를 물었다(제안·승인 패널).
     주문 집행을 걷어내면서 첫 질문이 **"무엇을 들고 있나"** 가 된다.

  ⚠️ 한 라우트(`/api/portfolio/summary`)에서 전부 받는다 — 조각마다 따로 치면
     하나가 느릴 때 **화면 절반이 빈 채로** 뜬다. 조각별 성패는 `parts` 로 와서
     **"없음" 과 "못 받음" 을 구분**해 보여준다.
-->
<template>
  <div class="page">
    <header class="page__head">
      <h1>포트폴리오</h1>
      <span v-if="at" class="mut mono-num">{{ fmtTime(at) }} 기준</span>
      <span class="gap"></span>
      <button class="btn" :disabled="busy" @click="load">{{ busy ? '불러오는 중…' : '새로고침' }}</button>
    </header>

    <p v-if="fatal" class="banner banner--error">{{ fatal }}</p>
    <p v-else-if="!data && busy" class="banner banner--empty">보유 현황을 불러오는 중…</p>

    <template v-if="data">
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

      <!-- ② 기준선 초과 — 막지 않고 말한다 -->
      <section v-if="overRules.length" class="card card--warn">
        <h2>기준선 초과 {{ overRules.length }}건</h2>
        <ul class="over">
          <li v-for="c in overRules" :key="c.key">
            <b>{{ c.label }}</b>
            <span class="mono-num">{{ num(c.actual) }}{{ c.unit }}</span>
            <small class="mut">기준 {{ c.limit }}{{ c.unit }}{{ c.direction === 'min' ? ' 이상' : ' 이하' }}</small>
          </li>
        </ul>
        <p class="mut">⚠️ 주문을 막지 않습니다 — 지금 포트폴리오가 기준선 밖이라는 사실만 알립니다.</p>
      </section>

      <div class="row2">
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
                  <td>
                    <b>{{ h.symbol }}</b>
                    <small class="mut">{{ h.name }}</small>
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

        <!-- ④ 비중 · 목표 괴리 -->
        <div class="col">
          <section class="card">
            <h2>비중 구성</h2>
            <p v-if="!categories.length" class="mut">
              {{ parts.weights === 'ok' ? '분류된 비중이 없습니다.' : '비중을 계산하지 못했습니다.' }}
            </p>
            <ul v-else class="wts">
              <li v-for="c in categories" :key="c.key">
                <span class="wts__k">{{ c.key }}</span>
                <span class="wts__bar"><i :style="{ width: barWidth(c.pct) }"></i></span>
                <span class="wts__v mono-num">{{ pctText(c.pct) }}</span>
              </li>
            </ul>
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
            📈 **자산 추이** — 와이어프레임 D-1 이 약속했는데 **만들지 않고 넘어갔다**(2026-10-12).
               사용자: *"와이어프레임 기반으로 디자인 전면 개편한거 맞아?"* — 맞는 지적이다.
            ⚠️ 두 점 미만이면 **그리지 않는다**(한 점짜리 선은 "변화 없음" 으로 읽힌다).
          -->
          <section class="card">
            <h2>자산 추이 <small class="mut" v-if="perfRange">{{ perfRange }}</small></h2>
            <p v-if="perfSeries.length < 2" class="mut">
              {{ perfSeries.length ? '관측이 하루치뿐입니다 — 이틀째부터 그립니다.' : '자산 스냅샷이 아직 없습니다.' }}
            </p>
            <template v-else>
              <svg class="spark" :viewBox="`0 0 ${SW} ${SH}`" preserveAspectRatio="none" role="img"
                   aria-label="총자산 추이">
                <path :d="perfArea" class="spark__area" />
                <path :d="perfLine" class="spark__line" />
              </svg>
              <div class="spark__foot">
                <span class="mut mono-num">{{ money(perfSeries[0].totalKrw) }}</span>
                <span class="gap"></span>
                <span class="mono-num" :class="dirClass(perfChangePct)">
                  {{ signedPct(perfChangePct) }} · {{ money(perfSeries[perfSeries.length - 1].totalKrw) }}
                </span>
              </div>
            </template>
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
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter, RouterLink } from 'vue-router';
import { apiFetch } from '../lib/apiClient';

const router = useRouter();
const data = ref(null);
const fatal = ref('');
const busy = ref(false);

const at = computed(() => data.value?.at || null);
const items = computed(() => data.value?.items || []);
const summary = computed(() => data.value?.summary || null);
const weights = computed(() => data.value?.weights || null);
const income = computed(() => data.value?.income || null);
const parts = computed(() => data.value?.parts || {});
const categories = computed(() => weights.value?.categories || []);

/** 🔴 기준선 초과만 모은다 — `unknown`(못 쟀다)은 초과가 아니다 */
const overRules = computed(() => (data.value?.rules?.checks || []).filter((c) => c.status === 'over'));

/**
 * ⚠️ 서버 계약을 **실물로 확인하고** 쓴다 — `targetAllocation.compare()` 의
 *    `buckets[] = { key, name, targetPct, currentPct, gapPct, direction, symbols }`.
 *    (처음에 `rows`·`actualPct`·`label` 로 지어 썼다가 소스를 열어 고쳤다 —
 *     없는 필드를 추정해 쓰면 조용히 비고 화면은 "목표 없음" 으로 보인다.)
 */
const unclassified = computed(() => {
  const u = data.value?.target?.unclassified;
  return Array.isArray(u) ? u : [];
});
const unclassifiedPct = computed(() => unclassified.value.reduce((a, u) => a + (Number(u.pct) || 0), 0));
/** 🔴 자산의 절반 이상이 목표 밖이면 목표가 낡은 것으로 본다 — 괴리를 읽기 전에 말해야 한다 */
const targetStale = computed(() => targetRows.value.length > 0 && unclassifiedPct.value >= 50);

const targetRows = computed(() => {
  const rows = data.value?.target?.buckets;
  return Array.isArray(rows) ? rows : [];
});

function weightOf(symbol) {
  const s = String(symbol || '').toUpperCase();
  return (weights.value?.holdings || []).find((h) => String(h.symbol).toUpperCase() === s)?.pct ?? null;
}
function gapOf(symbol) {
  const s = String(symbol || '').toUpperCase();
  const row = targetRows.value.find((b) => (b.symbols || []).map((x) => String(x).toUpperCase()).includes(s));
  return row?.gapPct ?? null;
}
function gapText(symbol) {
  const g = gapOf(symbol);
  return g == null ? '—' : signedPct(g);
}

const fmt = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });
function num(v) { return Number.isFinite(Number(v)) ? fmt.format(Number(v)) : '—'; }
function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  // 🔴 손익에도 쓰므로 **부호를 유지**한다(음수를 ₩-639,230 이 아니라 -₩639,230 으로)
  return `${n < 0 ? '-' : ''}₩${fmt.format(Math.abs(Math.round(n)))}`;
}
function signed(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${fmt.format(Math.round(n))}`;
}
function pctText(v) { return Number.isFinite(Number(v)) ? `${fmt.format(Number(v))}%` : '—'; }
function signedPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${fmt.format(n)}%`;
}
function dirClass(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '';
  return n > 0 ? 'up' : 'down';
}
function barWidth(pct) {
  const n = Math.max(0, Math.min(100, Number(pct) || 0));
  return `${n}%`;
}
function fmtTime(iso) {
  try { return new Date(iso).toLocaleString('ko-KR', { hour12: false }); } catch { return ''; }
}
function rulesText(key) {
  const c = (data.value?.rules?.checks || []).find((x) => x.key === key);
  if (!c) return '';
  if (c.status === 'unknown') return '기준선 판정 불가';
  return `기준 ${c.limit}${c.unit}${c.direction === 'min' ? ' 이상' : ' 이하'}`;
}
function goSymbol(symbol) {
  router.push({ name: 'symbol', params: { code: String(symbol).toUpperCase() } });
}

/* ── 📈 자산 추이 ─────────────────────────── */
const perf = ref(null);
const SW = 600; const SH = 90;
const perfSeries = computed(() => {
  const rows = perf.value?.series;
  return Array.isArray(rows) ? rows.filter((r) => Number.isFinite(Number(r.totalKrw))) : [];
});
const perfRange = computed(() => {
  const r = perfSeries.value;
  return r.length >= 2 ? `${r[0].day} ~ ${r[r.length - 1].day}` : '';
});
const perfChangePct = computed(() => {
  const r = perfSeries.value;
  if (r.length < 2) return null;
  const a = Number(r[0].totalKrw); const b = Number(r[r.length - 1].totalKrw);
  return a > 0 ? Math.round(((b - a) / a) * 1000) / 10 : null;
});
function perfPoints() {
  const r = perfSeries.value;
  if (r.length < 2) return [];
  const vals = r.map((x) => Number(x.totalKrw));
  const hi = Math.max(...vals); const lo = Math.min(...vals);
  const span = hi - lo || 1;
  return vals.map((v, i) => [(i / (vals.length - 1)) * SW, SH - ((v - lo) / span) * SH]);
}
const perfLine = computed(() => {
  const p = perfPoints();
  return p.length ? p.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ') : '';
});
const perfArea = computed(() => {
  const p = perfPoints();
  return p.length ? `${perfLine.value} L${SW} ${SH} L0 ${SH} Z` : '';
});

async function loadPerf() {
  try {
    const r = await apiFetch('/api/performance');
    perf.value = await r.json();
  } catch { /* 추이는 곁가지 — 포트폴리오 본문은 그대로 보여준다 */ }
}

async function load() {
  busy.value = true;
  fatal.value = '';
  try {
    const r = await apiFetch('/api/portfolio/summary');
    const b = await r.json();
    if (!r.ok || b?.ok === false) {
      fatal.value = b?.error || `보유 현황을 불러오지 못했습니다 (HTTP ${r.status}).`;
      return;
    }
    data.value = b;
  } catch (e) {
    fatal.value = `보유 현황 읽기 실패: ${e.message}`;
  } finally {
    busy.value = false;
  }
}

onMounted(() => { load(); loadPerf(); });
</script>

<style scoped>
.page { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-base); display: flex; flex-direction: column; gap: var(--space-base); }
.page__head { display: flex; align-items: center; gap: var(--space-sm); }
.page__head h1 { margin: 0; font-size: var(--text-lg); color: var(--color-ink); }
.gap { flex: 1; }
.mut { color: var(--color-muted); font-size: var(--text-xs); }

.kcards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-sm); }
.kcard { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-sm) var(--space-base); display: flex; flex-direction: column; gap: 2px; }
.kcard small { color: var(--color-faint); font-size: var(--text-2xs); }
.kcard b { font-size: var(--text-lg); color: var(--color-ink); }
.kcard em { font-style: normal; }

.card { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-base); display: flex; flex-direction: column; gap: var(--space-sm); }
.card h2 { margin: 0; font-size: var(--text-md); color: var(--color-ink); }
.card--warn { border-color: var(--color-warn); background: var(--color-warn-soft); }

.row2 { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: var(--space-base); align-items: start; }
@media (max-width: 1100px) { .row2 { grid-template-columns: 1fr; } }
.col { display: flex; flex-direction: column; gap: var(--space-base); }

.tblwrap { overflow-x: auto; }
.tbl { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.tbl th { text-align: left; font-size: var(--text-2xs); color: var(--color-faint); padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline); white-space: nowrap; }
.tbl td { padding: 6px var(--space-sm); border-bottom: 1px solid var(--color-hairline-soft); }
.tbl th.r, .tbl td.r { text-align: right; }
.tbl td b { color: var(--color-ink); display: block; }
.tbl td small { display: block; }
.row--click { cursor: pointer; }
.row--click:hover { background: var(--color-surface-hover); }

.over { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.over li { display: flex; align-items: baseline; gap: var(--space-sm); }
.over b { color: var(--color-ink); min-width: 7rem; }

.wts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.wts li { display: flex; align-items: center; gap: var(--space-sm); font-size: var(--text-sm); }
.wts__k { flex: 0 0 7rem; color: var(--color-body); }
.wts__bar { flex: 1; height: 6px; background: var(--color-surface-sunken); border-radius: var(--rounded-pill); overflow: hidden; }
.wts__bar i { display: block; height: 100%; background: var(--color-primary); }
.wts__v { color: var(--color-ink); }
.wts__gap { min-width: 4rem; text-align: right; }

.stalebox { margin: 0; padding: 8px 10px; border-radius: var(--rounded-md); border: 1px solid var(--color-danger); background: var(--color-danger-soft); color: var(--color-ink); font-size: var(--text-sm); }
.stalebox a { color: var(--color-primary); }
.unc { border: 1px solid var(--color-warn); background: var(--color-warn-soft); border-radius: var(--rounded-md); padding: var(--space-sm); display: flex; flex-direction: column; gap: 4px; }
.unc__head { display: flex; flex-direction: column; gap: 1px; }
.unc__head b { color: var(--color-warn); font-size: var(--text-sm); }
.unc__list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: var(--text-xs); }
.unc__list li { display: flex; gap: 6px; color: var(--color-body); }

.spark { width: 100%; height: 92px; display: block; }
.spark__area { fill: var(--color-primary-soft); }
.spark__line { fill: none; stroke: var(--color-primary); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.spark__foot { display: flex; align-items: baseline; font-size: var(--text-xs); }

.dl { display: flex; gap: var(--space-lg, 24px); margin: 0; flex-wrap: wrap; }
.dl dt { font-size: var(--text-2xs); color: var(--color-faint); }
.dl dd { margin: 0; font-weight: 600; color: var(--color-ink); }

.up { color: var(--color-up); }
.down { color: var(--color-down); }
.banner { padding: var(--space-sm) var(--space-base); border-radius: var(--rounded-md); border: 1px solid var(--color-hairline); }
.banner--error { border-color: var(--color-danger); background: var(--color-danger-soft); color: var(--color-ink); }
.banner--empty { color: var(--color-muted); }
.btn { border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); background: var(--color-surface-raised); color: var(--color-ink); padding: 6px var(--space-base); cursor: pointer; font-size: var(--text-sm); }
.btn:hover:not(:disabled) { border-color: var(--color-primary-line); }
.btn:disabled { opacity: .55; cursor: default; }
</style>

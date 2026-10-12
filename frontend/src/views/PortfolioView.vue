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
          <b class="mono-num" :class="dirClass(summary?.profitLoss?.amount)">
            {{ signed(summary?.profitLoss?.amount) }}
          </b>
          <em class="mut mono-num">{{ pctText(summary?.profitLoss?.rate) }}</em>
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
                  <td class="r mono-num" :class="dirClass(h.profitLoss?.amount ?? h.profitLossAmount)">
                    {{ signed(h.profitLoss?.amount ?? h.profitLossAmount) }}
                  </td>
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
import { useRouter } from 'vue-router';
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
function money(v) { return Number.isFinite(Number(v)) ? `₩${fmt.format(Math.round(Number(v)))}` : '—'; }
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

onMounted(load);
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

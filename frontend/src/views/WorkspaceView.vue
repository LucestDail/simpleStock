<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import PriceChart from '../components/PriceChart.vue';
import SettingsPanel from '../components/SettingsPanel.vue';
import { useWatchlist } from '../composables/useWatchlist';
import { useUi } from '../composables/useUi';
import { formatMarketClock } from '../lib/marketClock';
import { heatmapStyleFromChangePct, formatChangePct } from '../lib/heatmapColor';
import { apiFetch, apiStreamUrl, readApiError } from '../lib/apiClient';

const {
  groups,
  fx,
  sessions,
  loading,
  error,
  load,
  createGroup,
  renameGroup,
  deleteGroup,
  addTicker,
  removeTicker,
  applyState,
} = useWatchlist();
const { notify, confirmAction } = useUi();

const clock = ref(formatMarketClock());
const newGroupName = ref('');
const tickerInputs = ref({}); // groupId -> { query, market }
const busy = ref(false);
const refreshing = ref(false);

const briefing = ref(null);
const briefingLoading = ref(false);
const briefingError = ref('');

let clockTimer = null;
let pollTimer = null;
let es = null;

const totalTickers = computed(() =>
  groups.value.reduce((sum, g) => sum + (g.tickers?.length || 0), 0)
);

function sessionLabel(state) {
  if (state === 'open' || state === 'active' || state === 'regular') return '개장';
  if (state === 'pre' || state === 'premarket') return '장전';
  if (state === 'post' || state === 'postmarket') return '장후';
  return '휴장';
}

function formatPrice(ticker) {
  const q = ticker.quote;
  if (!q || q.price == null) return '시세 대기';
  const cur = q.currency || ticker.currency;
  // ⚠️ maximumFractionDigits 만 주면 $176.2 처럼 자릿수가 들쭉날쭉해 세로로 안 맞는다.
  //    금액은 **줄이 맞아야** 비교가 된다 — minimum 을 함께 준다.
  if (cur === 'USD')
    return `$${Number(q.price).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  if (cur === 'KRW') return `₩${Number(q.price).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}`;
  return `${Number(q.price).toLocaleString()} ${cur || ''}`.trim();
}

function marketBadge(ticker) {
  const m = String(ticker.market || '').toUpperCase();
  if (m === 'US') return '🇺🇸 US';
  if (m === 'ETF') return '📊 ETF';
  return '🇰🇷 KR';
}

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

async function onRenameGroup(group) {
  const next = window.prompt('그룹 이름 변경', group.name);
  if (next == null) return;
  const name = next.trim();
  if (!name || name === group.name) return;
  try {
    await renameGroup(group.id, name);
    notify({ message: '그룹 이름을 변경했습니다.', tone: 'success' });
  } catch (e) {
    notify({ message: e.message || '이름 변경 실패', tone: 'error' });
  }
}

async function onDeleteGroup(group) {
  const ok = await confirmAction({
    title: '그룹 삭제',
    message: `'${group.name}' 그룹과 포함된 ${group.tickers?.length || 0}개 종목을 삭제할까요?`,
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

async function onRefreshMarket() {
  refreshing.value = true;
  try {
    await apiFetch('/api/market/refresh', { method: 'POST' });
    await load();
    notify({ message: '시세를 갱신했습니다.', tone: 'success' });
  } catch (e) {
    notify({ message: e.message || '시세 갱신 실패', tone: 'error' });
  } finally {
    refreshing.value = false;
  }
}

/**
 * 대시보드 (2026-09-21) — 화면이 필요한 것을 `/api/dashboard` 한 번으로 받는다.
 * 조각마다 요청하면 토스 한도를 태운다.
 * ⚠️ 조각별 성패(`parts`)를 그대로 받아 **"없음" 과 "못 받음" 을 구분해 보여준다.**
 */
const dash = ref(null);
const dashError = ref('');
const selected = ref({ symbol: '', name: '' });
const settingsOpen = ref(false);
let dashTimer = null;

async function loadDashboard() {
  try {
    const res = await apiFetch('/api/dashboard');
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      dash.value = null;
      dashError.value = b.error || `대시보드를 불러오지 못했습니다 (${res.status})`;
      return;
    }
    dash.value = await res.json();
    dashError.value = '';
    // 아직 고른 종목이 없으면 보유 첫 종목을 기본으로
    if (!selected.value.symbol) {
      const first = dash.value?.portfolio?.items?.[0];
      if (first) selected.value = { symbol: first.symbol, name: first.name };
    }
  } catch (e) {
    dash.value = null;
    dashError.value = e.message || '대시보드 오류';
  }
}

function pickSymbol(symbol, name) {
  selected.value = { symbol, name: name || symbol };
}

/** 조각이 실패했으면 그 사실을 화면에 남긴다 */
const RANK_LABEL = {
  TOP_GAINERS: '급등', TOP_LOSERS: '급락',
  MARKET_TRADING_AMOUNT: '거래대금', MARKET_TRADING_VOLUME: '거래량',
  TOSS_SECURITIES_TRADING_AMOUNT: '토스 거래대금', TOSS_SECURITIES_TRADING_VOLUME: '토스 거래량',
};
function rankLabel(key) {
  const [country, type] = String(key).split(':');
  return `${country === 'US' ? '미국' : '한국'} ${RANK_LABEL[type] || type}`;
}

function partError(name) {
  const p = dash.value?.parts?.[name];
  return p && p.ok === false ? p : null;
}

function restartDashTimer() {
  if (dashTimer) clearInterval(dashTimer);
  const sec = Number(dash.value?.settings?.refreshSec) || 60;
  dashTimer = setInterval(loadDashboard, Math.max(15, sec) * 1000);
}

const portfolio = ref(null);
const portfolioError = ref('');
const portfolioLoading = ref(false);

/** 내 실제 보유 — 토스에서 **매번 읽는다**(저장하지 않는다) */
async function loadPortfolio() {
  portfolioLoading.value = true;
  try {
    const res = await apiFetch('/api/portfolio');
    if (res.ok) {
      portfolio.value = await res.json();
      portfolioError.value = '';
      return;
    }
    // 🔴 조용히 비우지 않는다 — 특히 ip-denied 는 화면에서 바로 알아야 고친다
    const body = await res.json().catch(() => ({}));
    portfolio.value = null;
    portfolioError.value = body.error || `보유 현황을 불러오지 못했습니다 (${res.status})`;
  } catch (e) {
    portfolio.value = null;
    portfolioError.value = e.message || '보유 현황을 불러오지 못했습니다.';
  } finally {
    portfolioLoading.value = false;
  }
}

/**
 * 🔴 환산은 **서버가 끝냈다**(2026-09-21). 프론트는 받은 값을 그리기만 한다 —
 *    소비자가 화면 하나가 아니라서(텔레그램·API 직접조회) 표시 로직을 뒤로 내렸다.
 *  - `converted:true` 면 계산값이므로 `≈` 를 붙인다
 *  - `krw:null` 이면 **환율을 모른다**는 뜻이다. 0 으로 보여주지 않는다("0원" 으로 읽힌다)
 */
function krwCell(p) {
  if (!p) return '—';
  if (p.krw == null) return p.usd != null ? `$${Number(p.usd).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—';
  return `${p.converted ? '≈' : ''}${money(p.krw, 'KRW')}`;
}

function money(v, cur) {
  if (v == null) return '—';
  return cur === 'USD'
    ? `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `₩${Math.round(Number(v)).toLocaleString('ko-KR')}`;
}
function pct(v) {
  if (v == null) return '—';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}
function signClass(v) {
  if (v == null) return 'flat';
  return Number(v) > 0 ? 'up' : Number(v) < 0 ? 'down' : 'flat';
}

async function loadLatestBriefing() {
  try {
    const res = await apiFetch('/api/briefing/latest');
    if (res.ok) {
      const data = await res.json();
      briefing.value = data.report || null;
    }
  } catch {
    // 무시
  }
}

async function runBriefing() {
  briefingLoading.value = true;
  briefingError.value = '';
  try {
    const res = await apiFetch('/api/briefing/run', { method: 'POST' });
    if (!res.ok) {
      briefingError.value = await readApiError(res, '브리핑 생성 실패');
      return;
    }
    const data = await res.json();
    briefing.value = data.report || null;
    notify({ message: '시장 브리핑을 생성했습니다.', tone: 'success' });
  } catch (e) {
    briefingError.value = e.message || '브리핑 생성 실패';
  } finally {
    briefingLoading.value = false;
  }
}

function openStream() {
  try {
    es = new EventSource(apiStreamUrl('/api/stream'));
    es.addEventListener('watchlist.updated', (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.watchlist) applyState(data.watchlist);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('manager.report.created', (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.manager?.latestReport) briefing.value = data.manager.latestReport;
      } catch {
        /* ignore */
      }
    });
    es.onerror = () => {
      /* 폴링이 백업 — 조용히 무시 */
    };
  } catch {
    /* EventSource 미지원 무시 */
  }
}

onMounted(async () => {
  await load();
  await loadLatestBriefing();
  await loadPortfolio();
  await loadDashboard();
  restartDashTimer();
  clockTimer = setInterval(() => {
    clock.value = formatMarketClock();
  }, 1000);
  pollTimer = setInterval(() => {
    load();
    loadPortfolio();
  }, 20000); // 시세 신선도 유지
  openStream();
});

onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer);
  if (pollTimer) clearInterval(pollTimer);
  if (dashTimer) clearInterval(dashTimer);
  if (es) es.close();
});
</script>
<template>
  <div class="tracker">
    <!-- ── 상단 ───────────────────────────────────────── -->
    <header class="topbar">
      <div class="brand">
        <span class="brand__mark" aria-hidden="true"></span>
        <div class="brand__text">
          <h1 class="brand__name">종합 주식·ETF 트래커</h1>
          <span class="brand__sub">한국 · 미국 관심종목 추적</span>
        </div>
      </div>

      <div class="clocks">
        <div class="clockchip">
          <span class="clockchip__zone">KST</span>
          <span class="clockchip__time mono-num">{{ clock.kst.time }}</span>
          <span class="dot" :class="`dot--${sessions?.kr?.state || 'closed'}`" aria-hidden="true"></span>
          <span class="clockchip__state">KRX {{ sessionLabel(sessions?.kr?.state) }}</span>
        </div>
        <div class="clockchip">
          <span class="clockchip__zone">ET</span>
          <span class="clockchip__time mono-num">{{ clock.us.time }}</span>
          <span class="dot" :class="`dot--${sessions?.us?.state || 'closed'}`" aria-hidden="true"></span>
          <span class="clockchip__state">US {{ sessionLabel(sessions?.us?.state) }}</span>
        </div>
      </div>

      <div class="topbar__meta">
        <div v-if="fx?.USDKRW?.rate" class="metric">
          <span class="metric__label">USD/KRW</span>
          <span class="metric__value mono-num">{{ Number(fx.USDKRW.rate).toLocaleString('ko-KR') }}</span>
        </div>
        <div class="metric">
          <span class="metric__label">종목</span>
          <span class="metric__value mono-num">{{ totalTickers }}</span>
        </div>
        <button class="btn btn--ghost" aria-label="운영 설정" title="운영 설정" @click="settingsOpen = true">⚙</button>
        <button class="btn btn--ghost" :disabled="refreshing" @click="onRefreshMarket">
          <span class="btn__spin" :class="{ 'btn__spin--on': refreshing }" aria-hidden="true"></span>
          {{ refreshing ? '갱신 중' : '시세 갱신' }}
        </button>
      </div>
    </header>

    <p v-if="error" class="banner banner--error">{{ error }}</p>

    <!-- ── 관심 테마 스트립 (상단) ─────────────────────── -->
    <section class="strip">
      <div v-if="!groups.length" class="strip__empty">
        관심 테마가 없습니다. ⚙ 설정에서 추가하세요.
      </div>
      <article v-for="group in groups" :key="group.id" class="wcard">
        <header class="wcard__head">
          <span class="wcard__name">{{ group.name }}</span>
          <span class="wcard__count mono-num">{{ group.tickers.length }}</span>
        </header>
        <ul class="wcard__list">
          <li
            v-for="t in group.tickers"
            :key="t.symbol + t.market"
            class="wrow"
            :class="{ 'wrow--on': selected.symbol === t.symbol }"
            @click="pickSymbol(t.symbol, t.name)"
          >
            <span class="wrow__name">{{ t.name }}</span>
            <span class="wrow__price mono-num">{{ formatPrice(t) }}</span>
            <span
              v-if="t.quote && t.quote.changePct != null"
              class="wrow__chg mono-num"
              :style="heatmapStyleFromChangePct(t.quote.changePct)"
            >{{ formatChangePct(t.quote.changePct) }}</span>
            <button class="wrow__rm" title="삭제" @click.stop="onRemoveTicker(group, t)">×</button>
          </li>
          <li v-if="!group.tickers.length" class="wrow wrow--empty">비어 있음</li>
        </ul>
        <div class="wcard__add">
          <input
            v-model="ensureInput(group.id).query"
            class="input input--xs"
            placeholder="티커/종목명"
            @keyup.enter="onAddTicker(group)"
          />
          <button class="btn btn--xs btn--soft" :disabled="busy" @click="onAddTicker(group)">+</button>
        </div>
      </article>
    </section>

    <!-- ── 본문: 넓으면 보드 + 브리핑 나란히 ──────────── -->
    <div class="layout">
      <div class="layout__main">
        <!-- ── 내 자산 (토스 실계좌) ───────────────────────────── -->
        <section class="assets">
          <header class="assets__head">
            <div class="assets__title">
              <span class="assets__badge">TOSS</span>
              <h2>내 자산</h2>
              <span v-if="portfolio?.items?.length" class="group__count mono-num">{{ portfolio.items.length }}</span>
            </div>
            <span v-if="portfolioLoading" class="assets__note">불러오는 중…</span>
            <span v-else-if="portfolio?.summary?.fx" class="assets__note">
              ≈ USD/KRW {{ Number(portfolio.summary.fx.rate).toLocaleString('ko-KR') }} 환산
            </span>
          </header>

          <p v-if="portfolioError" class="banner banner--error">{{ portfolioError }}</p>
          <p v-else-if="!portfolio" class="banner banner--empty">토스 연동을 설정하면 실제 보유가 표시됩니다.</p>

          <template v-else>
            <div class="kpis">
              <div class="kpi">
                <span class="kpi__label">평가금액</span>
                <span class="kpi__value mono-num">{{ krwCell(portfolio.summary.value) }}</span>
              </div>
              <div class="kpi">
                <span class="kpi__label">매입금액<template v-if="portfolio.summary.purchase.usd"> · USD 보유</template></span>
                <span class="kpi__value kpi__value--sub mono-num">{{ krwCell(portfolio.summary.purchase) }}</span>
              </div>
              <div class="kpi">
                <span class="kpi__label">평가손익</span>
                <span class="kpi__value mono-num" :class="signClass(portfolio.summary.profit.krw ?? portfolio.summary.profit.usd)">
                  {{ krwCell(portfolio.summary.profit) }}
                  <small>{{ pct(portfolio.summary.profitRate) }}</small>
                </span>
              </div>
              <div class="kpi">
                <span class="kpi__label">오늘</span>
                <span class="kpi__value mono-num" :class="signClass(portfolio.summary.dailyProfit.krw ?? portfolio.summary.dailyProfit.usd)">
                  {{ krwCell(portfolio.summary.dailyProfit) }}
                  <small>{{ pct(portfolio.summary.dailyRate) }}</small>
                </span>
              </div>
            </div>

            <!-- 모멘텀: 판단하지 않고 **고르기만** 한다 -->
            <div v-if="portfolio.momentum?.length" class="momentum">
              <span class="momentum__label">오늘 크게 움직임</span>
              <span v-for="m in portfolio.momentum" :key="m.symbol" class="momentum__chip" :class="signClass(m.dailyRate)">
                {{ m.name }} <b class="mono-num">{{ pct(m.dailyRate) }}</b>
              </span>
            </div>

            <table class="holdings">
              <thead>
                <tr>
                  <th>종목</th><th class="ta-r">수량</th><th class="ta-r">평단</th>
                  <th class="ta-r">현재가</th><th class="ta-r">평가손익</th><th class="ta-r">오늘</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="h in portfolio.items"
                  :key="h.symbol"
                  class="holdings__row"
                  :class="{ 'holdings__row--on': selected.symbol === h.symbol }"
                  @click="pickSymbol(h.symbol, h.name)"
                >
                  <td>
                    <span class="holdings__name">{{ h.name }}</span>
                    <span class="holdings__meta">{{ h.market }} · {{ h.symbol }}</span>
                  </td>
                  <td class="ta-r mono-num">{{ h.quantity }}</td>
                  <td class="ta-r mono-num">{{ money(h.avgPrice, h.currency) }}</td>
                  <td class="ta-r mono-num">{{ money(h.lastPrice, h.currency) }}</td>
                  <td class="ta-r mono-num" :class="signClass(h.profit)">
                    {{ money(h.profit, h.currency) }} <small>{{ pct(h.profitRate) }}</small>
                  </td>
                  <td class="ta-r mono-num" :class="signClass(h.dailyRate)">{{ pct(h.dailyRate) }}</td>
                </tr>
              </tbody>
            </table>
          </template>
        </section>

        <!-- ── 조각 실패를 숨기지 않는다 ─────────────────────── -->
        <p v-if="dashError" class="banner banner--error">{{ dashError }}</p>
        <p v-else-if="dash && dash.failedCount" class="banner banner--warn">
          일부 데이터를 못 받았습니다 ({{ dash.failedCount }}건) —
          <template v-for="(p, k) in dash.parts" :key="k">
            <span v-if="p.ok === false">{{ k }}: {{ p.error }} ({{ p.kind }}) </span>
          </template>
        </p>

        <!-- ── 차트 + 호가 ────────────────────────────────────── -->
        <PriceChart :symbol="selected.symbol" :name="selected.name" />

      </div>

      <!-- ── 신호 (모멘텀·경고·랭킹) ────────────────────── -->
      <aside class="layout__signals">
          <div class="signals">
            <div class="panel">
              <h3 class="panel__h">모멘텀 <small>|{{ dash?.momentumPct ?? 3 }}%| 이상</small></h3>
              <p v-if="!dash?.momentum?.length" class="panel__empty">기준을 넘는 종목이 없습니다.</p>
              <ul v-else class="panel__list">
                <li v-for="m in dash.momentum" :key="m.symbol">
                  <button class="linkish" @click="pickSymbol(m.symbol, m.name)">{{ m.name }}</button>
                  <b class="mono-num" :class="signClass(m.dailyRate)">{{ pct(m.dailyRate) }}</b>
                </li>
              </ul>
            </div>

            <div class="panel">
              <h3 class="panel__h">종목 경고</h3>
              <p v-if="partError('warnings')" class="panel__err">{{ partError('warnings').error }}</p>
              <p v-else-if="!dash || !Object.keys(dash.warnings || {}).length" class="panel__empty">경고 없음</p>
              <ul v-else class="panel__list">
                <li v-for="(ws, sym) in dash.warnings" :key="sym">
                  <span>{{ sym }}</span><b class="warnish">{{ ws.length }}건</b>
                </li>
              </ul>
            </div>

            <div class="panel">
              <h3 class="panel__h">랭킹</h3>
              <p v-if="partError('rankings')" class="panel__err">{{ partError('rankings').error }}</p>
              <template v-else v-for="(r, key) in (dash?.rankings || {})" :key="key">
                <div class="rank">
                  <!-- 🔴 키가 `국가:종류` 다. 사람이 읽는 말로 바꾼다 -->
                  <span class="rank__type">{{ rankLabel(key) }}</span>
                  <!-- 🔴 이 종류만 실패했으면 그렇게 말한다("없음" 과 다르다) -->
                  <p v-if="r.error" class="rank__err">{{ r.error }}</p>
                  <ol v-else class="rank__list">
                    <li v-for="row in (r.rows || []).slice(0, 5)" :key="row.symbol">
                      <!-- ⚠️ 이름이 없으면 코드를 보여준다(빈칸보다 낫다) -->
                      <button class="linkish" :title="row.symbol" @click="pickSymbol(row.symbol, row.name || row.symbol)">
                        {{ row.name || row.symbol }}
                      </button>
                    </li>
                  </ol>
                </div>
              </template>
            </div>
          </div>
      </aside>

      <!-- ── 브리핑: AI 레이어는 색으로 구분한다 ───────── -->
      <aside class="layout__rail">
        <section class="briefing">
          <header class="briefing__head">
            <div class="briefing__title">
              <span class="briefing__badge">AI</span>
              <h2>시장 브리핑</h2>
            </div>
            <button
              class="btn btn--ai"
              :disabled="briefingLoading || totalTickers === 0"
              @click="runBriefing"
            >
              {{ briefingLoading ? '생성 중…' : '브리핑 생성' }}
            </button>
          </header>

          <p v-if="briefingError" class="banner banner--error">{{ briefingError }}</p>
          <p v-else-if="!briefing" class="banner banner--empty">
            {{ totalTickers === 0 ? '종목을 추가하면 시장 브리핑을 생성할 수 있습니다.' : '아직 생성된 브리핑이 없습니다.' }}
          </p>

          <article v-else class="report">
            <div class="report__meta">
              <span class="report__date mono-num">{{ briefing.targetDate }}</span>
              <!-- 🔴 이 값은 **우리가 요청한 모델 이름**이지 실제로 답한 모델이 아니다.
                   호출은 osh-ai-gateway → OpenRouter 로 나가고, 사업자가 그때그때 다르다
                   (게이트웨이 기록으로 확인: simpleStock 은 전부 backend=openrouter). -->
              <!-- 게이트웨이가 x-llm-model/x-llm-provider 를 주면 **실제로 답한 것**을 보여준다.
                   안 주면 "확인 불가" 다 — 요청 이름으로 메우면 처음 문제로 돌아간다. -->
              <span v-if="briefing.servedBy" class="report__model" :title="`요청: ${briefing.model}`">
                {{ briefing.servedBy.model || '모델 미상' }}
                <template v-if="briefing.servedBy.provider"> · {{ briefing.servedBy.provider }}</template>
              </span>
              <span v-else class="report__model report__model--unknown" :title="`요청한 이름: ${briefing.model}. 게이트웨이가 실제 모델을 알려주지 않았습니다.`">
                응답 모델 확인 불가 · 요청 {{ briefing.model }}
              </span>
            </div>

            <p class="report__summary">{{ briefing.summary }}</p>

            <p v-if="briefing.dailyObjective" class="report__outlook">{{ briefing.dailyObjective }}</p>

            <div v-if="briefing.actionItems?.length" class="report__block">
              <h3 class="report__h">관심종목 시그널</h3>
              <ul class="report__list">
                <li v-for="(s, i) in briefing.actionItems" :key="i">{{ s }}</li>
              </ul>
            </div>
            <div v-if="briefing.riskChecks?.length" class="report__block report__block--risk">
              <h3 class="report__h">리스크 체크</h3>
              <ul class="report__list">
                <li v-for="(s, i) in briefing.riskChecks" :key="i">{{ s }}</li>
              </ul>
            </div>
            <div v-if="briefing.allocationNotes?.length" class="report__block">
              <h3 class="report__h">테마 · 섹터 노트</h3>
              <ul class="report__list">
                <li v-for="(s, i) in briefing.allocationNotes" :key="i">{{ s }}</li>
              </ul>
            </div>
          </article>
        </section>
      </aside>
    </div>

    <SettingsPanel :open="settingsOpen" @close="settingsOpen = false" @saved="loadDashboard(); restartDashTimer()" />
  </div>
</template>

<style scoped>
/**
 * 2026-09-21 전면 개정.
 *
 * 🔴 직전 판의 실제 결함(사용자 지적 + 스크린샷 확인):
 *   1. 주 버튼이 배경과 구분 안 됨          → btn--primary 에 실제 색을 준다
 *   2. 카드 배경이 페이지 배경과 같은 색     → surface 사다리를 쓴다
 *   3. 카드 안 `지수`셀렉트+`추가`가 잘림     → addticker 를 grid 로 (넘치면 줄바꿈)
 *   4. 카드가 좁아 오른쪽 절반이 빔          → 넓으면 보드+브리핑 2열
 *   5. 라이트 테마 잔재(#eef0f4 등)          → 전부 토큰으로
 *
 * ⚠️ 하드코딩 색을 다시 넣지 말 것. 필요하면 styles/tokens.css 에 토큰을 추가한다.
 */
/**
 * 🔴 데스크탑 전용 — **페이지가 스크롤되지 않는다**(2026-09-21 사용자 지시).
 *    화면 높이에 맞추고, 넘치는 것은 **각 패널 안에서** 스크롤한다.
 *    ⚠️ 그래서 모든 스크롤 컨테이너에 `min-height: 0` 이 필요하다 —
 *       grid/flex 자식은 기본 min-height:auto 라 **내용이 밀어내고 페이지가 늘어난다.**
 */
.tracker {
  height: 100vh;
  overflow: hidden;
  padding: var(--space-sm) var(--space-base) var(--space-base);
  background: var(--color-canvas);
  color: var(--color-ink);
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: var(--space-sm);
}

/* ── 상단 ─────────────────────────────────────────── */
.topbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  padding: var(--space-xs) var(--space-base);
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md);
}
.brand {
  display: flex;
  align-items: center;
  gap: var(--space-base);
  min-width: 0;
}
/* 브랜드 마크 — 이 앱의 유일한 그라디언트다(인디고→바이올렛: 시세와 AI 를 한 몸으로) */
.brand__mark {
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: var(--rounded-md);
  background: linear-gradient(140deg, var(--color-primary), var(--color-ai));
}
.brand__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.brand__name {
  margin: 0;
  font-size: var(--text-base);
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--color-ink);
  white-space: nowrap;
}
.brand__sub { display: none; } /* 헤더를 낮춘다 — 부제는 공간값이 없다 */

.clocks {
  display: flex;
  gap: var(--space-sm);
  flex-wrap: wrap;
}
.clockchip {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-xs) var(--space-base);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-hairline-soft);
  border-radius: var(--rounded-pill);
}
.clockchip__zone {
  font-size: var(--text-2xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--color-faint);
}
.clockchip__time {
  font-size: var(--text-md);
  color: var(--color-ink);
}
.clockchip__state {
  font-size: var(--text-xs);
  color: var(--color-muted);
}
/* 개장 여부는 배지가 아니라 점으로 — 배지가 많으면 색이 시세와 경쟁한다 */
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-faint);
  flex: none;
}
.dot--open,
.dot--active,
.dot--regular {
  background: var(--color-open);
  box-shadow: 0 0 0 3px var(--color-open-soft);
}

.topbar__meta {
  display: flex;
  align-items: center;
  gap: var(--space-md);
}
.metric {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  line-height: 1.2;
}
.metric__label {
  font-size: var(--text-2xs);
  letter-spacing: 0.06em;
  color: var(--color-faint);
}
.metric__value {
  font-size: var(--text-md);
  color: var(--color-body);
}

/* ── 레이아웃 ─────────────────────────────────────── */
/* 데스크탑 3열 — 자산·차트 / 신호 / 브리핑. 각 열은 **자기 안에서** 스크롤한다 */
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px 340px;
  gap: var(--space-sm);
  min-height: 0;
}
@media (max-width: 1400px) {
  .layout { grid-template-columns: minmax(0, 1fr) 240px 300px; }
}
@media (max-width: 1100px) {
  .layout { grid-template-columns: minmax(0, 1fr); overflow-y: auto; }
}
.layout__main,
.layout__rail {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
}

.addgroup {
  display: flex;
  gap: var(--space-sm);
}

/* ── 폼 ───────────────────────────────────────────── */
.input,
.select {
  height: 40px;
  padding: 0 var(--space-base);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md);
  color: var(--color-ink);
  font-size: var(--text-base);
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.input { flex: 1; min-width: 0; }
.input::placeholder { color: var(--color-faint); }
.input:focus,
.select:focus {
  outline: none;
  border-color: var(--color-primary-line);
  box-shadow: var(--ring);
}
.input--sm,
.select { height: 34px; font-size: var(--text-md); }
.select { padding-right: var(--space-sm); }

/* ── 버튼 ─────────────────────────────────────────── */
.btn {
  display: inline-flex;
  /* 헤더가 낮아졌다 */
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  height: 32px;
  padding: 0 var(--space-base);
  border: 1px solid var(--color-hairline-strong);
  border-radius: var(--rounded-md);
  background: var(--color-surface-raised);
  color: var(--color-ink);
  font-size: var(--text-md);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, opacity 0.12s ease;
}
.btn:hover:not(:disabled) { background: var(--color-surface-hover); border-color: var(--color-hairline-strong); }
.btn:disabled { opacity: 0.42; cursor: not-allowed; }
.btn--sm { height: 34px; padding: 0 var(--space-base); font-size: var(--text-sm); }

/* 🔴 주 행동 — 직전 판은 여기에 색이 없어서 버튼이 안 보였다 */
.btn--primary {
  background: var(--color-primary);
  border-color: transparent;
  color: var(--color-on-primary);
}
.btn--primary:hover:not(:disabled) { background: var(--color-primary-hover); }
.btn--primary:active:not(:disabled) { background: var(--color-primary-active); }

/* AI 가 하는 일은 AI 색으로 — 사람이 누르는 다른 버튼과 구분된다 */
.btn--ai {
  background: var(--color-ai-soft);
  border-color: var(--color-ai-line);
  color: var(--color-ai);
}
.btn--ai:hover:not(:disabled) { background: var(--color-ai-line); color: var(--color-ink); }

.btn--soft {
  background: var(--color-primary-soft);
  border-color: var(--color-primary-line);
  color: var(--color-primary);
}
.btn--soft:hover:not(:disabled) { background: var(--color-primary); color: var(--color-on-primary); }

.btn--ghost { background: transparent; }

.btn__spin { display: none; }
.btn__spin--on {
  display: block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--color-hairline-strong);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.iconbtn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  border-radius: var(--rounded-sm);
  color: var(--color-muted);
  font-size: var(--text-lg);
  line-height: 1;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.iconbtn:hover { background: var(--color-surface-hover); color: var(--color-ink); }
.iconbtn--danger:hover { background: var(--color-danger-soft); color: var(--color-danger); }

/* ── 안내 ─────────────────────────────────────────── */
.banner {
  margin: 0;
  padding: var(--space-base) var(--space-md);
  border-radius: var(--rounded-md);
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  color: var(--color-body);
  font-size: var(--text-md);
}
.banner--error {
  background: var(--color-danger-soft);
  border-color: transparent;
  color: var(--color-danger);
}
.banner--empty {
  border-style: dashed;
  text-align: center;
  color: var(--color-muted);
}

/* ── 내 자산 ──────────────────────────────────────── */
.assets {
  flex: none;
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  border-left: 2px solid var(--color-primary-line);
  border-radius: var(--rounded-lg);
  padding: var(--space-base);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}
.assets__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
.assets__title { display: flex; align-items: center; gap: var(--space-sm); }
.assets__title h2 { margin: 0; font-size: var(--text-base); font-weight: 700; color: var(--color-ink); }
.assets__badge {
  font-size: var(--text-2xs); font-weight: 700; letter-spacing: 0.1em;
  padding: 2px 6px; border-radius: var(--rounded-xs);
  background: var(--color-primary-soft); color: var(--color-primary);
}
.assets__note { font-size: var(--text-xs); color: var(--color-muted); }

.kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-xs);
}
.kpi {
  display: flex; flex-direction: column; gap: 1px;
  padding: var(--space-sm) var(--space-base);
  background: var(--color-surface-sunken);
  border-radius: var(--rounded-md);
}
.kpi__label { font-size: var(--text-2xs); letter-spacing: 0.06em; color: var(--color-faint); }
.kpi__value { font-size: var(--text-lg); font-weight: 700; color: var(--color-ink); }
.kpi__value--sub { font-size: var(--text-md); color: var(--color-body); font-weight: 600; }
.kpi__value small { font-size: var(--text-sm); font-weight: 600; margin-left: 6px; opacity: 0.85; }
.up { color: var(--color-up); }
.down { color: var(--color-down); }
.flat { color: var(--color-body); }

.momentum { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-sm); }
.momentum__label { font-size: var(--text-xs); color: var(--color-muted); }
.momentum__chip {
  font-size: var(--text-sm);
  padding: 3px 9px;
  border-radius: var(--rounded-pill);
  background: var(--color-flat-soft);
}
.momentum__chip.up { background: var(--color-up-soft); }
.momentum__chip.down { background: var(--color-down-soft); }

.holdings { width: 100%; border-collapse: collapse; font-size: var(--text-md); }
.holdings th {
  text-align: left; font-size: var(--text-2xs); font-weight: 600; letter-spacing: 0.06em;
  color: var(--color-faint); padding: 0 var(--space-sm) var(--space-xs);
  border-bottom: 1px solid var(--color-hairline-soft);
}
.holdings td { padding: 5px var(--space-sm); border-bottom: 1px solid var(--color-hairline-soft); }
.holdings tr:last-child td { border-bottom: none; }
.holdings__name { display: block; font-weight: 600; color: var(--color-ink); }
.holdings__meta { display: block; font-size: var(--text-xs); color: var(--color-faint); }
.holdings small { font-size: var(--text-xs); opacity: 0.85; margin-left: 4px; }
.ta-r { text-align: right; }

/* ── 관심 테마 스트립 (상단) ───────────────────────── */
.strip {
  display: flex;
  gap: var(--space-sm);
  overflow-x: auto;
  padding-bottom: 2px;
  flex: none;
}
.strip__empty {
  font-size: var(--text-sm); color: var(--color-faint);
  padding: var(--space-sm) var(--space-base);
  border: 1px dashed var(--color-hairline); border-radius: var(--rounded-md);
}
.wcard {
  flex: none;
  width: 236px;
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md);
  padding: var(--space-sm);
  display: flex; flex-direction: column; gap: 4px;
}
.wcard__head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.wcard__name {
  font-size: var(--text-sm); font-weight: 700; color: var(--color-ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wcard__count { font-size: var(--text-2xs); color: var(--color-faint); }
.wcard__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; max-height: 92px; overflow-y: auto; }
.wrow {
  display: grid; grid-template-columns: minmax(0, 1fr) auto auto 14px;
  align-items: center; gap: 5px;
  padding: 2px 3px; border-radius: var(--rounded-xs); cursor: pointer;
}
.wrow:hover { background: var(--color-surface-hover); }
.wrow--on { background: var(--color-primary-soft); }
.wrow--empty { color: var(--color-faint); font-size: var(--text-xs); cursor: default; display: block; }
.wrow__name { font-size: var(--text-xs); color: var(--color-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wrow__price { font-size: var(--text-2xs); color: var(--color-body); }
.wrow__chg { font-size: var(--text-3xs, 9px); padding: 1px 4px; border-radius: var(--rounded-xs); font-weight: 700; }
.wrow__rm { border: 0; background: none; color: var(--color-faint); cursor: pointer; font-size: 12px; padding: 0; opacity: 0; }
.wrow:hover .wrow__rm { opacity: 1; }
.wcard__add { display: grid; grid-template-columns: minmax(0, 1fr) 28px; gap: 4px; }
.input--xs { height: 26px; font-size: var(--text-xs); padding: 0 6px; }
.btn--xs { height: 26px; padding: 0; font-size: var(--text-sm); }

.layout__signals {
  display: flex; flex-direction: column; gap: var(--space-sm);
  min-width: 0; min-height: 0; overflow-y: auto;
}
.signals { display: flex; flex-direction: column; gap: var(--space-sm); }

/* ── HTS: 차트 + 사이드 패널 ──────────────────────── */
/* 신호 패널은 가운데 열로 옮겼다 — 차트는 자기 폭을 다 쓴다 */
.hts { display: block; }
.side { display: flex; flex-direction: column; gap: var(--space-sm); min-width: 0; }
.panel {
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: var(--space-base);
  display: flex; flex-direction: column; gap: var(--space-sm);
}
.panel__h {
  margin: 0; font-size: var(--text-xs); font-weight: 700;
  letter-spacing: 0.06em; color: var(--color-muted);
  display: flex; align-items: baseline; gap: 6px;
}
.panel__h small { font-weight: 500; color: var(--color-faint); }
.panel__empty { margin: 0; font-size: var(--text-sm); color: var(--color-faint); }
/* 🔴 "없음" 과 "못 받음" 은 다른 색이어야 한다 */
.panel__err { margin: 0; font-size: var(--text-sm); color: var(--color-down); }
.panel__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.panel__list li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); font-size: var(--text-md); }
.linkish {
  border: 0; background: none; padding: 0; cursor: pointer;
  color: var(--color-ink); font-size: var(--text-md); text-align: left;
}
.linkish:hover { color: var(--color-primary); }
.warnish { color: var(--color-warn); font-size: var(--text-sm); }
.rank { display: flex; flex-direction: column; gap: 4px; }
.rank__type { font-size: var(--text-2xs); color: var(--color-faint); letter-spacing: 0.06em; }
.rank__list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 2px; }
.rank__list li { font-size: var(--text-sm); }
.rank__err { margin: 0; font-size: var(--text-xs); color: var(--color-down); }

.banner--warn {
  background: var(--color-warn-soft);
  border-color: transparent;
  color: var(--color-warn);
}
.holdings__row { cursor: pointer; }
.holdings__row:hover { background: var(--color-surface-hover); }
.holdings__row--on { background: var(--color-primary-soft); }
.ticker__id[role='button'] { cursor: pointer; }

/* ── 보드 ─────────────────────────────────────────── */
.board {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--space-md);
  align-items: start;
}
.group {
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: var(--space-base);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  min-width: 0;
}
.group__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  padding-bottom: var(--space-sm);
  border-bottom: 1px solid var(--color-hairline-soft);
}
.group__title { display: flex; align-items: center; gap: var(--space-sm); min-width: 0; }
.group__name {
  font-size: var(--text-base);
  font-weight: 700;
  color: var(--color-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group__count {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-muted);
  background: var(--color-flat-soft);
  padding: 1px 7px;
  border-radius: var(--rounded-pill);
}
.group__actions { display: flex; gap: var(--space-xxs); flex: none; }

.tickers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.ticker {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-xs);
  border-radius: var(--rounded-sm);
  transition: background 0.1s ease;
}
.ticker:hover { background: var(--color-surface-hover); }
.ticker--empty {
  list-style: none;
  padding: var(--space-md);
  text-align: center;
  font-size: var(--text-md);
  color: var(--color-faint);
}
.ticker__id { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ticker__name {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--color-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ticker__meta { font-size: var(--text-xs); color: var(--color-faint); }
.ticker__quote {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}
.ticker__price { font-size: var(--text-md); font-weight: 600; color: var(--color-ink); }
.ticker__chg {
  min-width: 62px;
  text-align: center;
  font-size: var(--text-xs);
  font-weight: 700;
  padding: 3px 7px;
  border-radius: var(--rounded-sm);
}
.ticker__rm { flex: none; opacity: 0; }
.ticker:hover .ticker__rm,
.ticker__rm:focus-visible { opacity: 1; }

/* 🔴 종전에는 flex 라 셀렉트·버튼이 카드 폭을 넘어 잘렸다. grid 로 자리를 정해 준다 */
.addticker {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 78px 58px;
  gap: var(--space-xs);
  margin-top: var(--space-xs);
  padding-top: var(--space-sm);
  border-top: 1px solid var(--color-hairline-soft);
}
.addticker__query { min-width: 0; }

/* ── 브리핑 (AI 레이어) ──────────────────────────── */
.briefing {
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  border-left: 2px solid var(--color-ai-line);
  border-radius: var(--rounded-lg);
  padding: var(--space-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-base);
}
.briefing__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
}
.briefing__title { display: flex; align-items: center; gap: var(--space-sm); }
.briefing__title h2 { margin: 0; font-size: var(--text-lg); font-weight: 700; color: var(--color-ink); }
.briefing__badge {
  font-size: var(--text-2xs);
  font-weight: 700;
  letter-spacing: 0.1em;
  padding: 2px 6px;
  border-radius: var(--rounded-xs);
  background: var(--color-ai-soft);
  color: var(--color-ai);
}

.report { display: flex; flex-direction: column; gap: var(--space-base); }
.report__meta { display: flex; align-items: center; gap: var(--space-sm); font-size: var(--text-xs); }
.report__date { color: var(--color-muted); }
.report__model { color: var(--color-faint); }
.report__model--unknown { color: var(--color-warn); }

.report__summary {
  margin: 0;
  font-size: var(--text-md);
  line-height: 1.7;
  color: var(--color-body);
  white-space: pre-wrap;
}
/* 모델의 '전망' 은 한 단계 들여 인용처럼 — 사실과 해석을 눈으로 가른다 */
.report__outlook {
  margin: 0;
  padding: var(--space-sm) var(--space-base);
  border-left: 2px solid var(--color-ai-line);
  background: var(--color-ai-soft);
  border-radius: 0 var(--rounded-sm) var(--rounded-sm) 0;
  font-size: var(--text-md);
  line-height: 1.65;
  color: var(--color-body);
}

.report__block { display: flex; flex-direction: column; gap: var(--space-sm); }
.report__h {
  margin: 0;
  font-size: var(--text-xs);
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--color-muted);
  text-transform: none;
}
.report__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}
.report__list li {
  position: relative;
  padding-left: var(--space-base);
  font-size: var(--text-md);
  line-height: 1.6;
  color: var(--color-body);
}
.report__list li::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--color-primary);
}
.report__block--risk .report__list li::before { background: var(--color-warn); }

@media (max-width: 640px) {
  .tracker { padding: var(--space-base) var(--space-base) var(--space-xl); }
  .topbar { gap: var(--space-sm); }
  .topbar__meta { width: 100%; justify-content: space-between; }
  .board { grid-template-columns: minmax(0, 1fr); }
  .briefing { max-height: none; }
}
</style>

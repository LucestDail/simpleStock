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
const report = ref(null);
const proposals = ref([]);
const analystLoading = ref(false);
const analystError = ref('');
/**
 * my-computer MCP 웹검색 연계 상태.
 * 🔴 **"안 붙었다" 와 "붙었는데 결과가 없다" 는 다르다** — 상태를 보여주지 않으면
 *    둘 다 "뉴스 없음" 으로 똑같이 보인다(오늘 하루 종일 본 그 실패 모드).
 */
const mcpState = ref(null);

/**
 * 선택한 종목 뉴스(레이아웃 지시: 본문 좌열 상단).
 * ⚠️ 종목을 바꿀 때마다 부른다 — **자동 새로고침 타이머에는 안 붙인다**(밖으로 나가는 호출이다).
 */
const news = ref({ loading: false, ok: false, items: [], error: '', when: null });
let newsSeq = 0;

async function loadNews() {
  const sym = selected.value.symbol;
  if (!sym) { news.value = { loading: false, ok: false, items: [], error: '', when: null }; return; }
  const seq = ++newsSeq;
  news.value = { ...news.value, loading: true, error: '' };
  try {
    const q = new URLSearchParams({ symbol: sym, name: selected.value.name || '' });
    const res = await apiFetch(`/api/news?${q}`);
    const b = await res.json().catch(() => ({}));
    // 🔴 늦게 온 응답이 새 선택을 덮어쓰지 않게 한다(종목을 빨리 바꾸면 실제로 일어난다)
    if (seq !== newsSeq) return;
    news.value = {
      loading: false,
      ok: Boolean(b.ok),
      items: b.items || [],
      error: b.ok ? '' : (b.error || `뉴스를 불러오지 못했습니다 (${res.status})`),
      when: new Date().toISOString(),
    };
  } catch (e) {
    if (seq !== newsSeq) return;
    news.value = { loading: false, ok: false, items: [], error: e.message || '뉴스 오류', when: null };
  }
}
const useWebSearch = ref(true);

async function loadMcpStatus() {
  try {
    const res = await apiFetch('/api/mcp/status');
    if (res.ok) mcpState.value = await res.json();
  } catch {
    mcpState.value = null;
  }
}

/** 시황 → 모멘텀 → 매매 제안. 🔴 제안은 **승인해야** 진행된다 */
async function runAnalyst() {
  analystLoading.value = true;
  analystError.value = '';
  try {
    const res = await apiFetch('/api/analyst/run', {
      method: 'POST',
      body: JSON.stringify({ useWebSearch: useWebSearch.value }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.error || `분석 실패 (${res.status})`);
    }
    report.value = await res.json();
    await loadProposals();
  } catch (e) {
    analystError.value = e.message || '분석 실패';
  } finally {
    analystLoading.value = false;
  }
}

async function loadProposals() {
  try {
    const res = await apiFetch('/api/orders/proposals');
    if (res.ok) proposals.value = (await res.json()).proposals || [];
  } catch {
    // 조용히 넘기지 않는다 — 실패하면 목록이 비는데, 그건 "제안 없음" 과 다르다
    analystError.value = '제안 목록을 불러오지 못했습니다.';
  }
}

const STATUS_LABEL = {
  PENDING: '승인 대기', APPROVED: '승인됨', REJECTED: '거절',
  DRY_RUN: '모의 실행됨', EXPIRED: '만료', BLOCKED: '차단',
};
function statusLabel(p) {
  return p.expired && p.status === 'PENDING' ? '만료' : STATUS_LABEL[p.status] || p.status;
}

async function decide(p, action) {
  try {
    const res = await apiFetch(`/api/orders/proposals/${encodeURIComponent(p.id)}/${action}`, { method: 'POST' });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) {
      notify({ message: b.error || '처리 실패', tone: 'error' });
      return;
    }
    if (action === 'execute') {
      // ⚠️ 실제로 안 나갔다는 것을 **그대로** 말한다
      notify({ message: b.proposal?.result?.note || '모의 실행했습니다(실제 주문 아님).', tone: 'info' });
    }
    await loadProposals();
  } catch (e) {
    notify({ message: e.message || '처리 실패', tone: 'error' });
  }
}

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
  // 종목을 고르면 좌열 뉴스도 따라간다(차트와 같은 대상을 본다)
  loadNews();
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

/**
 * 랭킹 탭. 🔴 **키가 사라져도 빈 화면이 되지 않게** 현재 탭을 항상 유효한 값으로 맞춘다
 *    (설정에서 국가·종류를 빼면 고르던 탭이 없어진다).
 */
const rankTab = ref('');
const rankKeys = computed(() => Object.keys(dash.value?.rankings || {}));
const activeRank = computed(() => {
  const keys = rankKeys.value;
  if (!keys.length) return null;
  const key = keys.includes(rankTab.value) ? rankTab.value : keys[0];
  return dash.value.rankings[key];
});

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
    es.onerror = () => {
      /* 폴링이 백업 — 조용히 무시 */
    };
  } catch {
    /* EventSource 미지원 무시 */
  }
}

onMounted(async () => {
  await load();
  await loadPortfolio();
  await loadDashboard();
  await loadProposals();
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

    <!--
      ── 상단 2열 (2026-09-21 사용자 레이아웃 지시) ─────────────
         좌 = ETF 추가·관리(좌우 스크롤) · 우 = 내 자산
      🔴 자산을 본문에서 위로 올렸다. 본문 좌열은 **선택 종목**(뉴스·차트) 전용이 된다.
    -->
    <div class="top">
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
    </div>

    <!-- ── 본문 3열: [선택종목 뉴스+차트] [옵셔널 정보] [애널리스트 채팅] ── -->
    <div class="layout">
      <div class="layout__main">
        <!-- ── 선택한 종목 뉴스 (레이아웃 지시: 좌열 상단) ───── -->
        <section class="news">
          <header class="news__head">
            <h3 class="panel__h">
              뉴스
              <small v-if="selected.symbol">{{ selected.name || selected.symbol }}</small>
            </h3>
            <button class="btn btn--xs btn--soft" :disabled="!selected.symbol || news.loading" @click="loadNews">
              {{ news.loading ? '검색 중…' : '새로고침' }}
            </button>
          </header>
          <p v-if="!selected.symbol" class="panel__empty">종목을 고르면 뉴스를 찾습니다.</p>
          <p v-else-if="news.loading" class="panel__empty">검색 중…</p>
          <!-- 🔴 "없다" 와 "못 받았다" 를 구분해 보여준다 -->
          <p v-else-if="news.error" class="panel__err">{{ news.error }}</p>
          <p v-else-if="!news.items.length" class="panel__empty">검색 결과가 없습니다.</p>
          <ul v-else class="news__list">
            <li v-for="n in news.items" :key="n.rank">
              <a v-if="n.url" :href="n.url" target="_blank" rel="noopener" class="news__title">{{ n.title }}</a>
              <span v-else class="news__title">{{ n.title }}</span>
              <!-- ⚠️ 날짜를 반드시 보여준다 — 실측에서 **6개월 지난 기사**가 섞여 왔다 -->
              <time v-if="n.when" class="news__when">{{ n.when }}</time>
            </li>
          </ul>
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

            <!--
              🔴 2026-09-21 사용자: *"타이틀이랑 하단 정보가 안 맞는데. 차라리 그냥 정형화된
                 테이블로 라도 하지"* ⇒ 목록을 **표**로 바꿨다.
              ★ 목록형은 **어느 제목에 속한 줄인지**가 들여쓰기로만 표현돼서, 그룹이 4개로
                늘어나자 제목과 내용이 어긋나 보였다. 표는 **열이 뜻을 고정**한다.
              ⚠️ 그룹을 한 번에 다 펼치지 않고 **탭으로 하나씩** 본다 — 네 덩어리를 세로로
                 쌓으면 어느 것이 어느 제목 밑인지 다시 헷갈린다.
            -->
            <div class="panel">
              <h3 class="panel__h">랭킹</h3>
              <p v-if="partError('rankings')" class="panel__err">{{ partError('rankings').error }}</p>
              <template v-else>
                <div v-if="rankKeys.length" class="rank__tabs">
                  <button
                    v-for="k in rankKeys" :key="k"
                    class="rank__tab" :class="{ 'rank__tab--on': k === rankTab }"
                    @click="rankTab = k"
                  >{{ rankLabel(k) }}</button>
                </div>
                <p v-if="!rankKeys.length" class="panel__empty">랭킹을 불러오지 못했습니다.</p>
                <template v-else-if="activeRank">
                  <!-- 🔴 이 종류만 실패했으면 그렇게 말한다("없음" 과 다르다) -->
                  <p v-if="activeRank.error" class="rank__err">{{ activeRank.error }}</p>
                  <p v-else-if="!activeRank.rows?.length" class="panel__empty">해당 종목 없음</p>
                  <table v-else class="rtable">
                    <thead>
                      <tr><th class="rtable__n">#</th><th>종목</th><th class="rtable__r">등락률</th></tr>
                    </thead>
                    <tbody>
                      <tr v-for="row in activeRank.rows.slice(0, 8)" :key="row.symbol">
                        <td class="rtable__n mono-num">{{ row.rank }}</td>
                        <td>
                          <!-- ⚠️ 이름이 없으면 코드를 보여준다(빈칸보다 낫다) -->
                          <button class="linkish" :title="row.symbol" @click="pickSymbol(row.symbol, row.name || row.symbol)">
                            {{ row.name || row.symbol }}
                          </button>
                          <!-- 🔴 이름이 붙었을 때만 코드를 따로 보여준다(같은 값을 두 번 쓰지 않는다) -->
                          <small v-if="row.name" class="rtable__sym mono-num">{{ row.symbol }}</small>
                        </td>
                        <td class="rtable__r mono-num" :class="signClass(row.changePct)">{{ pct(row.changePct) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </template>
              </template>
            </div>
          </div>
      </aside>

      <!-- ── 매매 분석 + 제안 (브리핑 대체) ─────────────────── -->
      <aside class="layout__rail">
        <section class="analyst">
          <header class="analyst__head">
            <div class="analyst__title">
              <span class="analyst__badge">AI</span>
              <h2>매매 분석</h2>
            </div>
            <button class="btn btn--ai" :disabled="analystLoading" @click="runAnalyst">
              {{ analystLoading ? '분석 중…' : '분석 실행' }}
            </button>
          </header>

          <!--
            🔴 웹검색이 **붙었는지**를 먼저 보여준다. 이게 없으면 "검색이 안 돈 것" 과
               "검색했는데 별 게 없던 것" 이 화면에서 똑같아진다.
            ⚠️ 5분 타이머에는 안 붙는다 — 버튼을 눌렀을 때만 검색한다
          -->
          <label class="websearch" :class="{ 'websearch--off': mcpState && mcpState.effective !== 'live' }">
            <input v-model="useWebSearch" type="checkbox" :disabled="!mcpState || mcpState.effective !== 'live'" />
            <span>웹 검색</span>
            <span v-if="!mcpState" class="websearch__tag">확인 중…</span>
            <span v-else-if="mcpState.effective === 'live'" class="websearch__tag websearch__tag--on">
              my-computer · 도구 {{ mcpState.tools ? mcpState.tools.length : '?' }}
            </span>
            <span v-else class="websearch__tag">
              미연결 ({{ mcpState.reason === 'url_or_token_missing' ? '주소·토큰 없음' : '꺼짐' }})
            </span>
          </label>

          <p v-if="analystError" class="banner banner--error">{{ analystError }}</p>
          <p v-else-if="!report" class="banner banner--empty">
            분석을 실행하면 시황·모멘텀 판단과 <b>매수/매도 제안</b>이 나옵니다.
          </p>

          <template v-else>
            <!-- ★ 새 기능이 **실제로 돌았다는 증거**를 화면에 둔다 — 0 이면 스스로 알려준다 -->
            <p v-if="report.web" class="analyst__src">
              <template v-if="report.web.ok">웹 검색 {{ report.web.hits }}건 반영 · {{ report.web.tool }}</template>
              <template v-else>웹 검색 미반영 — {{ report.web.error }}</template>
            </p>
            <p class="analyst__view">{{ report.marketView }}</p>
            <p class="analyst__mom">{{ report.momentumRead }}</p>

            <!-- 🔴 제안 — 승인해야만 진행된다. 실행은 아직 no-op 이다 -->
            <div v-if="proposals.length" class="props">
              <h3 class="panel__h">매매 제안 <small>승인해야 진행됩니다</small></h3>
              <article v-for="p in proposals" :key="p.id" class="prop" :class="`prop--${p.side.toLowerCase()}`">
                <header class="prop__head">
                  <span class="prop__side">{{ p.side === 'BUY' ? '매수' : '매도' }}</span>
                  <span class="prop__sym">{{ p.symbol }}</span>
                  <span class="prop__status">{{ statusLabel(p) }}</span>
                </header>
                <dl class="prop__grid">
                  <div><dt>수량</dt><dd class="mono-num">{{ p.quantity }}</dd></div>
                  <div><dt>지정가</dt><dd class="mono-num">{{ p.price }}</dd></div>
                  <div><dt>평가금액</dt><dd class="mono-num">{{ (p.quantity * p.price).toLocaleString() }}</dd></div>
                </dl>
                <p class="prop__why">{{ p.reason }}</p>
                <div v-if="p.status === 'PENDING'" class="prop__act">
                  <button class="btn btn--sm" @click="decide(p, 'reject')">거절</button>
                  <button class="btn btn--sm btn--primary" @click="decide(p, 'approve')">승인</button>
                </div>
                <div v-else-if="p.status === 'APPROVED'" class="prop__act">
                  <!-- ⚠️ 실행해도 실제로는 나가지 않는다(no-op). 그 사실을 버튼에 적는다 -->
                  <button class="btn btn--sm btn--soft" @click="decide(p, 'execute')">실행(모의)</button>
                </div>
                <p v-else-if="p.result" class="prop__note">{{ p.result.note }}</p>
              </article>
            </div>

            <div v-if="report.rejected?.length" class="props">
              <h3 class="panel__h">버려진 제안</h3>
              <!-- 🔴 조용히 버리지 않는다 — 왜 안 만들어졌는지 보여준다 -->
              <p v-for="(r, i) in report.rejected" :key="i" class="prop__rej">
                {{ r.symbol }} {{ r.side }} — {{ r.error }}
              </p>
            </div>

            <div v-if="report.positions?.length" class="props">
              <h3 class="panel__h">종목 판단</h3>
              <article v-for="ps in report.positions" :key="ps.symbol" class="pos">
                <header>
                  <b>{{ ps.symbol }}</b>
                  <span class="pos__stance" :class="`pos--${ps.stance.toLowerCase()}`">{{ ps.stance }}</span>
                  <span class="pos__conf">{{ ps.confidence }}</span>
                </header>
                <p>{{ ps.rationale }}</p>
                <ul><li v-for="(e, i) in ps.evidence" :key="i">{{ e }}</li></ul>
                <p class="pos__risk">⚠ {{ ps.risk }}</p>
              </article>
            </div>

            <!-- ⚠️ 무엇을 못 봤는지 밝힌다 — 안 밝히면 "다 보고 판단했다" 로 읽힌다 -->
            <div v-if="report.dataGaps?.length" class="gaps">
              <h3 class="panel__h">이 분석이 못 본 것</h3>
              <ul><li v-for="(g, i) in report.dataGaps" :key="i">{{ g }}</li></ul>
            </div>
          </template>
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
/* 🔴 사용자: *"내 자산 부분 크기 좀 더 줄여"* — 상단으로 올라가므로 한 줄을 낮춘다 */
.kpi__value { font-size: var(--text-base); font-weight: 700; color: var(--color-ink); }
.kpi__value--sub { font-size: var(--text-sm); color: var(--color-body); font-weight: 600; }
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
/*
  🔴 2026-09-21 사용자: *"수량 평단, 평가손익 금일 변동치가 각 항목과 위치가 안맞는데"*
     원인은 데이터가 아니라 **CSS 특이도**였다 — `.holdings th`(0,1,1)가 `.ta-r`(0,1,0)를
     이겨서 **헤더만 왼쪽 정렬**되고 데이터는 오른쪽으로 갔다. 표는 이미 <table> 이었고
     열 폭도 맞았는데, **헤더 글자만 반대쪽에 붙어** 다른 열을 가리키는 것처럼 보였다.
  ★ 눈으로는 "데이터가 밀렸다" 로 보이지만 실제로 움직인 건 **헤더**다 —
    증상과 원인이 반대편에 있어서 데이터 정렬을 아무리 고쳐도 안 맞았을 자리.
*/
.holdings th.ta-r, .holdings td.ta-r { text-align: right; }
.holdings tr:last-child td { border-bottom: none; }
.holdings__name { display: block; font-weight: 600; color: var(--color-ink); }
.holdings__meta { display: block; font-size: var(--text-xs); color: var(--color-faint); }
.holdings small { font-size: var(--text-xs); opacity: 0.85; margin-left: 4px; }
.ta-r { text-align: right; }

/* ── 관심 테마 스트립 (상단) ───────────────────────── */
/*
  ── 상단 2열 (2026-09-21 레이아웃 지시) ──────────────────
  좌 = 관심 테마(좌우 스크롤) · 우 = 내 자산
  ⚠️ 좌열은 **반드시 min-width:0** 이어야 한다 — 안 주면 grid 항목이 내용 폭만큼
     벌어져 `overflow-x` 가 안 먹고 우열(내 자산)을 화면 밖으로 밀어낸다.
*/
.top {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-sm);
  min-height: 0;
}
@media (min-width: 1180px) {
  /* 자산이 더 넓다 — 숫자가 많고 잘리면 안 된다 */
  .top { grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr); }
}

.strip {
  display: flex;
  /* 🔴 줄바꿈 금지 — 카드가 아래로 떨어지면 상단 높이가 들쭉날쭉해진다(2026-09-21 지시) */
  flex-wrap: nowrap;
  gap: var(--space-sm);
  overflow-x: auto;
  overflow-y: hidden;
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

/* ── 선택 종목 뉴스 ──────────────────────────────── */
.news {
  background: var(--color-surface); border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg); padding: var(--space-sm) var(--space-base);
  display: flex; flex-direction: column; gap: var(--space-xs);
  /* 뉴스가 길어도 차트를 밀어내지 않는다 — 차트가 주인공이다 */
  max-height: 168px; overflow-y: auto;
}
.news__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
.news__head .panel__h { margin: 0; }
.news__head small { margin-left: 6px; color: var(--color-faint); font-weight: 500; }
.news__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.news__title { display: block; font-size: var(--text-xs); color: var(--color-body); text-decoration: none; }
a.news__title:hover { color: var(--color-primary); text-decoration: underline; }
.news__when { display: block; font-size: var(--text-2xs); color: var(--color-faint); }

/* ── 랭킹 표 ──────────────────────────────────────── */
.rank__tabs { display: flex; flex-wrap: wrap; gap: 2px; margin-bottom: var(--space-xs); }
.rank__tab {
  border: 0; background: var(--color-surface-sunken); color: var(--color-muted);
  font-size: var(--text-2xs); font-weight: 600; padding: 3px 8px;
  border-radius: var(--rounded-sm); cursor: pointer;
}
.rank__tab--on { background: var(--color-primary-soft); color: var(--color-primary); }
.rtable { width: 100%; border-collapse: collapse; font-size: var(--text-xs); }
.rtable th {
  text-align: left; font-weight: 600; color: var(--color-faint);
  font-size: var(--text-2xs); padding: 2px 4px; border-bottom: 1px solid var(--color-hairline);
}
.rtable td { padding: 3px 4px; border-bottom: 1px solid var(--color-hairline-soft); }
.rtable tr:last-child td { border-bottom: 0; }
/* ⚠️ 위와 **같은 함정**을 내가 이 표에도 넣었다(`.rtable th` 가 유틸 클래스를 이긴다).
      한 곳 고칠 때 저장소를 훑으라는 규칙의 CSS 판본 — 아래는 th·td 를 함께 짚는다. */
.rtable th.rtable__n, .rtable td.rtable__n { width: 1.6rem; color: var(--color-faint); text-align: right; }
.rtable th.rtable__r, .rtable td.rtable__r { text-align: right; white-space: nowrap; }
.rtable__sym { display: block; color: var(--color-faint); font-size: var(--text-2xs); }

/* ── 매매 분석 ────────────────────────────────────── */
.websearch {
  display: flex; align-items: center; gap: var(--space-xs);
  font-size: var(--text-xs); color: var(--color-body); cursor: pointer;
}
.websearch--off { cursor: not-allowed; color: var(--color-faint); }
.websearch__tag {
  margin-left: auto; padding: 2px 6px; border-radius: var(--rounded-sm);
  background: var(--color-surface-sunken); color: var(--color-faint); font-size: var(--text-2xs);
}
.websearch__tag--on { background: var(--color-ai-soft); color: var(--color-ai); }
.analyst__src { margin: 0; font-size: var(--text-2xs); color: var(--color-faint); }

.analyst {
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  border-left: 2px solid var(--color-ai-line);
  border-radius: var(--rounded-lg);
  padding: var(--space-base);
  display: flex; flex-direction: column; gap: var(--space-sm);
}
.analyst__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
.analyst__title { display: flex; align-items: center; gap: var(--space-sm); }
.analyst__title h2 { margin: 0; font-size: var(--text-base); font-weight: 700; color: var(--color-ink); }
.analyst__badge {
  font-size: var(--text-2xs); font-weight: 700; letter-spacing: 0.1em;
  padding: 2px 6px; border-radius: var(--rounded-xs);
  background: var(--color-ai-soft); color: var(--color-ai);
}
.analyst__view { margin: 0; font-size: var(--text-md); line-height: 1.65; color: var(--color-body); }
.analyst__mom {
  margin: 0; padding: var(--space-sm) var(--space-base);
  border-left: 2px solid var(--color-ai-line); background: var(--color-ai-soft);
  border-radius: 0 var(--rounded-sm) var(--rounded-sm) 0;
  font-size: var(--text-md); line-height: 1.6; color: var(--color-body);
}
.props { display: flex; flex-direction: column; gap: var(--space-sm); }
.prop {
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-md);
  padding: var(--space-sm); display: flex; flex-direction: column; gap: 6px;
  background: var(--color-surface-sunken);
}
.prop--buy { border-left: 3px solid var(--color-up); }
.prop--sell { border-left: 3px solid var(--color-down); }
.prop__head { display: flex; align-items: center; gap: 8px; font-size: var(--text-md); }
.prop__side { font-weight: 700; color: var(--color-ink); }
.prop__sym { color: var(--color-body); }
.prop__status { margin-left: auto; font-size: var(--text-xs); color: var(--color-muted); }
.prop__grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin: 0; }
.prop__grid dt { font-size: var(--text-2xs); color: var(--color-faint); }
.prop__grid dd { margin: 0; font-size: var(--text-md); font-weight: 600; color: var(--color-ink); }
.prop__why { margin: 0; font-size: var(--text-xs); color: var(--color-muted); line-height: 1.5; }
.prop__act { display: flex; gap: 6px; justify-content: flex-end; }
.prop__note { margin: 0; font-size: var(--text-xs); color: var(--color-warn); }
.prop__rej { margin: 0; font-size: var(--text-xs); color: var(--color-down); }
.pos { border-top: 1px solid var(--color-hairline-soft); padding-top: var(--space-sm); }
.pos header { display: flex; align-items: center; gap: 8px; font-size: var(--text-md); color: var(--color-ink); }
.pos__stance { font-size: var(--text-2xs); font-weight: 700; padding: 1px 6px; border-radius: var(--rounded-pill); }
.pos--buy { background: var(--color-up-soft); color: var(--color-up); }
.pos--sell { background: var(--color-down-soft); color: var(--color-down); }
.pos--hold { background: var(--color-flat-soft); color: var(--color-muted); }
.pos__conf { margin-left: auto; font-size: var(--text-2xs); color: var(--color-faint); }
.pos p { margin: 4px 0; font-size: var(--text-xs); color: var(--color-body); line-height: 1.5; }
.pos ul, .gaps ul { margin: 2px 0; padding-left: 16px; }
.pos li, .gaps li { font-size: var(--text-xs); color: var(--color-muted); line-height: 1.5; }
.pos__risk { color: var(--color-warn) !important; }
.gaps { border-top: 1px solid var(--color-hairline-soft); padding-top: var(--space-sm); }

/* ── 브리핑 (AI 레이어) ──────────────────────────── */
@media (max-width: 640px) {
  .tracker { padding: var(--space-base) var(--space-base) var(--space-xl); }
  .topbar { gap: var(--space-sm); }
  .topbar__meta { width: 100%; justify-content: space-between; }
  .board { grid-template-columns: minmax(0, 1fr); }
  .briefing { max-height: none; }
}
</style>

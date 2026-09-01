<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
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
  if (cur === 'USD') return `$${Number(q.price).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
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
  clockTimer = setInterval(() => {
    clock.value = formatMarketClock();
  }, 1000);
  pollTimer = setInterval(() => {
    load();
  }, 20000); // 시세 신선도 유지
  openStream();
});

onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer);
  if (pollTimer) clearInterval(pollTimer);
  if (es) es.close();
});
</script>

<template>
  <div class="tracker">
    <header class="topbar">
      <div class="brand">
        <h1>종합 주식·ETF 트래커</h1>
        <span class="brand__sub">한국 · 미국 관심종목 추적</span>
      </div>
      <div class="clock">
        <div class="clock__row">
          <span class="clock__label">KST</span>
          <span class="clock__time">{{ clock.kst.time }}</span>
          <span class="badge" :class="`badge--${sessions?.kr?.state || 'closed'}`">
            KRX {{ sessionLabel(sessions?.kr?.state) }}
          </span>
        </div>
        <div class="clock__row">
          <span class="clock__label">ET</span>
          <span class="clock__time">{{ clock.us.time }}</span>
          <span class="badge" :class="`badge--${sessions?.us?.state || 'closed'}`">
            US {{ sessionLabel(sessions?.us?.state) }}
          </span>
        </div>
      </div>
      <div class="topbar__meta">
        <span v-if="fx?.USDKRW?.rate" class="fx">USD/KRW {{ Number(fx.USDKRW.rate).toLocaleString('ko-KR') }}</span>
        <span class="count">종목 {{ totalTickers }}</span>
        <button class="btn" :disabled="refreshing" @click="onRefreshMarket">
          {{ refreshing ? '갱신 중…' : '시세 갱신' }}
        </button>
      </div>
    </header>

    <div class="addgroup">
      <input
        v-model="newGroupName"
        class="input"
        type="text"
        placeholder="새 테마 그룹 이름 (예: 반도체, 미국 ETF, 배당주)"
        @keyup.enter="onAddGroup"
      />
      <button class="btn btn--primary" :disabled="busy || !newGroupName.trim()" @click="onAddGroup">그룹 추가</button>
    </div>

    <p v-if="error" class="banner banner--error">{{ error }}</p>
    <p v-else-if="loading && groups.length === 0" class="banner">불러오는 중…</p>
    <p v-else-if="groups.length === 0" class="banner">
      아직 그룹이 없습니다. 위에서 테마 그룹을 만들고 종목을 추가하세요.
    </p>

    <main class="board">
      <section v-for="group in groups" :key="group.id" class="group">
        <header class="group__head">
          <div class="group__title">
            <span class="group__name">{{ group.name }}</span>
            <span class="group__count">{{ group.tickers.length }}</span>
          </div>
          <div class="group__actions">
            <button class="iconbtn" title="이름 변경" @click="onRenameGroup(group)">✎</button>
            <button class="iconbtn iconbtn--danger" title="그룹 삭제" @click="onDeleteGroup(group)">×</button>
          </div>
        </header>

        <ul class="tickers">
          <li v-for="t in group.tickers" :key="t.symbol + t.market" class="ticker">
            <div class="ticker__id">
              <span class="ticker__name">{{ t.name }}</span>
              <span class="ticker__meta">{{ marketBadge(t) }} · {{ t.symbol }}</span>
            </div>
            <div class="ticker__quote">
              <span class="ticker__price">{{ formatPrice(t) }}</span>
              <span
                v-if="t.quote && t.quote.changePct != null"
                class="ticker__chg"
                :style="heatmapStyleFromChangePct(t.quote.changePct)"
              >{{ formatChangePct(t.quote.changePct) }}</span>
            </div>
            <button class="iconbtn iconbtn--danger ticker__rm" title="삭제" @click="onRemoveTicker(group, t)">×</button>
          </li>
          <li v-if="group.tickers.length === 0" class="ticker ticker--empty">종목을 추가하세요</li>
        </ul>

        <div class="addticker">
          <input
            v-model="ensureInput(group.id).query"
            class="input input--sm"
            type="text"
            placeholder="티커 또는 종목명 (AAPL / 삼성전자)"
            @keyup.enter="onAddTicker(group)"
          />
          <select v-model="ensureInput(group.id).market" class="select">
            <option value="">자동</option>
            <option value="KR">KR</option>
            <option value="US">US</option>
            <option value="ETF">ETF</option>
          </select>
          <button class="btn btn--sm" :disabled="busy" @click="onAddTicker(group)">추가</button>
        </div>
      </section>
    </main>

    <section class="briefing">
      <header class="briefing__head">
        <h2>시장 브리핑</h2>
        <button class="btn btn--primary" :disabled="briefingLoading || totalTickers === 0" @click="runBriefing">
          {{ briefingLoading ? '생성 중…' : '브리핑 생성' }}
        </button>
      </header>
      <p v-if="briefingError" class="banner banner--error">{{ briefingError }}</p>
      <p v-else-if="!briefing" class="banner">
        {{ totalTickers === 0 ? '종목을 추가하면 시장 브리핑을 생성할 수 있습니다.' : '아직 생성된 브리핑이 없습니다.' }}
      </p>
      <article v-else class="report">
        <div class="report__date">{{ briefing.targetDate }} · {{ briefing.model }}</div>
        <p class="report__summary">{{ briefing.summary }}</p>
        <p v-if="briefing.dailyObjective" class="report__outlook">📈 {{ briefing.dailyObjective }}</p>
        <div v-if="briefing.actionItems?.length" class="report__block">
          <h3>관심종목 시그널</h3>
          <ul><li v-for="(s, i) in briefing.actionItems" :key="i">{{ s }}</li></ul>
        </div>
        <div v-if="briefing.riskChecks?.length" class="report__block">
          <h3>리스크 체크</h3>
          <ul><li v-for="(s, i) in briefing.riskChecks" :key="i">{{ s }}</li></ul>
        </div>
        <div v-if="briefing.allocationNotes?.length" class="report__block">
          <h3>테마/섹터 노트</h3>
          <ul><li v-for="(s, i) in briefing.allocationNotes" :key="i">{{ s }}</li></ul>
        </div>
      </article>
    </section>
  </div>
</template>

<style scoped>
.tracker {
  height: 100%;
  overflow-y: auto;
  padding: var(--space-lg, 24px);
  background: var(--color-bg, #f4f5f7);
  color: var(--color-ink, #1a1c1e);
  display: flex;
  flex-direction: column;
  gap: var(--space-base, 16px);
}
.topbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-base, 16px);
  padding: var(--space-base, 16px);
  background: var(--color-canvas, #fff);
  border-radius: var(--rounded-xl, 16px);
  box-shadow: var(--shadow-soft, 0 6px 20px rgba(0, 0, 0, 0.06));
}
.brand h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
.brand__sub { color: var(--color-body, #5b6066); font-size: 13px; }
.clock { display: flex; flex-direction: column; gap: 4px; font-variant-numeric: tabular-nums; }
.clock__row { display: flex; align-items: center; gap: 8px; }
.clock__label { font-size: 12px; color: var(--color-body, #5b6066); width: 28px; }
.clock__time { font-size: 15px; font-weight: 600; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #e7e9ee; color: #4b5059; }
.badge--open, .badge--active, .badge--regular { background: #d8f3e0; color: #1c7a43; }
.topbar__meta { display: flex; align-items: center; gap: 12px; }
.fx { font-size: 13px; color: var(--color-body, #5b6066); }
.count { font-size: 13px; color: var(--color-body, #5b6066); }
.addgroup { display: flex; gap: 8px; }
.input {
  flex: 1;
  height: 42px;
  padding: 0 14px;
  border: 1px solid var(--color-border, #d9dce1);
  border-radius: var(--rounded-lg, 12px);
  font-size: 15px;
  background: var(--color-canvas, #fff);
  color: var(--color-ink, #1a1c1e);
}
.input--sm { height: 36px; font-size: 13px; }
.select {
  height: 36px;
  border: 1px solid var(--color-border, #d9dce1);
  border-radius: var(--rounded-lg, 12px);
  padding: 0 8px;
  background: var(--color-canvas, #fff);
  font-size: 13px;
}
.btn {
  height: 42px;
  padding: 0 18px;
  border: 1px solid var(--color-border, #d9dce1);
  border-radius: var(--rounded-pill, 999px);
  background: var(--color-canvas, #fff);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.btn--sm { height: 36px; padding: 0 12px; font-size: 13px; }
.btn--primary { background: var(--color-primary, #2f6bff); color: var(--color-on-primary, #fff); border-color: transparent; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.banner {
  padding: 14px;
  border-radius: var(--rounded-lg, 12px);
  background: var(--color-canvas, #fff);
  color: var(--color-body, #5b6066);
  text-align: center;
}
.banner--error { background: #fdecec; color: #b02a2a; }
.board {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--space-base, 16px);
  align-items: start;
}
.group {
  background: var(--color-canvas, #fff);
  border-radius: var(--rounded-xl, 16px);
  box-shadow: var(--shadow-soft, 0 6px 20px rgba(0, 0, 0, 0.06));
  padding: var(--space-base, 16px);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.group__head { display: flex; align-items: center; justify-content: space-between; }
.group__title { display: flex; align-items: center; gap: 8px; }
.group__name { font-size: 16px; font-weight: 700; }
.group__count { font-size: 12px; color: var(--color-body, #5b6066); background: #eef0f4; padding: 1px 8px; border-radius: 999px; }
.group__actions { display: flex; gap: 4px; }
.iconbtn { width: 28px; height: 28px; border: none; background: transparent; border-radius: 8px; cursor: pointer; font-size: 16px; color: var(--color-body, #5b6066); }
.iconbtn:hover { background: #eef0f4; }
.iconbtn--danger:hover { background: #fdecec; color: #b02a2a; }
.tickers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.ticker { display: flex; align-items: center; gap: 10px; padding: 8px 6px; border-radius: 10px; }
.ticker:hover { background: #f7f8fa; }
.ticker--empty { color: var(--color-body, #9aa0a8); justify-content: center; font-size: 13px; padding: 12px; }
.ticker__id { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ticker__name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ticker__meta { font-size: 11px; color: var(--color-body, #7a808a); }
.ticker__quote { text-align: right; display: flex; flex-direction: column; align-items: flex-end; }
.ticker__price { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
.ticker__chg { font-size: 12px; font-weight: 700; padding: 0 6px; border-radius: 6px; font-variant-numeric: tabular-nums; }
.ticker__rm { flex: none; }
.addticker { display: flex; gap: 6px; margin-top: 4px; }
.addticker .input { flex: 1; }
.briefing {
  background: var(--color-canvas, #fff);
  border-radius: var(--rounded-xl, 16px);
  box-shadow: var(--shadow-soft, 0 6px 20px rgba(0, 0, 0, 0.06));
  padding: var(--space-lg, 24px);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.briefing__head { display: flex; align-items: center; justify-content: space-between; }
.briefing__head h2 { margin: 0; font-size: 18px; font-weight: 700; }
.report { display: flex; flex-direction: column; gap: 10px; }
.report__date { font-size: 12px; color: var(--color-body, #7a808a); }
.report__summary { margin: 0; font-size: 15px; line-height: 1.65; white-space: pre-wrap; }
.report__outlook { margin: 0; font-size: 14px; color: var(--color-body, #4b5059); }
.report__block h3 { margin: 8px 0 4px; font-size: 13px; font-weight: 700; color: var(--color-body, #4b5059); }
.report__block ul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 3px; }
.report__block li { font-size: 14px; line-height: 1.55; }
@media (max-width: 640px) {
  .tracker { padding: 12px; }
  .topbar { gap: 10px; }
}
</style>

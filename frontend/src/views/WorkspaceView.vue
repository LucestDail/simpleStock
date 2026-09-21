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
        <button class="btn btn--ghost" :disabled="refreshing" @click="onRefreshMarket">
          <span class="btn__spin" :class="{ 'btn__spin--on': refreshing }" aria-hidden="true"></span>
          {{ refreshing ? '갱신 중' : '시세 갱신' }}
        </button>
      </div>
    </header>

    <p v-if="error" class="banner banner--error">{{ error }}</p>

    <!-- ── 본문: 넓으면 보드 + 브리핑 나란히 ──────────── -->
    <div class="layout">
      <div class="layout__main">
        <div class="addgroup">
          <input
            v-model="newGroupName"
            class="input"
            type="text"
            placeholder="새 테마 그룹 이름 (예: 반도체, 미국 ETF, 배당주)"
            @keyup.enter="onAddGroup"
          />
          <button class="btn btn--primary" :disabled="busy || !newGroupName.trim()" @click="onAddGroup">
            그룹 추가
          </button>
        </div>

        <p v-if="loading && groups.length === 0" class="banner">불러오는 중…</p>
        <p v-else-if="groups.length === 0" class="banner banner--empty">
          아직 그룹이 없습니다. 위에서 테마 그룹을 만들고 종목을 추가하세요.
        </p>

        <main v-else class="board">
          <section v-for="group in groups" :key="group.id" class="group">
            <header class="group__head">
              <div class="group__title">
                <span class="group__name">{{ group.name }}</span>
                <span class="group__count mono-num">{{ group.tickers.length }}</span>
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
                  <span class="ticker__price mono-num">{{ formatPrice(t) }}</span>
                  <span
                    v-if="t.quote && t.quote.changePct != null"
                    class="ticker__chg mono-num"
                    :style="heatmapStyleFromChangePct(t.quote.changePct)"
                  >{{ formatChangePct(t.quote.changePct) }}</span>
                </div>
                <button
                  class="iconbtn iconbtn--danger ticker__rm"
                  title="삭제"
                  @click="onRemoveTicker(group, t)"
                >×</button>
              </li>
              <li v-if="group.tickers.length === 0" class="ticker--empty">종목을 추가하세요</li>
            </ul>

            <div class="addticker">
              <input
                v-model="ensureInput(group.id).query"
                class="input input--sm addticker__query"
                type="text"
                placeholder="티커 또는 종목명"
                @keyup.enter="onAddTicker(group)"
              />
              <select v-model="ensureInput(group.id).market" class="select">
                <option value="">자동</option>
                <option value="KR">KR</option>
                <option value="US">US</option>
                <option value="ETF">ETF</option>
              </select>
              <button class="btn btn--sm btn--soft" :disabled="busy" @click="onAddTicker(group)">추가</button>
            </div>
          </section>
        </main>
      </div>

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
              <span class="report__model">{{ briefing.model }}</span>
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
.tracker {
  height: 100%;
  overflow-y: auto;
  padding: var(--space-lg) var(--space-lg) var(--space-xxl);
  background: var(--color-canvas);
  color: var(--color-ink);
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

/* ── 상단 ─────────────────────────────────────────── */
.topbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  padding: var(--space-base) var(--space-md);
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
}
.brand {
  display: flex;
  align-items: center;
  gap: var(--space-base);
  min-width: 0;
}
/* 브랜드 마크 — 이 앱의 유일한 그라디언트다(인디고→바이올렛: 시세와 AI 를 한 몸으로) */
.brand__mark {
  width: 32px;
  height: 32px;
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
  font-size: var(--text-lg);
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--color-ink);
  white-space: nowrap;
}
.brand__sub {
  font-size: var(--text-sm);
  color: var(--color-muted);
}

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
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-md);
  align-items: start;
}
@media (min-width: 1180px) {
  /* 넓으면 보드와 브리핑을 나란히 — 종전에는 오른쪽이 통째로 비었다 */
  .layout {
    grid-template-columns: minmax(0, 1fr) minmax(360px, 440px);
  }
  .layout__rail {
    position: sticky;
    top: 0;
  }
}
.layout__main {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  min-width: 0;
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
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  height: 40px;
  padding: 0 var(--space-md);
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
  max-height: calc(100vh - 2 * var(--space-lg));
  overflow-y: auto;
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

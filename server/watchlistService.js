// v3 종합 주식·ETF 트래커 — 관심종목(watchlist) 테마 그룹 관리.
// 개인 자산(보유수량·평단가·금액) 개념 없음. 티커를 테마별 그룹으로 묶어 시세만 추적한다.
// 시세 자체는 marketDataService 가 소유(폴링). 여기선 그룹·티커 CRUD + 최신 시세 조인만.

const crypto = require('crypto');
const { loadStore, mutateStore } = require('./dataStore');
const { getMarketSnapshot, scheduleMarketRefresh } = require('./marketDataService');
const { resolveTickerByName } = require('./tickerLookupService');
const { broadcast } = require('./realtimeService');
const { logInfo, logWarn } = require('./logger');

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function inferMarket({ symbol, market, currency }) {
  const rawMarket = String(market || '').trim().toUpperCase();
  if (rawMarket === 'US' || rawMarket === 'KR' || rawMarket === 'ETF') return rawMarket;
  const cur = String(currency || '').trim().toUpperCase();
  if (cur === 'USD') return 'US';
  if (cur === 'KRW') return 'KR';
  // 6자리 숫자(또는 5~6자 영숫자 KRX 코드)면 KR, 아니면 US로 추정.
  if (/^\d{5,6}$/.test(symbol)) return 'KR';
  return 'US';
}

// 최신 시세를 티커에 조인. quotes 키는 "MARKET:SYMBOL" 이지만 ETF↔KR 편차가 있어
// 심볼 기준(관용 매칭)으로도 찾는다.
function buildQuoteIndex() {
  const market = getMarketSnapshot();
  const quotes = market && market.quotes ? market.quotes : {};
  const bySymbol = new Map();
  for (const [key, quote] of Object.entries(quotes)) {
    if (!quote) continue;
    const sym = normalizeSymbol(quote.symbol || key.split(':').pop());
    if (sym && !bySymbol.has(sym)) bySymbol.set(sym, quote);
  }
  return bySymbol;
}

function joinQuote(ticker, quoteIndex) {
  const quote = quoteIndex.get(normalizeSymbol(ticker.symbol)) || null;
  return {
    ...ticker,
    quote: quote
      ? {
          price: quote.price ?? null,
          previousClose: quote.previousClose ?? null,
          change: quote.change ?? null,
          changePct: quote.changePct ?? null,
          currency: quote.currency || ticker.currency || null,
          marketState: quote.marketState || '',
          updatedAt: quote.updatedAt || null,
          source: quote.source || '',
          shortName: quote.shortName || '',
        }
      : null,
  };
}

function getWatchlistState(store = loadStore()) {
  const quoteIndex = buildQuoteIndex();
  const groups = (store.watchlist && Array.isArray(store.watchlist.groups) ? store.watchlist.groups : [])
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((group) => ({
      id: group.id,
      name: group.name,
      order: group.order,
      tickers: (group.tickers || []).map((ticker) => joinQuote(ticker, quoteIndex)),
    }));
  const market = getMarketSnapshot();
  return {
    groups,
    fx: market?.fx || null,
    sessions: market?.sessions || null,
    updatedAt: new Date().toISOString(),
  };
}

function broadcastWatchlist() {
  broadcast('watchlist.updated', { watchlist: getWatchlistState() });
}

async function createGroup(name) {
  const clean = String(name || '').trim().slice(0, 80) || '새 그룹';
  const id = crypto.randomUUID();
  await mutateStore((store) => {
    if (!store.watchlist || !Array.isArray(store.watchlist.groups)) store.watchlist = { groups: [] };
    store.watchlist.groups.push({
      id,
      name: clean,
      order: store.watchlist.groups.length,
      tickers: [],
    });
  });
  logInfo('watchlist.group.created', { id, name: clean });
  broadcastWatchlist();
  return getWatchlistState();
}

async function renameGroup(groupId, name) {
  const clean = String(name || '').trim().slice(0, 80);
  if (!clean) throw new Error('그룹 이름이 필요합니다.');
  let found = false;
  await mutateStore((store) => {
    const group = (store.watchlist?.groups || []).find((g) => g.id === groupId);
    if (group) {
      group.name = clean;
      found = true;
    }
  });
  if (!found) throw new Error('그룹을 찾을 수 없습니다.');
  broadcastWatchlist();
  return getWatchlistState();
}

async function deleteGroup(groupId) {
  let removed = false;
  await mutateStore((store) => {
    const before = (store.watchlist?.groups || []).length;
    store.watchlist.groups = (store.watchlist?.groups || []).filter((g) => g.id !== groupId);
    store.watchlist.groups.forEach((g, idx) => {
      g.order = idx;
    });
    removed = before !== store.watchlist.groups.length;
  });
  if (!removed) throw new Error('그룹을 찾을 수 없습니다.');
  logInfo('watchlist.group.deleted', { id: groupId });
  broadcastWatchlist();
  scheduleMarketRefresh('watchlist:group_deleted', { force: true, delayMs: 300 });
  return getWatchlistState();
}

async function reorderGroups(orderedIds) {
  const ids = Array.isArray(orderedIds) ? orderedIds.map(String) : [];
  await mutateStore((store) => {
    const groups = store.watchlist?.groups || [];
    const rank = new Map(ids.map((id, idx) => [id, idx]));
    groups.sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
      return ra - rb;
    });
    groups.forEach((g, idx) => {
      g.order = idx;
    });
  });
  broadcastWatchlist();
  return getWatchlistState();
}

// 종목 추가: symbol 직접 입력 또는 종목명(query) → resolveTickerByName 으로 해석.
async function addTicker(groupId, input = {}) {
  const rawSymbol = normalizeSymbol(input.symbol);
  const query = String(input.query || input.name || '').trim();

  let resolved = null;
  if (rawSymbol) {
    resolved = {
      symbol: rawSymbol,
      name: String(input.name || '').trim() || rawSymbol,
      market: inferMarket({ symbol: rawSymbol, market: input.market, currency: input.currency }),
      currency: String(input.currency || '').trim().toUpperCase(),
    };
  } else if (query) {
    const candidate = await resolveTickerByName(query);
    if (!candidate || !candidate.ticker) {
      logWarn('watchlist.ticker.unresolved', { query });
      throw new Error(`"${query}" 종목을 찾을 수 없습니다. 티커를 직접 입력해 보세요.`);
    }
    resolved = {
      symbol: normalizeSymbol(candidate.ticker),
      name: String(candidate.shortName || candidate.name || query).slice(0, 120),
      market: inferMarket({ symbol: normalizeSymbol(candidate.ticker), market: candidate.market, currency: candidate.currency }),
      currency: String(candidate.currency || '').trim().toUpperCase(),
    };
  } else {
    // 🔴 문구가 원인을 가리면 안 된다. 사용자는 종목명을 **분명히 입력**했는데
    //    본문이 서버에 안 닿으면(Content-Type 누락 등) 이 자리로 떨어진다.
    //    ⇒ 본문 자체가 비었으면 그렇게 말한다.
    const gotAnyField = Object.keys(input || {}).length > 0;
    throw new Error(
      gotAnyField
        ? 'symbol 또는 종목명(query)이 필요합니다.'
        : '요청 본문이 비어 있습니다. (Content-Type: application/json 인지 확인하세요)'
    );
  }

  if (!resolved.currency) resolved.currency = resolved.market === 'US' ? 'USD' : 'KRW';

  let added = false;
  let groupFound = false;
  await mutateStore((store) => {
    const group = (store.watchlist?.groups || []).find((g) => g.id === groupId);
    if (!group) return;
    groupFound = true;
    if (!Array.isArray(group.tickers)) group.tickers = [];
    const exists = group.tickers.some(
      (t) => normalizeSymbol(t.symbol) === resolved.symbol && String(t.market).toUpperCase() === resolved.market
    );
    if (!exists) {
      group.tickers.push({
        symbol: resolved.symbol,
        name: resolved.name,
        market: resolved.market,
        currency: resolved.currency,
        addedAt: new Date().toISOString(),
      });
      added = true;
    }
  });

  if (!groupFound) throw new Error('그룹을 찾을 수 없습니다.');
  logInfo('watchlist.ticker.added', { groupId, symbol: resolved.symbol, market: resolved.market, added });
  broadcastWatchlist();
  // 새 티커 시세를 즉시 반영하도록 폴링 강제 갱신 예약.
  scheduleMarketRefresh('watchlist:ticker_added', { force: true, delayMs: 300 });
  return { added, ticker: resolved, watchlist: getWatchlistState() };
}

/**
 * 🔴 **감시 표시** (2026-09-22 사용자 지적: *"지금 넣은 관심종목들 다 디폴트로 넣은 애들이잖아."*)
 *
 * 관심종목 41개는 **내가 테마 프리셋으로 넣은 것**이지 사용자가 고른 게 아니다.
 * 그걸 그대로 분석 감시 대상으로 쓰면 **내 기본값이 분석 빈도와 비용을 정한다.**
 *
 * ⇒ 종목마다 **감시 표시**를 둔다. **기본은 꺼짐**이고, 켠 것만 모멘텀 감시를 받는다.
 * ⚠️ 보유·최근매도·목표손절은 표시가 필요 없다 — 그건 **사용자 행동 자체가 신호**다.
 *    표시가 필요한 건 *"아직 안 샀지만 지켜보겠다"* 하나뿐이다.
 * ⚠️ 기본을 켜짐으로 두면 프리셋 41개가 전부 켜져 **같은 문제가 반복된다.**
 */
async function setWatch(groupId, symbol, on) {
  const target = normalizeSymbol(symbol);
  let found = false;
  await mutateStore((store) => {
    const group = (store.watchlist?.groups || []).find((g) => g.id === groupId);
    if (!group) return;
    const t = (group.tickers || []).find((x) => normalizeSymbol(x.symbol) === target);
    if (!t) return;
    t.watch = Boolean(on);
    found = true;
  });
  if (!found) throw new Error('해당 종목을 찾을 수 없습니다.');
  /**
   * 🔴 **쓰고 나서 되읽어 확인한다** (2026-09-22 pm2 제안)
   *
   * 저장 정규화가 `watch` 를 버리고 있었는데 **200 과 로그 `on:true` 는 그대로 나갔다** —
   * 사용자가 배지를 눌러도 아무 일이 안 일어나는데 **밖에서는 정상으로 보였다.**
   * ⇒ 실제로 남았는지 보고 **안 맞으면 던진다.** 그래야 200 이 거짓말을 안 한다.
   * ⚠️ 로그도 **되읽은 값**으로 찍는다 — 의도를 찍으면 로그가 거짓말한다.
   */
  const after = (loadStore().watchlist?.groups || [])
    .find((g) => g.id === groupId)?.tickers
    ?.find((x) => normalizeSymbol(x.symbol) === target);
  if (Boolean(after?.watch) !== Boolean(on)) {
    throw new Error('감시 설정이 저장되지 않았습니다(저장 계약을 확인하세요).');
  }
  logInfo('watchlist.ticker.watch', { groupId, symbol: target, on: Boolean(after?.watch) });
  broadcastWatchlist();
  return getWatchlistState();
}

/**
 * 감시 표시된 심볼 — 분석 트리거가 이것만 본다.
 * ⚠️ 그룹이 달라도 같은 종목이면 **한 번만** 센다(반도체·AI 에 NVDA 가 겹친다).
 */
function getWatchedSymbols(state = getWatchlistState()) {
  const out = new Set();
  for (const g of state.groups || []) {
    for (const t of g.tickers || []) if (t.watch) out.add(normalizeSymbol(t.symbol));
  }
  return [...out];
}

async function removeTicker(groupId, symbol) {
  const target = normalizeSymbol(symbol);
  let removed = false;
  await mutateStore((store) => {
    const group = (store.watchlist?.groups || []).find((g) => g.id === groupId);
    if (!group) return;
    const before = (group.tickers || []).length;
    group.tickers = (group.tickers || []).filter((t) => normalizeSymbol(t.symbol) !== target);
    removed = before !== group.tickers.length;
  });
  if (!removed) throw new Error('해당 종목을 찾을 수 없습니다.');
  logInfo('watchlist.ticker.removed', { groupId, symbol: target });
  broadcastWatchlist();
  return getWatchlistState();
}

module.exports = {
  getWatchlistState,
  createGroup,
  renameGroup,
  deleteGroup,
  reorderGroups,
  addTicker,
  removeTicker,
  setWatch,
  getWatchedSymbols,
  inferMarket,
};

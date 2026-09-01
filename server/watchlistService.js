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
    throw new Error('symbol 또는 종목명(query)이 필요합니다.');
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
  inferMarket,
};

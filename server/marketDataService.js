const { APP_TIMEZONE } = require('./time');
const { loadStore, mutateStore } = require('./dataStore');
const { buildPortfolioPayload } = require('./payloadService');
const { broadcast } = require('./realtimeService');
const { logInfo, logWarn, logError } = require('./logger');
const { USD_KRW_FALLBACK_RATE } = require('./structuredImportService');

const MARKET_EVENT_TYPES = Object.freeze({
  QUOTE_UPDATED: 'market.quote.updated',
  SESSION_UPDATED: 'market.session.updated',
  FX_RATE_UPDATED: 'fx.rate.updated',
});

const HOLDING_MARKET_FIELDS = Object.freeze([
  'ticker',
  'market',
  'currency',
  'lastQuote',
  'previousClose',
  'priceChange',
  'priceChangePct',
  'marketState',
  'lastQuoteAt',
  'quoteSource',
]);

const YAHOO_PROVIDER = 'yahoo-finance';
const FINNHUB_PROVIDER = 'finnhub';
const PUBLIC_DATA_PROVIDER = 'public-data-portal';
const FINNHUB_API_KEY = String(process.env.FINNHUB_API_KEY || '').trim();
const PUBLIC_DATA_API_KEY = String(process.env.PUBLIC_DATA_API_KEY || '').trim();
const DEFAULT_PROVIDER = String(process.env.MARKET_DATA_PROVIDER || '').trim() || (FINNHUB_API_KEY ? FINNHUB_PROVIDER : YAHOO_PROVIDER);
const US_PROVIDER = String(process.env.MARKET_US_PROVIDER || '').trim() || DEFAULT_PROVIDER;
const KR_PROVIDER = String(process.env.MARKET_KR_PROVIDER || '').trim() || PUBLIC_DATA_PROVIDER;
const FX_PROVIDER = String(process.env.MARKET_FX_PROVIDER || '').trim() || (DEFAULT_PROVIDER === FINNHUB_PROVIDER ? YAHOO_PROVIDER : DEFAULT_PROVIDER);
const PUBLIC_DATA_BASE_URL =
  String(process.env.PUBLIC_DATA_BASE_URL || '').trim() ||
  'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService';
const FX_SYMBOL = 'USDKRW=X';
const FINNHUB_FX_SYMBOLS = ['OANDA:USD_KRW', 'OANDA:USDKRW', 'USDKRW'];
const MARKET_DATA_ENABLED = process.env.MARKET_DATA_ENABLED !== 'false';
const MARKET_REFRESH_INTERVAL_MS = Math.max(
  15_000,
  Number(process.env.MARKET_REFRESH_INTERVAL_MS) || 60_000
);
const MARKET_QUOTE_TTL_MS = Math.max(10_000, Number(process.env.MARKET_QUOTE_TTL_MS) || 60_000);
const MARKET_KR_QUOTE_TTL_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.MARKET_KR_QUOTE_TTL_MS) || 6 * 60 * 60 * 1000
);
const quoteCache = new Map();
const inflightRequests = new Map();

let refreshTimer = null;
let delayedRefreshTimer = null;
let refreshPromise = null;

function getMarketProviderConfig() {
  return {
    timezone: APP_TIMEZONE,
    provider: DEFAULT_PROVIDER,
    enabled: MARKET_DATA_ENABLED,
    providers: {
      kr: KR_PROVIDER,
      us: US_PROVIDER,
      fx: FX_PROVIDER,
    },
    refreshIntervalsMs: {
      session: MARKET_REFRESH_INTERVAL_MS,
      quote: MARKET_REFRESH_INTERVAL_MS,
      fx: MARKET_REFRESH_INTERVAL_MS,
    },
    quoteTtlMs: MARKET_QUOTE_TTL_MS,
    krQuoteTtlMs: MARKET_KR_QUOTE_TTL_MS,
  };
}

function roundNumber(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function getTimezoneHour(now = new Date(), timeZone = APP_TIMEZONE) {
  const hourPart = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  })
    .formatToParts(now)
    .find((part) => part.type === 'hour');
  return Number(hourPart?.value || 0);
}

function getSessionState(hour, windowStartHour, windowEndHour) {
  if (windowStartHour < windowEndHour) {
    if (hour < windowStartHour) return 'pre';
    if (hour >= windowEndHour) return 'closed';
    return 'open';
  }

  if (hour >= windowStartHour || hour < windowEndHour) {
    return 'open';
  }

  return hour < windowStartHour ? 'pre' : 'closed';
}

function getMarketSessionSnapshot(now = new Date()) {
  const hour = getTimezoneHour(now, APP_TIMEZONE);

  return {
    timezone: APP_TIMEZONE,
    asOf: now.toISOString(),
    sessions: {
      kr: {
        market: 'KRX',
        state: getSessionState(hour, 9, 16),
      },
      us: {
        market: 'US',
        state: getSessionState(hour, 22, 5),
      },
    },
  };
}

function buildMarketExtensionHooks() {
  return {
    eventTypes: MARKET_EVENT_TYPES,
    holdingFields: HOLDING_MARKET_FIELDS,
    config: getMarketProviderConfig(),
  };
}

function normalizeTickerSymbol(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function isUsdHolding(holding) {
  return String(holding?.details?.currency || '').toUpperCase() === 'USD';
}

function isTrackedUsStock(holding) {
  if (!holding?.details?.ticker) return false;
  const market = String(holding.details.market || '').toUpperCase();
  const currency = String(holding.details.currency || '').toUpperCase();
  return market === 'US' || currency === 'USD';
}

function isTrackedKrStock(holding) {
  if (!holding?.details?.ticker) return false;
  const market = String(holding.details.market || '').toUpperCase();
  const currency = String(holding.details.currency || '').toUpperCase();
  return market === 'KR' || (currency === 'KRW' && /^\d{6,9}[A-Z]?$/.test(String(holding.details.ticker || '')));
}

function getTrackedQuoteKey({ market, symbol }) {
  return `${String(market || '').toUpperCase()}:${normalizeTickerSymbol(symbol)}`;
}

function listTrackedTickerConfigs(store = loadStore()) {
  const tracked = new Map();

  for (const holding of store.portfolio.holdings || []) {
    const isUs = isTrackedUsStock(holding);
    const isKr = isTrackedKrStock(holding);
    if (!isUs && !isKr) continue;
    const symbol = normalizeTickerSymbol(holding.details.ticker);
    if (!symbol) continue;
    const market = isUs ? 'US' : 'KR';
    const trackedKey = getTrackedQuoteKey({ market, symbol });

    const existing = tracked.get(trackedKey) || {
      symbol,
      name: holding.name,
      market,
      currency: isUs ? 'USD' : 'KRW',
      holdingIds: [],
    };

    existing.holdingIds.push(String(holding.id));
    tracked.set(trackedKey, existing);
  }

  return [...tracked.values()].sort((a, b) =>
    `${a.market}:${a.symbol}`.localeCompare(`${b.market}:${b.symbol}`)
  );
}

function getCacheKey(kind, symbol) {
  return `${kind}:${symbol}`;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`market upstream ${response.status}`);
  }

  return response.json();
}

function getMarketStateFromTimestamp(timestampSeconds) {
  if (!Number.isFinite(Number(timestampSeconds)) || Number(timestampSeconds) <= 0) {
    return '';
  }

  const ageMs = Math.abs(Date.now() - Number(timestampSeconds) * 1000);
  if (ageMs <= 15 * 60 * 1000) {
    return 'active';
  }
  return 'closed';
}

async function fetchYahooChartQuote(symbol) {
  const data = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`
  );
  const meta = data?.chart?.result?.[0]?.meta;

  if (!meta || !Number.isFinite(Number(meta.regularMarketPrice))) {
    throw new Error(`${symbol} 시세를 확인하지 못했습니다.`);
  }

  const price = roundNumber(meta.regularMarketPrice);
  const previousClose = Number.isFinite(Number(meta.previousClose))
    ? roundNumber(meta.previousClose)
    : null;
  const change = previousClose == null ? null : roundNumber(price - previousClose);
  const changePct = previousClose ? roundNumber(((price - previousClose) / previousClose) * 100) : null;

  return {
    symbol: normalizeTickerSymbol(meta.symbol || symbol),
    shortName: String(meta.shortName || meta.longName || symbol),
    market: symbol === FX_SYMBOL ? 'FX' : 'US',
    currency: String(meta.currency || (symbol === FX_SYMBOL ? 'KRW' : 'USD')),
    price,
    previousClose,
    change,
    changePct,
    marketState: String(meta.marketState || ''),
    updatedAt: meta.regularMarketTime
      ? new Date(Number(meta.regularMarketTime) * 1000).toISOString()
      : new Date().toISOString(),
    source: YAHOO_PROVIDER,
  };
}

async function fetchFinnhubQuote(symbol) {
  if (!FINNHUB_API_KEY) {
    throw new Error('FINNHUB_API_KEY가 설정되지 않았습니다.');
  }

  const data = await fetchJson(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(FINNHUB_API_KEY)}`
  );

  if (!data || !Number.isFinite(Number(data.c)) || Number(data.c) <= 0) {
    throw new Error(`${symbol} Finnhub 시세를 확인하지 못했습니다.`);
  }

  const price = roundNumber(data.c);
  const previousClose = Number.isFinite(Number(data.pc)) ? roundNumber(data.pc) : null;
  const change = Number.isFinite(Number(data.d))
    ? roundNumber(data.d)
    : previousClose == null
      ? null
      : roundNumber(price - previousClose);
  const changePct = Number.isFinite(Number(data.dp))
    ? roundNumber(data.dp)
    : previousClose
      ? roundNumber(((price - previousClose) / previousClose) * 100)
      : null;

  return {
    symbol: normalizeTickerSymbol(symbol),
    shortName: normalizeTickerSymbol(symbol),
    market: 'US',
    currency: 'USD',
    price,
    previousClose,
    change,
    changePct,
    marketState: getMarketStateFromTimestamp(data.t),
    updatedAt: Number.isFinite(Number(data.t)) && Number(data.t) > 0
      ? new Date(Number(data.t) * 1000).toISOString()
      : new Date().toISOString(),
    source: FINNHUB_PROVIDER,
  };
}

async function getCachedQuote(kind, symbol, fetcher, { force = false, ttlMs = MARKET_QUOTE_TTL_MS } = {}) {
  const cacheKey = getCacheKey(kind, symbol);
  const now = Date.now();
  const cached = quoteCache.get(cacheKey);
  if (!force && cached && now - cached.cachedAt < ttlMs) {
    return cached.value;
  }

  if (inflightRequests.has(cacheKey)) {
    return inflightRequests.get(cacheKey);
  }

  const pending = (async () => {
    const value = await fetcher(symbol);
    quoteCache.set(cacheKey, {
      value,
      cachedAt: Date.now(),
    });
    return value;
  })().finally(() => {
    inflightRequests.delete(cacheKey);
  });

  inflightRequests.set(cacheKey, pending);
  return pending;
}

async function fetchUsQuote(symbol, options = {}) {
  const normalizedSymbol = normalizeTickerSymbol(symbol);
  const provider = US_PROVIDER === FINNHUB_PROVIDER ? FINNHUB_PROVIDER : YAHOO_PROVIDER;
  const fetcher = provider === FINNHUB_PROVIDER ? fetchFinnhubQuote : fetchYahooChartQuote;
  return getCachedQuote('quote', normalizedSymbol, fetcher, options);
}

async function fetchUsdKrwRate(options = {}) {
  let quote = null;
  let lastError = null;

  if (FX_PROVIDER === FINNHUB_PROVIDER && FINNHUB_API_KEY) {
    for (const symbol of FINNHUB_FX_SYMBOLS) {
      try {
        quote = await getCachedQuote('fx', symbol, fetchFinnhubQuote, options);
        break;
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (!quote) {
    if (lastError && FX_PROVIDER === FINNHUB_PROVIDER) {
      logWarn('market.fx.finnhub_unavailable', {
        message: lastError.message,
      });
    }
    quote = await getCachedQuote('fx', FX_SYMBOL, fetchYahooChartQuote, options);
  }

  return {
    pair: 'USDKRW',
    rate: quote.price,
    previousClose: quote.previousClose,
    change: quote.change,
    changePct: quote.changePct,
    updatedAt: quote.updatedAt,
    source: quote.source,
  };
}

function formatBasDtToIso(basDt) {
  const value = String(basDt || '');
  if (!/^\d{8}$/.test(value)) return new Date().toISOString();
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T13:00:00+09:00`;
}

function listRecentBasDates(limit = 7) {
  const dates = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);

  while (dates.length < limit) {
    const weekday = cursor.getDay();
    if (weekday !== 0 && weekday !== 6) {
      const y = cursor.getFullYear();
      const m = String(cursor.getMonth() + 1).padStart(2, '0');
      const d = String(cursor.getDate()).padStart(2, '0');
      dates.push(`${y}${m}${d}`);
    }
    cursor.setDate(cursor.getDate() - 1);
  }

  return dates;
}

function normalizeItems(items) {
  if (Array.isArray(items)) return items;
  if (items && typeof items === 'object') return [items];
  return [];
}

function parsePublicDataBody(data) {
  const response = data?.response || {};
  const header = response.header || {};
  const body = response.body || {};
  const items = normalizeItems(body?.items?.item);
  return {
    resultCode: String(header.resultCode || ''),
    resultMsg: String(header.resultMsg || ''),
    items,
  };
}

async function fetchPublicDataJson(params) {
  if (!PUBLIC_DATA_API_KEY) {
    throw new Error('PUBLIC_DATA_API_KEY가 설정되지 않았습니다.');
  }

  const search = new URLSearchParams({
    serviceKey: PUBLIC_DATA_API_KEY,
    numOfRows: '10',
    pageNo: '1',
    resultType: 'json',
    ...params,
  });
  const url = `${PUBLIC_DATA_BASE_URL}/getStockPriceInfo?${search.toString()}`;
  const data = await fetchJson(url);
  const parsed = parsePublicDataBody(data);

  if (parsed.resultCode && parsed.resultCode !== '00') {
    throw new Error(`공공데이터포털 오류: ${parsed.resultCode} ${parsed.resultMsg}`.trim());
  }

  return parsed.items;
}

async function fetchKrPublicStockQuote(symbol, options = {}) {
  const normalizedSymbol = normalizeTickerSymbol(symbol);
  return getCachedQuote(
    'quote',
    getTrackedQuoteKey({ market: 'KR', symbol: normalizedSymbol }),
    async () => {
      let matched = null;
      for (const basDt of listRecentBasDates(7)) {
        const items = await fetchPublicDataJson({
          basDt,
          likeSrtnCd: normalizedSymbol,
        });
        matched =
          items.find((item) => String(item?.srtnCd || '') === normalizedSymbol) ||
          items[0] ||
          null;
        if (matched) break;
      }

      if (!matched || !Number.isFinite(Number(matched.clpr))) {
        throw new Error(`${normalizedSymbol} 공공데이터 시세를 찾지 못했습니다.`);
      }

      const price = Math.round(Number(matched.clpr));
      const change = Number.isFinite(Number(matched.vs)) ? Math.round(Number(matched.vs)) : null;
      const changePct = Number.isFinite(Number(matched.fltRt)) ? roundNumber(matched.fltRt) : null;
      const previousClose = change == null ? null : price - change;

      return {
        symbol: normalizeTickerSymbol(matched.srtnCd || normalizedSymbol),
        shortName: String(matched.itmsNm || normalizedSymbol),
        market: String(matched.mrktCtg || 'KR'),
        currency: 'KRW',
        price,
        previousClose,
        change,
        changePct,
        marketState: 'delayed',
        updatedAt: formatBasDtToIso(matched.basDt),
        source: PUBLIC_DATA_PROVIDER,
      };
    },
    {
      ...options,
      ttlMs: MARKET_KR_QUOTE_TTL_MS,
    }
  );
}

function buildUsdSummary(details, quotePrice, nativeAmount, amountKrw) {
  const fragments = [];
  if (details.ticker) fragments.push(details.ticker);
  if (Number.isFinite(Number(details.quantity))) fragments.push(`${details.quantity}주`);
  if (Number.isFinite(Number(quotePrice))) fragments.push(`$${Number(quotePrice).toFixed(2)}`);
  if (Number.isFinite(Number(nativeAmount))) fragments.push(`$${Number(nativeAmount).toFixed(2)}`);
  if (Number.isFinite(Number(amountKrw))) fragments.push(`₩${Math.round(amountKrw).toLocaleString('ko-KR')}`);
  return fragments.join(' · ');
}

function buildKrwSummary(details, quotePrice, nativeAmount) {
  const fragments = [];
  if (details.ticker) fragments.push(details.ticker);
  if (Number.isFinite(Number(details.quantity))) fragments.push(`${details.quantity}주`);
  if (Number.isFinite(Number(quotePrice))) fragments.push(`${Math.round(quotePrice).toLocaleString('ko-KR')}원`);
  if (Number.isFinite(Number(nativeAmount))) fragments.push(`₩${Math.round(nativeAmount).toLocaleString('ko-KR')}`);
  return fragments.join(' · ');
}

async function refreshMarketData({ reason = 'interval', force = false } = {}) {
  if (!MARKET_DATA_ENABLED) {
    return buildPortfolioPayload();
  }

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const initialStore = loadStore();
    const trackedTickers = listTrackedTickerConfigs(initialStore);
    const sessions = getMarketSessionSnapshot();
    const usdHoldings = (initialStore.portfolio.holdings || []).filter(isUsdHolding);
    const nextQuotes = {};
    const errors = [];
    let nextFx = null;

    if (usdHoldings.length) {
      try {
        nextFx = await fetchUsdKrwRate({ force });
      } catch (error) {
        logWarn('market.fx.refresh_failed', {
          reason,
          message: error.message,
        });
        errors.push(`USD/KRW 환율 갱신 실패: ${error.message}`);
      }
    }

    for (const ticker of trackedTickers) {
      try {
        const quoteKey = getTrackedQuoteKey(ticker);
        nextQuotes[quoteKey] =
          ticker.market === 'KR'
            ? await fetchKrPublicStockQuote(ticker.symbol, { force })
            : await fetchUsQuote(ticker.symbol, { force });
      } catch (error) {
        logWarn('market.quote.refresh_failed', {
          reason,
          market: ticker.market,
          symbol: ticker.symbol,
          message: error.message,
        });
        errors.push(`${ticker.market}:${ticker.symbol} 시세 갱신 실패: ${error.message}`);
      }
    }

    const refreshedAt = new Date().toISOString();
    await mutateStore((store) => {
      const market = store.memory.market || {};
      const existingQuotes = market.quotes && typeof market.quotes === 'object' ? market.quotes : {};
      const usdKrwRate = nextFx?.rate || market.fx?.USDKRW?.rate || USD_KRW_FALLBACK_RATE;

      for (const holding of store.portfolio.holdings) {
        const details = holding.details;
        if (!details) continue;

        const isUs = isTrackedUsStock(holding);
        const isKr = isTrackedKrStock(holding);
        const quoteKey = details.ticker ? getTrackedQuoteKey({ market: isUs ? 'US' : isKr ? 'KR' : details.market, symbol: details.ticker }) : null;
        const quote = quoteKey ? nextQuotes[quoteKey] || existingQuotes[quoteKey] : null;

        if (String(details.currency || '').toUpperCase() === 'USD') {
          details.market = details.market || 'US';
          details.fxRate = roundNumber(usdKrwRate, 2);

          if (quote && Number.isFinite(Number(details.quantity))) {
            const nativeAmount = roundNumber(Number(details.quantity) * Number(quote.price), 2);
            const amountKrw = Math.round(nativeAmount * usdKrwRate);
            details.currentPrice = quote.price;
            details.lastQuote = quote.price;
            details.previousClose = quote.previousClose;
            details.priceChange = quote.change;
            details.priceChangePct = quote.changePct;
            details.marketState = quote.marketState;
            details.lastQuoteAt = quote.updatedAt;
            details.quoteSource = quote.source;
            details.nativeAmount = nativeAmount;
            details.summary = buildUsdSummary(details, quote.price, nativeAmount, amountKrw);
            holding.amount = amountKrw;
            continue;
          }

          if (Number.isFinite(Number(details.nativeAmount))) {
            holding.amount = Math.round(Number(details.nativeAmount) * usdKrwRate);
            details.summary = buildUsdSummary(details, details.lastQuote, details.nativeAmount, holding.amount);
          }
          continue;
        }

        if ((String(details.currency || '').toUpperCase() === 'KRW' || isKr) && quote) {
          details.market = details.market || 'KR';
          details.currentPrice = quote.price;
          details.lastQuote = quote.price;
          details.previousClose = quote.previousClose;
          details.priceChange = quote.change;
          details.priceChangePct = quote.changePct;
          details.marketState = quote.marketState;
          details.lastQuoteAt = quote.updatedAt;
          details.quoteSource = quote.source;

          if (Number.isFinite(Number(details.quantity))) {
            const nativeAmount = Math.round(Number(details.quantity) * Number(quote.price));
            details.nativeAmount = nativeAmount;
            holding.amount = nativeAmount;
            details.summary = buildKrwSummary(details, quote.price, nativeAmount);
          } else if (Number.isFinite(Number(details.nativeAmount))) {
            holding.amount = Math.round(Number(details.nativeAmount));
            details.summary = buildKrwSummary(details, quote.price, details.nativeAmount);
          }
        }
      }

      store.memory.market = {
        provider: DEFAULT_PROVIDER,
        refreshStatus: errors.length && !Object.keys(nextQuotes).length && !nextFx ? 'error' : 'ready',
        lastRefreshAt: refreshedAt,
        lastSuccessAt:
          Object.keys(nextQuotes).length || nextFx ? refreshedAt : market.lastSuccessAt || refreshedAt,
        lastError: errors.join(' | ').slice(0, 300),
        trackedTickers,
        quotes: {
          ...existingQuotes,
          ...nextQuotes,
        },
        fx: {
          USDKRW: nextFx || market.fx?.USDKRW || {
            pair: 'USDKRW',
            rate: USD_KRW_FALLBACK_RATE,
            previousClose: null,
            change: null,
            changePct: null,
            updatedAt: refreshedAt,
            source: 'fallback',
          },
        },
        sessions: sessions.sessions,
      };
    });

    const payload = buildPortfolioPayload();
    const marketPayload = {
      system: {
        market: payload.system.market,
      },
      reason,
      updatedSymbols: Object.keys(nextQuotes),
    };

    broadcast(MARKET_EVENT_TYPES.SESSION_UPDATED, marketPayload);
    if (nextFx) {
      broadcast(MARKET_EVENT_TYPES.FX_RATE_UPDATED, {
        ...marketPayload,
        rate: nextFx,
      });
    }
    if (Object.keys(nextQuotes).length) {
      broadcast(MARKET_EVENT_TYPES.QUOTE_UPDATED, marketPayload);
    }
    if (Object.keys(nextQuotes).length || nextFx) {
      broadcast('portfolio.updated', payload);
    }

    logInfo('market.refresh.finish', {
      reason,
      trackedTickerCount: trackedTickers.length,
      quoteCount: Object.keys(nextQuotes).length,
      refreshedAt,
      hasFx: Boolean(nextFx),
      errorCount: errors.length,
    });

    return payload;
  })().catch((error) => {
    logError('market.refresh.failed', error, {
      reason,
    });
    throw error;
  }).finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

function scheduleMarketRefresh(reason = 'delayed', options = {}) {
  if (!MARKET_DATA_ENABLED) return;
  if (delayedRefreshTimer) {
    clearTimeout(delayedRefreshTimer);
  }

  delayedRefreshTimer = setTimeout(() => {
    delayedRefreshTimer = null;
    refreshMarketData({ reason, force: Boolean(options.force) }).catch((error) => {
      logError('market.refresh.delayed_failed', error, {
        reason,
      });
    });
  }, options.delayMs ?? 500);
}

function startMarketDataPolling() {
  if (!MARKET_DATA_ENABLED) {
    logInfo('market.polling.disabled', {
      reason: 'market_data_disabled',
    });
    return;
  }

  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  scheduleMarketRefresh('startup', { force: true, delayMs: 300 });
  refreshTimer = setInterval(() => {
    refreshMarketData({ reason: 'interval' }).catch((error) => {
      logError('market.polling.failed', error, {
        intervalMs: MARKET_REFRESH_INTERVAL_MS,
      });
    });
  }, MARKET_REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();

  logInfo('market.polling.started', {
    intervalMs: MARKET_REFRESH_INTERVAL_MS,
    quoteTtlMs: MARKET_QUOTE_TTL_MS,
    provider: DEFAULT_PROVIDER,
  });
}

function getMarketSnapshot() {
  return loadStore().memory.market;
}

module.exports = {
  MARKET_EVENT_TYPES,
  HOLDING_MARKET_FIELDS,
  getMarketProviderConfig,
  getMarketSessionSnapshot,
  buildMarketExtensionHooks,
  listTrackedTickerConfigs,
  fetchUsQuote,
  fetchUsdKrwRate,
  refreshMarketData,
  scheduleMarketRefresh,
  startMarketDataPolling,
  getMarketSnapshot,
};

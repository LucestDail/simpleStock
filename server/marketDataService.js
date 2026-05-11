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

const DEFAULT_PROVIDER = 'yahoo-finance';
const FX_SYMBOL = 'USDKRW=X';
const MARKET_DATA_ENABLED = process.env.MARKET_DATA_ENABLED !== 'false';
const MARKET_REFRESH_INTERVAL_MS = Math.max(
  15_000,
  Number(process.env.MARKET_REFRESH_INTERVAL_MS) || 60_000
);
const MARKET_QUOTE_TTL_MS = Math.max(10_000, Number(process.env.MARKET_QUOTE_TTL_MS) || 60_000);
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
      kr: null,
      us: DEFAULT_PROVIDER,
      fx: DEFAULT_PROVIDER,
    },
    refreshIntervalsMs: {
      session: MARKET_REFRESH_INTERVAL_MS,
      quote: MARKET_REFRESH_INTERVAL_MS,
      fx: MARKET_REFRESH_INTERVAL_MS,
    },
    quoteTtlMs: MARKET_QUOTE_TTL_MS,
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

function listTrackedTickerConfigs(store = loadStore()) {
  const tracked = new Map();

  for (const holding of store.portfolio.holdings || []) {
    if (!isTrackedUsStock(holding)) continue;
    const symbol = normalizeTickerSymbol(holding.details.ticker);
    if (!symbol) continue;

    const existing = tracked.get(symbol) || {
      symbol,
      name: holding.name,
      market: 'US',
      currency: 'USD',
      holdingIds: [],
    };

    existing.holdingIds.push(String(holding.id));
    tracked.set(symbol, existing);
  }

  return [...tracked.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
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
    source: DEFAULT_PROVIDER,
  };
}

async function getCachedQuote(kind, symbol, fetcher, { force = false } = {}) {
  const cacheKey = getCacheKey(kind, symbol);
  const now = Date.now();
  const cached = quoteCache.get(cacheKey);
  if (!force && cached && now - cached.cachedAt < MARKET_QUOTE_TTL_MS) {
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
  return getCachedQuote('quote', normalizeTickerSymbol(symbol), fetchYahooChartQuote, options);
}

async function fetchUsdKrwRate(options = {}) {
  const quote = await getCachedQuote('fx', FX_SYMBOL, fetchYahooChartQuote, options);
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

function buildUsdSummary(details, quotePrice, nativeAmount, amountKrw) {
  const fragments = [];
  if (details.ticker) fragments.push(details.ticker);
  if (Number.isFinite(Number(details.quantity))) fragments.push(`${details.quantity}주`);
  if (Number.isFinite(Number(quotePrice))) fragments.push(`$${Number(quotePrice).toFixed(2)}`);
  if (Number.isFinite(Number(nativeAmount))) fragments.push(`$${Number(nativeAmount).toFixed(2)}`);
  if (Number.isFinite(Number(amountKrw))) fragments.push(`₩${Math.round(amountKrw).toLocaleString('ko-KR')}`);
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
        nextQuotes[ticker.symbol] = await fetchUsQuote(ticker.symbol, { force });
      } catch (error) {
        logWarn('market.quote.refresh_failed', {
          reason,
          symbol: ticker.symbol,
          message: error.message,
        });
        errors.push(`${ticker.symbol} 시세 갱신 실패: ${error.message}`);
      }
    }

    const refreshedAt = new Date().toISOString();
    await mutateStore((store) => {
      const market = store.memory.market || {};
      const existingQuotes = market.quotes && typeof market.quotes === 'object' ? market.quotes : {};
      const usdKrwRate = nextFx?.rate || market.fx?.USDKRW?.rate || USD_KRW_FALLBACK_RATE;

      for (const holding of store.portfolio.holdings) {
        const details = holding.details;
        if (!details || String(details.currency || '').toUpperCase() !== 'USD') continue;

        details.market = details.market || 'US';
        details.fxRate = roundNumber(usdKrwRate, 2);

        if (isTrackedUsStock(holding)) {
          const symbol = normalizeTickerSymbol(details.ticker);
          const quote = nextQuotes[symbol] || existingQuotes[symbol];
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
        }

        if (Number.isFinite(Number(details.nativeAmount))) {
          holding.amount = Math.round(Number(details.nativeAmount) * usdKrwRate);
          details.summary = buildUsdSummary(details, details.lastQuote, details.nativeAmount, holding.amount);
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

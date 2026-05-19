const { loadStore, mutateStore } = require('./dataStore');
const { logInfo, logWarn } = require('./logger');

let cachedFetch = null;
async function getFetch() {
  if (cachedFetch) return cachedFetch;
  if (typeof fetch === 'function') {
    cachedFetch = fetch;
    return cachedFetch;
  }
  const mod = await import('node-fetch');
  cachedFetch = mod.default;
  return cachedFetch;
}

const inflight = new Map();

function normalizeName(name) {
  return String(name || '').trim();
}

function buildCacheKey(name) {
  return normalizeName(name).toLowerCase();
}

function getCachedTicker(name) {
  const key = buildCacheKey(name);
  if (!key) return null;
  const store = loadStore();
  const entry = store?.memory?.tickerLookup?.byName?.[key];
  if (!entry || !entry.ticker) return null;
  return entry;
}

async function setCachedTicker(name, payload) {
  const key = buildCacheKey(name);
  if (!key || !payload?.ticker) return;
  await mutateStore((store) => {
    if (!store.memory.tickerLookup) store.memory.tickerLookup = { byName: {} };
    if (!store.memory.tickerLookup.byName) store.memory.tickerLookup.byName = {};
    store.memory.tickerLookup.byName[key] = {
      ticker: String(payload.ticker),
      market: payload.market || null,
      currency: payload.currency || null,
      shortName: payload.shortName || null,
      source: payload.source || null,
      cachedAt: new Date().toISOString(),
    };
  });
}

async function lookupKrTickerByName(name) {
  const text = normalizeName(name);
  if (!text) return null;
  const market = require('./marketDataService');
  const {
    KR_PUBLIC_DATA_PRICE_OPERATIONS,
    fetchPublicDataOperation,
    listRecentBasDates,
  } = market;
  if (!KR_PUBLIC_DATA_PRICE_OPERATIONS || typeof fetchPublicDataOperation !== 'function') {
    return null;
  }

  const tries = [...listRecentBasDates(7), null];
  for (const basDt of tries) {
    for (const { operation } of KR_PUBLIC_DATA_PRICE_OPERATIONS) {
      try {
        const params = { likeItmsNm: text };
        if (basDt) params.basDt = basDt;
        const items = await fetchPublicDataOperation(operation, params);
        const exact = items.find((it) => String(it?.itmsNm || '').trim() === text);
        const matched = exact || items[0];
        if (matched && matched.srtnCd) {
          const ticker = String(matched.srtnCd).replace(/^A/i, '').trim();
          if (ticker) {
            return {
              ticker,
              market: 'KR',
              currency: 'KRW',
              shortName: String(matched.itmsNm || text),
              source: 'public-data-portal',
            };
          }
        }
      } catch (error) {
        logWarn('ticker_lookup.kr.public_data.failed', {
          name: text,
          operation,
          basDt,
          message: error?.message,
        });
      }
    }
  }
  return null;
}

async function lookupTickerViaYahooSearch(name) {
  const text = normalizeName(name);
  if (!text) return null;
  const fetchFn = await getFetch();
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(text)}&quotesCount=10&newsCount=0`;
  let response;
  try {
    response = await fetchFn(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; simpleStock/1.0)',
        Accept: 'application/json',
      },
    });
  } catch (error) {
    logWarn('ticker_lookup.yahoo.network_failed', { name: text, message: error?.message });
    return null;
  }
  if (!response.ok) {
    logWarn('ticker_lookup.yahoo.http_failed', { name: text, status: response.status });
    return null;
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    logWarn('ticker_lookup.yahoo.parse_failed', { name: text, message: error?.message });
    return null;
  }
  const quotes = Array.isArray(body?.quotes) ? body.quotes : [];
  if (!quotes.length) return null;

  const equityQuotes = quotes.filter((q) => String(q?.quoteType || '').toUpperCase() === 'EQUITY' || String(q?.quoteType || '').toUpperCase() === 'ETF');
  const candidates = equityQuotes.length ? equityQuotes : quotes;

  const exchangeMarket = (q) => {
    const exch = String(q?.exchange || '').toUpperCase();
    if (['KSC', 'KOE', 'KOSDAQ', 'KS', 'KQ'].some((m) => exch.includes(m))) return 'KR';
    if (['NMS', 'NYQ', 'NCM', 'NGM', 'PCX', 'ASE', 'BATS', 'OPRA'].some((m) => exch.includes(m))) return 'US';
    return null;
  };

  const krMatch = candidates.find((q) => exchangeMarket(q) === 'KR');
  const usMatch = candidates.find((q) => exchangeMarket(q) === 'US');

  if (krMatch) {
    const symbol = String(krMatch.symbol || '');
    const code = symbol.replace(/\.K[SQ]$/i, '').trim();
    if (code && /^\d{6}$/.test(code)) {
      return {
        ticker: code,
        market: 'KR',
        currency: 'KRW',
        shortName: String(krMatch.shortname || krMatch.longname || text),
        source: 'yahoo-finance-search',
      };
    }
  }

  if (usMatch) {
    const ticker = String(usMatch.symbol || '').toUpperCase().trim();
    if (ticker && /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) {
      return {
        ticker,
        market: 'US',
        currency: 'USD',
        shortName: String(usMatch.shortname || usMatch.longname || text),
        source: 'yahoo-finance-search',
      };
    }
  }

  return null;
}

async function lookupTickerViaGeminiSearch(name) {
  const text = normalizeName(name);
  if (!text) return null;
  let ai;
  try {
    ai = require('./aiService');
  } catch (error) {
    return null;
  }
  if (!ai.isAiConfigured?.()) return null;

  const schema = {
    type: 'object',
    properties: {
      ticker: { type: 'string' },
      market: { type: 'string', enum: ['KR', 'US', ''] },
      currency: { type: 'string', enum: ['KRW', 'USD', ''] },
      shortName: { type: 'string' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low', ''] },
    },
    required: ['ticker', 'market'],
  };

  try {
    const result = await ai.generateStructuredOutput(
      {
        systemPrompt: [
          '너는 종목명-티커 매핑기다.',
          '사용자가 입력한 회사/ETF/ETN 이름에 대해 거래소 단축코드(ticker)와 거래소(KR=KRX/KOSPI/KOSDAQ, US=NASDAQ/NYSE)를 알려줘.',
          '한국 종목은 6자리 숫자 단축코드(예: 005930), 미국 종목은 알파벳 1~5자(예: NVDA)로 답한다.',
          '확신할 수 없으면 ticker를 빈 문자열로 둔다.',
          '반드시 JSON으로만 답한다.',
        ].join('\n'),
        userPrompt: JSON.stringify({ query: text }),
        schema,
        useGoogleSearch: false,
        logLabel: 'ticker_lookup_gemini',
      },
      { ticker: '', market: '', currency: '', shortName: text, confidence: '' }
    );
    const ticker = String(result?.ticker || '').trim();
    const market = String(result?.market || '').trim();
    if (!ticker || !market) return null;
    if (market === 'KR' && !/^\d{6}$/.test(ticker)) return null;
    if (market === 'US' && !/^[A-Z][A-Z0-9.-]{0,9}$/i.test(ticker)) return null;
    return {
      ticker: ticker.toUpperCase(),
      market,
      currency: market === 'KR' ? 'KRW' : 'USD',
      shortName: String(result?.shortName || text),
      source: 'gemini-structured',
    };
  } catch (error) {
    logWarn('ticker_lookup.gemini.failed', { name: text, message: error?.message });
    return null;
  }
}

async function resolveTickerByName(name) {
  const text = normalizeName(name);
  if (!text) return null;

  const cached = getCachedTicker(text);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  const cacheKey = buildCacheKey(text);
  if (inflight.has(cacheKey)) {
    return inflight.get(cacheKey);
  }

  const promise = (async () => {
    const krResult = await lookupKrTickerByName(text);
    if (krResult) {
      await setCachedTicker(text, krResult);
      logInfo('ticker_lookup.resolved', { name: text, ticker: krResult.ticker, market: 'KR', source: krResult.source });
      return krResult;
    }
    const yahooResult = await lookupTickerViaYahooSearch(text);
    if (yahooResult) {
      await setCachedTicker(text, yahooResult);
      logInfo('ticker_lookup.resolved', {
        name: text,
        ticker: yahooResult.ticker,
        market: yahooResult.market,
        source: yahooResult.source,
      });
      return yahooResult;
    }
    const geminiResult = await lookupTickerViaGeminiSearch(text);
    if (geminiResult) {
      await setCachedTicker(text, geminiResult);
      logInfo('ticker_lookup.resolved', {
        name: text,
        ticker: geminiResult.ticker,
        market: geminiResult.market,
        source: geminiResult.source,
      });
      return geminiResult;
    }
    logWarn('ticker_lookup.unresolved', { name: text });
    return null;
  })().finally(() => {
    inflight.delete(cacheKey);
  });

  inflight.set(cacheKey, promise);
  return promise;
}

module.exports = {
  resolveTickerByName,
  getCachedTicker,
  setCachedTicker,
  lookupKrTickerByName,
  lookupTickerViaYahooSearch,
  lookupTickerViaGeminiSearch,
  __testables: {
    normalizeName,
    buildCacheKey,
  },
};

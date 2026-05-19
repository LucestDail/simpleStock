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
        const matched = items.find((it) => String(it?.itmsNm || '').trim() === text);
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

/**
 * Gemini Google Search grounding 으로 종목명을 ticker 로 매핑한다.
 * - useGoogleSearch: true 로 hallucination 차단 (실제 검색 결과로 답)
 * - structured schema 와 grounding 동시 사용 시 일부 모델이 실패하므로
 *   schema 없이 텍스트 응답을 받아 JSON 추출
 */
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

  try {
    const result = await ai.generateStructuredOutput(
      {
        systemPrompt: [
          '너는 종목명→티커 매핑기다. Google Search 결과를 근거로만 답한다.',
          '사용자가 입력한 회사/ETF/ETN 이름에 대해 정확한 거래소 단축코드(ticker)와 거래소(KR=KRX/KOSPI/KOSDAQ, US=NASDAQ/NYSE)를 알려줘.',
          '예시:',
          '  "Rekor Systems" / "레코 시스템즈" → ticker: "REKR", market: "US"',
          '  "삼성전자" → ticker: "005930", market: "KR"',
          '  "NVIDIA" / "엔비디아" → ticker: "NVDA", market: "US"',
          '한국 종목 ticker는 6자리 숫자(예: 005930), 미국 종목 ticker는 영문 1~5자(예: NVDA, REKR)로 답한다.',
          '검색 결과로 확신할 수 없으면 ticker 를 빈 문자열로 둔다. 절대 추측·hallucination 금지.',
          '반드시 다음 JSON 형식으로만 답한다(코드블록·설명문구 없이):',
          '{"ticker":"...","market":"KR|US","shortName":"공식 영어 회사명","sourceUrl":"근거가 된 1차 URL"}',
        ].join('\n'),
        userPrompt: `다음 종목의 ticker 와 거래소를 알려줘: "${text}"`,
        schema: null,
        useGoogleSearch: true,
        logLabel: 'ticker_lookup_grounded',
        modelOverride: process.env.GEMINI_TICKER_LOOKUP_MODEL || 'gemini-2.5-flash',
        timeoutOverrideMs: 45_000,
      },
      null,
      { throwOnParseFailure: false }
    );

    const parsed = parseTickerLookupResponse(result, text);
    if (!parsed) return null;
    return parsed;
  } catch (error) {
    logWarn('ticker_lookup.grounded.failed', { name: text, message: error?.message });
    return null;
  }
}

function parseTickerLookupResponse(payload, fallbackName) {
  let obj = payload;
  if (typeof payload === 'string') {
    const match = payload.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      obj = JSON.parse(match[0]);
    } catch (e) {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const ticker = String(obj.ticker || '').trim().toUpperCase();
  const market = String(obj.market || '').trim().toUpperCase();
  if (!ticker || !market) return null;
  if (market === 'KR' && !/^\d{6}$/.test(ticker)) return null;
  if (market === 'US' && !/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) return null;
  return {
    ticker,
    market,
    currency: market === 'KR' ? 'KRW' : 'USD',
    shortName: String(obj.shortName || fallbackName),
    source: 'gemini-grounded-search',
    sourceUrl: obj.sourceUrl ? String(obj.sourceUrl) : null,
  };
}

/**
 * lookup 결과의 정합성을 시세 조회로 검증.
 * 시세가 잡혀야만 해당 ticker 를 채택 → AI hallucination(예: ticker:'KR' market:'US')으로
 * 상장돼있지 않은 코드가 캐시에 박히는 것을 방지.
 */
async function verifyTickerWithQuote({ ticker, market }) {
  if (!ticker || !market) return false;
  try {
    const marketSvc = require('./marketDataService');
    if (market === 'US') {
      const quote = await marketSvc.fetchUsQuote(ticker);
      return Boolean(quote && Number.isFinite(Number(quote.price)) && Number(quote.price) > 0);
    }
    if (market === 'KR' && typeof marketSvc.fetchPublicDataOperation === 'function') {
      const items = await marketSvc.fetchPublicDataOperation('getStockPriceInfo', {
        likeSrtnCd: ticker,
      });
      return Array.isArray(items) && items.some(
        (it) => String(it?.srtnCd || '').replace(/^A/i, '') === ticker
      );
    }
  } catch (error) {
    logWarn('ticker_lookup.verify.failed', { ticker, market, message: error?.message });
    return false;
  }
  return false;
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
    const candidates = [];
    const krResult = await lookupKrTickerByName(text);
    if (krResult) candidates.push(krResult);
    const yahooResult = await lookupTickerViaYahooSearch(text);
    if (yahooResult) candidates.push(yahooResult);
    const geminiResult = await lookupTickerViaGeminiSearch(text);
    if (geminiResult) candidates.push(geminiResult);

    for (const candidate of candidates) {
      const verified = await verifyTickerWithQuote(candidate);
      if (!verified) {
        logWarn('ticker_lookup.candidate.rejected', {
          name: text,
          ticker: candidate.ticker,
          market: candidate.market,
          source: candidate.source,
          reason: 'quote_verification_failed',
        });
        continue;
      }
      await setCachedTicker(text, candidate);
      logInfo('ticker_lookup.resolved', {
        name: text,
        ticker: candidate.ticker,
        market: candidate.market,
        source: candidate.source,
        sourceUrl: candidate.sourceUrl || null,
      });
      return candidate;
    }

    logWarn('ticker_lookup.unresolved', { name: text, attempts: candidates.length });
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

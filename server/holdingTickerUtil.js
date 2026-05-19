function normalizeText(value) {
  return String(value || '').trim();
}

const KR_NAME_TICKER_MAP = new Map([
  ['삼성전자', '005930'],
  ['삼성전자우', '005935'],
  ['SK하이닉스', '000660'],
  ['에스케이하이닉스', '000660'],
  ['LG에너지솔루션', '373220'],
  ['LG화학', '051910'],
  ['NAVER', '035420'],
  ['네이버', '035420'],
  ['카카오', '035720'],
  ['카카오뱅크', '323410'],
  ['현대차', '005380'],
  ['현대자동차', '005380'],
  ['기아', '000270'],
  ['POSCO홀딩스', '005490'],
  ['포스코홀딩스', '005490'],
  ['셀트리온', '068270'],
  ['삼성바이오로직스', '207940'],
  ['SK이노베이션', '096770'],
  ['하이브', '352820'],
  ['두산에너빌리티', '034020'],
  ['HD현대중공업', '329180'],
  ['한화에어로스페이스', '012450'],
  ['LG전자', '066570'],
  ['삼성SDI', '006400'],
  ['KB금융', '105560'],
  ['신한지주', '055550'],
  ['하나금융지주', '086790'],
  ['우리금융지주', '316140'],
]);

const US_NAME_TICKER_MAP = new Map([
  ['엔비디아', 'NVDA'],
  ['NVIDIA', 'NVDA'],
  ['애플', 'AAPL'],
  ['Apple', 'AAPL'],
  ['마이크로소프트', 'MSFT'],
  ['Microsoft', 'MSFT'],
  ['구글', 'GOOGL'],
  ['알파벳', 'GOOGL'],
  ['Alphabet', 'GOOGL'],
  ['아마존', 'AMZN'],
  ['Amazon', 'AMZN'],
  ['메타', 'META'],
  ['테슬라', 'TSLA'],
  ['Tesla', 'TSLA'],
  ['마이크론', 'MU'],
  ['Micron', 'MU'],
  ['브로드컴', 'AVGO'],
  ['Broadcom', 'AVGO'],
  ['AMD', 'AMD'],
  ['인텔', 'INTC'],
  ['Intel', 'INTC'],
]);

function lookupTickerByKoreanName(name) {
  const text = normalizeText(name);
  if (!text) return { ticker: '', market: '' };
  if (KR_NAME_TICKER_MAP.has(text)) {
    return { ticker: KR_NAME_TICKER_MAP.get(text), market: 'KR' };
  }
  if (US_NAME_TICKER_MAP.has(text)) {
    return { ticker: US_NAME_TICKER_MAP.get(text), market: 'US' };
  }
  return { ticker: '', market: '' };
}

function normalizeTickerSymbol(value) {
  return normalizeText(value).toUpperCase().replace(/\s+/g, '');
}

function isUsEquityTicker(ticker) {
  return /^[A-Z]{1,5}$/.test(normalizeTickerSymbol(ticker));
}

function isKrEquityTicker(ticker) {
  return /^[A-Z0-9]{5,12}$/.test(normalizeTickerSymbol(ticker));
}

function isEquityTicker(ticker) {
  const symbol = normalizeTickerSymbol(ticker);
  return isUsEquityTicker(symbol) || isKrEquityTicker(symbol);
}

function extractTickerFromHoldingName(name) {
  const text = normalizeText(name);
  if (!text) return '';

  const parenUsMatch = text.match(/\(([A-Z]{1,5})\b/);
  if (parenUsMatch) return normalizeTickerSymbol(parenUsMatch[1]);

  const parenKrMatch = text.match(/\((\d{6})\b/);
  if (parenKrMatch) return normalizeTickerSymbol(parenKrMatch[1]);

  const parenAlphanumMatch = text.match(/\(([A-Z0-9]{5,12})\b/i);
  if (parenAlphanumMatch && isEquityTicker(parenAlphanumMatch[1])) {
    return normalizeTickerSymbol(parenAlphanumMatch[1]);
  }

  const commaMatch = text.match(/\b([A-Z]{1,5})\s*[,，]/);
  if (commaMatch && isUsEquityTicker(commaMatch[1])) return normalizeTickerSymbol(commaMatch[1]);

  if (isEquityTicker(text)) return normalizeTickerSymbol(text);

  const lookup = lookupTickerByKoreanName(text);
  if (lookup.ticker) return lookup.ticker;

  return '';
}

function normalizeWatchlistHoldingName(name, ticker = '') {
  const text = normalizeText(name);
  const beforeParen = text.split('(')[0].trim();
  if (beforeParen && beforeParen.length <= 80 && !/관찰|추가|대기|데이터/.test(beforeParen)) {
    return beforeParen;
  }
  const symbol = normalizeTickerSymbol(ticker);
  if (symbol && isUsEquityTicker(symbol)) return symbol;
  return beforeParen || text.slice(0, 80);
}

function mergeHoldingDetailFields(existing, patch) {
  if (!patch || typeof patch !== 'object') return existing || null;
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    if (key === 'orders' && Array.isArray(value) && !value.length) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    base[key] = value;
  }
  return Object.keys(base).length ? base : null;
}

function applyEquityWatchDefaults(details) {
  if (!details || !isEquityTicker(details.ticker)) return details;
  const next = { ...details };
  const ticker = normalizeTickerSymbol(next.ticker);
  const isUs = isUsEquityTicker(ticker);

  if (!normalizeText(next.currency)) {
    next.currency = isUs ? 'USD' : 'KRW';
  }
  if (!normalizeText(next.market)) {
    next.market = isUs ? 'US' : 'KR';
  }
  if (!Number.isFinite(Number(next.quantity))) {
    next.quantity = 0;
  }
  return next;
}

function buildEquityDetailsPatch({ name, details }) {
  const tickerFromDetails = normalizeTickerSymbol(details?.ticker);
  const tickerFromName = extractTickerFromHoldingName(name);
  const ticker = tickerFromDetails || tickerFromName;
  if (!ticker) return { detailsPatch: null, cleanName: normalizeText(name) };

  const merged = applyEquityWatchDefaults(
    mergeHoldingDetailFields(details, {
      ticker,
      quantity: Number.isFinite(Number(details?.quantity)) ? Number(details.quantity) : 0,
    })
  );
  return {
    detailsPatch: merged,
    cleanName: normalizeWatchlistHoldingName(name, ticker),
  };
}

const PROTECTED_HOLDING_CATEGORIES = new Set(['fund', 'installment', 'pension']);

function repairWatchlistHolding(holding) {
  if (PROTECTED_HOLDING_CATEGORIES.has(holding?.category)) {
    return holding;
  }

  const { detailsPatch, cleanName } = buildEquityDetailsPatch({
    name: holding?.name,
    details: holding?.details,
  });

  if (!detailsPatch?.ticker) {
    return {
      ...holding,
      name: cleanName || holding.name,
    };
  }

  return {
    ...holding,
    name: cleanName || holding.name,
    category: 'stock',
    details: detailsPatch,
  };
}

function dedupeGhostHoldings(holdings) {
  const stockKeys = new Set();
  for (const holding of holdings) {
    if (holding.category !== 'stock' || !holding.details?.ticker) continue;
    stockKeys.add(normalizeWatchlistHoldingName(holding.name).toLowerCase());
    stockKeys.add(normalizeTickerSymbol(holding.details.ticker).toLowerCase());
  }

  return holdings.filter((holding) => {
    if (holding.category !== 'deposit') return true;
    if (Number(holding.amount) > 0) return true;
    if (holding.details?.ticker) return true;

    const nameKey = normalizeWatchlistHoldingName(holding.name).toLowerCase();
    if (stockKeys.has(nameKey)) return false;

    for (const key of stockKeys) {
      if (nameKey && (nameKey.includes(key) || key.includes(nameKey))) return false;
    }
    return true;
  });
}

function repairPortfolioHoldings(holdings) {
  const repaired = holdings.map((item) => repairWatchlistHolding(item));
  return dedupeGhostHoldings(repaired);
}

module.exports = {
  normalizeTickerSymbol,
  isUsEquityTicker,
  isKrEquityTicker,
  isEquityTicker,
  extractTickerFromHoldingName,
  normalizeWatchlistHoldingName,
  mergeHoldingDetailFields,
  applyEquityWatchDefaults,
  buildEquityDetailsPatch,
  repairWatchlistHolding,
  dedupeGhostHoldings,
  repairPortfolioHoldings,
  lookupTickerByKoreanName,
};

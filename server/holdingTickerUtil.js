function normalizeText(value) {
  return String(value || '').trim();
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

function repairWatchlistHolding(holding) {
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
};

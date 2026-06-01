const {
  normalizeWatchlistHoldingName,
  normalizeTickerSymbol,
} = require('./holdingTickerUtil');

function normalizeText(value) {
  return String(value || '').trim();
}

const STOCK_PURCHASE_PATTERN = /(\d{1,6})\s*주|평단|매수|매입|샀|구매|보유\s*수량/i;

function looksLikeStockPurchaseText(text) {
  return STOCK_PURCHASE_PATTERN.test(String(text || ''));
}

function extractQuantityFromText(text) {
  const match = String(text || '').match(/(\d{1,6})\s*주/);
  if (!match) return null;
  const quantity = Number(match[1]);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : null;
}

function extractAveragePriceFromText(text) {
  const raw = String(text || '');
  const labeled = raw.match(/평단(?:가)?\s*([0-9,]+(?:\.\d+)?)\s*(?:원|₩|krw)?/i);
  if (labeled) {
    const value = Number(String(labeled[1]).replace(/,/g, ''));
    if (Number.isFinite(value) && value > 0) return Math.round(value);
  }

  const amounts = [];
  for (const match of raw.matchAll(/([0-9]{1,3}(?:[,，][0-9]{3})+|[0-9]{4,})(?:\s*(?:원|₩|krw|won))?/gi)) {
    const value = Number(String(match[1]).replace(/[,，]/g, ''));
    if (Number.isFinite(value) && value >= 1000 && value <= 50_000_000) {
      amounts.push(value);
    }
  }
  if (!amounts.length) return null;
  return Math.round(amounts[amounts.length - 1]);
}

function extractStockNameFromPurchaseText(text) {
  let name = normalizeText(text);
  if (!name) return '';

  name = name
    .replace(/\d+\s*주.*/i, '')
    .replace(/[,，]\s*내\s*평단.*/i, '')
    .replace(/[,，]\s*평단.*/i, '')
    .replace(/\s*(매수|매입|샀|구매).*/i, '')
    .trim();

  return normalizeWatchlistHoldingName(name).slice(0, 80);
}

function parseStockPurchaseFromText(text, fallbackAmount = 0) {
  const raw = String(text || '');
  const quantity = extractQuantityFromText(raw);
  let averagePrice = extractAveragePriceFromText(raw);
  const cleanName = extractStockNameFromPurchaseText(raw);

  if (!averagePrice && Number(fallbackAmount) > 0) {
    const amount = Math.round(Number(fallbackAmount));
    if (amount >= 1000 && amount <= 50_000_000) {
      if (/평단|average/i.test(raw)) {
        averagePrice = amount;
      } else if (!quantity || amount < quantity * 5000) {
        averagePrice = amount;
      }
    }
  }

  return {
    cleanName,
    quantity,
    averagePrice,
  };
}

function namesOverlap(a, b) {
  const left = normalizeForMatch(a);
  const right = normalizeForMatch(b);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function normalizeForMatch(text) {
  return normalizeText(text).toLowerCase().replace(/[\s\-_·()（）,，]/g, '');
}

function coerceMisclassifiedStockActions(actions, userMessage, logInfo = () => {}) {
  if (!Array.isArray(actions) || actions.length === 0) return actions;

  const sourceText = normalizeText(userMessage);
  const messageLooksLikePurchase = looksLikeStockPurchaseText(sourceText);
  let coerced = 0;

  const next = actions.map((action) => {
    if (action?.type !== 'upsertHolding') return action;

    const holding = { ...(action.holding || {}) };
    const actionText = [holding.name, holding.details?.summary, action.rationale].filter(Boolean).join('\n');
    const combinedText = [sourceText, actionText].filter(Boolean).join('\n');
    const purchaseLike =
      looksLikeStockPurchaseText(combinedText) ||
      (messageLooksLikePurchase && normalizeText(holding.name));

    const isMisclassifiedDeposit =
      purchaseLike && (holding.category === 'deposit' || (!holding.category && !holding.details?.ticker));

    const isStockMissingQuantity =
      (holding.category === 'stock' || holding.details?.ticker) &&
      (!Number.isFinite(Number(holding.details?.quantity)) || Number(holding.details?.quantity) <= 0) &&
      messageLooksLikePurchase;

    if (!isMisclassifiedDeposit && !isStockMissingQuantity) return action;

    const parsedFromAction = parseStockPurchaseFromText(actionText, holding.amount);
    const parsedFromMessage = parseStockPurchaseFromText(sourceText, 0);
    const parsed = {
      cleanName:
        extractStockNameFromPurchaseText(holding.name) ||
        parsedFromAction.cleanName ||
        parsedFromMessage.cleanName,
      quantity: parsedFromAction.quantity || parsedFromMessage.quantity,
      averagePrice: parsedFromAction.averagePrice || parsedFromMessage.averagePrice,
    };

    const details = { ...(holding.details || {}) };
    if (parsed.quantity) details.quantity = parsed.quantity;
    if (parsed.averagePrice) details.averagePrice = parsed.averagePrice;
    if (!details.currency) details.currency = 'KRW';
    if (!details.market) details.market = 'KR';

    coerced += 1;
    return {
      ...action,
      holding: {
        ...holding,
        name: parsed.cleanName || holding.name,
        category: 'stock',
        amount: 0,
        mode: 'set',
        details,
      },
    };
  });

  if (coerced > 0) {
    logInfo('chat.actions.stock_purchase_coerced', { coerced });
  }

  return dedupeStockPurchaseActions(next);
}

function dedupeStockPurchaseActions(actions) {
  const merged = [];
  const indexByKey = new Map();

  for (const action of actions) {
    if (action?.type !== 'upsertHolding') {
      merged.push(action);
      continue;
    }

    const holding = action.holding || {};
    const key =
      normalizeText(holding.id) ||
      normalizeTickerSymbol(holding.details?.ticker).toLowerCase() ||
      normalizeForMatch(holding.name);

    if (!key) {
      merged.push(action);
      continue;
    }

    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, merged.length);
      merged.push(action);
      continue;
    }

    const existing = merged[existingIndex];
    const existingHolding = existing.holding || {};
    const incomingHolding = holding;
    const mergedHolding = {
      ...existingHolding,
      ...Object.fromEntries(
        Object.entries(incomingHolding).filter(([, value]) => value !== null && value !== undefined && value !== '')
      ),
      details: {
        ...(existingHolding.details || {}),
        ...(incomingHolding.details || {}),
      },
    };

    if (existingHolding.category !== 'stock' && incomingHolding.category === 'stock') {
      mergedHolding.category = 'stock';
    }
    if (incomingHolding.category === 'stock') {
      mergedHolding.category = 'stock';
      mergedHolding.amount = 0;
    }

    merged[existingIndex] = { ...existing, holding: mergedHolding };
  }

  return merged;
}

function mergeMisclassifiedDepositsIntoStocks(holdings) {
  if (!Array.isArray(holdings) || holdings.length === 0) return holdings;

  const stocks = holdings.filter((item) => item.category === 'stock');
  const toRemove = new Set();

  for (const deposit of holdings) {
    if (deposit.category !== 'deposit') continue;
    if (!looksLikeStockPurchaseText(deposit.name)) continue;

    const parsed = parseStockPurchaseFromText(deposit.name, deposit.amount);
    const cleanName = parsed.cleanName || extractStockNameFromPurchaseText(deposit.name);
    const stock = stocks.find((item) => namesOverlap(item.name, cleanName));
    if (!stock) continue;

    if (!stock.details || typeof stock.details !== 'object') {
      stock.details = {};
    }
    if (parsed.quantity && (!stock.details.quantity || Number(stock.details.quantity) <= 0)) {
      stock.details.quantity = parsed.quantity;
    }
    if (parsed.averagePrice && (!stock.details.averagePrice || Number(stock.details.averagePrice) <= 0)) {
      stock.details.averagePrice = parsed.averagePrice;
    }
    const price = Number(stock.details.lastQuote || stock.details.currentPrice || stock.details.averagePrice);
    if (Number.isFinite(Number(stock.details.quantity)) && Number(stock.details.quantity) > 0 && Number.isFinite(price) && price > 0) {
      stock.amount = Math.round(Number(stock.details.quantity) * price);
      stock.details.nativeAmount = stock.amount;
    }
    toRemove.add(deposit.id);
  }

  return holdings.filter((item) => !toRemove.has(item.id));
}

module.exports = {
  looksLikeStockPurchaseText,
  parseStockPurchaseFromText,
  coerceMisclassifiedStockActions,
  mergeMisclassifiedDepositsIntoStocks,
  extractQuantityFromText,
  extractAveragePriceFromText,
  extractStockNameFromPurchaseText,
};

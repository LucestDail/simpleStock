const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseStockPurchaseFromText,
  coerceMisclassifiedStockActions,
  extractStockNameFromPurchaseText,
} = require('../server/stockPurchaseUtil');
const { repairPortfolioHoldings } = require('../server/holdingTickerUtil');

test('parseStockPurchaseFromText extracts quantity and average price', () => {
  const parsed = parseStockPurchaseFromText('미래에셋 증권 35주 샀고, 내 평단 61,157원', 61157);
  assert.equal(parsed.cleanName, '미래에셋 증권');
  assert.equal(parsed.quantity, 35);
  assert.equal(parsed.averagePrice, 61157);
});

test('coerceMisclassifiedStockActions converts deposit purchase into stock', () => {
  const actions = coerceMisclassifiedStockActions(
    [
      {
        type: 'upsertHolding',
        rationale: 'test',
        holding: {
          name: '미래에셋 증권 35주 샀고, 내 평단',
          category: 'deposit',
          amount: 61157,
        },
      },
    ],
    '미래에셋 증권 35주 샀고, 내 평단 61157원'
  );

  assert.equal(actions.length, 1);
  assert.equal(actions[0].holding.category, 'stock');
  assert.equal(actions[0].holding.name, '미래에셋 증권');
  assert.equal(actions[0].holding.details.quantity, 35);
  assert.equal(actions[0].holding.details.averagePrice, 61157);
  assert.equal(actions[0].holding.amount, 0);
});

test('repairPortfolioHoldings merges misclassified deposit into existing stock', () => {
  const holdings = repairPortfolioHoldings([
    {
      id: 'deposit-ghost',
      name: '미래에셋 증권 35주 샀고, 내 평단',
      category: 'deposit',
      amount: 61157,
      details: null,
    },
    {
      id: 'stock-main',
      name: '미래에셋 증권',
      category: 'stock',
      amount: 0,
      details: {
        ticker: '006800',
        currency: 'KRW',
        market: 'KR',
        quantity: 0,
        averagePrice: 0,
        lastQuote: 61400,
      },
    },
  ]);

  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].name, '미래에셋 증권');
  assert.equal(holdings[0].details.quantity, 35);
  assert.equal(holdings[0].details.averagePrice, 61157);
});

test('extractStockNameFromPurchaseText strips purchase suffix', () => {
  assert.equal(extractStockNameFromPurchaseText('미래에셋 증권 35주 샀고, 내 평단'), '미래에셋 증권');
});

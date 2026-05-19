const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isEquityTicker,
  extractTickerFromHoldingName,
  applyEquityWatchDefaults,
  repairWatchlistHolding,
  dedupeGhostHoldings,
} = require('../server/holdingTickerUtil');

test('isEquityTicker accepts US and KR symbols', () => {
  assert.equal(isEquityTicker('NVDA'), true);
  assert.equal(isEquityTicker('005930'), true);
  assert.equal(isEquityTicker('0183J0'), true);
});

test('extractTickerFromHoldingName parses NVDA from descriptive name', () => {
  assert.equal(extractTickerFromHoldingName('NVIDIA (NVDA, 0주 관찰용 데이터 추가됨)'), 'NVDA');
});

test('applyEquityWatchDefaults sets USD for US tickers', () => {
  const details = applyEquityWatchDefaults({ ticker: 'NVDA' });
  assert.equal(details.currency, 'USD');
  assert.equal(details.market, 'US');
  assert.equal(details.quantity, 0);
});

test('repairWatchlistHolding fixes malformed NVIDIA watch entry', () => {
  const repaired = repairWatchlistHolding({
    id: 'x',
    name: 'NVIDIA (NVDA, 0주 관찰용 데이터 추가됨)',
    category: 'deposit',
    amount: 0,
    details: null,
  });
  assert.equal(repaired.category, 'stock');
  assert.equal(repaired.name, 'NVIDIA');
  assert.equal(repaired.details.ticker, 'NVDA');
  assert.equal(repaired.details.currency, 'USD');
});

test('dedupeGhostHoldings removes deposit duplicate when stock exists', () => {
  const holdings = dedupeGhostHoldings([
    {
      id: 'stock',
      name: 'TIGER 미국우주테크',
      category: 'stock',
      amount: 100,
      details: { ticker: '0183J0' },
    },
    {
      id: 'ghost',
      name: 'TIGER 미국우주테크',
      category: 'deposit',
      amount: 0,
      details: null,
    },
  ]);
  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].id, 'stock');
});

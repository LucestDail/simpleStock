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

test('extractTickerFromHoldingName parses 000660 from Korean stock name', () => {
  assert.equal(extractTickerFromHoldingName('SK하이닉스 (000660, 0주 관찰용 데이터 추가됨)'), '000660');
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

test('repairWatchlistHolding fixes malformed SK hynix watch entry', () => {
  const repaired = repairWatchlistHolding({
    id: 'y',
    name: 'SK하이닉스 (000660, 0주 관찰용 데이터 추가됨)',
    category: 'deposit',
    amount: 0,
    details: null,
  });
  assert.equal(repaired.category, 'stock');
  assert.equal(repaired.name, 'SK하이닉스');
  assert.equal(repaired.details.ticker, '000660');
  assert.equal(repaired.details.currency, 'KRW');
  assert.equal(repaired.details.market, 'KR');
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

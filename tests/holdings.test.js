const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findHoldingIndex, mergeHoldingDetails, inferHoldingCategory } = require('../server/actionService');
const { applyEquityWatchDefaults } = require('../server/holdingTickerUtil');

test('findHoldingIndex matches category when duplicate names exist', () => {
  const holdings = [
    { name: '삼성', category: 'deposit', amount: 1 },
    { name: '삼성', category: 'stock', amount: 2 },
  ];
  assert.equal(findHoldingIndex(holdings, '삼성', 'stock'), 1);
  assert.equal(findHoldingIndex(holdings, '삼성', 'deposit'), 0);
});

test('findHoldingIndex without category returns first name match', () => {
  const holdings = [
    { name: 'A', category: 'stock', amount: 1 },
    { name: 'A', category: 'fund', amount: 2 },
  ];
  assert.equal(findHoldingIndex(holdings, 'A', ''), 0);
});

test('findHoldingIndex prefers id over duplicate names', () => {
  const holdings = [
    { id: 'a', name: 'TIGER', category: 'deposit', amount: 0 },
    { id: 'b', name: 'TIGER', category: 'stock', amount: 100 },
  ];
  assert.equal(findHoldingIndex(holdings, 'TIGER', '', 'b'), 1);
});

test('inferHoldingCategory maps ticker holdings to stock', () => {
  assert.equal(
    inferHoldingCategory('deposit', { ticker: '005930', currency: 'KRW' }),
    'stock'
  );
  assert.equal(inferHoldingCategory('deposit', null), 'deposit');
});

test('applyEquityWatchDefaults fills KR watchlist fields', () => {
  const details = applyEquityWatchDefaults({ ticker: '005930' });
  assert.equal(details.currency, 'KRW');
  assert.equal(details.market, 'KR');
  assert.equal(details.quantity, 0);
});

test('applyEquityWatchDefaults fills US watchlist fields', () => {
  const details = applyEquityWatchDefaults({ ticker: 'NVDA' });
  assert.equal(details.currency, 'USD');
  assert.equal(details.market, 'US');
});

test('mergeHoldingDetails updates ticker without wiping other fields', () => {
  const merged = mergeHoldingDetails(
    {
      account: '한국 계좌',
      currency: 'KRW',
      ticker: '473580',
      quantity: 85,
      orders: ['예약 주문'],
    },
    {
      account: '',
      ticker: '0183J0',
      quantity: null,
    }
  );
  assert.equal(merged.ticker, '0183J0');
  assert.equal(merged.quantity, 85);
  assert.equal(merged.account, '한국 계좌');
  assert.deepEqual(merged.orders, ['예약 주문']);
});

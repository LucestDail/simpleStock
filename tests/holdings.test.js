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

test('fund category preserves explicit category even when ticker-like text exists in name', async () => {
  const { applyConversationActions } = require('../server/actionService');
  const { mutateStore, loadStore } = require('../server/dataStore');
  await mutateStore((store) => {
    store.portfolio.holdings = [
      {
        id: 'kb-fund-cat',
        name: 'KB 한국 인덱스 50 청년형 소득공제 증권 자투자신탁(채권혼합) C-E',
        category: 'fund',
        amount: 5516165,
        details: null,
      },
    ];
  });
  await applyConversationActions([
    {
      type: 'upsertHolding',
      rationale: 'fund update',
      holding: {
        id: 'kb-fund-cat',
        name: 'KB 한국 인덱스 50 청년형 소득공제 증권 자투자신탁(채권혼합) C-E',
        category: 'fund',
        amount: 5600000,
      },
    },
  ]);
  const h = loadStore().portfolio.holdings.find((x) => x.id === 'kb-fund-cat');
  assert.equal(h.category, 'fund');
  assert.equal(h.amount, 5600000);
  assert.equal(h.details, null);
});

test('upsertHolding without amount marks as ignored to avoid silent no-op', async () => {
  const { applyConversationActions } = require('../server/actionService');
  const { mutateStore, loadStore } = require('../server/dataStore');
  await mutateStore((store) => {
    store.portfolio.holdings = [
      {
        id: 'kb-fund-test',
        name: 'KB 한국 인덱스 50 청년형 소득공제 펀드',
        category: 'fund',
        amount: 5468619,
        details: null,
      },
    ];
  });
  const result = await applyConversationActions([
    {
      type: 'upsertHolding',
      rationale: 'AI dropped amount field',
      holding: { id: 'kb-fund-test', name: 'KB 한국 인덱스 50 청년형 소득공제 펀드', category: 'fund' },
    },
  ]);
  const r = result.actionResults[0];
  assert.equal(r.status, 'ignored');
  assert.match(r.message, /amount/);
  const h = loadStore().portfolio.holdings.find((x) => x.id === 'kb-fund-test');
  assert.equal(h.amount, 5468619);
});

test('upsertHolding with explicit amount applies and reports diff', async () => {
  const { applyConversationActions } = require('../server/actionService');
  const { mutateStore, loadStore } = require('../server/dataStore');
  await mutateStore((store) => {
    store.portfolio.holdings = [
      {
        id: 'kb-fund-test2',
        name: 'KB 한국 인덱스 50 청년형 소득공제 펀드',
        category: 'fund',
        amount: 5468619,
        details: null,
      },
    ];
  });
  const result = await applyConversationActions([
    {
      type: 'upsertHolding',
      rationale: 'user provided new amount',
      holding: { id: 'kb-fund-test2', name: 'KB 한국 인덱스 50 청년형 소득공제 펀드', category: 'fund', amount: 5516165 },
    },
  ]);
  const r = result.actionResults[0];
  assert.equal(r.status, 'applied');
  assert.match(r.message, /5,468,619.*5,516,165/);
  const h = loadStore().portfolio.holdings.find((x) => x.id === 'kb-fund-test2');
  assert.equal(h.amount, 5516165);
});

test('empty detailsPatch does not wipe existing quantity', async () => {
  const { applyConversationActions } = require('../server/actionService');
  const { mutateStore, loadStore } = require('../server/dataStore');
  await mutateStore((store) => {
    store.portfolio.holdings = [
      {
        id: 'test-guard',
        name: 'QLD',
        category: 'stock',
        amount: 7000,
        details: { ticker: 'QLD', currency: 'USD', market: 'US', quantity: 85, averagePrice: 69.04 },
      },
    ];
  });
  await applyConversationActions([
    {
      type: 'upsertHolding',
      rationale: 'test empty patch',
      holding: { id: 'test-guard', name: 'QLD', category: 'stock' },
    },
  ]);
  const h = loadStore().portfolio.holdings.find((x) => x.id === 'test-guard');
  assert.equal(h.details.quantity, 85, 'quantity should not be wiped to 0');
  assert.equal(h.details.averagePrice, 69.04);
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

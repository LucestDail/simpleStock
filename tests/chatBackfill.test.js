const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-for-loading';
const chatModule = require('../server/chatService');

const { __testables } = chatModule;

test('extractKrwAmountsFromText picks comma numbers with 원', () => {
  if (!__testables) return;
  const arr = __testables.extractKrwAmountsFromText('KB 펀드 5,516,165원으로 갱신해줘');
  assert.ok(arr.includes(5516165));
});

test('extractKrwAmountsFromText picks bare large integers', () => {
  if (!__testables) return;
  const arr = __testables.extractKrwAmountsFromText('금액 5516165 갱신');
  assert.ok(arr.includes(5516165));
});

test('backfillMissingHoldingAmounts fills single missing amount', () => {
  if (!__testables) return;
  const result = __testables.backfillMissingHoldingAmounts(
    [
      {
        type: 'upsertHolding',
        holding: { id: 'x', name: 'KB 펀드', category: 'fund' },
      },
    ],
    'KB 펀드 5,516,165원으로 갱신해줘',
    'thread-1'
  );
  assert.equal(result[0].holding.amount, 5516165);
});

test('backfillMissingHoldingAmounts skips when multiple upserts present', () => {
  if (!__testables) return;
  const before = [
    { type: 'upsertHolding', holding: { id: 'a', name: 'A', category: 'fund' } },
    { type: 'upsertHolding', holding: { id: 'b', name: 'B', category: 'fund' } },
  ];
  const after = __testables.backfillMissingHoldingAmounts(before, '5,000,000원', 'thread-2');
  assert.equal(after[0].holding.amount, undefined);
  assert.equal(after[1].holding.amount, undefined);
});

test('backfillMissingHoldingAmounts is no-op when amount already provided', () => {
  if (!__testables) return;
  const before = [
    { type: 'upsertHolding', holding: { id: 'a', name: 'A', category: 'fund', amount: 100 } },
  ];
  const after = __testables.backfillMissingHoldingAmounts(before, '5,000,000원', 'thread-3');
  assert.equal(after[0].holding.amount, 100);
});

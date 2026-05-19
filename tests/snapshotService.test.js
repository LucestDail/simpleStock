const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSnapshot } = require('../server/snapshotService');

test('buildSnapshot maps category shares without shares.map error', () => {
  const snapshot = buildSnapshot(
    [
      { category: 'stock', amount: 1_000_000, name: 'ACE KRX금현물' },
      { category: 'deposit', amount: 500_000, name: '예금' },
    ],
    '2026-05-19'
  );

  assert.equal(snapshot.date, '2026-05-19');
  assert.equal(snapshot.total, 1_500_000);
  assert.equal(snapshot.byCategory.stock, 1_000_000);
  assert.equal(snapshot.byCategory.deposit, 500_000);
});

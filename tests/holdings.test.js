const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findHoldingIndex } = require('../server/actionService');

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

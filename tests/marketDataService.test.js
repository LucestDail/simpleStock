const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isMarketUpstreamQuotaError,
  listRecentBasDates,
} = require('../server/marketDataService');

test('isMarketUpstreamQuotaError detects quota and rate-limit messages', () => {
  assert.equal(isMarketUpstreamQuotaError(new Error('API token quota exceeded')), true);
  assert.equal(isMarketUpstreamQuotaError(new Error('market upstream 429')), true);
  assert.equal(isMarketUpstreamQuotaError(new Error('공공데이터포털: 일일 트래픽 한도 초과')), true);
  assert.equal(isMarketUpstreamQuotaError(new Error('symbol not found')), false);
});

test('listRecentBasDates returns only weekdays up to the limit', () => {
  const dates = listRecentBasDates(2);
  assert.equal(dates.length, 2);
  assert.match(dates[0], /^\d{8}$/);
  assert.match(dates[1], /^\d{8}$/);
});

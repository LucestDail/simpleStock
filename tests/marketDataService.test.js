const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isMarketUpstreamQuotaError,
  listRecentBasDates,
  KR_PUBLIC_DATA_PRICE_OPERATIONS,
  findKrPublicDataItem,
  buildKrQuoteFromPublicDataItem,
  isTrackedKrStock,
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

test('KR public data operations include stock and securities endpoints', () => {
  const operations = KR_PUBLIC_DATA_PRICE_OPERATIONS.map((item) => item.operation);
  assert.deepEqual(operations, ['getStockPriceInfo', 'getSecuritiesPriceInfo']);
});

test('findKrPublicDataItem matches exact srtnCd only', () => {
  const items = [
    { srtnCd: '005930', clpr: '70000' },
    { srtnCd: '411060', clpr: '12000' },
  ];
  assert.equal(findKrPublicDataItem(items, '411060')?.srtnCd, '411060');
  assert.equal(findKrPublicDataItem(items, '999999'), null);
});

test('isTrackedKrStock accepts alphanumeric KRX tickers like 0183J0', () => {
  assert.equal(
    isTrackedKrStock({
      details: { ticker: '0183J0', currency: 'KRW', market: '' },
    }),
    true
  );
  assert.equal(
    isTrackedKrStock({
      details: { ticker: '473580', currency: 'KRW', market: '' },
    }),
    true
  );
  assert.equal(
    isTrackedKrStock({
      details: { ticker: 'QLD', currency: 'USD', market: 'US' },
    }),
    false
  );
});

test('buildKrQuoteFromPublicDataItem maps securities ETF rows', () => {
  const quote = buildKrQuoteFromPublicDataItem(
    {
      basDt: '20260516',
      srtnCd: '411060',
      itmsNm: 'ACE KRX금현물',
      clpr: '11230',
      vs: '120',
      fltRt: '1.08',
    },
    '411060',
    { kind: 'securities' }
  );

  assert.equal(quote.symbol, '411060');
  assert.equal(quote.shortName, 'ACE KRX금현물');
  assert.equal(quote.market, 'ETF');
  assert.equal(quote.price, 11230);
  assert.equal(quote.krPriceKind, 'securities');
});

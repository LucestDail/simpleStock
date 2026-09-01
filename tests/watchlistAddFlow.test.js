const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWatchlist } = require('../server/dataStore');
const { listTrackedTickerConfigs } = require('../server/marketDataService');
const { inferMarket } = require('../server/watchlistService');

// v3 종합 트래커: 추적 대상은 watchlist 테마 그룹의 티커(개인 보유 아님).

test('normalizeWatchlist: 시장 추정·중복제거·order 재정렬', () => {
  const wl = normalizeWatchlist({
    groups: [
      {
        id: 'g2',
        name: '미국',
        order: 5,
        tickers: [
          { symbol: 'aapl', currency: 'USD' },
          { symbol: 'AAPL', market: 'US' }, // 중복 → 제거
        ],
      },
      {
        id: 'g1',
        name: '국내',
        order: 1,
        tickers: [{ symbol: '005930', name: '삼성전자' }],
      },
    ],
  });
  // order 로 정렬(1 먼저) 후 0,1 로 재부여
  assert.equal(wl.groups[0].name, '국내');
  assert.equal(wl.groups[0].order, 0);
  assert.equal(wl.groups[1].order, 1);
  // 미국 그룹 중복 제거 → 1개
  assert.equal(wl.groups[1].tickers.length, 1);
  assert.equal(wl.groups[1].tickers[0].market, 'US');
  assert.equal(wl.groups[1].tickers[0].currency, 'USD');
  // 숫자코드 → KR/KRW 추정
  assert.equal(wl.groups[0].tickers[0].market, 'KR');
  assert.equal(wl.groups[0].tickers[0].currency, 'KRW');
});

test('listTrackedTickerConfigs: watchlist 그룹 티커를 US/KR 로 추적 소스화', () => {
  const store = {
    watchlist: {
      groups: [
        {
          id: 'g1',
          name: '반도체',
          tickers: [
            { symbol: 'NVDA', market: 'US', currency: 'USD', name: 'NVIDIA' },
            { symbol: '005930', market: 'KR', currency: 'KRW', name: '삼성전자' },
            { symbol: '069500', market: 'ETF', currency: 'KRW', name: 'KODEX 200' }, // ETF → KR 경로
          ],
        },
        {
          id: 'g2',
          name: '중복그룹',
          tickers: [{ symbol: 'NVDA', market: 'US', currency: 'USD', name: 'NVIDIA' }], // 그룹 간 중복 → 1개
        },
      ],
    },
  };
  const tracked = listTrackedTickerConfigs(store);
  const nvda = tracked.find((t) => t.symbol === 'NVDA');
  const etf = tracked.find((t) => t.symbol === '069500');
  assert.ok(nvda, 'NVDA 추적 포함');
  assert.equal(nvda.market, 'US');
  assert.equal(tracked.filter((t) => t.symbol === 'NVDA').length, 1, '그룹 간 중복 제거');
  assert.ok(etf, 'ETF 추적 포함');
  assert.equal(etf.market, 'KR', 'ETF 는 KR 시세경로로 추적');
});

test('inferMarket: 통화·심볼로 시장 추정', () => {
  assert.equal(inferMarket({ symbol: '005930' }), 'KR');
  assert.equal(inferMarket({ symbol: 'AAPL' }), 'US');
  assert.equal(inferMarket({ symbol: 'X', currency: 'USD' }), 'US');
  assert.equal(inferMarket({ symbol: 'Y', market: 'ETF' }), 'ETF');
});

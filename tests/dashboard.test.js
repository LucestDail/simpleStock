const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

/**
 * 대시보드 집계 (2026-09-21)
 *
 * 🔴 이 설계의 핵심은 **부분 실패를 전체 성공/실패로 뭉개지 않는 것**이다.
 *   - 조각 하나가 실패해도 나머지는 그려야 한다(전부 502 로 만들면 멀쩡한 것까지 사라진다)
 *   - 그렇다고 조용히 빈 값으로 만들면 화면은 "데이터가 없네" 로 보이고 **원인을 영영 모른다**
 *   ⇒ 조각마다 성패를 싣고 상위에 실패 개수를 낸다.
 */

process.env.TOSS_CLIENT_ID = 'test-id';
process.env.TOSS_CLIENT_SECRET = 'test-secret';

const dashboard = require('../server/dashboardService');
const portfolio = require('../server/tossPortfolio');

const realFetch = global.fetch;
let routes = new Map();

function res(status, body, headers = {}) {
  return {
    status, ok: status >= 200 && status < 300,
    headers: new Map(Object.entries(headers)),
    json: async () => body, text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  routes = new Map();
  global.fetch = async (url) => {
    const u = String(url);
    for (const [frag, fn] of routes) if (u.includes(frag)) return fn(u);
    throw new Error(`등록되지 않은 호출: ${u}`);
  };
  portfolio._resetForTest();
});
afterEach(() => { global.fetch = realFetch; });

const ok = () => res(200, { access_token: 'AT', token_type: 'Bearer', expires_in: 86399 });

function baseRoutes() {
  routes.set('/oauth2/token', ok);
  routes.set('/api/v1/accounts', () => res(200, { result: [{ accountNo: 'x', accountSeq: 1, accountType: 'BROKERAGE' }] }));
  routes.set('/api/v1/holdings', () => res(200, { result: {
    totalPurchaseAmount: { krw: '0', usd: '100' },
    marketValue: { amount: { krw: '0', usd: '110' } },
    profitLoss: { amount: { krw: '0', usd: '10' }, rate: '0.1' },
    dailyProfitLoss: { amount: { krw: '0', usd: '5' }, rate: '0.05' },
    items: [{ symbol: 'QLD', name: 'QLD', marketCountry: 'US', currency: 'USD', quantity: '1',
      lastPrice: '110', averagePurchasePrice: '100',
      marketValue: { purchaseAmount: '100', amount: '110' },
      profitLoss: { amount: '10', rate: '0.1' },
      dailyProfitLoss: { amount: '5', rate: '0.045' } }] } }));
  routes.set('/api/v1/stocks?', () => res(200, { result: [{ symbol: 'QLD', name: 'QLD', market: 'US', currency: 'USD', status: 'LISTED' }] }));
  routes.set('/api/v1/rankings', () => res(200, { result: { rankedAt: 'now', rankings: [{ rank: 1, symbol: 'A', price: {}, tradingVolume: '1' }] } }));
  routes.set('/api/v1/stocks/', () => res(200, { result: [] })); // warnings
}

test('한 번에 모아 준다 (화면이 조각마다 요청하면 한도를 태운다)', async () => {
  baseRoutes();
  const d = await dashboard.build({ watchSymbols: ['005930'], momentumPct: 3 });
  assert.ok(d.portfolio, '보유가 없다');
  assert.equal(d.failedCount, 0, `실패 조각 ${JSON.stringify(d.parts)}`);
  assert.ok(d.rankings.TOP_GAINERS, '랭킹이 없다');
  assert.ok('stockInfo' in d);
});

test('🔴 조각 하나가 실패해도 나머지는 살아 있다', async () => {
  baseRoutes();
  routes.set('/api/v1/rankings', () => res(500, { error: 'boom' }));
  const d = await dashboard.build({ momentumPct: 3 });
  assert.ok(d.portfolio, '랭킹이 죽었다고 보유까지 사라졌다');
  assert.equal(d.parts.rankings.ok, false);
  assert.equal(d.parts.holdings.ok, true);
});

test('🔴 실패를 **조용히 빈 값으로** 만들지 않는다 (화면이 "없음" 과 "못 받음" 을 구분한다)', async () => {
  baseRoutes();
  routes.set('/api/v1/rankings', () => res(500, { error: 'boom' }));
  const d = await dashboard.build({});
  assert.equal(d.failedCount, 1, '실패를 세지 않았다');
  assert.ok(d.parts.rankings.error, '실패 이유가 없다 — 원인을 영영 모른다');
  assert.ok(d.parts.rankings.kind, 'kind 가 없다 — ip-denied 인지 429 인지 화면이 못 가른다');
});

test('보유가 통째로 실패해도 대시보드는 응답한다', async () => {
  baseRoutes();
  routes.set('/api/v1/holdings', () => res(403, { error: 'denied' }));
  const d = await dashboard.build({});
  assert.equal(d.portfolio, null);
  assert.equal(d.parts.holdings.ok, false);
  assert.equal(d.parts.holdings.kind, 'ip-denied', 'IP 거부가 화면에 그대로 전달돼야 고칠 수 있다');
  assert.deepEqual(d.momentum, []);
});

test('★ 자의 판별력 — 모두 성공일 때 failedCount 가 0 이다(항상 0 인 자가 아니다)', async () => {
  baseRoutes();
  const okRun = await dashboard.build({});
  assert.equal(okRun.failedCount, 0);
  routes.set('/api/v1/stocks?', () => res(500, {}));
  routes.set('/api/v1/rankings', () => res(500, {}));
  const badRun = await dashboard.build({});
  assert.equal(badRun.failedCount, 2, '두 조각이 실패했는데 세지 못했다');
});

test('모멘텀 임계값이 실제로 걸린다', async () => {
  baseRoutes();
  const loose = await dashboard.build({ momentumPct: 1 });   // 4.5% > 1%
  assert.equal(loose.momentum.length, 1);
  const strict = await dashboard.build({ momentumPct: 10 }); // 4.5% < 10%
  assert.equal(strict.momentum.length, 0);
});

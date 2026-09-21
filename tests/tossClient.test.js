const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

/**
 * 토스 클라이언트/프로바이더 (2026-09-21 신설)
 *
 * 🔴 **이 테스트는 절대 라이브 API 를 때리면 안 된다.**
 *   - 라이브 키만 발급된다(샌드박스 없음) → 실제 호출은 실계좌 자격으로 나간다
 *   - 허용 IP 가 고정이라 CI·다른 기계에서는 어차피 403 이다
 *   ⇒ `global.fetch` 를 갈아끼우고, **아무도 안 갈아끼웠을 때 바로 실패**하게 한다.
 *
 * 응답 모양은 실측에서 왔다(2026-09-21 `.25` 탐침):
 *   /prices  → {result:[{symbol,timestamp,lastPrice:"272500",currency}]}   ← **값이 문자열**
 *   /candles → {result:{candles:[{closePrice:"272000"},…]}}                 ← **최신순**
 */

process.env.TOSS_CLIENT_ID = 'test-id';
process.env.TOSS_CLIENT_SECRET = 'test-secret';

const toss = require('../server/tossClient');
const provider = require('../server/tossProvider');

const realFetch = global.fetch;
/** 호출 기록 */
let calls = [];
/** path 조각 → 응답을 만드는 함수 */
let routes = new Map();

function res(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map(Object.entries(headers)),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
// headers.get 이 필요하다 (Map 은 get 이 있으므로 entries 도 그대로 동작한다)

function install() {
  calls = [];
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    for (const [frag, fn] of routes) {
      if (u.includes(frag)) return fn(u);
    }
    throw new Error(`테스트에 등록되지 않은 호출: ${u}`);
  };
}

beforeEach(() => {
  routes = new Map();
  install();
  provider._resetForTest();
});
afterEach(() => {
  global.fetch = realFetch;
});

const okToken = () => res(200, { access_token: 'AT', token_type: 'Bearer', expires_in: 86399 });

test('🔴 테스트가 라이브 API 를 때리지 않는다 (미등록 호출은 실패한다)', async () => {
  routes = new Map(); // 아무것도 등록하지 않는다
  await assert.rejects(() => toss.getPrices(['005930']), /등록되지 않은 호출/);
});

test('토큰을 한 번만 받고 재사용한다 (토큰 한도가 5 로 가장 좁다)', async () => {
  let tokenCalls = 0;
  routes.set('/oauth2/token', () => { tokenCalls += 1; return okToken(); });
  routes.set('/api/v1/prices', () => res(200, { result: [] }, { 'x-ratelimit-limit': '15' }));

  await toss.getPrices(['A']);
  await toss.getPrices(['B']);
  assert.equal(tokenCalls, 1, '요청마다 토큰을 새로 받고 있다');
});

test('동시 요청이 토큰을 여러 번 받지 않는다', async () => {
  let tokenCalls = 0;
  routes.set('/oauth2/token', async () => {
    tokenCalls += 1;
    await new Promise((r) => setTimeout(r, 30));
    return okToken();
  });
  routes.set('/api/v1/prices', () => res(200, { result: [] }));
  await Promise.all([toss.getPrices(['A']), toss.getPrices(['B']), toss.getPrices(['C'])]);
  assert.equal(tokenCalls, 1, `동시 요청이 토큰을 ${tokenCalls}번 받았다`);
});

test('🔴 403 은 "IP 문제" 라고 말한다 — 안 그러면 아무도 못 고친다', async () => {
  routes.set('/oauth2/token', () => res(403, { error: 'access_denied' }));
  await assert.rejects(
    () => toss.getPrices(['005930']),
    (e) => {
      assert.equal(e.kind, 'ip-denied');
      assert.match(e.message, /IP/, '메시지에 IP 라는 말이 없다');
      return true;
    }
  );
});

test('401 이면 토큰을 한 번만 다시 받는다 (무한 재발급 금지)', async () => {
  let tokenCalls = 0;
  let priceCalls = 0;
  routes.set('/oauth2/token', () => { tokenCalls += 1; return okToken(); });
  routes.set('/api/v1/prices', () => { priceCalls += 1; return res(401, { error: 'expired' }); });

  await assert.rejects(() => toss.getPrices(['A']));
  assert.equal(tokenCalls, 2, '401 인데 토큰을 다시 안 받았다');
  assert.equal(priceCalls, 2, '401 재시도가 한 번을 넘었다');
});

test('🔴 429 뒤에는 그 경로를 네트워크 없이 막는다 (retry-after 가 없으므로 우리가 정한다)', async () => {
  routes.set('/oauth2/token', () => okToken());
  routes.set('/api/v1/prices', () => res(429, { error: 'too many' }));

  await assert.rejects(() => toss.getPrices(['A']), (e) => e.kind === 'rate-limited');

  const before = calls.length;
  await assert.rejects(() => toss.getPrices(['A']), (e) => {
    assert.equal(e.kind, 'rate-limited');
    assert.match(e.message, /대기/);
    return true;
  });
  assert.equal(calls.length, before, '물러서는 중인데 또 때렸다 — 한도만 태운다');
});

test('가격이 **문자열**로 와도 숫자로 바꾼다 (실측: "272500")', async () => {
  routes.set('/oauth2/token', () => okToken());
  routes.set('/api/v1/prices', () =>
    res(200, {
      result: [{ symbol: '005930', timestamp: '2026-09-21T14:26:08.000+09:00', lastPrice: '272500', currency: 'KRW' }],
    })
  );
  const m = await toss.getPrices(['005930']);
  assert.equal(m.get('005930').price, 272500);
  assert.equal(typeof m.get('005930').price, 'number');
});

test('⚠️ 200종목을 넘기면 조용히 자르지 않고 던진다', async () => {
  routes.set('/oauth2/token', () => okToken());
  const many = Array.from({ length: 201 }, (_, i) => `S${i}`);
  await assert.rejects(() => toss.getPrices(many), /200종목/);
});

test('result 가 없는 응답은 형식 오류로 던진다 (빈 값으로 감싸지 않는다)', async () => {
  routes.set('/oauth2/token', () => okToken());
  routes.set('/api/v1/prices', () => res(200, { data: [] }));
  await assert.rejects(() => toss.getPrices(['A']), (e) => e.kind === 'shape');
});

test('실측 한도를 헤더에서 읽어 둔다 (스펙에 숫자가 없다)', async () => {
  routes.set('/oauth2/token', () => okToken());
  routes.set('/api/v1/prices', () =>
    res(200, { result: [] }, { 'x-ratelimit-limit': '15', 'x-ratelimit-remaining': '14' })
  );
  await toss.getPrices(['A']);
  const seen = toss.getObservedLimits()['/api/v1/prices'];
  assert.equal(seen.limit, 15);
});

// ── 프로바이더 ───────────────────────────────────────────────

function priceRoute(symbol, last) {
  routes.set('/api/v1/prices', () =>
    res(200, { result: [{ symbol, timestamp: '2026-09-21T14:00:00.000+09:00', lastPrice: last, currency: 'KRW' }] })
  );
}
function candleRoute(prevClose, todayClose = '272000') {
  let n = 0;
  routes.set('/api/v1/candles', () => {
    n += 1;
    return res(200, { result: { candles: [{ closePrice: todayClose }, { closePrice: prevClose }] } });
  });
  return () => n;
}

test('🔴 등락률을 만든다 — /prices 에는 등락률이 없다(4필드뿐)', async () => {
  routes.set('/oauth2/token', () => okToken());
  priceRoute('005930', '272500');
  candleRoute('260000');

  const m = await provider.fetchQuotes(['005930']);
  const q = m.get('005930');
  assert.equal(q.price, 272500);
  // (272500 - 260000) / 260000 * 100 = 4.808%
  assert.ok(Math.abs(q.changePct - 4.808) < 0.01, `등락률이 ${q.changePct}`);
});

test('전일 종가는 **하루 한 번만** 받는다 (종목당 1콜/일)', async () => {
  routes.set('/oauth2/token', () => okToken());
  priceRoute('005930', '272500');
  const candleCount = candleRoute('260000');

  await provider.fetchQuotes(['005930']);
  await provider.fetchQuotes(['005930']);
  await provider.fetchQuotes(['005930']);
  assert.equal(candleCount(), 1, `일봉을 ${candleCount()}번 받았다 — 하루 한 번이어야 한다`);
});

test('★ 자의 판별력 — 날짜가 바뀌면 다시 받는다', async () => {
  routes.set('/oauth2/token', () => okToken());
  priceRoute('005930', '272500');
  const candleCount = candleRoute('260000');

  await provider.fetchQuotes(['005930']);
  // 캐시의 날짜를 어제로 돌려 놓는다
  provider._prevCloseCache.set('005930', { close: 260000, forDate: '2000-01-01' });
  await provider.fetchQuotes(['005930']);
  assert.equal(candleCount(), 2, '날짜가 바뀌었는데 옛 종가를 그대로 썼다');
});

test('전일 종가를 못 받으면 **가격은 주고 등락률만 비운다** (0% 로 속이지 않는다)', async () => {
  routes.set('/oauth2/token', () => okToken());
  priceRoute('005930', '272500');
  routes.set('/api/v1/candles', () => res(200, { result: { candles: [] } }));

  const q = (await provider.fetchQuotes(['005930'])).get('005930');
  assert.equal(q.price, 272500);
  assert.equal(q.changePct, null, '등락률을 모르는데 0 이나 숫자를 만들어 냈다');
});

test('IP 거부면 나머지 종목 일봉을 더 때리지 않는다 (한도만 태운다)', async () => {
  routes.set('/oauth2/token', () => okToken());
  routes.set('/api/v1/prices', () =>
    res(200, {
      result: ['A', 'B', 'C'].map((s) => ({ symbol: s, lastPrice: '100', currency: 'KRW', timestamp: null })),
    })
  );
  let candleCalls = 0;
  routes.set('/api/v1/candles', () => { candleCalls += 1; return res(403, { error: 'access_denied' }); });

  await provider.fetchQuotes(['A', 'B', 'C']);
  assert.equal(candleCalls, 1, `403 인데 ${candleCalls}번 때렸다 — 첫 실패에서 멈춰야 한다`);
});

// ── LAN 판정 (위조 방지) ─────────────────────────────────────
const SESSION = require('../server/session');

test('🔴 외부 IP 가 헤더로 LAN 인 척해도 통하지 않는다', () => {
  // 소켓 상대가 루프백이 아니면 **헤더를 아예 안 본다**
  const req = {
    socket: { remoteAddress: '203.0.113.9' },
    headers: { 'x-real-ip': '192.168.11.5', 'x-forwarded-for': '10.0.0.1' },
  };
  assert.equal(SESSION.clientIp(req), '203.0.113.9');
  assert.equal(SESSION.isTrustedLanRequest(req), false, '헤더 위조로 LAN 면제를 얻었다');
});

test('nginx 경유(루프백)면 nginx 가 덮어쓰는 X-Real-IP 를 본다', () => {
  const lan = { socket: { remoteAddress: '::1' }, headers: { 'x-real-ip': '192.168.11.18' } };
  assert.equal(SESSION.isTrustedLanRequest(lan), true);

  const ext = { socket: { remoteAddress: '::1' }, headers: { 'x-real-ip': '203.0.113.9' } };
  assert.equal(SESSION.isTrustedLanRequest(ext), false, '외부에서 nginx 를 거쳐 온 것을 LAN 으로 봤다');
});

test('XFF 는 **마지막** 항목만 믿는다 (앞쪽은 클라이언트가 지어낸다)', () => {
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': '192.168.11.5, 203.0.113.9' }, // 앞이 위조, 뒤가 nginx 가 붙인 진짜
  };
  assert.equal(SESSION.clientIp(req), '203.0.113.9');
  assert.equal(SESSION.isTrustedLanRequest(req), false);
});

test('★ 자의 판별력 — 사설 대역을 실제로 알아본다', () => {
  for (const ip of ['10.1.2.3', '192.168.0.9', '172.16.0.1', '172.31.255.1', '127.0.0.1', '::1'])
    assert.equal(SESSION.isPrivateIp(ip), true, `${ip} 를 사설로 못 봤다`);
  for (const ip of ['8.8.8.8', '203.0.113.9', '172.32.0.1', '172.15.0.1', '180.70.85.99', ''])
    assert.equal(SESSION.isPrivateIp(ip), false, `${ip} 를 사설로 잘못 봤다`);
});

test('🔴 상대를 못 알아내면 면제하지 않는다 (모르는 것을 LAN 으로 치지 않는다)', () => {
  assert.equal(SESSION.isTrustedLanRequest({ socket: {}, headers: {} }), false);
  assert.equal(SESSION.isTrustedLanRequest({}), false);
});

test('🔴 표시되는 provider 가 **실제로 쓰는 것**을 따라간다 (2026-09-21 라이브에서 발견)', () => {
  // 전환했는데 /api/market/status 가 계속 옛 값을 보였다. 실제 호출은 바뀌었는데
  // 화면만 안 바뀌어서, "전환이 안 먹었다" 로 읽힌다 — 표시가 사실을 말해야 한다.
  const settings = require('../server/settingsService');
  const mds = require('../server/marketDataService');

  const before = mds.getMarketProviderConfig();
  assert.equal(typeof before.provider, 'string');
  // 기본값도 따로 보여 준다 — 무엇이 덮였는지 알 수 있어야 한다
  assert.ok('providerDefault' in before, 'providerDefault 가 없다 — 무엇이 덮였는지 못 본다');

  const applied = settings.updateSettings({ market: { krProvider: 'toss', usProvider: 'toss' } });
  assert.ok(applied, '설정 저장 실패');
  const after = mds.getMarketProviderConfig();
  assert.equal(after.provider, 'toss', '프로바이더를 바꿨는데 표시가 안 따라온다');
  assert.equal(after.providers.kr, 'toss');

  // 원복 — 테스트가 로컬 설정을 바꾼 채 끝나면 안 된다
  settings.updateSettings({ market: { krProvider: null, usProvider: null } });
  assert.notEqual(mds.getMarketProviderConfig().providers.kr, 'toss');
});

test('저장 스냅샷에도 providerDefault 가 실린다 (화면은 스냅샷을 본다)', async () => {
  /*
   * 2026-09-21: getMarketProviderConfig() 에만 넣고 **스냅샷에 안 실어서**
   * /api/market/status 에서 null 이었다. 설정 객체와 화면이 보는 객체가 **다르다** —
   * 한쪽에만 넣으면 "넣었는데 안 보인다" 가 된다.
   */
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'marketDataService.js'), 'utf8');
  const snapshotBlock = src.slice(src.indexOf('store.memory.market = {'), src.indexOf('store.memory.market = {') + 900);
  assert.ok(
    /providerDefault:/.test(snapshotBlock),
    '저장 스냅샷에 providerDefault 가 없다 — 설정 조회에만 있으면 화면에서는 null 이다'
  );
  assert.ok(/providers:/.test(snapshotBlock), '스냅샷에 providers 가 없다');
});

// ── 내 자산 (실계좌) ────────────────────────────────────────
const portfolio = require('../server/tossPortfolio');

function accountRoute(seq = 7) {
  routes.set('/api/v1/accounts', () =>
    res(200, { result: [{ accountNo: '123-456-7890', accountSeq: seq, accountType: 'BROKERAGE' }] })
  );
}
function holdingsRoute(capture) {
  routes.set('/api/v1/holdings', (url) => {
    if (capture) capture(url);
    return res(200, {
      result: {
        totalPurchaseAmount: { krw: '1000000', usd: '0' },
        marketValue: { amount: { krw: '1120000', usd: '0' } },
        profitLoss: { amount: { krw: '120000', usd: '0' }, rate: '12' },
        dailyProfitLoss: { amount: { krw: '-30000', usd: '0' }, rate: '-2.6' },
        items: [
          { symbol: '005930', name: '삼성전자', marketCountry: 'KR', currency: 'KRW',
            quantity: '3', lastPrice: '272500', averagePurchasePrice: '250000',
            marketValue: { purchaseAmount: '750000', amount: '817500' },
            profitLoss: { amount: '67500', rate: '9' },
            dailyProfitLoss: { amount: '-12000', rate: '-4.2' } },
          { symbol: 'QLD', name: 'ProShares Ultra QQQ', marketCountry: 'US', currency: 'USD',
            quantity: '2', lastPrice: '91.72', averagePurchasePrice: '80',
            marketValue: { purchaseAmount: '160', amount: '183.44' },
            profitLoss: { amount: '23.44', rate: '14.65' },
            dailyProfitLoss: { amount: '1.2', rate: '0.9' } },
        ],
      },
    });
  });
}

test('🔴 보유 조회는 accountNo 가 아니라 **accountSeq** 를 헤더에 넣는다', async () => {
  // 실측: accountNo 를 넣으면 `account-not-found` 가 온다. 그 문구만 보면
  // "계좌가 없다" 로 읽히는데 실제로는 **형식이 틀린 것**이다.
  routes.set('/oauth2/token', () => okToken());
  accountRoute(7);
  let seenHeader = null;
  const realFetchLocal = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes('/holdings')) seenHeader = init?.headers?.['X-Tossinvest-Account'];
    return realFetchLocal(url, init);
  };
  holdingsRoute();
  portfolio._resetForTest();
  await portfolio.getHoldings();
  global.fetch = realFetchLocal;
  assert.equal(seenHeader, '7', `헤더가 ${seenHeader} 다 — accountSeq(7) 여야 한다`);
});

test('🔴 계좌번호를 밖으로 내보내지 않는다 (개인 금융정보)', async () => {
  routes.set('/oauth2/token', () => okToken());
  accountRoute(7);
  holdingsRoute();
  portfolio._resetForTest();
  const acc = await portfolio.getAccount();
  assert.ok(!('accountNo' in acc), 'accountNo 가 캐시에 담겼다 — 나갈 일이 없는 값이다');
  const data = await portfolio.getHoldings();
  assert.ok(!JSON.stringify(data).includes('123-456-7890'), '응답에 계좌번호가 섞였다');
});

test('문자열 금액을 숫자로 바꾸고 통화별로 나눠 담는다', async () => {
  routes.set('/oauth2/token', () => okToken());
  accountRoute();
  holdingsRoute();
  portfolio._resetForTest();
  const { summary, items } = await portfolio.getHoldings();
  assert.equal(summary.value.krw, 1120000);
  assert.equal(summary.profitRate, 12);
  assert.equal(summary.dailyProfit.krw, -30000);
  assert.equal(items[0].quantity, 3);
  assert.equal(items[1].avgPrice, 80);
  assert.equal(typeof items[0].lastPrice, 'number');
});

test('계좌 목록은 캐시한다 (limit 이 1/초로 가장 좁다)', async () => {
  routes.set('/oauth2/token', () => okToken());
  let accCalls = 0;
  routes.set('/api/v1/accounts', () => {
    accCalls += 1;
    return res(200, { result: [{ accountNo: 'x', accountSeq: 1, accountType: 'BROKERAGE' }] });
  });
  holdingsRoute();
  portfolio._resetForTest();
  await portfolio.getHoldings();
  await portfolio.getHoldings();
  assert.equal(accCalls, 1, `계좌를 ${accCalls}번 조회했다 — 한도가 1/초다`);
});

test('모멘텀은 임계값을 넘은 것만 고르고 **판단은 안 한다**', () => {
  const items = [
    { symbol: 'A', dailyRate: -4.2 },
    { symbol: 'B', dailyRate: 0.9 },
    { symbol: 'C', dailyRate: 7.1 },
    { symbol: 'D', dailyRate: null },
  ];
  const picked = portfolio.pickMomentum(items, 3);
  assert.deepEqual(picked.map((x) => x.symbol), ['C', 'A'], '절대값 큰 순서로 골라야 한다');
  // ★ 자의 판별력 — 전부 고르지도, 아무것도 안 고르지도 않는다
  assert.equal(portfolio.pickMomentum(items, 100).length, 0);
  assert.equal(portfolio.pickMomentum(items, 0.5).length, 3, 'null 은 후보가 아니다');
});

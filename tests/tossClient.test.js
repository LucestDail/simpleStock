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

/**
 * 🔴 불리 방향 지정가 (2026-10-05 — 사용자: "현재가 98 근접인데 왜 97.5 에 파는거야")
 * 매도 지정가 < 현재가는 marketable limit 이지만 **그 가격이 슬리피지 하한**이 된다 —
 * 주간거래처럼 얕은 호가에선 거기까지 밀려 체결될 수 있다. 모델이 하한을 정하게 두지 않는다.
 * 쌍: 불리 0.3%+ 거부 / 유리 방향·0.3% 이내는 통과 / analyst 는 거부 대신 현재가 보정.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * ⚠️ `orderbook` 인자 추가 (2026-10-06) — 기준가가 `lastPrice` 에서 **호가**로 바뀌었다
 *    (매도=ask · 매수=bid). 안 주면 호가 없음 → lastPrice 폴백이라 종전 테스트는 그대로 돈다.
 */
function fresh(nowPrice, orderbook = null) {
  for (const k of Object.keys(require.cache)) if (/simpleStock\/server\//.test(k)) delete require.cache[k];
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-'));
  const tp = require.resolve('../server/tossClient');
  require.cache[tp] = { id: tp, filename: tp, loaded: true, exports: {
    ...require(tp),
    getPrices: async () => new Map([['QLD', { price: nowPrice }]]),
    getOrderbook: async () => (orderbook || {}),
    getPriceLimits: async () => ({}),
    getSellableQuantity: async () => ({ quantity: { num: 100, raw: '100' } }),
    getBuyingPower: async () => ({ cash: { num: 100000, raw: '100000' } }),
  } };
  return require('../server/orderService');
}

test('🔴 매도 지정가가 현재가보다 0.3% 넘게 낮으면 거부(adverse-price) + 현재가 동봉', async () => {
  const o = fresh(97.87);
  const r = await o.checkAccountLimits({ symbol: 'QLD', side: 'SELL', quantity: 5, price: 97.3 }); // -0.58%
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'adverse-price');
  assert.equal(r.currentPrice, 97.87);
});

/**
 * ⚠️ 2026-10-06 — 허용 폭이 0.3 → **0** 으로 바뀌자 이 테스트의 `97.7`(−0.17%)이 거부됐다.
 *    로직 회귀가 아니라 **의미 변경**이다(사용자: "현재 시세보다 싸게 올려놓았네").
 *    ⇒ 이 테스트는 **허용 폭 메커니즘**을 재는 것이므로 env 로 0.3 을 핀하고,
 *      기본값 0 은 아래 전용 테스트가 전담한다(한도 20→35→40 에서 쓴 것과 같은 수법).
 */
test('통과 쌍 — 유리 방향은 통과 · 허용 폭 안의 불리는 막지 않는다(폭=0.3 핀)', async () => {
  process.env.ADVERSE_PRICE_PCT = '0.3';
  const o = fresh(97.87);
  const hi = await o.checkAccountLimits({ symbol: 'QLD', side: 'SELL', quantity: 5, price: 98.5 }); // 유리 +0.64%
  assert.equal(hi.ok, true, hi.error);
  const near = await o.checkAccountLimits({ symbol: 'QLD', side: 'SELL', quantity: 5, price: 97.7 }); // -0.17%
  assert.equal(near.ok, true, near.error);
  delete process.env.ADVERSE_PRICE_PCT;
});

test('기본값 0 — 1틱이라도 불리하면 거부 (유리·동일가는 통과)', async () => {
  delete process.env.ADVERSE_PRICE_PCT;
  const o = fresh(100);
  assert.equal((await o.checkAccountLimits({ symbol: 'QLD', side: 'SELL', quantity: 1, price: 99.99 })).ok, false,
    '1틱 싸게 파는 제안이 통과했다');
  assert.equal((await o.checkAccountLimits({ symbol: 'QLD', side: 'SELL', quantity: 1, price: 100 })).ok, true,
    '같은 가격이 거부됐다 — 체결 가능한 가격을 막으면 제안이 통째로 죽는다');
  assert.equal((await o.checkAccountLimits({ symbol: 'QLD', side: 'SELL', quantity: 1, price: 100.5 })).ok, true,
    '유리 방향이 거부됐다');
});

test('매수는 반대 — 허용 폭 넘게 높으면 거부(폭=0.3 핀)', async () => {
  process.env.ADVERSE_PRICE_PCT = '0.3';
  const o = fresh(100);
  const r = await o.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1, price: 100.8 });
  assert.equal(r.kind, 'adverse-price');
  const ok = await o.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1, price: 99.5 }); // 유리(싸게)
  assert.equal(ok.ok, true, ok.error);
});

/**
 * 🔴 **불리 방향 0 허용** (2026-10-06 사용자: "또 현재 시세보다 싸게 qld 올려놓았네").
 * 0.3% 를 "마켓터블 리밋이라 체결 보장" 으로 뒀는데, 사용자 기준은 **현재가보다 싸게 파는
 * 제안 자체가 손해**였다(QLD SELL @100.16 vs 현재가 100.19 = 0.03% — 게이트는 통과했다).
 */
test('불리 방향 — 1틱이라도 불리하면 거부(기본값 0)', () => {
  delete process.env.ADVERSE_PRICE_PCT;
  for (const k of Object.keys(require.cache)) if (/orderService/.test(k)) delete require.cache[k];
  const os = require('../server/orderService');
  assert.equal(os.ADVERSE_PRICE_PCT ?? 0, 0, '기본값이 0 이 아니다 — 또 싸게 파는 제안이 통과한다');
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server', 'orderService.js'), 'utf8');
  assert.match(src, /ADVERSE_PRICE_PCT \?\? 0\)/, '코드 기본값이 0 이 아니다');
  assert.match(src, /adverse > ADVERSE_PRICE_PCT/, '판정식이 바뀌었다 — 0 이어도 같은 가격은 통과해야 한다');
});


/**
 * 🔴 **기준가는 호가다** (2026-10-06 — 사용자가 **세 번** 지적한 것의 근본).
 *    `lastPrice` 는 bid 일 수도 ask 일 수도 있어서, "불리 0%" 로 조여도
 *    **매수 호가에 매도를 던지는** 일이 통과했다(실측: last 100.17 = bid, ask 100.19).
 *    ⇒ 매도는 ask, 매수는 bid 를 기준으로 본다.
 */
test('기준가 = 호가 — last 가 bid 와 같아도 ask 미만 매도는 거부', async () => {
  delete process.env.ADVERSE_PRICE_PCT;
  const ob = { bids: [{ price: 100.17 }], asks: [{ price: 100.19 }] };
  const o = fresh(100.17, ob);   // last = bid = 100.17 (실측과 같은 모양)
  const bad = await o.checkAccountLimits({ symbol: 'QLD', side: 'SELL', quantity: 1, price: 100.17 });
  assert.equal(bad.ok, false, 'bid 에 매도를 던졌는데 통과했다 — 사용자가 세 번 지적한 그 자리');
  assert.equal(bad.currentPrice, 100.19, '기준가가 ask 가 아니다');
  const good = await o.checkAccountLimits({ symbol: 'QLD', side: 'SELL', quantity: 1, price: 100.19 });
  assert.equal(good.ok, true, 'ask 에 낸 매도가 거부됐다');
});

test('매수는 반대 — bid 초과는 거부(같은 구조, 방향만 반대)', async () => {
  delete process.env.ADVERSE_PRICE_PCT;
  const ob = { bids: [{ price: 100.17 }], asks: [{ price: 100.19 }] };
  const o = fresh(100.19, ob);   // last = ask
  assert.equal((await o.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1, price: 100.19 })).ok, false,
    'ask 에 매수를 던졌는데 통과했다 — 비싸게 사는 쪽');
  assert.equal((await o.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1, price: 100.17 })).ok, true,
    'bid 에 낸 매수가 거부됐다');
});

test('호가 없으면 lastPrice 폴백 — 조용히 옛 기준으로 안 돌아간다(warn)', async () => {
  delete process.env.ADVERSE_PRICE_PCT;
  const o = fresh(100.18, { bids: [], asks: [] });
  // 호가가 비면 last(100.18) 기준 — 같은 가격은 통과
  assert.equal((await o.checkAccountLimits({ symbol: 'QLD', side: 'SELL', quantity: 1, price: 100.18 })).ok, true);
  assert.equal((await o.checkAccountLimits({ symbol: 'QLD', side: 'SELL', quantity: 1, price: 100.17 })).ok, false);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'orderService.js'), 'utf8');
  assert.match(src, /orders\.orderbook_empty/, '호가 비었음을 로그로 남기지 않는다');
  assert.match(src, /orders\.orderbook_failed/, '호가 조회 실패를 로그로 남기지 않는다');
});

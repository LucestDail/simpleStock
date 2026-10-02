const { test } = require('node:test');
const assert = require('node:assert/strict');
const pre = require('../server/orderPrecheck');

/**
 * 🔴 **주문 사전 점검** — 2026-10-02 와이어프레임 ⑨
 *
 * 원문 원칙: *"에이전트는 주문 '초안'까지만 만든다. 실제 주문 전송은 사람의 최종 확인
 * 한 번을 반드시 거친다."*
 *
 * ## 이 자가 지키는 것 — **막는 게 아니라 보여주는 것**
 * 각 항목은 `pass|warn|fail|unknown` 을 돌려주고 **집행은 사람이** 정한다.
 * 여기서 막아 버리면 "왜 승인 버튼이 없지" 가 되고, 그건 사용자가 이유를 모르는 침묵이다.
 *
 * ## ⚠️ 가장 중요한 축 — `unknown` 은 `pass` 가 아니다
 * 못 잰 항목을 통과로 보여주면 그게 *"검사 안 한 것을 초록불로 보여주는"* 그 실패 모드다.
 * 이 저장소가 가장 여러 번 밟은 자리라 **오탐·발동보다 먼저** 잠근다.
 */

const HOLD = {
  asOf: new Date(Date.now() - 12_000).toISOString(),
  summary: { cash: { usd: { amount: 4755 }, krw: { amount: 0 } } },
  items: [
    { symbol: 'QLD', marketValue: 6785, quantity: 70, lastPrice: 96.93, leverageFactor: 2, currency: 'USD' },
    { symbol: 'RAM', marketValue: 4347, quantity: 300, lastPrice: 14.49, leverageFactor: 2, currency: 'USD' },
    { symbol: 'O', marketValue: 107, quantity: 2, lastPrice: 53.63, currency: 'USD' },
  ],
};
/** 테스트는 실물을 안 쓴다 — 비중 계산은 실제 함수를 그대로 태운다(두 벌이면 갈라진다) */
const weightsOf = (i, s) => require('../server/analystService').portfolioWeights(i, s, { categories: {} });
const base = (over = {}) => ({
  getHoldings: async () => HOLD,
  checkAccountLimits: async () => ({ ok: true }),
  getSessions: async () => ({ sessions: { us: { state: 'open' }, kr: { state: 'closed' } } }),
  getOpenOrders: async () => [],
  weightsOf,
  ...over,
});
const P = (over = {}) => ({ id: 'p1', symbol: 'RAM', side: 'SELL', quantity: 100, price: 14.49, ...over });
const find = (r, k) => r.checks.find((c) => c.key === k);

test('🔴 전부 통과하면 ready — 그리고 항목마다 사실이 적힌다', async () => {
  const r = await pre.precheck(P(), base());
  assert.equal(r.verdict, 'ready');
  assert.equal(find(r, 'balance').status, 'pass');
  assert.match(find(r, 'balance').detail, /초 전/, '언제 읽은 값인지가 없다 — 스냅샷 불일치를 못 잡는다');
  assert.equal(find(r, 'limits').status, 'pass');
  assert.equal(find(r, 'session').status, 'pass');
  assert.equal(find(r, 'open_orders').status, 'pass');
});

/**
 * 🔴 **`unknown` 은 `pass` 가 아니다** — 이 저장소가 가장 여러 번 밟은 자리다.
 *    미체결 조회 수단이 없으면 **항목을 빼지 않고** "조회 수단 미연결" 이라고 적는다.
 *    빼면 화면에서 "확인했다" 로 읽힌다.
 */
test('🔴 미체결 조회 수단이 없으면 unknown 으로 남긴다 (빼지 않는다)', async () => {
  const r = await pre.precheck(P(), base({ getOpenOrders: null }));
  const c = find(r, 'open_orders');
  assert.ok(c, '항목이 통째로 사라졌다 — 화면에서 "확인했다" 로 읽힌다');
  assert.equal(c.status, 'unknown');
  assert.match(c.detail, /미연결/);
  assert.equal(r.verdict, 'caution', 'unknown 이 있는데 ready 로 판정했다');
});

test('🔴 잔고를 못 읽으면 fail 이다 (통과가 아니다)', async () => {
  const r = await pre.precheck(P(), base({ getHoldings: async () => { throw new Error('토스 502'); } }));
  assert.equal(find(r, 'balance').status, 'fail');
  assert.match(find(r, 'balance').detail, /502/);
  assert.equal(r.verdict, 'blocked');
});

/**
 * 🔴 **수량 부족은 fail 이 아니라 warn** — `maxQuantity` 로 줄이면 주문이 성립한다.
 *    브리핑 경로가 이미 그렇게 깎아서 낸다(10-02). 화면도 같은 선택지를 줘야 한다.
 */
test('🔴 수량 부족은 warn + 줄일 수량을 돌려준다', async () => {
  const r = await pre.precheck(P(), base({
    checkAccountLimits: async () => ({ ok: false, kind: 'insufficient', maxQuantity: 42, error: '현금 부족' }),
  }));
  const c = find(r, 'limits');
  assert.equal(c.status, 'warn', '깎으면 되는데 막았다');
  assert.equal(c.suggestQuantity, 42, '줄일 수량을 안 알려줬다 — 사용자가 직접 계산해야 한다');
  assert.equal(r.verdict, 'caution');
});

test('한도가 수량 문제가 아니면 fail 이다 (가격 밴드 등)', async () => {
  const r = await pre.precheck(P(), base({
    checkAccountLimits: async () => ({ ok: false, kind: 'price-band', error: '지정가가 ±2.5% 밖' }),
  }));
  assert.equal(find(r, 'limits').status, 'fail');
  assert.equal(r.verdict, 'blocked');
});

/**
 * 🔴 **장 마감은 막지 않는다** — 예약 주문으로 접수된다. 막으면 사용자가 밤에 아무것도 못 한다.
 */
test('🔴 장 마감은 warn — "예약 주문으로 접수" 라고 알린다', async () => {
  const r = await pre.precheck(P(), base({
    getSessions: async () => ({ sessions: { us: { state: 'closed' } } }),
  }));
  const c = find(r, 'session');
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /예약 주문/);
  assert.notEqual(r.verdict, 'blocked', '장 마감으로 주문을 막았다');
});

test('한국 종목은 KR 세션으로 본다 (6자리 숫자)', async () => {
  const r = await pre.precheck(P({ symbol: '005930' }), base({
    getSessions: async () => ({ sessions: { kr: { state: 'open' }, us: { state: 'closed' } } }),
  }));
  assert.equal(find(r, 'session').status, 'pass');
  assert.match(find(r, 'session').label, /한국/);
});

// ── 체결 후 비중 ────────────────────────────────────────────────

/**
 * 🔴 승인 버튼을 누르기 전에 **무엇이 바뀌는지** 보여준다.
 *    레버리지 노출 90.7% 같은 숫자가 체결 후 어떻게 되는지가 이 화면의 핵심이다.
 */
test('🔴 매도하면 그 종목 비중이 줄고 현금이 는다', async () => {
  const r = await pre.precheck(P({ symbol: 'RAM', side: 'SELL', quantity: 100, price: 14.49 }), base());
  assert.ok(r.impact, '영향 계산이 통째로 없다');
  const beforeRam = r.impact.before.holdings.find((h) => h.symbol === 'RAM').pct;
  const afterRam = r.impact.after.holdings.find((h) => h.symbol === 'RAM').pct;
  assert.ok(afterRam < beforeRam, `RAM 비중이 안 줄었다 (${beforeRam} → ${afterRam})`);
  assert.ok(r.impact.after.cashPct > r.impact.before.cashPct, '현금 비중이 안 늘었다');
  assert.ok(r.impact.after.leveragePct < r.impact.before.leveragePct, '레버리지 노출이 안 줄었다');
});

test('🔴 매수하면 현금이 줄고 그 종목이 는다', async () => {
  const r = await pre.precheck(P({ symbol: 'O', side: 'BUY', quantity: 10, price: 53.63 }), base());
  const b = r.impact.before.holdings.find((h) => h.symbol === 'O').pct;
  const a = r.impact.after.holdings.find((h) => h.symbol === 'O').pct;
  assert.ok(a > b, `O 비중이 안 늘었다 (${b} → ${a})`);
  assert.ok(r.impact.after.cashPct < r.impact.before.cashPct, '현금이 안 줄었다');
});

test('보유에 없는 종목을 사면 새 줄이 생긴다', async () => {
  const r = await pre.precheck(P({ symbol: 'SHY', side: 'BUY', quantity: 10, price: 81.1 }), base());
  assert.ok(r.impact.after.holdings.some((h) => h.symbol === 'SHY'), '새로 산 종목이 비중에 안 나타난다');
});

/** ⚠️ 수량만 바꾸고 marketValue 를 안 옮기면 화면의 "몇 주" 가 거짓이 된다 */
test('수량도 함께 옮긴다 (금액만 바꾸면 "몇 주" 가 거짓이 된다)', () => {
  const r = pre.projectWeights({
    items: HOLD.items, summary: HOLD.summary, side: 'SELL', symbol: 'RAM',
    quantity: 100, price: 14.49, weightsOf,
  });
  assert.ok(r, '투영이 null 이다');
  // holdings 는 pct 만 들고 있으므로 비중이 실제로 줄었는지로 본다
  const before = r.before.holdings.find((h) => h.symbol === 'RAM').pct;
  const after = r.after.holdings.find((h) => h.symbol === 'RAM').pct;
  assert.ok(after < before);
});

test('수량·가격이 없으면 영향은 null 이다 (0 으로 채우지 않는다)', () => {
  assert.equal(pre.projectWeights({ items: HOLD.items, summary: HOLD.summary, side: 'SELL', symbol: 'RAM', quantity: 0, price: 14, weightsOf }), null);
  assert.equal(pre.projectWeights({ items: HOLD.items, summary: HOLD.summary, side: 'SELL', symbol: '', quantity: 1, price: 14, weightsOf }), null);
});

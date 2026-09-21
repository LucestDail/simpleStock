const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateOrderRequest, buildStopLoss, idempotencyKeyFor, krTickSize } = require('../server/orderRules');

/**
 * 주문 규칙 (2026-09-22 · 토스 명세 v1.2.17)
 *
 * **돈이 움직이는 규칙을 네트워크 없이 잰다.** 장중을 기다릴 이유가 없다.
 * 아래 규칙은 전부 명세에서 뽑은 것이고, 틀리면 **사용자가 승인을 누른 뒤에** 실패한다.
 */

const ok = (i, o) => { const r = validateOrderRequest(i, o); assert.equal(r.ok, true, `🔴 막혔다: ${r.errors}`); return r; };
const no = (i, re, o) => { const r = validateOrderRequest(i, o); assert.equal(r.ok, false, '🔴 통과시켰다'); assert.ok(r.errors.some((e) => re.test(e)), `기대: ${re} / 실제: ${r.errors}`); return r; };

// ── 가격 ─────────────────────────────────────────────────────

test('🔴 MARKET 에 price 를 보내면 안 된다 (명세: 보내면 400)', () => {
  no({ symbol: 'NVDA', side: 'BUY', orderType: 'MARKET', quantity: 1, price: 100 }, /price 를 보내면 안 됩니다/);
  ok({ symbol: 'NVDA', side: 'BUY', orderType: 'MARKET', quantity: 1 });
});

test('LIMIT 은 price 가 필수다', () => {
  no({ symbol: 'NVDA', side: 'BUY', orderType: 'LIMIT', quantity: 1 }, /price 가 필요/);
});

/** 🔴 호가 단위 — 어긋나면 거래소가 거부한다 */
test('🔴 국내 호가 단위를 지킨다', () => {
  assert.equal(krTickSize(1500), 1);
  assert.equal(krTickSize(70000), 100);
  assert.equal(krTickSize(300000), 500);
  no({ symbol: '005930', side: 'BUY', orderType: 'LIMIT', quantity: 1, price: 70050 }, /호가 단위/, { isEtf: false });
  ok({ symbol: '005930', side: 'BUY', orderType: 'LIMIT', quantity: 1, price: 70100 }, { isEtf: false });
});

/**
 * 🔴 **모르면 통과시키지 않는다** — ETF 는 전 구간 5원이라 일반주 기준으로 재면 틀린다.
 * 종류를 모르면 **경고로 남겨 사람이 보게** 한다(조용히 통과도, 무턱대고 거부도 아니다).
 */
test('🔴 ETF 여부를 모르면 "확인 못 함" 으로 남긴다', () => {
  const r = validateOrderRequest({ symbol: '069500', side: 'BUY', orderType: 'LIMIT', quantity: 1, price: 30005 });
  assert.equal(r.ok, true, 'ETF 일 수 있으니 막지는 않는다');
  assert.ok(r.warnings.some((w) => /호가 단위를 확정하지 못했습니다/.test(w)), '🔴 모르는데 조용히 통과했다');
});

test('ETF 라고 알려주면 5원 단위로 판정한다', () => {
  ok({ symbol: '069500', side: 'BUY', orderType: 'LIMIT', quantity: 1, price: 30005 }, { isEtf: true });
  no({ symbol: '069500', side: 'BUY', orderType: 'LIMIT', quantity: 1, price: 30003 }, /ETF 호가 단위/, { isEtf: true });
});

test('해외는 소수점 지정가가 된다 (호가 단위 규칙 없음)', () => {
  ok({ symbol: 'NVDA', side: 'BUY', orderType: 'LIMIT', quantity: 1, price: 180.37 });
});

// ── 소수점 수량 / 금액 주문 ──────────────────────────────────

/** 🔴 명세: 소수점 수량은 **US + MARKET + SELL** 일 때만 */
test('🔴 소수점 수량은 해외 시장가 매도에서만', () => {
  ok({ symbol: 'AAPL', side: 'SELL', orderType: 'MARKET', quantity: 5.5 });
  no({ symbol: 'AAPL', side: 'BUY', orderType: 'MARKET', quantity: 5.5 }, /시장가 매도.*만|orderAmount/);
  no({ symbol: 'AAPL', side: 'SELL', orderType: 'LIMIT', quantity: 5.5, price: 100 }, /시장가 매도/);
  no({ symbol: '005930', side: 'SELL', orderType: 'MARKET', quantity: 5.5 }, /국내 주식은 소수점/);
});

test('소수점은 6자리까지', () => {
  ok({ symbol: 'AAPL', side: 'SELL', orderType: 'MARKET', quantity: 1.123456 });
  no({ symbol: 'AAPL', side: 'SELL', orderType: 'MARKET', quantity: 1.1234567 }, /6자리/);
});

test('🔴 소수점 매수는 orderAmount 로 한다 (해외 시장가 전용)', () => {
  ok({ symbol: 'AAPL', side: 'BUY', orderType: 'MARKET', orderAmount: 100 });
  no({ symbol: '005930', side: 'BUY', orderType: 'MARKET', orderAmount: 100 }, /해외주식 전용/);
  no({ symbol: 'AAPL', side: 'BUY', orderType: 'LIMIT', orderAmount: 100, price: 10 }, /시장가에서만/);
  no({ symbol: 'AAPL', side: 'BUY', orderType: 'MARKET', quantity: 1, orderAmount: 100 }, /함께 보낼 수 없/);
});

/** ⚠️ 시간 제약은 **경고**다 — 막으려면 캘린더가 필요하고, 여기는 순수 함수다 */
test('⚠️ 소수점·금액 주문의 시간 제약을 알린다', () => {
  const r = ok({ symbol: 'AAPL', side: 'BUY', orderType: 'MARKET', orderAmount: 100 });
  assert.ok(r.warnings.some((w) => /정규장 종료 1시간 전/.test(w)));
});

// ── 멱등키 ───────────────────────────────────────────────────

/**
 * 🔴 명세: *"서버는 자동 생성하지 않습니다"* ⇒ **우리가 안 주면 멱등성이 없다.**
 * 같은 제안을 두 번 승인하면 **주문이 두 번 나간다.**
 */
test('🔴 제안 id 로 멱등키를 만든다', () => {
  const k = idempotencyKeyFor('47a52453-3970-4e37-93b9-da7c43e77256');
  assert.equal(k, '47a52453-3970-4e37-93b9-da7c43e77256');
  assert.ok(k.length <= 36);
  assert.match(k, /^[a-zA-Z0-9\-_]+$/);
});

test('규격 밖 문자는 걸러내고, 빈 값이면 null 을 준다', () => {
  assert.equal(idempotencyKeyFor('주문/1 2!'), '12');
  assert.equal(idempotencyKeyFor(''), null);
  assert.equal(idempotencyKeyFor('한글만'), null, '🔴 빈 문자열을 키로 보내면 멱등이 안 걸린다');
});

test('잘못된 멱등키는 요청을 막는다', () => {
  no({ symbol: 'NVDA', side: 'BUY', orderType: 'MARKET', quantity: 1, clientOrderId: 'a'.repeat(37) }, /clientOrderId/);
  no({ symbol: 'NVDA', side: 'BUY', orderType: 'MARKET', quantity: 1, clientOrderId: '주문1' }, /clientOrderId/);
});

// ── 만들어지는 본문 ──────────────────────────────────────────

/** 🔴 모든 수량·가격은 **문자열**이다 — number 로 보내면 정밀도가 깎인다 */
test('🔴 본문의 수량·가격이 문자열이다', () => {
  const r = ok({ symbol: 'NVDA', side: 'BUY', orderType: 'LIMIT', quantity: 3, price: 180.37, clientOrderId: 'abc' });
  assert.equal(typeof r.body.quantity, 'string');
  assert.equal(typeof r.body.price, 'string');
  assert.equal(r.body.price, '180.37');
  assert.equal(r.body.clientOrderId, 'abc');
});

test('MARKET 본문에는 price 가 아예 없다', () => {
  const r = ok({ symbol: 'NVDA', side: 'SELL', orderType: 'MARKET', quantity: 1 });
  assert.ok(!('price' in r.body), '🔴 MARKET 에 price 키가 들어갔다 — 400 이 된다');
});

test('금액 주문에는 timeInForce 를 넣지 않는다 (명세상 그 필드가 없다)', () => {
  const r = ok({ symbol: 'AAPL', side: 'BUY', orderType: 'MARKET', orderAmount: 50, timeInForce: 'DAY' });
  assert.ok(!('timeInForce' in r.body));
});

// ── 조건주문(손절) ───────────────────────────────────────────

/**
 * 🔴 명세에 **"스탑로스" 타입이 없다.** 조건 종류(`STOP`/`PROFIT_RATE`)는 **응답 전용**이고
 *    요청은 `SINGLE` + `SELL` + `triggerPrice` 로 표현한다.
 * 🔴 **트레일링 스탑은 만들 수단이 없다** — 명세에 미래 언급만 있다.
 */
test('🔴 손절은 SINGLE + SELL + triggerPrice 로 만든다', () => {
  const r = buildStopLoss({ symbol: 'QLD', quantity: 99, triggerPrice: 89.5, orderPrice: 89, expireDate: '2026-12-31' });
  assert.equal(r.ok, true, r.errors);
  assert.equal(r.body.type, 'SINGLE');
  assert.equal(r.body.orderType, 'LIMIT', '조건주문은 LIMIT 만 된다');
  assert.equal(r.body.first.orderSide, 'SELL');
  assert.equal(r.body.first.triggerPrice, '89.5');
  assert.equal(typeof r.body.quantity, 'string');
});

/** 🔴 `expireDate` 는 **필수**다 — 빠지면 거부된다 */
test('🔴 expireDate 없이는 만들지 않는다', () => {
  const r = buildStopLoss({ symbol: 'QLD', quantity: 99, triggerPrice: 89.5, orderPrice: 89 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /expireDate/.test(e)));
});

test('빠진 값을 전부 알려준다 (하나씩 되묻지 않게)', () => {
  const r = buildStopLoss({});
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 4, `빠진 값을 ${r.errors.length}개만 알려준다`);
});

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 실거래 실행 경로 (2026-09-22)
 *
 * ## 🔴 이 파일이 재는 것은 **돈이 두 번 나가지 않는가** 다
 *
 * 명세에서 확인한 것:
 * ```
 * clientOrderId  멱등키. **서버가 자동 생성하지 않는다** ⇒ 우리가 안 주면 두 번 승인 = 두 번 주문
 * 성공 응답      **orderId 뿐** — 체결 여부는 모른다. "성공" 이라 적으면 사용자가 체결로 읽는다
 * 타임아웃       "실패" 가 아니라 **"모름"** — 재시도하면 두 번 산다
 * 정정·취소      **멱등키 없음** + 성공해도 **새 orderId** ⇒ 자동 재시도 절대 금지
 * ```
 *
 * ⚠️ 실행은 `ORDERS_ENABLED`·`ORDERS_LIVE` 가 **둘 다** 켜져야 한다. 여기서만 켠다.
 */

process.env.ORDERS_FILE = path.join(os.tmpdir(), `ss-exec-${process.pid}.json`);
process.env.ORDERS_ENABLED = 'true';
process.env.ORDERS_LIVE = 'true';
process.env.ORDER_PROPOSAL_TTL_MS = '60000';

const GOOD = { symbol: 'NVDA', side: 'BUY', type: 'LIMIT', quantity: 2, price: 180, reason: 't' };

function fresh(tossStub) {
  for (const k of Object.keys(require.cache)) {
    if (/orderService|tossClient|orderRules/.test(k)) delete require.cache[k];
  }
  const tp = require.resolve('../server/tossClient');
  const real = require(tp);
  require.cache[tp] = { id: tp, filename: tp, loaded: true, exports: { ...real, ...tossStub } };
  return require('../server/orderService');
}
async function approved(o, input = GOOD) {
  const { proposal } = o.propose(input, { source: 'test', notify: false });
  assert.ok(o.approve(proposal.id).ok);
  return proposal.id;
}

beforeEach(() => { try { fs.unlinkSync(process.env.ORDERS_FILE); } catch { /* 없으면 그만 */ } });

test('🔴 멱등키(clientOrderId)를 **반드시** 실어 보낸다', async () => {
  let sentBody = null;
  const o = fresh({
    createOrder: async (b) => { sentBody = b; return { orderId: 'ord-1' }; },
    getOrder: async () => ({ status: 'NEW' }),
  });
  const id = await approved(o);
  const r = await o.execute(id);
  assert.equal(r.ok, true, r.error);
  assert.ok(sentBody.clientOrderId, '🔴 멱등키 없이 보냈다 — 두 번 승인하면 두 번 산다');
  assert.equal(sentBody.clientOrderId, id.slice(0, 36));
  assert.match(sentBody.clientOrderId, /^[a-zA-Z0-9\-_]+$/);
});

/** 🔴 명세대로 **문자열**로 나가는지 — number 면 정밀도가 깎인다 */
test('🔴 수량·가격이 문자열로 나간다', async () => {
  let b = null;
  const o = fresh({ createOrder: async (x) => { b = x; return { orderId: 'o' }; }, getOrder: async () => ({}) });
  await o.execute(await approved(o));
  assert.equal(typeof b.quantity, 'string');
  assert.equal(typeof b.price, 'string');
});

/**
 * 🔴🔴 **가장 중요한 테스트** — 보냈는데 답이 없으면 `UNKNOWN` 이고,
 * *"실패"* 로 적으면 안 된다(실패로 읽으면 다시 보내게 된다).
 */
test('🔴 전송 후 응답 없음 = UNKNOWN (실패 아님 · 재시도 금지 안내)', async () => {
  let calls = 0;
  const o = fresh({
    createOrder: async () => { calls += 1; const e = new Error('응답 없음'); e.kind = 'unknown'; throw e; },
  });
  const id = await approved(o);
  const r = await o.execute(id);
  assert.equal(r.ok, false);
  assert.equal(r.unknown, true, '🔴 "모름" 을 "실패" 로 뭉뚱그렸다');
  assert.equal(calls, 1, '🔴 자동 재시도했다 — 두 번 살 수 있다');
  assert.equal(o.list().find((p) => p.id === id).status, 'UNKNOWN');
  /**
   * ⚠️ 첫 판에 `r.error`(=스텁이 던진 문구)를 봤다 — 그건 **우리 코드가 아니라 픽스처**를 재는 것이다.
   *    우리가 통제하는 것은 제안에 남기는 안내문이다.
   */
  const stored = o.list().find((x) => x.id === id);
  assert.match(stored.result.note, /재시도 금지|조회로 확정/, '🔴 다시 보내라는 뜻으로 읽힐 안내다');
});

test('🔴 멱등키 충돌은 따로 구분한다 (우리 상태가 꼬인 것이다)', async () => {
  const o = fresh({
    createOrder: async () => { const e = new Error('같은 키 다른 본문'); e.kind = 'idempotency-conflict'; throw e; },
  });
  const r = await o.execute(await approved(o));
  assert.equal(r.ok, false);
  assert.match(r.error, /멱등키 충돌/);
});

/**
 * 🔴 응답에 `orderId` 만 온다 ⇒ **SENT**(접수)이지 체결이 아니다.
 * 여기서 "성공/체결" 이라고 적으면 사용자가 팔린 줄 안다.
 */
test('🔴 접수는 SENT 다 — 체결이라고 적지 않는다', async () => {
  const o = fresh({ createOrder: async () => ({ orderId: 'ord-9' }), getOrder: async () => ({ status: 'NEW' }) });
  const id = await approved(o);
  await o.execute(id);
  const p = o.list().find((x) => x.id === id);
  assert.equal(p.status, 'SENT');
  assert.equal(p.orderId, 'ord-9');
  assert.match(p.result.note, /접수/);
  assert.ok(!/체결(?!\s*여부)/.test(p.result.note), '🔴 체결로 읽히는 문구다');
});

test('상태 확인이 실패해도 **주문은 이미 나갔다** (되돌리지 않는다)', async () => {
  const o = fresh({
    createOrder: async () => ({ orderId: 'ord-x' }),
    getOrder: async () => { throw new Error('조회 실패'); },
  });
  const id = await approved(o);
  const r = await o.execute(id);
  assert.equal(r.ok, true, '🔴 상태 조회 실패로 주문을 실패 처리했다 — 실제로는 나갔다');
  assert.equal(o.list().find((x) => x.id === id).status, 'SENT');
});

/** 🔴 승인 안 된 제안은 실행되지 않는다 — 구조(승인 레코드 존재)로 막는다 */
test('🔴 승인 없이는 실행되지 않는다', async () => {
  let called = false;
  const o = fresh({ createOrder: async () => { called = true; return { orderId: 'x' }; } });
  const { proposal } = o.propose(GOOD, { source: 'test', notify: false });
  const r = await o.execute(proposal.id);
  assert.equal(r.ok, false);
  assert.equal(called, false, '🔴 승인 전에 주문이 나갔다');
});

/** 🔴 보내기 전에 형식을 막는다 — 거래소가 거부하는 것보다 여기가 낫다 */
test('🔴 국내 호가 단위가 어긋나면 보내지 않는다', async () => {
  let called = false;
  const o = fresh({ createOrder: async () => { called = true; return { orderId: 'x' }; } });
  const id = await approved(o, { symbol: '005930', side: 'BUY', type: 'LIMIT', quantity: 1, price: 70050, reason: 't' });
  const r = await o.execute(id);
  assert.equal(r.ok, false);
  assert.equal(called, false, '🔴 거래소가 거부할 주문을 보냈다');
  assert.match(r.error, /확인하지 못한|호가 단위|주문 형식/);
});

/** 🔴 자기검증 — 스위치가 꺼져 있으면 **절대** 안 나간다 */
test('🔴 자기검증: ORDERS_LIVE 가 꺼지면 전송 자체가 없다', async () => {
  process.env.ORDERS_LIVE = 'false';
  let called = false;
  const o = fresh({ createOrder: async () => { called = true; return { orderId: 'x' }; } });
  const id = await approved(o);
  const r = await o.execute(id);
  process.env.ORDERS_LIVE = 'true';
  assert.equal(called, false, '🔴 스위치가 꺼졌는데 주문이 나갔다');
  assert.equal(r.dryRun, true);
});

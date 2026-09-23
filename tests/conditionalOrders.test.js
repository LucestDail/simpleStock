const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 예약(조건부) 주문 파이프라인 (2026-09-23)
 *
 * 사용자: *"100불 도달하면 100불보다 비싸게 지정가로 QLD 전량 매도"* —
 * 이 문장이 제안→승인→집행→감사의 **같은 HITL 흐름**을 타는지 잰다.
 * 🔴 재는 것: ①모양 규칙(명세 위반은 보내기 전에 막힘) ②멱등키가 실림
 * ③즉시 주문 API 가 아니라 **조건주문 API 로** 나감 ④승인 없이는 안 나감.
 */

process.env.ORDERS_FILE = path.join(os.tmpdir(), `ss-cond-${process.pid}.json`);
process.env.ORDERS_ENABLED = 'true';
process.env.ORDERS_LIVE = 'true';
process.env.ORDER_PROPOSAL_TTL_MS = '60000';

const rules = require('../server/orderRules');

const COND = {
  symbol: 'QLD', side: 'SELL', type: 'LIMIT', quantity: 99, reason: '사용자 지시',
  conditional: { triggerPrice: 100, orderPrice: 100.5, orderType: 'LIMIT', expireDate: '2026-10-23' },
};

function fresh(tossStub) {
  for (const k of Object.keys(require.cache)) {
    if (/orderService|tossClient|orderRules/.test(k)) delete require.cache[k];
  }
  const tp = require.resolve('../server/tossClient');
  const real = require(tp);
  require.cache[tp] = { id: tp, filename: tp, loaded: true, exports: { ...real, ...tossStub } };
  return require('../server/orderService');
}

beforeEach(() => { try { fs.unlinkSync(process.env.ORDERS_FILE); } catch { /* 없으면 그만 */ } });

// ── 순수 규칙층 ────────────────────────────────────────────────

test('사용자 예시가 그대로 명세 모양이 된다 (SINGLE·SELL·감시가 100·지정가 100.5)', () => {
  const r = rules.buildConditionalSingle({
    symbol: 'QLD', side: 'SELL', quantity: 99,
    triggerPrice: 100, orderPrice: 100.5, expireDate: '2026-10-23', clientOrderId: 'k-1',
  });
  assert.equal(r.ok, true, r.errors?.join(','));
  assert.deepEqual(r.body, {
    symbol: 'QLD', type: 'SINGLE', orderType: 'LIMIT', quantity: '99', expireDate: '2026-10-23',
    first: { orderSide: 'SELL', triggerPrice: '100', orderPrice: '100.5' },
    clientOrderId: 'k-1',
  });
});

test('🔴 명세 규칙이 보내기 전에 막는다 — MARKET+주문가 / expireDate 누락 / KR 소수량', () => {
  assert.equal(rules.buildConditionalSingle({ symbol: 'QLD', side: 'SELL', quantity: 1, triggerPrice: 100, orderPrice: 99, orderType: 'MARKET', expireDate: '2026-10-01' }).ok, false);
  assert.equal(rules.buildConditionalSingle({ symbol: 'QLD', side: 'SELL', quantity: 1, triggerPrice: 100, orderPrice: 101 }).ok, false); // expireDate 없음
  assert.equal(rules.buildConditionalSingle({ symbol: '005930', side: 'BUY', quantity: 0.5, triggerPrice: 70000, orderPrice: 70100, expireDate: '2026-10-01' }).ok, false); // KR 소수점
  // MARKET 은 orderPrice 없이 통과한다
  const mkt = rules.buildConditionalSingle({ symbol: 'QLD', side: 'SELL', quantity: 1, triggerPrice: 100, orderType: 'MARKET', expireDate: '2026-10-01' });
  assert.equal(mkt.ok, true, mkt.errors?.join(','));
  assert.equal(mkt.body.first.orderPrice, undefined);
});

// ── 제안층 ────────────────────────────────────────────────────

test('조건부 제안은 price 없이 만들어지고, 잘못된 조건은 제안 단계에서 거부된다', () => {
  const o = fresh({});
  const good = o.propose(COND, { source: 'test', notify: false });
  assert.equal(good.ok, true, good.error);
  assert.equal(good.proposal.conditional.triggerPrice, 100);
  assert.equal(good.proposal.price, null); // 즉시 지정가가 아니다

  // 승인 눌렀는데 형식으로 막히면 신뢰가 깎인다 — **제안 시점에** 걸러진다
  const bad = o.propose({ ...COND, conditional: { ...COND.conditional, expireDate: '' } }, { source: 'test', notify: false });
  assert.equal(bad.ok, false);
  assert.match(String(bad.missing.join(',')), /expireDate/);
});

// ── 집행층 ────────────────────────────────────────────────────

test('🔴 승인된 조건부 제안은 **조건주문 API 로만** 나가고 멱등키가 실린다', async () => {
  let condBody = null;
  let immediateCalled = false;
  const o = fresh({
    createConditionalOrder: async (b) => { condBody = b; return { conditionalOrderId: 'co-1' }; },
    createOrder: async () => { immediateCalled = true; return { orderId: 'wrong' }; },
  });
  const { proposal } = o.propose(COND, { source: 'test', notify: false });
  assert.ok(o.approve(proposal.id).ok);
  const r = await o.execute(proposal.id);
  assert.equal(r.ok, true, r.error);
  assert.equal(immediateCalled, false, '🔴 즉시 주문 API 로 나갔다 — 예약이 지금 체결된다');
  assert.equal(condBody.type, 'SINGLE');
  assert.equal(condBody.first.triggerPrice, '100');
  assert.ok(condBody.clientOrderId, '멱등키 없이 보냈다');
  assert.equal(r.conditionalOrderId, 'co-1');
  assert.equal(r.proposal.status, 'SENT');
  assert.match(r.proposal.result.note, /감시가 100/);
});

test('승인 없이는 조건부도 안 나간다 (같은 상태기계)', async () => {
  let called = false;
  const o = fresh({ createConditionalOrder: async () => { called = true; return {}; } });
  const { proposal } = o.propose(COND, { source: 'test', notify: false });
  const r = await o.execute(proposal.id);
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test('감사에 조건이 남는다 — 나중에 "무슨 예약을 승인했나" 를 파일이 답해야 한다', async () => {
  const auditFile = path.join(__dirname, '..', 'data', 'orders-audit.jsonl');
  const before = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8') : '';
  const o = fresh({ createConditionalOrder: async () => ({ conditionalOrderId: 'co-2' }) });
  const { proposal } = o.propose(COND, { source: 'test', notify: false });
  o.approve(proposal.id);
  await o.execute(proposal.id);
  const added = fs.readFileSync(auditFile, 'utf8').slice(before.length);
  assert.match(added, /"event":"proposed".*"conditional"/);
  assert.match(added, /"event":"conditional_sent"/);
  assert.match(added, /"triggerPrice":100/);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 🔴 **TTL 과 멱등창의 관계를 강제한다** (2026-09-22)
 *
 * 이중발주를 막는 층이 둘이고, 둘째 층(멱등키)이 **설정값 하나에 매달려 있다**:
 *
 *   두 번의 전송은 반드시 `[createdAt, createdAt+TTL]` 안에서 일어난다
 *   ⇒ 간격이 TTL 을 못 넘는다 ⇒ `TTL ≤ 멱등창(10분)` 이면 둘째 주문이 항상 막힌다
 *
 * TTL 을 10분 위로 올리는 순간 **둘째 층이 조용히 사라진다.** 아무 증상도 안 난다 —
 * ①(상태기계)이 평소엔 혼자서도 막으니까. 그래서 **자가 없으면 아무도 모른다.**
 *
 * ★ 이 저장소에서 같은 계열을 여러 번 밟았다(바깥 상한이 안쪽보다 촘촘해지는 역전).
 *   처방도 같다 — **값을 흩어 두지 말고 관계를 한 곳에서 강제한다.**
 */

function freshWith(env) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const k of Object.keys(require.cache)) if (/orderService/.test(k)) delete require.cache[k];
  const m = require('../server/orderService');
  process.env = saved;
  return m;
}

test('🔴 기본 TTL 은 멱등창을 넘지 않는다', () => {
  const o = freshWith({ ORDER_PROPOSAL_TTL_MS: '' });
  const s = o.status();
  assert.ok(s.proposalTtlMs > 0, 'TTL 이 노출되지 않는다');
  assert.ok(s.idempotencyWindowMs > 0, '멱등창이 노출되지 않는다 — 자가 볼 수 없으면 잠글 수 없다');
  assert.ok(
    s.proposalTtlMs <= s.idempotencyWindowMs,
    `🔴 TTL(${s.proposalTtlMs}ms) 이 멱등창(${s.idempotencyWindowMs}ms) 을 넘었다 — 이중발주 둘째 층이 사라졌다`,
  );
});

test('지시받은 값이 실제로 10분이다', () => {
  const o = freshWith({ ORDER_PROPOSAL_TTL_MS: '' });
  assert.equal(o.status().proposalTtlMs, 10 * 60_000);
});

/**
 * 🔴 **자의 판별력** — 값을 넘기면 실제로 잡히는가.
 *    (안 잡히면 위 테스트는 "지금 값이 우연히 맞다" 만 말하는 장식이다)
 */
test('🔴 TTL 을 멱등창 위로 올리면 **잡힌다**', () => {
  const o = freshWith({ ORDER_PROPOSAL_TTL_MS: String(11 * 60_000) });
  const s = o.status();
  assert.ok(s.proposalTtlMs > s.idempotencyWindowMs, '환경변수가 안 먹었다 — 변이 자체가 성립 안 함');
  // 위 규칙 테스트가 이 상태에서 실패해야 한다
  assert.throws(() => {
    assert.ok(s.proposalTtlMs <= s.idempotencyWindowMs);
  }, '🔴 넘겼는데도 규칙이 통과한다 — 자가 장식이다');
});

/**
 * 🔴 **근거가 코드에 남아 있는가** — "왜 10분에서 멈추는가" 를 지우면
 *    다음 사람이 무심코 올린다. 주석은 사고를 못 막지만, **이유 없는 상수**는 반드시 바뀐다.
 */
test('🔴 TTL 상수 옆에 멱등창과의 관계가 적혀 있다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'orderService.js'), 'utf-8');
  const i = src.indexOf('const PROPOSAL_TTL_MS');
  assert.ok(i > 0, 'TTL 상수를 못 찾았다');
  const before = src.slice(Math.max(0, i - 2000), i);
  assert.match(before, /멱등/, '🔴 TTL 을 왜 여기서 멈추는지 근거가 없다 — 이유 없는 상수는 곧 바뀐다');
});

/** ⚠️ 상태기계(①층)도 함께 확인한다 — 둘째 층만 믿으면 안 된다 */
test('🔴 보낸 제안은 **다시 실행되지 않는다** (첫째 층)', async () => {
  const o = freshWith({ ORDERS_ENABLED: '', ORDERS_LIVE: '' });
  const p = o.propose({ symbol: 'RAM', side: 'SELL', type: 'LIMIT', quantity: 1, price: 20 },
    { source: 'test', notify: false });
  assert.equal(p.ok, true, p.error);
  o.approve(p.proposal.id);
  const first = await o.execute(p.proposal.id);
  assert.equal(first.ok, true);
  const second = await o.execute(p.proposal.id);
  assert.equal(second.ok, false, '🔴 같은 제안이 두 번 실행됐다');
  assert.match(second.error, /승인되지 않은/);
});

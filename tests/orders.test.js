const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

/**
 * 주문 제안 → 승인 → 실행 (2026-09-21)
 *
 * 🔴 **토스는 샌드박스가 없다.** 연습할 곳이 없으니 흐름의 결함을 **실주문으로 배우면 안 된다.**
 *    이 테스트가 그 한 바퀴를 대신 돈다.
 * 🔴 실행은 **이름·의도 추론이 아니라 구조**로 막는다 — 승인 레코드가 있을 때만 돈다.
 *    (셸 가드 18/18 · AIm 승인 게이트 8/8 이 이름 열거로 졌다)
 */

const orders = require('../server/orderService');

beforeEach(() => orders._resetForTest());

const good = { symbol: '005930', side: 'BUY', type: 'LIMIT', quantity: 10, price: 270000 };

test('기본이 dry-run 이다 (환경변수가 없으면 꺼짐)', () => {
  const s = orders.status();
  assert.equal(s.ordersEnabled, false, 'ORDERS_ENABLED 미설정이 켜짐이 됐다');
  assert.equal(s.effective, 'dry-run');
});

test('🔴 빈칸이 있는 제안은 **만들지 않는다** (승인 화면이 주문 화면이 되면 안 된다)', () => {
  for (const [patch, field] of [
    [{ symbol: '' }, 'symbol'],
    [{ side: 'HOLD' }, 'side'],
    [{ quantity: 0 }, 'quantity'],
    [{ price: null }, 'price'],
  ]) {
    const r = orders.propose({ ...good, ...patch });
    assert.equal(r.ok, false, `${field} 가 비었는데 제안이 만들어졌다`);
    assert.ok(r.missing.length, '무엇이 빠졌는지 안 알려준다');
  }
  // ★ 자의 판별력 — 온전한 제안은 만들어진다(전부 거부하는 자가 아니다)
  assert.equal(orders.propose(good).ok, true);
});

test('시장가는 가격이 없어도 된다 (지정가만 가격을 요구한다)', () => {
  assert.equal(orders.propose({ ...good, type: 'MARKET', price: null }).ok, true);
});

test('🔴 승인 없이는 실행되지 않는다 (fail-closed)', async () => {
  const { proposal } = orders.propose(good);
  const r = await orders.execute(proposal.id);
  assert.equal(r.ok, false);
  assert.match(r.error, /승인/);
});

test('승인해도 **그것만으로는 아무것도 나가지 않는다**', () => {
  const { proposal } = orders.propose(good);
  const a = orders.approve(proposal.id);
  assert.equal(a.ok, true);
  assert.equal(a.proposal.status, 'APPROVED');
  assert.equal(a.proposal.executedAt, null, '승인이 곧 실행이 됐다');
});

test('승인 후 실행하면 **dry-run 으로 끝난다** (실거래 미연결)', async () => {
  const { proposal } = orders.propose(good);
  orders.approve(proposal.id);
  const r = await orders.execute(proposal.id);
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true, '🔴 dry-run 이 아니다 — 실거래로 나갔을 수 있다');
  assert.equal(r.proposal.status, 'DRY_RUN');
});

test('두 번 승인되지 않는다 (중복 클릭)', () => {
  const { proposal } = orders.propose(good);
  assert.equal(orders.approve(proposal.id).ok, true);
  assert.equal(orders.approve(proposal.id).ok, false, '두 번 승인됐다 — 두 번 살 수 있다');
});

test('🔴 만료된 제안은 승인해도 실행되지 않는다 (시세가 움직였다)', async () => {
  const { proposal } = orders.propose(good);
  orders.approve(proposal.id);
  // 만료를 강제한다
  proposal.expiresAt = new Date(Date.now() - 1000).toISOString();
  const r = await orders.execute(proposal.id);
  assert.equal(r.ok, false);
  assert.match(r.error, /만료/);
});

test('만료된 제안은 승인 자체가 안 된다', () => {
  const { proposal } = orders.propose(good);
  proposal.expiresAt = new Date(Date.now() - 1000).toISOString();
  const a = orders.approve(proposal.id);
  assert.equal(a.ok, false);
  assert.match(a.error, /만료/);
});

test('거절하면 실행되지 않는다', async () => {
  const { proposal } = orders.propose(good);
  orders.reject(proposal.id, '비중 초과');
  const r = await orders.execute(proposal.id);
  assert.equal(r.ok, false);
});

test('제안마다 멱등키가 다르다 (승인 1건 = 주문 1건)', () => {
  const a = orders.propose(good).proposal;
  const b = orders.propose(good).proposal;
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
  assert.ok(a.idempotencyKey.length >= 16);
});

test('🔴 실거래 경로가 **아직 구현되지 않았다는 사실**이 코드에 남아 있다', () => {
  /*
   * 주석이 "곧 만든다" 로 남고 아무도 안 만드는 것을 막는다.
   * ⚠️ 이 테스트는 실거래를 붙이면 **깨져야 한다** — 그때 이 가드를 고치면서
   *    "재시도 금지 · 조회로 확정" 이 실제로 들어갔는지 다시 보게 된다.
   */
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'server/orderService.js'), 'utf8');
  assert.ok(/not-implemented/.test(src), '실거래 미구현 표시가 사라졌다 — 붙였다면 이 가드를 갱신하라');
  assert.ok(/재시도 금지/.test(src), '전송 타임아웃 처방("재시도 금지 · 조회로 확정")이 사라졌다');
});

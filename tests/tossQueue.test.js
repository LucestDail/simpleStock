const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createQueue } = require('../server/tossQueue');

/**
 * 🔴 **그룹별 큐 + 한도 스케줄러** (2026-09-22 사용자 지시)
 *
 * > *"큐 산입 → 토스 rate limit 맞게 호출 → 실패하면 큐 상단 재산입. 429 찍혀서 멈추면 안되잖아."*
 *
 * 종전엔 429 를 맞으면 그 버킷을 잠그고 **그 사이 호출을 던져서 거절**했다.
 * 한도는 아꼈지만 **기능이 멈췄다** — 화면이 비고 분석이 데이터 없이 돌았다.
 *
 * ## 🔴 이 파일에서 가장 중요한 축: **무엇을 되꽂는가**
 * ```
 * 429 응답      서버가 **받고 거절**했다 ⇒ 처리 안 됨이 확실 ⇒ 재산입 안전
 * 네트워크 실패  **나갔는지 모른다** ⇒ 재시도하면 **두 번 주문** ⇒ 절대 금지
 * ```
 * 어젯밤 `send_unknown` 사고가 뒤쪽이다. 여기를 느슨하게 하면 돈이 두 번 나간다.
 */

/** 가짜 시계 — 실제로 기다리지 않고 창을 넘긴다 */
function fakeClock() {
  let t = 0;
  const waiters = [];
  return {
    now: () => t,
    sleep: (ms) => new Promise((r) => { waiters.push({ at: t + ms, r }); }),
    advance(ms) {
      t += ms;
      const due = waiters.filter((w) => w.at <= t);
      for (const w of due) { waiters.splice(waiters.indexOf(w), 1); w.r(); }
      return new Promise((r) => setImmediate(r));
    },
  };
}
const rateErr = () => Object.assign(new Error('토스 API 요청 제한(429)'), { kind: 'rate-limited' });

/**
 * ⚠️ **거절 핸들러를 `advance` 전에 붙인다.** 안 그러면 시계를 감는 도중 거절이 일어나
 *    `unhandledRejection` 으로 테스트가 죽는다 — **제품이 아니라 하니스 문제**인데
 *    빨간불만 보면 "재시도가 안 막힌다" 로 읽힌다(첫 판에 4건이 그랬다).
 */
const settled = (p) => { const r = p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })); return r; };

test('🔴 한도만큼만 한 창에 보낸다 (ACCOUNT=1/s)', async () => {
  const c = fakeClock();
  const q = createQueue(c);
  let sent = 0;
  const ps = [1, 2, 3].map(() => q.run('ACCOUNT', async () => { sent += 1; return sent; }));
  await c.advance(0);
  assert.equal(sent, 1, `🔴 1/s 인데 한 창에 ${sent}건 나갔다 — 즉시 429다`);
  await c.advance(1000); assert.equal(sent, 2);
  await c.advance(1000); assert.equal(sent, 3);
  await Promise.all(ps);
});

test('🔴 그룹이 서로를 막지 않는다', async () => {
  const c = fakeClock();
  const q = createQueue(c);
  const order = [];
  const a = q.run('ACCOUNT', async () => order.push('acct'));
  const b = q.run('MARKET_DATA', async () => order.push('mkt'));
  await c.advance(0);
  assert.deepEqual(order.sort(), ['acct', 'mkt'], '🔴 ACCOUNT 가 막혔다고 시세까지 섰다');
  await Promise.all([a, b]);
});

/** 🔴 사용자 지시의 핵심 — "실패하면 큐 상단 재산입" */
test('🔴 429 는 **앞에** 되꽂혀 결국 성공한다 (멈추지 않는다)', async () => {
  const c = fakeClock();
  const q = createQueue(c);
  let n = 0;
  const p = q.run('RANKING', async () => { n += 1; if (n === 1) throw rateErr(); return 'ok'; });
  await c.advance(0);
  assert.equal(n, 1);
  await c.advance(1000);
  await c.advance(1000);
  assert.equal(await p, 'ok', '🔴 429 한 번에 호출이 죽었다 — "멈추면 안 된다" 는 지시 위반');
  assert.equal(n, 2);
});

test('🔴 되꽂은 것이 **뒤가 아니라 앞**이다 (순서 보존)', async () => {
  const c = fakeClock();
  const q = createQueue(c);
  const done = [];
  let first = 0;
  const a = q.run('RANKING', async () => { first += 1; if (first === 1) throw rateErr(); done.push('A'); });
  const b = q.run('RANKING', async () => { done.push('B'); });
  await c.advance(0);
  for (let i = 0; i < 4; i += 1) await c.advance(1000);
  await Promise.all([a, b]);
  assert.deepEqual(done, ['A', 'B'], `🔴 되꽂힌 A 가 B 뒤로 밀렸다: ${done}`);
});

/** 🔴🔴 여기를 느슨하게 하면 **두 번 주문**이 나간다 */
test('🔴 네트워크 실패는 **재시도하지 않는다** (나갔는지 모른다)', async () => {
  const c = fakeClock();
  const q = createQueue(c);
  let n = 0;
  const r = settled(q.run('ORDER', async () => { n += 1; throw Object.assign(new Error('응답 없음'), { kind: 'unknown' }); }));
  await c.advance(0);
  const got = await r;
  assert.equal(got.ok, false); assert.match(got.e.message, /응답 없음/);
  assert.equal(n, 1, `🔴 "모름" 을 ${n}번 보냈다 — 주문이 두 번 나갈 수 있다`);
});

test('⚠️ 업스트림 오류도 재시도하지 않는다 (의미 없는 재시도로 한도만 태운다)', async () => {
  const c = fakeClock();
  const q = createQueue(c);
  let n = 0;
  const r = settled(q.run('STOCK', async () => { n += 1; throw Object.assign(new Error('400'), { kind: 'upstream' }); }));
  await c.advance(0);
  assert.equal((await r).ok, false);
  assert.equal(n, 1);
});

test('🔴 429 가 계속되면 **포기하되 조용하지 않다**', async () => {
  const c = fakeClock();
  const q = createQueue(c);
  let n = 0;
  const r = settled(q.run('RANKING', async () => { n += 1; throw rateErr(); }));
  for (let i = 0; i < 20; i += 1) await c.advance(1000);
  const got = await r;
  assert.equal(got.ok, false); assert.match(got.e.message, /요청 제한/);
  assert.ok(n >= 2 && n <= 5, `재시도 횟수가 상한을 벗어났다: ${n}`);
});

/** ⚠️ 큐에서 오래 기다린 것은 **"안 나갔다"** 로 돌려준다 — 그래야 호출자가 안전하게 판단한다 */
test('⚠️ 대기 상한을 넘기면 not-sent 로 거절한다', async () => {
  const c = fakeClock();
  const q = createQueue(c);
  let sent = 0;
  const blocker = q.run('ACCOUNT', async () => { sent += 1; });
  const late = settled(q.run('ACCOUNT', async () => { sent += 1; }, { maxWaitMs: 500 }));
  await c.advance(0);
  await c.advance(1000);
  const got = await late;
  assert.equal(got.ok, false);
  assert.equal(got.e.kind, 'not-sent');
  assert.match(got.e.message, /나가지 않았습니다/);
  assert.equal(sent, 1, '🔴 상한을 넘긴 요청이 나갔다');
  await blocker;
});

test('🔴 큐가 가득 차면 **즉시** 거절한다(무한히 쌓지 않는다)', async () => {
  const c = fakeClock();
  const q = createQueue(c);
  const ps = [];
  for (let i = 0; i < 600; i += 1) ps.push(q.run('ACCOUNT', async () => 1).catch((e) => e.kind));
  await c.advance(0);
  const kinds = await Promise.all(ps.slice(-50));
  assert.ok(kinds.includes('not-sent'), '🔴 상한 없이 쌓인다 — 호출자가 영영 안 돌아온다');
});

test('관측한 한도를 반영한다 (추측값으로 계속 돌지 않는다)', async () => {
  const c = fakeClock();
  const q = createQueue(c);
  q.setLimit('RANKING', 5);
  let sent = 0;
  const ps = Array.from({ length: 5 }, () => q.run('RANKING', async () => { sent += 1; }));
  await c.advance(0);
  assert.equal(sent, 5, `🔴 한도 5 를 배웠는데 ${sent}건만 나갔다`);
  await Promise.all(ps);
});

// ── 배선 ─────────────────────────────────────────────────────────
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'tossClient.js'), 'utf-8');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** 🔴 큐 로직만 맞고 **안 불리면** 아무 의미가 없다 */
test('🔴 apiGet·apiPost 가 **둘 다** 큐를 탄다', () => {
  for (const fn of ['apiGet', 'apiPost']) {
    const i = code.indexOf(`async function ${fn}(`);
    assert.ok(i > 0, `${fn} 이 없다`);
    const block = code.slice(i, i + 500);
    assert.match(block, /tossQueue\.run\(/, `🔴 ${fn} 이 큐를 안 탄다 — 큐가 있으나 마나다`);
    assert.match(block, /tossGroupOf\(path\)/, `🔴 ${fn} 이 그룹을 안 넘긴다 — 전역 큐가 돼 서로를 막는다`);
  }
});

/** 🔴 **정본이 둘이면 안 된다** — 옛 백오프 게이트가 살아 있으면 큐와 따로 판단한다 */
test('🔴 옛 백오프 게이트가 **죽어 있다** (물러서기 정본은 큐 하나)', () => {
  assert.ok(!/\bbackoffActive\s*\(/.test(code),
    '🔴 backoffActive 가 아직 호출된다 — 큐와 둘이 각자 막으면 로그로 못 가른다');
});

test('🔴 관측한 한도를 큐에 **넘긴다** (추측값으로 계속 돌지 않는다)', () => {
  assert.match(code, /tossQueue\.setLimit\(/, '🔴 배운 한도를 큐가 모른다');
});

/** ⚠️ 401 재발급이 큐를 두 번 타면 한 칸을 두 번 먹는다 */
test('⚠️ 401 재발급은 큐를 다시 타지 않는다', () => {
  const i = code.indexOf('retriedAuth: true');
  assert.ok(i > 0, '재발급 경로가 없다');
  const block = code.slice(Math.max(0, i - 200), i + 120);
  assert.match(block, /apiGetOnce\(/, '🔴 재발급이 apiGet 을 다시 불러 큐를 두 번 탄다');
});

// ── 주문 대기 상한 ↔ 제안 TTL ↔ 멱등창 ────────────────────────────
/**
 * 🔴 **바깥이 안쪽보다 촘촘한가** (2026-09-22, pm2 지적 — 우리가 Probius 에서 세 번 밟은 가족)
 *
 * ```
 * 주문 큐 대기 상한  ← 이게 가장 짧아야 한다
 *   < 제안 TTL(10분)
 *     ≤ 토스 멱등창(10분)
 * ```
 * 순서가 깨지면:
 * - 큐 대기 > TTL 이면 **제안은 EXPIRED 인데 주문은 나간다**(상태가 갈려 무엇을 취소할지 모른다)
 * - TTL > 멱등창이면 **이중발주 둘째 층이 사라진다**(오늘 새벽에 잠근 것)
 *
 * ⚠️ 값이 **세 파일에 흩어져 있다** ⇒ 누가 하나만 바꾸면 조용히 뒤집힌다. 여기서 한 번에 본다.
 */
const queueMod = require('../server/tossQueue');

function freshOrders(env = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const k of Object.keys(require.cache)) if (/orderService/.test(k)) delete require.cache[k];
  const m = require('../server/orderService');
  process.env = saved;
  return m;
}

test('🔴 주문 큐 대기 상한 < 제안 TTL ≤ 멱등창', () => {
  const st = freshOrders().status();
  assert.ok(queueMod.ORDER_MAX_WAIT_MS > 0, '주문 대기 상한이 없다');
  assert.ok(
    queueMod.ORDER_MAX_WAIT_MS < st.proposalTtlMs,
    `🔴 주문이 큐에서 ${queueMod.ORDER_MAX_WAIT_MS}ms 기다릴 수 있는데 제안 TTL 은 ${st.proposalTtlMs}ms 다 `
    + '— 제안은 만료됐는데 주문이 나갈 수 있다',
  );
  assert.ok(
    st.proposalTtlMs <= st.idempotencyWindowMs,
    `🔴 TTL(${st.proposalTtlMs}) 이 멱등창(${st.idempotencyWindowMs}) 을 넘었다 — 이중발주 둘째 층이 사라진다`,
  );
});

/** 🔴 자의 판별력 — 뒤집으면 실제로 잡히는가 */
test('🔴 주문 대기 상한을 TTL 위로 올리면 **잡힌다**', () => {
  const st = freshOrders().status();
  const bad = st.proposalTtlMs + 1;
  assert.throws(() => { assert.ok(bad < st.proposalTtlMs); },
    '🔴 뒤집었는데 규칙이 통과한다 — 자가 장식이다');
});

test('⚠️ 주문 계열 그룹이 **전부** 짧은 상한을 쓴다(하나만 고치고 옆을 안 보는 그 병)', () => {
  for (const grp of ['ORDER', 'ORDER_INFO', 'CONDITIONAL_ORDER', 'ACCOUNT']) {
    assert.ok(queueMod.ORDER_GROUPS.has(grp), `🔴 ${grp} 이 긴 상한을 쓴다`);
  }
});

/** 🔴 마감시각이 지나면 **보내지 않는다** — 이게 pm2 가 짚은 구멍의 실제 방어다 */
test('🔴 큐에서 기다리다 유효시간이 지나면 **안 보낸다**', async () => {
  const c = fakeClock();
  const q = createQueue(c);
  let sent = 0;
  const blocker = q.run('ACCOUNT', async () => { sent += 1; });
  const late = settled(q.run('ACCOUNT', async () => { sent += 1; }, { deadlineAt: 500 }));
  await c.advance(0);
  await c.advance(1000);
  const got = await late;
  assert.equal(got.ok, false);
  assert.equal(got.e.kind, 'not-sent');
  assert.match(got.e.message, /유효시간이 지났습니다/);
  assert.equal(sent, 1, '🔴 유효시간이 지난 주문이 나갔다 — 제안은 EXPIRED 인데 주문은 체결될 수 있다');
  await blocker;
});

test('🔴 주문 실행이 제안 만료시각을 큐에 **실제로 넘긴다**', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'orderService.js'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const i = src.indexOf('toss.createOrder(');
  assert.ok(i > 0, 'createOrder 호출부가 없다');
  const block = src.slice(i, i + 200);
  assert.match(block, /deadlineAt/, '🔴 만료시각을 안 넘긴다 — 큐가 언제까지 유효한지 모른다');
  assert.match(block, /expiresAt/, '🔴 제안의 expiresAt 이 아니라 다른 값을 넘긴다');
});

// ── "안 나간 것" 도 되꽂는다 ──────────────────────────────────────
/**
 * 🔴 **처음 설계가 덜 갔다** (2026-09-22 라이브에서 드러남)
 *
 * 되꽂는 대상을 `rate-limited` 하나로 뒀는데, **`unreachable`·`not-sent` 는
 * 연결조차 못 맺은 것**이라 *"서버가 받고 거절한"* 429 **보다도** 안 나갔음이 확실하다.
 * 재시도 안전 판정의 근거를 내가 만들어 놓고 **정작 큐에서 안 썼다.**
 *
 * ⚠️ 대가가 실측으로 나왔다 — 도커 내장 DNS 간헐 실패(`EAI_AGAIN`)로
 *    **30분에 시세 갱신 1324건이 그냥 버려졌다.**
 * 🔴 그래도 **`unknown`·`timeout` 은 절대 안 넣는다** — 나갔는지 모르는 것이라 **두 번 산다.**
 */
const netErr = (kind) => Object.assign(new Error('토스에 연결하지 못했습니다(EAI_AGAIN 5015ms)'), { kind });

for (const kind of ['unreachable', 'not-sent']) {
  test(`🔴 \`${kind}\` 은 **되꽂는다** (나간 적이 없으니 안전)`, async () => {
    const c = fakeClock();
    const q = createQueue(c);
    let n = 0;
    const p = q.run('MARKET_DATA', async () => { n += 1; if (n === 1) throw netErr(kind); return 'ok'; });
    await c.advance(0);
    for (let i = 0; i < 4; i += 1) await c.advance(1500);
    assert.equal(await p, 'ok', `🔴 ${kind} 을 버렸다 — DNS 한 번 흔들리면 그 회차가 통째로 사라진다`);
    assert.equal(n, 2);
  });
}

/** 🔴🔴 여기를 넓히면 **두 번 주문**이 나간다 — 경계가 정확한지 본다 */
for (const kind of ['unknown', 'timeout']) {
  test(`🔴 \`${kind}\` 은 **절대 되꽂지 않는다** (나갔는지 모른다)`, async () => {
    const c = fakeClock();
    const q = createQueue(c);
    let n = 0;
    const r = settled(q.run('ORDER', async () => { n += 1; throw netErr(kind); }));
    await c.advance(0);
    for (let i = 0; i < 3; i += 1) await c.advance(1500);
    assert.equal((await r).ok, false);
    assert.equal(n, 1, `🔴 "${kind}" 을 ${n}번 보냈다 — 주문이 두 번 나갈 수 있다`);
  });
}

test('⚠️ 네트워크 실패는 429 보다 **길게** 쉰다 (초가 바뀐다고 DNS 가 낫지 않는다)', () => {
  assert.ok(queueMod.NET_RETRY_MS > queueMod.WINDOW_MS,
    `🔴 네트워크 재시도(${queueMod.NET_RETRY_MS}ms)가 429 창(${queueMod.WINDOW_MS}ms) 이하다 — 같은 실패를 바로 또 맞는다`);
});

test('🔴 재시도 대상 목록이 **정확히** 셋이다 (넓히면 두 번 주문)', () => {
  assert.deepEqual([...queueMod.RETRYABLE].sort(), ['not-sent', 'rate-limited', 'unreachable']);
  for (const bad of ['unknown', 'timeout', 'upstream', 'auth', 'idempotency-conflict']) {
    assert.ok(!queueMod.RETRYABLE.has(bad), `🔴 ${bad} 이 재시도 대상에 있다`);
  }
});

/** ⚠️ 계속 실패하면 **포기한다** — DNS 가 완전히 죽어도 큐가 영원히 돌지 않는다 */
test('⚠️ 네트워크가 계속 죽어 있으면 포기한다(무한 루프 없음)', async () => {
  const c = fakeClock();
  const q = createQueue(c);
  let n = 0;
  const r = settled(q.run('MARKET_DATA', async () => { n += 1; throw netErr('unreachable'); }));
  for (let i = 0; i < 30; i += 1) await c.advance(1500);
  assert.equal((await r).ok, false);
  assert.ok(n >= 2 && n <= 5, `🔴 재시도가 상한을 벗어났다: ${n}회`);
});

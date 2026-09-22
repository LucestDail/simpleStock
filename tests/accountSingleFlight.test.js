const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * 🔴 **계좌 조회 캐시 스탬피드** (2026-09-22 라이브에서 실제로 429 가 났다)
 *
 * `withAccount` 를 쓰는 함수가 **11개**인데 `getAccountSeq` 에 단일비행이 없었다.
 * TTL(10분)이 만료된 **그 순간** 동시 호출이 들어오면 각자 `/api/v1/accounts` 를 치는데,
 * **`ACCOUNT` 한도는 1/s** 라 즉시 429다.
 *
 * ⚠️ 실측: 감시를 13 → 41종목으로 늘린 직후 `portfolio.failed kind="rate-limited"` · `ACCOUNT 0/1`.
 *    캐시가 있으니 안전하다고 본 것이 **"캐시 미스가 동시에 일어나는 순간"** 을 안 본 것이다.
 * 🔴 **주문 직전에 나면 `send_unknown`** 이 된다 — 사람이 거래소를 확인해야 하는 상태.
 *    호출이 드문 그룹이라 방심하기 쉬운데 **드문 게 아니라 한도가 1일 뿐이다.**
 */

process.env.TOSS_CLIENT_ID = 'x';
process.env.TOSS_CLIENT_SECRET = 'y';

function fresh() {
  for (const k of Object.keys(require.cache)) if (/tossClient/.test(k)) delete require.cache[k];
  return require('../server/tossClient');
}

/** 토큰 1회 + 이후 accounts 응답. accounts 호출 횟수를 센다 */
function stub({ fail = false, delayMs = 20 } = {}) {
  const calls = { token: 0, accounts: 0 };
  global.fetch = async (url) => {
    const u = String(url);
    if (/oauth2\/token/.test(u)) {
      calls.token += 1;
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ access_token: 't', expires_in: 3600 }) };
    }
    if (/\/accounts/.test(u)) {
      calls.accounts += 1;
      await new Promise((r) => setTimeout(r, delayMs));
      /**
       * ⚠️ **429 를 쓰면 안 된다** — 클라이언트의 **물러서기(2초)** 가 발동해
       *    다음 호출이 in-flight 때문이 아니라 **백오프 때문에** 막힌다.
       *    첫 판에서 그걸 섞어 재고 "in-flight 가 안 비워졌다" 로 읽을 뻔했다.
       *    ⇒ 재려는 것만 재도록 **500** 으로 실패시킨다.
       */
      if (fail) return { ok: false, status: 500, headers: new Map(), json: async () => ({ error: { message: '서버 오류' } }) };
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ result: [{ accountSeq: '77' }] }) };
    }
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ result: [] }) };
  };
  return calls;
}

test('🔴 동시 10건이 들어와도 `/accounts` 는 **한 번만** 나간다', async () => {
  const t = fresh();
  const calls = stub();
  const got = await Promise.all(Array.from({ length: 10 }, () => t.getAccountSeq()));
  assert.deepEqual([...new Set(got)], ['77'], '결과가 갈렸다');
  assert.equal(calls.accounts, 1,
    `🔴 동시 호출이 각자 계좌를 조회했다(${calls.accounts}회) — ACCOUNT 한도 1/s 라 즉시 429다`);
});

test('캐시가 살아 있으면 아예 안 나간다', async () => {
  const t = fresh();
  const calls = stub();
  await t.getAccountSeq();
  await Promise.all(Array.from({ length: 5 }, () => t.getAccountSeq()));
  assert.equal(calls.accounts, 1);
});

/** 🔴 **실패를 영원히 나눠 쓰면 안 된다** — 안 비우면 한 번 실패한 뒤 계속 그 실패가 나온다 */
test('🔴 실패해도 in-flight 를 비운다 (다음 시도가 새로 나간다)', async () => {
  const t = fresh();
  const calls = stub({ fail: true });
  await Promise.allSettled(Array.from({ length: 4 }, () => t.getAccountSeq()));
  assert.equal(calls.accounts, 1, '실패도 한 번만 나가야 한다');
  // 두 번째 라운드 — 성공 응답으로 바꾼다
  const ok = stub({ fail: false });
  const seq = await t.getAccountSeq();
  assert.equal(seq, '77', '🔴 실패한 약속을 계속 나눠 쓴다 — 영영 복구 못 한다');
  assert.equal(ok.accounts, 1);
});

/** ⚠️ 자의 판별력 — 단일비행을 빼면 이 테스트가 실제로 깨지는가 */
test('⚠️ 단일비행이 없으면 동시 호출이 각자 나간다(대조군)', async () => {
  let n = 0;
  let cache = null;
  const naive = async () => {           // 단일비행 없는 옛 구현
    if (cache) return cache;
    n += 1;
    await new Promise((r) => setTimeout(r, 20));
    cache = '77';
    return cache;
  };
  await Promise.all(Array.from({ length: 10 }, naive));
  assert.equal(n, 10, '🔴 대조군이 1회로 끝났다 — 이 자가 단일비행을 재는 게 아니다');
});

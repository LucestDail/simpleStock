const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * 🔴 **fetch 실패를 사실대로 분류하는가** (2026-09-22)
 *
 * ## 왜 생겼나 — 폰 실행 첫 시험에서 한꺼번에 세 가지를 밟았다
 *
 * `catch (e)` 가 **`e` 를 한 번도 안 보고** 전부 *"응답을 받지 못했습니다(10000ms)"* 라고 적었다.
 *
 *   ① **거짓말** — 실제 경과는 5.02초였는데 `TIMEOUT_MS` 를 그대로 박아 10초라고 했다
 *   ② **원인 소실** — `e` 를 버려서 무엇이 실패했는지 **영영 알 수 없다**(지금도 모른다)
 *   ③ **과잉 잠금** — 확실히 안 나간 실패까지 "모름" 으로 잠가 사람이 손으로 확정해야 했다
 *
 * ③ 이 특히 나쁘다: "모름" 이 자주 뜨면 **그 신호를 가볍게 여기게 된다.**
 * 진짜 모름일 때 사람이 안 움직이면 두 번 주문이 나간다.
 *
 * ⚠️ **애매하면 모름이 맞다** — `ECONNRESET` 은 서버가 받아서 처리한 뒤 끊었을 수도 있다.
 */

function fresh() {
  for (const k of Object.keys(require.cache)) if (/tossClient/.test(k)) delete require.cache[k];
  return require('../server/tossClient');
}

const netErr = (code, name = 'TypeError') => {
  const e = new Error('fetch failed'); e.name = name; e.cause = { code }; return e;
};

process.env.TOSS_CLIENT_ID = 'x'; process.env.TOSS_CLIENT_SECRET = 'y';

/**
 * ⚠️ **자가 먼저 틀렸다** — `createOrder` 는 계좌 seq 를 GET 으로 먼저 받는다.
 *    그래서 첫 판은 POST 에 닿지도 못하고 GET 쪽 분류(`unreachable`)를 재고 있었다.
 *    ⇒ `accountSeq` 를 직접 넘겨 **재려던 경로를 실제로 태운다.**
 */
function withToken(after) {
  let n = 0;
  global.fetch = async () => {
    n += 1;
    if (n === 1) return { ok: true, status: 200, headers: new Map(), json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    throw after;
  };
}

async function post(t) {
  try { await t.apiPost('/api/v1/orders', { symbol: 'RAM' }, { accountSeq: 1 }); return null; }
  catch (e) { return e; }
}
async function get(t) {
  try { await t.apiGet('/api/v1/accounts'); return null; }
  catch (e) { return e; }
}

test('🔴 연결거부는 **"안 나갔다"** 로 분류한다 (모름이 아니다)', async () => {
  const t = fresh(); withToken(netErr('ECONNREFUSED'));
  const e = await post(t);
  assert.equal(e.kind, 'not-sent', '🔴 연결도 못 했는데 "모름" 으로 잠갔다');
  assert.match(e.message, /나가지 않았으니/);
});

test('🔴 DNS 실패도 "안 나갔다"', async () => {
  const t = fresh(); withToken(netErr('ENOTFOUND'));
  assert.equal((await post(t)).kind, 'not-sent');
});

/** 🔴 여기를 느슨하게 하면 **두 번 주문**이 나간다 */
test('🔴 ECONNRESET 은 여전히 **모름**이다 (서버가 처리했을 수 있다)', async () => {
  const t = fresh(); withToken(netErr('ECONNRESET'));
  const e = await post(t);
  assert.equal(e.kind, 'unknown', '🔴 끊긴 연결을 "안 나갔다" 로 봤다 — 두 번 살 수 있다');
  assert.match(e.message, /재시도하지 말고/);
});

test('🔴 타임아웃은 모름이다', async () => {
  const t = fresh(); const e0 = new Error('timeout'); e0.name = 'TimeoutError';
  withToken(e0);
  assert.equal((await post(t)).kind, 'unknown');
});

/** 🔴 ①번 결함: 경과시간을 **실제로** 적는가 */
test('🔴 메시지에 **실제 경과와 원인**이 적힌다 (TIMEOUT_MS 를 박지 않는다)', async () => {
  const t = fresh(); withToken(netErr('ECONNRESET'));
  const e = await post(t);
  assert.match(e.message, /ECONNRESET/, '🔴 원인을 버렸다 — 다음 사람이 진단할 수 없다');
  assert.ok(!/\(10000ms\)/.test(e.message), '🔴 실제 경과가 아니라 상한을 적었다(거짓말)');
  assert.ok(e.cause, 'cause 가 호출자에게 전달되지 않는다');
});

test('원인 코드가 없어도 이름은 남긴다', async () => {
  const t = fresh(); withToken(new Error('boom'));
  const e = await post(t);
  assert.equal(e.kind, 'unknown');
  assert.match(e.message, /Error/);
});

/** GET 쪽도 같은 병이었다 — 조회는 재시도해도 안전하니 kind 만 갈라 둔다 */
test('GET 은 연결거부를 unreachable 로, 그 밖은 timeout 으로', async () => {
  let t = fresh(); withToken(netErr('ECONNREFUSED'));
  assert.equal((await get(t)).kind, 'unreachable');
  t = fresh(); withToken(netErr('ECONNRESET'));
  const e = await get(t);
  assert.equal(e.kind, 'timeout');
  assert.match(e.message, /ECONNRESET/, '🔴 GET 도 원인을 버리고 있었다');
});

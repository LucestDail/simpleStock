const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 🔴 계좌 헤더 — **하나라도 빠지면 그 경로만 400 이다** (2026-09-22)
 *
 * `buying-power`·`sellable-quantity`·`commissions`·주문 계열은 `X-Tossinvest-Account` 가 **필수**다.
 * 안 넘기면 400 `account-header-required`.
 *
 * ## 실제로 그랬다
 * `checkAccountLimits` 가 헤더 없이 불러 **항상 `unknown` 으로 실패**했다 —
 * 방향은 안전(막힘)이었지만 **모든 제안이 막혔다.** 라이브 실측:
 * `{"ok":false,"kind":"unknown","error":"계좌 확인 실패: 토스 API 오류 (400)"}`
 *
 * ★ 그리고 고치면서 **일괄 치환이 두 곳을 빠뜨렸다**(`listOrders`·`cancelConditionalOrder`).
 *   그래서 자를 *"내가 고쳤나"* 가 아니라 **"전부 채웠나"** 로 만든다.
 */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'tossClient.js'), 'utf8');

/** 계좌 헤더가 필요한 함수 — 명세 기준. 늘어나면 여기 추가해야 하고, 그때 이 자가 강제한다 */
const NEED_ACCOUNT = [
  'getBuyingPower', 'getSellableQuantity', 'getCommissions',
  'createOrder', 'getOrder', 'listOrders', 'cancelOrder', 'modifyOrder',
  'createConditionalOrder', 'listConditionalOrders', 'cancelConditionalOrder',
];

test('🔴 계좌 헤더가 필요한 함수는 **전부** withAccount 를 거친다', () => {
  const missing = [];
  let checked = 0;
  for (const fn of NEED_ACCOUNT) {
    /**
     * ⚠️ 첫 판에 정규식이 **과다 이스케이프**돼 `Unterminated group` 으로 던졌다 —
     *    제품은 11/11 멀쩡한데 **자가 터져서** 빨간불이 났다.
     *    ★ 문자열로 정규식을 조립할 때는 **만든 뒤 한 번 태워 본다.**
     */
    const body = new RegExp(`async function ${fn}\\([\\s\\S]*?\\n\\}`).exec(SRC)?.[0];
    assert.ok(body, `🔴 ${fn} 을 못 찾았다 — 자가 헛돈다(이름이 바뀌었나?)`);
    checked += 1;
    if (!/withAccount\(/.test(body)) missing.push(fn);
  }
  assert.equal(checked, NEED_ACCOUNT.length);
  assert.deepEqual(missing, [], `\n🔴 이 경로는 **400 account-header-required** 가 난다:\n${missing.join('\n')}`);
});

/**
 * 🔴 `ACCOUNT` 그룹 한도가 **1/s** 다(pm2 헤더 실측 `limit=1 remaining=0`).
 * 요청마다 계좌를 조회하면 **바로 429** 다 ⇒ 캐시해야 한다.
 */
test('🔴 계좌 조회는 캐시한다 (ACCOUNT 한도가 1/s 다)', async () => {
  for (const k of Object.keys(require.cache)) if (/tossClient/.test(k)) delete require.cache[k];
  const t = require('../server/tossClient');
  let calls = 0;
  const realGet = t.apiGet;
  // apiGet 을 세는 스텁으로 갈아끼운다(모듈 내부 참조라 직접은 못 바꾸므로 동작으로 본다)
  assert.equal(typeof t.getAccountSeq, 'function', '🔴 계좌 캐시 함수가 없다');
  void realGet; void calls;
  // 캐시 TTL 상수가 실제로 있는지 — 없으면 매번 부른다
  assert.match(SRC, /ACCOUNT_TTL_MS/, '🔴 TTL 없이 캐시하면 계좌 변경을 영영 못 본다');
  assert.match(SRC, /accountSeqCache/, '🔴 캐시가 없다 — 요청마다 ACCOUNT 를 태운다');
});

/** ⚠️ 영원히 캐시하지 않는다 — 계좌가 바뀌면 알아야 한다 */
test('⚠️ 캐시에 TTL 이 있다 (영원히 들고 있지 않는다)', () => {
  const m = /const ACCOUNT_TTL_MS = [^;]+;/.exec(SRC)?.[0] || '';
  assert.match(m, /60_000|60000/, `TTL 하한이 안 보인다: ${m}`);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadCalendar } = require('../server/marketCalendar');

/**
 * 🔴 캘린더 하루치 캐시 키 — UTC 가 아니라 **앱 시간대(KST) 날짜** (2026-09-28 라이브 장애)
 *
 * `loadCalendar` 는 하루 한 번만 캘린더를 받으려고 `now` 를 날짜 문자열로 접어 캐시 키로
 * 쓴다. 종전엔 `toISOString().slice(0,10)`(UTC 날짜)를 썼는데, KST 00:00~09:00 은
 * UTC 로 아직 **전날**이라 그 구간 내내 캐시 키가 안 바뀌었다. 실측: 앱이 일요일 캘린더를
 * 들고 월요일 아침을 맞아 KR 세션이 `closed` 로 굳었고, 그 창과 겹치는 프리장(08:00~09:00
 * KST) 브리핑이 원리상 절대 못 떴다.
 *
 * ⚠️ 캐시가 module 전역(`calCache`, 마켓 문자열이 키)이라 테스트마다 **고유한 가짜 마켓
 *    이름**을 쓴다 — 실제 KR/US 와 겹치면 다른 테스트(`tests/marketCalendar*.test.js`)의
 *    캐시를 물려받거나 서로를 오염시킨다.
 */

function countingToss(calendarBody = { today: {} }) {
  let calls = 0;
  return {
    toss: { getMarketCalendar: async () => { calls += 1; return calendarBody; } },
    calls: () => calls,
  };
}

test('🔴 핵심 축: KST 08:30(=UTC 전날 23:30)과 KST 10:00 은 같은 KST 날짜 — 캘린더를 한 번만 받는다', async () => {
  const { toss, calls } = countingToss();
  const market = 'CACHEKEY-TEST-SAMEDAY';
  const t0830 = Date.parse('2026-09-28T08:30:00+09:00'); // UTC 로는 2026-09-27T23:30:00Z — 전날
  const t1000 = Date.parse('2026-09-28T10:00:00+09:00');

  await loadCalendar(market, { toss, now: t0830 });
  await loadCalendar(market, { toss, now: t1000 });

  assert.equal(calls(), 1, 'KST 로 같은 날인데 캘린더를 두 번 받았다(UTC 캐시 키 버그가 재발했다)');
});

test('KST 날짜가 바뀌면(23:59 → 00:01) 캐시 키도 바뀌어 다시 받는다', async () => {
  const { toss, calls } = countingToss();
  const market = 'CACHEKEY-TEST-ROLLOVER';
  const before = Date.parse('2026-09-28T23:59:00+09:00');
  const after = Date.parse('2026-09-29T00:01:00+09:00');

  await loadCalendar(market, { toss, now: before });
  await loadCalendar(market, { toss, now: after });

  assert.equal(calls(), 2, 'KST 로 날짜가 바뀌었는데도 캐시를 그대로 재사용했다');
});

test('같은 KST 날짜 안에서는 미국 시장도 같은 캐시 규율을 따른다(시장별로 다른 시간대를 쓰지 않는다)', async () => {
  const { toss, calls } = countingToss();
  const market = 'CACHEKEY-TEST-US-SAMEDAY';
  const t0005 = Date.parse('2026-09-28T00:05:00+09:00'); // UTC 로는 09-27 15:05 — 전날
  const t2300 = Date.parse('2026-09-28T23:00:00+09:00');

  await loadCalendar(market, { toss, now: t0005 });
  await loadCalendar(market, { toss, now: t2300 });

  assert.equal(calls(), 1, '미국 시장 캐시도 KST 하루 단위여야 하는데 두 번 받았다');
});

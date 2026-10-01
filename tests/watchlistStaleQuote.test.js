const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isSelfDeclaredStale, QUOTE_STALE_MS } = require('../server/watchlistService');

/**
 * 관심종목 시세의 **낡음 판정** — 2026-10-01
 *
 * ## 무엇이 아팠나 (라이브 실측 2026-10-01 11:4x)
 *
 * 시세 저장소에 같은 종목이 두 키로 들어 있었고, `buildQuoteIndex` 가 **먼저 온 것을**
 * 골랐다:
 * ```
 * key=QLD      yahoo-finance  91.72  +4.63%   updatedAt 2026-05-08   ← 5개월 전. 이게 이겼다
 * key=US:QLD   toss           96.74  +1.596%  updatedAt 없음          ← 현재
 * ```
 * **보유 종목인데** 관심종목 화면에 5개월 묵은 값이 떠 있었다. 공급자를 yahoo → toss 로
 * 바꿀 때 옛 키가 안 지워져 남은 것으로 보인다.
 *
 * ## 이 자가 지키는 경계 — 두 방향이 다 필요하다
 *
 * ```
 * 발동   본인이 "N일 전 값" 이라고 적어 둔 것은 버린다        ← 안 지키면 낡은 값이 다시 산다
 * 오탐   시각이 **없거나 못 읽는** 것은 낡았다고 단정 안 한다  ← 안 지키면 toss 시세가 통째로 날아간다
 * ```
 * 🔴 오탐 쪽이 더 위험하다. `updatedAt` 없는 toss 시세가 **330건**이다 — 그걸 낡았다고
 *    읽으면 화면의 시세가 전부 사라진다. "모르는 것을 나쁜 쪽으로 단정" 하는 실수가
 *    여기서는 제품을 통째로 끈다.
 */

const DAY = 24 * 60 * 60_000;
const now = Date.parse('2026-10-01T02:40:00Z');

test('임계값보다 오래됐다고 스스로 적은 시세는 낡은 것이다', () => {
  // 라이브에서 실제로 잡힌 그 값
  assert.equal(isSelfDeclaredStale({ updatedAt: '2026-05-08T20:00:00.000Z' }, now), true);
});

test('방금 찍힌 시세는 낡지 않았다', () => {
  assert.equal(isSelfDeclaredStale({ updatedAt: new Date(now - 60_000).toISOString() }, now), false);
});

test('updatedAt 이 없으면 낡았다고 단정하지 않는다 (toss 시세 330건이 여기 걸린다)', () => {
  assert.equal(isSelfDeclaredStale({ price: 96.74 }, now), false);
  assert.equal(isSelfDeclaredStale({ updatedAt: null }, now), false);
  assert.equal(isSelfDeclaredStale({ updatedAt: '' }, now), false);
});

test('읽을 수 없는 시각도 낡았다고 단정하지 않는다', () => {
  // 🔴 `Date.parse` 실패를 NaN 으로 받아 "아주 오래됨" 으로 읽으면 전부 버려진다
  assert.equal(isSelfDeclaredStale({ updatedAt: '어제' }, now), false);
  assert.equal(isSelfDeclaredStale({ updatedAt: 'not-a-date' }, now), false);
});

test('null·undefined 시세에 터지지 않는다', () => {
  assert.equal(isSelfDeclaredStale(null, now), false);
  assert.equal(isSelfDeclaredStale(undefined, now), false);
});

test('경계: 임계값 직전은 살고, 직후는 죽는다', () => {
  const 직전 = new Date(now - QUOTE_STALE_MS + 1000).toISOString();
  const 직후 = new Date(now - QUOTE_STALE_MS - 1000).toISOString();
  assert.equal(isSelfDeclaredStale({ updatedAt: 직전 }, now), false);
  assert.equal(isSelfDeclaredStale({ updatedAt: 직후 }, now), true);
});

test('미래 시각은 낡은 것이 아니다 (시계가 어긋나도 멀쩡한 시세를 버리지 않는다)', () => {
  assert.equal(isSelfDeclaredStale({ updatedAt: new Date(now + DAY).toISOString() }, now), false);
});

test('임계값이 하루보다 짧게 설정되지 않았다', () => {
  // 장이 쉬는 주말을 넘겨야 하므로 너무 짧으면 월요일 아침에 멀쩡한 금요일 종가를 버린다
  assert.ok(QUOTE_STALE_MS >= 2 * DAY, `임계값이 ${QUOTE_STALE_MS / DAY}일 — 주말을 못 넘긴다`);
});

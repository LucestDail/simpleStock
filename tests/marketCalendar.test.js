const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveSession, isWeekend, sessionStateByHour } = require('../server/marketCalendar');
const { getMarketSessionSnapshot } = require('../server/marketDataService');

/**
 * 장 운영 상태 — 요일 판정 (2026-09-21 실결함 가드)
 *
 * 종전에는 **시각만** 봐서 토요일 오전 10시도 `open` 이었다.
 * ★ 가장 틀리기 쉬운 자리는 **미국장의 요일을 KST 로 자르는 것**이다.
 *   KST 토요일 새벽 = 뉴욕 금요일 오후 = **정상 개장**. 그래서 US 는 뉴욕 요일로 본다.
 */

const KST = 'Asia/Seoul';
/** KST 기준 시각을 UTC Date 로 (KST = UTC+9, 서머타임 없음) */
const kst = (iso) => new Date(`${iso}+09:00`);

test('🔴 한국장 — 토요일 장중 시각은 닫혀 있다', () => {
  const sat = kst('2026-09-19T10:00:00'); // 토
  const r = resolveSession(sat, 'KR', 9, 16, KST);
  assert.equal(r.state, 'closed');
  assert.equal(r.reason, 'weekend');
});

test('한국장 — 평일 장중은 열려 있다 (자의 판별력: 전부 닫는 자가 아니다)', () => {
  const mon = kst('2026-09-21T10:00:00'); // 월
  assert.equal(resolveSession(mon, 'KR', 9, 16, KST).state, 'open');
});

test('한국장 — 평일 장전/장후는 기존 판정 그대로', () => {
  assert.equal(resolveSession(kst('2026-09-21T08:00:00'), 'KR', 9, 16, KST).state, 'pre');
  assert.equal(resolveSession(kst('2026-09-21T17:00:00'), 'KR', 9, 16, KST).state, 'closed');
});

test('🔴 미국장 — KST 토요일 새벽은 뉴욕 금요일이라 **열려 있어야** 한다', () => {
  // KST 2026-09-19(토) 03:00 = 뉴욕 2026-09-18(금) 14:00
  const r = resolveSession(kst('2026-09-19T03:00:00'), 'US', 22, 5, KST);
  assert.equal(
    r.state,
    'open',
    'KST 요일로 잘라서 미국 금요일장을 닫아 버렸다 — 시간대 변환을 빠뜨린 전형이다'
  );
});

test('미국장 — 뉴욕 기준 토요일은 닫혀 있다', () => {
  // KST 2026-09-20(일) 03:00 = 뉴욕 2026-09-19(토) 14:00
  const r = resolveSession(kst('2026-09-20T03:00:00'), 'US', 22, 5, KST);
  assert.equal(r.state, 'closed');
  assert.equal(r.reason, 'weekend');
});

test('isWeekend 는 시장 현지 요일로 판정한다', () => {
  const t = kst('2026-09-19T03:00:00'); // KST 토 / NY 금
  assert.equal(isWeekend(t, 'KR').weekend, true);
  assert.equal(isWeekend(t, 'US').weekend, false);
});

test('시각 판정 자체는 바뀌지 않았다 (회귀 방지)', () => {
  assert.equal(sessionStateByHour(8, 9, 16), 'pre');
  assert.equal(sessionStateByHour(10, 9, 16), 'open');
  assert.equal(sessionStateByHour(16, 9, 16), 'closed');
  // 자정을 넘는 창
  assert.equal(sessionStateByHour(23, 22, 5), 'open');
  assert.equal(sessionStateByHour(3, 22, 5), 'open');
  // ⚠️ 자정을 넘는 창에서 정오는 'closed' 가 아니라 'pre' 다 — **오늘 밤 개장 전**이라는 뜻.
  //    처음에 'closed' 로 적었다가 틀렸다(제품이 맞았다). 기대값을 짐작으로 쓰지 말 것.
  assert.equal(sessionStateByHour(12, 22, 5), 'pre');
});

test('스냅샷이 실제로 이 로직을 쓴다 (배선 확인 — 로직만 맞고 안 불리는 것을 막는다)', async () => {
  // 캘린더를 못 읽으면 폴백으로 내려간다 — 그 경로도 여전히 요일을 본다
  const failing = { toss: { getMarketCalendar: async () => { throw new Error('no network'); } } };
  const snap = await getMarketSessionSnapshot(kst('2026-09-19T10:00:00'), failing); // 토
  assert.equal(snap.sessions.kr.state, 'closed');
  assert.equal(snap.sessions.kr.reason, 'weekend');
  assert.equal(snap.sessions.kr.source, 'fallback');
});

/**
 * 🔴 **값만 바꾸지 않았다.** 이 자리에 원래 *"공휴일은 아직 모른다"* 를 못박은 테스트가 있었고,
 *    거기에 **"바꿀 때는 정말 휴장일을 보는지 증명하는 테스트로 교체하라"** 고 적혀 있었다.
 *    ⇒ 캘린더를 주입해 **실제로 휴장 응답을 먹여 보고** 판정한다.
 */
test('🔴 휴장일을 **실제로 본다** (캘린더를 먹여서 증명)', async () => {
  const holiday = { date: '2026-01-01', dayMarket: null, preMarket: null, regularMarket: null, afterMarket: null };
  const deps = { toss: { getMarketCalendar: async () => ({ today: holiday }) } };
  const snap = await getMarketSessionSnapshot(kst('2026-01-01T10:00:00'), deps);
  assert.equal(snap.sessions.kr.state, 'closed', '🔴 휴장일 오전 10시를 장중으로 봤다');
  assert.equal(snap.sessions.kr.holidayAware, true);
  assert.equal(snap.sessions.kr.source, 'calendar');
  assert.match(snap.sessions.kr.reason, /캘린더/);
});

/** ⚠️ 반대로 **못 읽었으면 안다고 말하지 않는다** — 그게 이 필드의 존재 이유다 */
test('⚠️ 캘린더를 못 읽으면 holidayAware 가 false 로 내려간다', async () => {
  const deps = { toss: { getMarketCalendar: async () => { throw new Error('boom'); } } };
  const snap = await getMarketSessionSnapshot(kst('2026-01-02T10:00:00'), deps);
  assert.equal(snap.sessions.kr.holidayAware, false, '🔴 못 읽었는데 휴장일을 안다고 말한다');
  assert.equal(snap.sessions.kr.source, 'fallback');
  // ⚠️ 폴백은 **종전 어휘를 그대로** 쓴다(weekend/schedule) — 문구를 덮으면 기존 소비자가 깨진다
  assert.match(snap.sessions.kr.reason, /^(weekend|schedule)$/);
});

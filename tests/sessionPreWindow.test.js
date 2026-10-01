const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sessionFromCalendar } = require('../server/marketCalendar');

/**
 * `pre` 는 **프리장 창 안**일 때만이다 — 2026-10-01
 *
 * ## 무엇이 아팠나 (라이브 실측 2026-10-01 11:47 KST)
 *
 * ```
 * session:us = 'pre'      ← 마감 6시간 후, 프리장 5시간 전인데 'pre'
 * analyst.sessions = {"us":"pre","kr":"open"}
 * lastCloseDay = {}       ← 양 시장 모두 한 번도 안 채워졌다
 * ```
 *
 * 종전 조건은 `nowMs < today.regular.start` **하나**였다. 미국장의 '오늘 정규장' 은
 * KST 22:30 시작이라, 05:00 에 끝난 뒤 **17시간 내내** 그 조건이 참이다 ⇒ 미국장은
 * `open → pre` 로 가고 **`closed` 를 한 번도 거치지 않는다.**
 *
 * 마감 브리핑은 **`closed` 로의 전이**로 발동한다(`analystTrigger`) ⇒
 * **미국장 마감 브리핑이 원리상 한 번도 뜰 수 없었다.** 설계된 정기 브리핑 7회차 중
 * 하나이고, 보유가 **둘 다 미국 종목**인데 그 요약을 못 받고 있었다. 대신 05:00 에
 * `open→pre` 전이가 나서 **"🔔 미국장 장 전"** 이 갔다 — 마감인데.
 *
 * ★ **같은 코드가 시장에 따라 다르게 동작했다.** 한국장은 정규장이 09:00 라 15:30 뒤에는
 *   조건이 거짓 ⇒ `closed` 로 정상 동작. 그래서 "US 만 안 된다" 로 보여 시장별 설정을
 *   의심하기 쉬웠다. 원인은 **공용 코드의 시간 가정**이었다.
 *
 * ## 이 자가 지키는 두 방향
 * ```
 * 발동  프리장 창 **밖**이면 closed 다           ← 안 지키면 마감 전이가 사라진다
 * 오탐  프리장 창 **안**이면 여전히 pre 다        ← 안 지키면 "장 전" 알림이 통째로 죽는다
 * ```
 */

const H = 60 * 60_000;
/** KST 시각 → epoch (KST = UTC+9, 서머타임 없음) */
const kst = (iso) => Date.parse(`${iso}+09:00`);

/** `sessionFromCalendar` 가 받는 모양 — US 는 최상위, KR 은 `integrated` 안 */
const usDay = (date, regStart, regEnd, preStart = null, preEnd = null) => ({
  date,
  regularMarket: { startTime: new Date(regStart).toISOString(), endTime: new Date(regEnd).toISOString() },
  ...(preStart ? { preMarket: { startTime: new Date(preStart).toISOString(), endTime: new Date(preEnd).toISOString() } } : {}),
});

/**
 * 미국장 하루 — KST 기준. 정규장은 **전날 22:30 → 당일 05:00** 으로 날짜를 넘는다.
 * 캘린더의 `today` 는 "오늘 열릴 장"(22:30~내일 05:00)이고, `previousBusinessDay` 가
 * 방금 끝난 장(어제 22:30~오늘 05:00)이다 — 이 비대칭이 결함의 무대였다.
 */
function usDays(d = '2026-10-01') {
  return {
    previousBusinessDay: usDay('2026-09-30', kst('2026-09-30T22:30:00'), kst('2026-10-01T05:00:00'),
      kst('2026-09-30T17:00:00'), kst('2026-09-30T22:30:00')),
    today: usDay(d, kst('2026-10-01T22:30:00'), kst('2026-10-02T05:00:00'),
      kst('2026-10-01T17:00:00'), kst('2026-10-01T22:30:00')),
    nextBusinessDay: null,
  };
}

const krDays = () => ({
  previousBusinessDay: null,
  today: {
    date: '2026-10-01',
    integrated: {
      regularMarket: { startTime: new Date(kst('2026-10-01T09:00:00')).toISOString(), endTime: new Date(kst('2026-10-01T15:30:00')).toISOString() },
      preMarket: { startTime: new Date(kst('2026-10-01T08:00:00')).toISOString(), endTime: new Date(kst('2026-10-01T09:00:00')).toISOString() },
    },
  },
  nextBusinessDay: null,
});

// ── 미국장: 결함이 살던 자리 ───────────────────────────────────────

test('🔴 미국장 — 마감 직후(05:30 KST)는 closed 다 (종전엔 pre 였다)', () => {
  const r = sessionFromCalendar(kst('2026-10-01T05:30:00'), usDays());
  assert.equal(r.state, 'closed', '마감 전이가 여기서 나야 마감 브리핑이 뜬다');
});

test('🔴 미국장 — 라이브에서 실제로 잡힌 그 시각(11:47 KST)도 closed 다', () => {
  const r = sessionFromCalendar(kst('2026-10-01T11:47:00'), usDays());
  assert.equal(r.state, 'closed');
});

test('미국장 — 프리장 창 안(17:00~22:30)은 여전히 pre 다 (오탐 축)', () => {
  assert.equal(sessionFromCalendar(kst('2026-10-01T17:00:00'), usDays()).state, 'pre');
  assert.equal(sessionFromCalendar(kst('2026-10-01T20:00:00'), usDays()).state, 'pre');
});

test('미국장 — 프리장 시작 1분 전은 아직 closed, 시작 시각은 pre (경계)', () => {
  assert.equal(sessionFromCalendar(kst('2026-10-01T17:00:00') - 60_000, usDays()).state, 'closed');
  assert.equal(sessionFromCalendar(kst('2026-10-01T17:00:00'), usDays()).state, 'pre');
});

test('미국장 — 정규장 중(23:00 KST)은 open 이다 (멀쩡한 것을 깨지 않았다)', () => {
  assert.equal(sessionFromCalendar(kst('2026-10-01T23:00:00'), usDays()).state, 'open');
});

test('미국장 — 전일 장 진행 중(04:00 KST)도 open 이다 (날짜를 넘는 장)', () => {
  assert.equal(sessionFromCalendar(kst('2026-10-01T04:00:00'), usDays()).state, 'open');
});

test('🔴 미국장 — open → closed 전이가 실제로 일어난다 (마감 브리핑의 전제)', () => {
  const days = usDays();
  const 직전 = sessionFromCalendar(kst('2026-10-01T05:00:00') - 60_000, days).state;
  const 직후 = sessionFromCalendar(kst('2026-10-01T05:00:00') + 60_000, days).state;
  assert.equal(직전, 'open');
  assert.equal(직후, 'closed', 'open→pre 로 건너뛰면 마감 브리핑이 원리상 안 뜬다');
});

// ── 한국장: 회귀가 나면 안 되는 쪽 ─────────────────────────────────

test('한국장 — 프리장 창(08:00~09:00)은 pre 다', () => {
  assert.equal(sessionFromCalendar(kst('2026-10-01T08:30:00'), krDays()).state, 'pre');
});

test('한국장 — 새벽 02:00 은 closed 다 (프리장 전이라 "곧 연다" 고 말하지 않는다)', () => {
  assert.equal(sessionFromCalendar(kst('2026-10-01T02:00:00'), krDays()).state, 'closed');
});

test('한국장 — 장중·마감 후 판정은 그대로다', () => {
  assert.equal(sessionFromCalendar(kst('2026-10-01T10:00:00'), krDays()).state, 'open');
  assert.equal(sessionFromCalendar(kst('2026-10-01T16:00:00'), krDays()).state, 'closed');
});

// ── 프리장 정보가 없을 때 ──────────────────────────────────────────

test('프리장 정보가 없으면 pre 라고 말하지 않는다 (근거 없는 주장을 안 한다)', () => {
  const days = {
    previousBusinessDay: null,
    today: usDay('2026-10-01', kst('2026-10-01T22:30:00'), kst('2026-10-02T05:00:00')), // pre 없음
    nextBusinessDay: null,
  };
  assert.equal(sessionFromCalendar(kst('2026-10-01T11:00:00'), days).state, 'closed');
  // ⚠️ 잃는 것은 그런 날의 "장 전" 알림 하나이고, 얻는 것은 마감 전이다.
  //    open 전이는 영향 없다 — closed→open 이든 pre→open 이든 전이는 전이다.
  assert.equal(sessionFromCalendar(kst('2026-10-01T23:00:00'), days).state, 'open');
});

test('휴장일(정규장 없음)은 그대로 closed 다', () => {
  const days = { previousBusinessDay: null, today: { date: '2026-10-03' }, nextBusinessDay: null };
  assert.equal(sessionFromCalendar(kst('2026-10-03T11:00:00'), days).state, 'closed');
});

test('preSpan 은 상태와 무관하게 계속 실린다 (프리장 브리핑이 이걸 직접 본다)', () => {
  // 🔴 프리장 **개장 브리핑**은 state 가 아니라 preSpan 을 본다 — 그 경로가 안 끊겼는지 확인
  const r = sessionFromCalendar(kst('2026-10-01T11:47:00'), usDays());
  assert.equal(r.state, 'closed');
  assert.equal(r.preSpan?.start, kst('2026-10-01T17:00:00'));
});

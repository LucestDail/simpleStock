const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCalendarDay, sessionFromCalendar } = require('../server/marketCalendar');

/**
 * 장 캘린더 (2026-09-22) — **하드코딩이 실제와 어긋나 있었다**
 *
 * ```
 *        하드코딩      실제(토스 캘린더 라이브)
 * KRX    09~16시      09:00 ~ **15:30**     ⇒ 마감을 30분 늦게 잡았다
 * 미국장  22~06시      22:30 ~ **05:00**     ⇒ 개장 30분 이르고 마감 1시간 늦었다
 * ```
 * ⚠️ 어젯밤 만든 **장마감 분석 트리거가 이 추정 위에 서 있었다.**
 *
 * ## 🔴 두 시장의 **모양이 다르다** — 지문은 라이브 실물이다
 * `US` 는 최상위에 4세션, `KR` 은 `integrated` 안에 3세션. 한쪽만 보고 짜면 **조용히 깨진다.**
 */

/** 라이브 실물 (2026-09-22) */
const US_DAY = {
  date: '2026-09-22',
  dayMarket: { startTime: '2026-09-22T09:00:00.000+09:00', endTime: '2026-09-22T17:00:00.000+09:00' },
  preMarket: { startTime: '2026-09-22T17:00:00.000+09:00', endTime: '2026-09-22T22:30:00.000+09:00' },
  regularMarket: { startTime: '2026-09-22T22:30:00.000+09:00', endTime: '2026-09-23T05:00:00.000+09:00' },
  afterMarket: { startTime: '2026-09-23T05:00:00.000+09:00', endTime: '2026-09-23T08:50:00.000+09:00' },
};
const KR_DAY = {
  date: '2026-09-22',
  integrated: {
    preMarket: { startTime: '2026-09-22T08:00:00.000+09:00', endTime: '2026-09-22T09:00:00.000+09:00' },
    regularMarket: { startTime: '2026-09-22T09:00:00.000+09:00', endTime: '2026-09-22T15:30:00.000+09:00' },
    afterMarket: { startTime: '2026-09-22T15:30:00.000+09:00', endTime: '2026-09-22T20:00:00.000+09:00' },
  },
};
const at = (iso) => Date.parse(iso);

test('🔴 미국 — 정규장 22:30~05:00 을 읽는다 (하드코딩 22~06 이 아니다)', () => {
  const d = normalizeCalendarDay(US_DAY);
  assert.equal(d.regular.start, at('2026-09-22T22:30:00+09:00'));
  assert.equal(d.regular.end, at('2026-09-23T05:00:00+09:00'));
});

test('🔴 국내 — `integrated` 안을 읽고 마감이 15:30 이다 (하드코딩 16시가 아니다)', () => {
  const d = normalizeCalendarDay(KR_DAY);
  assert.ok(d.regular, '🔴 integrated 를 못 읽었다 — 국내가 통째로 "모름" 이 된다');
  assert.equal(d.regular.end, at('2026-09-22T15:30:00+09:00'));
});

test('🔴 프리·애프터는 정규장이 아니다 (마감 요약이 늦으면 안 된다)', () => {
  const days = { today: US_DAY };
  assert.equal(sessionFromCalendar(at('2026-09-22T20:00:00+09:00'), days).state, 'closed', '프리마켓을 open 으로 봤다');
  assert.equal(sessionFromCalendar(at('2026-09-23T06:00:00+09:00'), days).state, 'closed', '애프터마켓을 open 으로 봤다');
  assert.equal(sessionFromCalendar(at('2026-09-23T01:00:00+09:00'), days).state, 'open');
});

test('경계 — 시작은 포함, 끝은 제외', () => {
  const days = { today: US_DAY };
  assert.equal(sessionFromCalendar(at('2026-09-22T22:30:00+09:00'), days).state, 'open');
  assert.equal(sessionFromCalendar(at('2026-09-23T05:00:00+09:00'), days).state, 'closed', '🔴 마감 시각에 아직 열려 있다');
});

/** ⚠️ 휴장일은 세션이 **null** 이다(키가 없는 게 아니다) */
test('⚠️ 휴장일은 하루 종일 닫혀 있다', () => {
  const holiday = { date: '2026-07-03', dayMarket: null, preMarket: null, regularMarket: null, afterMarket: null };
  const r = sessionFromCalendar(at('2026-07-03T23:00:00+09:00'), { today: holiday });
  assert.equal(r.state, 'closed');
  assert.equal(r.source, 'calendar', '🔴 휴장을 "모름" 으로 읽으면 폴백이 열어 버린다');
});

/** 🔴 전날 정규장이 자정을 넘겨 이어진다 — 오늘만 보면 **개장 중인데 닫혔다**고 한다 */
test('🔴 전날 미국장이 새벽까지 이어지는 것을 본다', () => {
  const prev = { ...US_DAY, date: '2026-09-21',
    regularMarket: { startTime: '2026-09-21T22:30:00.000+09:00', endTime: '2026-09-22T05:00:00.000+09:00' } };
  const r = sessionFromCalendar(at('2026-09-22T03:00:00+09:00'), { previousBusinessDay: prev, today: US_DAY });
  assert.equal(r.state, 'open', '🔴 새벽 3시 미국장을 닫힌 것으로 봤다');
});

test('모양이 예상과 다르면 null (조용히 닫지 않는다)', () => {
  assert.equal(normalizeCalendarDay(null), null);
  assert.equal(sessionFromCalendar(Date.now(), {}), null, '🔴 빈 응답을 "닫힘" 으로 단정했다');
  assert.equal(sessionFromCalendar(Date.now(), null), null);
});

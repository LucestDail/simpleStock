const { test } = require('node:test');
const assert = require('node:assert/strict');
const trigger = require('../server/analystTrigger');
const { kstDay } = require('../server/time');

/**
 * 🔴 **KST 00:00~08:59 는 UTC 로 전날이다 — 그 대역 회차가 날짜 판정에서 죽었다** (2026-09-30).
 *
 * 실제로 있었던 것: `sameDayMark` 가 UTC 폴백(`toISOString().slice(0,10)`)을 함께 인정해서,
 * **어제 저장한 KST 날짜**와 **오늘 아침 회차의 UTC 날짜**가 같아졌다 ⇒ *"오늘 이미 보냈다"* 로
 * 오판하고 **조용히 건너뛰었다.** 결과는 **프리장 격일 발화**.
 * ```
 * 09-29 08:03 발화 → 저장 "2026-09-29"
 * 09-30 08:00      → UTC 가 "2026-09-29" 라 매칭 → 건너뜀 🔴 (라이브 실측)
 * ```
 *
 * ⚠️ **프리장만 고정하지 않는다**(pm2 지적) — 같은 대역에 다른 회차가 들어오면 같은 병에 걸린다.
 *    그래서 **대역 전체**를 골든으로 못박는다.
 * ⚠️ **실제 호출 모양으로 부른다** — `alertService.tick` 은 `new Date()` 를 넘긴다.
 *    이 파일을 숫자로 불렀다가 09-22 에 `lastRunAt` NaN 버그를 놓친 전례가 이 저장소에 있다
 *    (`decide` 주석). 자가 *실제 호출 모양*을 안 재면 프로덕션과 다른 것을 잰다.
 */

const KST = 9 * 3600e3;
const kstAt = (y, m, d, hh, mm = 0) => Date.UTC(y, m - 1, d, hh, mm) - KST;
const utcSlice = (ms) => new Date(ms).toISOString().slice(0, 10);

function krSession(day) {
  return {
    key: 'kr',
    label: 'KRX',
    state: 'pre',
    source: 'calendar',
    preSpan: { start: kstAt(2026, 9, day, 8, 0), end: kstAt(2026, 9, day, 9, 0) },
    regular: { start: kstAt(2026, 9, day, 9, 0), end: kstAt(2026, 9, day, 15, 30) },
  };
}

/** 실제 호출 모양: now 는 Date */
function run(day, state) {
  return trigger.decide({
    now: new Date(kstAt(2026, 9, day, 8, 30)),
    sessions: [krSession(day)],
    symbols: [],
    state,
  });
}

// ── 대역 자체를 못박는다 ────────────────────────────────────────────────
test('🔴 골든: KST 00:00~08:59 는 UTC 로 전날이다 (이 대역 회차가 위험하다)', () => {
  for (let h = 0; h <= 8; h += 1) {
    const ms = kstAt(2026, 9, 30, h, 30);
    assert.equal(kstDay(ms), '2026-09-30', `KST ${h}시는 09-30 이어야 한다`);
    assert.equal(utcSlice(ms), '2026-09-29', `KST ${h}시의 UTC 날짜는 전날이다 — 이 어긋남이 결함의 원인이었다`);
  }
  // 09시부터는 어긋나지 않는다 — 그래서 개장(09:00)·장중·마감은 이 병을 안 겪었다
  const at9 = kstAt(2026, 9, 30, 9, 30);
  assert.equal(kstDay(at9), utcSlice(at9), 'KST 09시 이후는 UTC 날짜와 같다');
});

// ── 핵심 회귀: 연속 이틀 발화 ───────────────────────────────────────────
test('🔴 회귀: 프리장이 이틀 연속 뜬다 (격일이 아니다)', () => {
  let state = { lastPreopenDay: {}, mid: {}, sessions: {}, momentum: {}, pending: [] };

  const d29 = run(29, state);
  assert.ok(d29.reasons.some((r) => r.kind === 'preopen'), '09-29 프리장이 떠야 한다');
  state = d29.state;
  assert.equal(state.lastPreopenDay.kr, '2026-09-29', 'KST 날짜로 저장해야 한다');

  const d30 = run(30, state);
  assert.ok(
    d30.reasons.some((r) => r.kind === 'preopen'),
    '🔴 09-30 프리장이 안 떴다 — UTC 폴백이 되살아났다(어제 KST 날짜 == 오늘 UTC 날짜)',
  );
});

test('🔴 자기검증: UTC 폴백을 되살리면 이 자가 잡는다', () => {
  // 폴백이 있었다면 09-30 회차에서 stored "2026-09-29" 가 UTC 날짜와 매칭됐다
  const stored = '2026-09-29';
  const preStart = kstAt(2026, 9, 30, 8, 0);
  assert.equal(utcSlice(preStart), stored, '전제: 09-30 08:00 의 UTC 날짜가 어제 저장값과 같다');
  assert.notEqual(kstDay(preStart), stored, 'KST 로 보면 다르다 — 그래서 KST 하나로만 판정해야 한다');
});

// ── 같은 날 중복은 여전히 막는다 (반대 방향 오탐 방지) ──────────────────
test('⚠️ 오탐 없음: 같은 날 두 번 부르면 두 번째는 안 뜬다', () => {
  let state = { lastPreopenDay: {}, mid: {}, sessions: {}, momentum: {}, pending: [] };
  const first = run(30, state);
  assert.ok(first.reasons.some((r) => r.kind === 'preopen'), '첫 호출은 떠야 한다');
  const second = run(30, first.state);
  assert.ok(!second.reasons.some((r) => r.kind === 'preopen'), '같은 날 두 번째는 막혀야 한다(중복 발화 금지)');
  assert.ok(
    (second.skipped || []).some((s) => s.kind === 'preopen' && s.why === 'already_sent'),
    '막았으면 **이유를 남겨야** 한다 — 이번 결함을 손계산으로 찾은 이유가 그게 없어서였다',
  );
});

// ── skipped 계약 ───────────────────────────────────────────────────────
test('🔴 탈락 사유가 밖으로 나온다 (조용한 continue 금지)', () => {
  const state = { lastPreopenDay: {}, mid: {}, sessions: {}, momentum: {}, pending: [] };
  const noSpan = trigger.decide({
    now: new Date(kstAt(2026, 9, 30, 8, 30)),
    sessions: [{ ...krSession(30), preSpan: null }],
    symbols: [], state,
  });
  const hit = (noSpan.skipped || []).find((s) => s.kind === 'preopen');
  assert.ok(hit, 'preSpan 이 없으면 사유를 실어야 한다(캘린더 폴백이면 여기 걸린다)');
  assert.equal(hit.why, 'no_span');
  assert.equal(hit.hasPre, false);
});

test('⚠️ 소음 없음: 아직 창 전이면 skipped 에 안 싣는다', () => {
  const state = { lastPreopenDay: {}, mid: {}, sessions: {}, momentum: {}, pending: [] };
  const early = trigger.decide({
    now: new Date(kstAt(2026, 9, 30, 6, 0)), // 프리장 창(08:00) 전
    sessions: [krSession(30)], symbols: [], state,
  });
  assert.equal(
    (early.skipped || []).filter((s) => s.kind === 'preopen').length, 0,
    '창 전은 정상이라 안 실어야 한다 — 실으면 매일 새벽 내내 쌓여 진짜 신호가 묻힌다',
  );
});

test('🔴 검사 대상이 실재한다 — decide 가 skipped 를 항상 돌려준다', () => {
  const state = { lastPreopenDay: {}, mid: {}, sessions: {}, momentum: {}, pending: [] };
  const out = trigger.decide({ now: new Date(kstAt(2026, 9, 30, 8, 30)), sessions: [], symbols: [], state });
  assert.ok(Array.isArray(out.skipped), 'skipped 가 배열이 아니면 호출자가 조용히 아무것도 못 찍는다');
});

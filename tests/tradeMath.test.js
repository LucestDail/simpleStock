const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeTrade, summarizeCandles } = require('../server/analystService');

/**
 * 손익비 · 포지션 사이징 (2026-09-21 사용자 지시)
 *
 * ## 🔴 왜 **코드가** 계산하나
 *
 * 모델에게 곱셈·나눗셈을 시키면 **그럴듯하게 틀린다** — 오늘 내내 본 "그럴듯한 숫자" 의
 * 가장 흔한 출처다. ⇒ **레벨은 모델이 판단하고, 산수는 여기서 한다.**
 * 그래서 이 파일은 **손으로 푼 값**과 대조한다.
 */

test('손익비를 손으로 푼 값과 맞춘다', () => {
  // 매수 100 진입 · 90 손절 · 130 목표 → 위험 10, 보상 30 → R/R = 3
  const r = computeTrade({ side: 'BUY', entry: 100, stop: 90, target: 130 });
  assert.equal(r.perShareRisk, 10);
  assert.equal(r.rr, 3);
  assert.equal(r.riskPct, 10);
});

test('매도는 방향이 반대다', () => {
  // 매도 100 진입 · 110 손절(반등하면 틀린 것) · 70 목표 → 위험 10, 보상 30
  const r = computeTrade({ side: 'SELL', entry: 100, stop: 110, target: 70 });
  assert.equal(r.perShareRisk, 10);
  assert.equal(r.rr, 3);
});

/**
 * 🔴 **방향이 뒤집힌 손절을 조용히 넘기면 수량이 음수가 된다.**
 *    모델이 매수인데 손절을 진입 위에 두는 일이 실제로 있다.
 */
test('손절이 방향과 안 맞으면 계산하지 않고 이유를 남긴다', () => {
  const r = computeTrade({ side: 'BUY', entry: 100, stop: 110, target: 130 });
  assert.ok(r.error, '방향이 뒤집혔는데 계산했다');
  assert.match(r.error, /손절 위치/);
  assert.equal(r.sizedQuantity, undefined);
});

test('수량은 위험예산 ÷ 주당 위험액을 내림한다', () => {
  // 예산 1,000 · 주당 위험 30 → 33주 (33×30=990 ≤ 1000)
  const r = computeTrade({ side: 'BUY', entry: 100, stop: 70, target: 160, riskBudget: 1000 });
  assert.equal(r.perShareRisk, 30);
  assert.equal(r.sizedQuantity, 33);
  assert.equal(r.rr, 2);
});

/** ⚠️ 예산이 1주 위험보다 작으면 **0주** 다 — 1주로 반올림하면 위험 한도를 넘는다 */
test('예산이 모자라면 0주이고 그 사실을 말한다', () => {
  const r = computeTrade({ side: 'BUY', entry: 100, stop: 50, target: 200, riskBudget: 10 });
  assert.equal(r.sizedQuantity, 0);
  assert.match(r.sizeNote, /1주 위험액보다 작/);
});

/** 🔴 예산이 없으면 **수량을 내지 않는다** — 0 으로 두면 "위험 없음" 처럼 보인다 */
test('위험예산이 없으면 수량 자체를 만들지 않는다', () => {
  const r = computeTrade({ side: 'BUY', entry: 100, stop: 90, target: 130 });
  assert.equal(r.sizedQuantity, undefined);
  assert.equal(r.riskBudget, undefined);
  assert.equal(r.rr, 3, '수량과 무관하게 손익비는 낸다');
});

test('목표가가 이익 방향이 아니면 손익비를 내지 않고 말한다', () => {
  const r = computeTrade({ side: 'BUY', entry: 100, stop: 90, target: 95 });
  assert.equal(r.rr, null);
  assert.match(r.rrNote, /이익 방향/);
});

test('값이 없으면 터지지 않고 이유를 준다', () => {
  assert.match(computeTrade({ side: 'BUY', entry: 0, stop: 90 }).error, /진입가/);
  assert.match(computeTrade({ side: 'BUY', entry: 100 }).error, /손절가/);
});

// ── 변동성 지표 ────────────────────────────────────────────

/** ⚠️ 표본이 적으면 변동성이 **거짓말한다** — 0 이 아니라 null 이어야 한다 */
test('봉이 모자라면 변동성을 0 이 아니라 null 로 둔다', () => {
  const few = Array.from({ length: 19 }, (_, i) => ({ c: 100 + i, h: 101 + i, l: 99 + i }));
  assert.equal(summarizeCandles(few), null, '20개 미만인데 지표를 냈다');
});

test('스윙 고저와 변동성을 계산한다', () => {
  const rows = Array.from({ length: 60 }, (_, i) => {
    const c = 100 + Math.sin(i / 5) * 10;
    return { c, h: c + 1, l: c - 1 };
  });
  const t = summarizeCandles(rows);
  assert.ok(t.volPct > 0, '변동성이 0이다');
  assert.ok(t.atrPct > 0);
  assert.ok(t.swingHigh > t.swingLow);
  // 최근 20일 스윙은 전체 고저 **안**에 있어야 한다
  assert.ok(t.swingHigh <= t.high + 1e-9 && t.swingLow >= t.low - 1e-9);
});

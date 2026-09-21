const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify, opinionFor, bandText, RUBRICS, TYPES } = require('../server/stockRating');

/**
 * 종목 계층 평가 (2026-09-21 사용자 사양)
 *
 * ## 🔴 자의 초점 — **점수와 투자의견이 어긋나면 안 된다**
 *
 * 사양이 명시적으로 금지했다. 모델에게 둘 다 맡기면 88점에 "적극 매수" 를 쓴다.
 * ⇒ 의견은 **코드가 점수에서 유도**하고, 여기서 구간 경계를 못박는다.
 * ⚠️ 사양이 `90점 초과` 라고 썼다 — **90.0 은 적극 매수가 아니다.** 경계를 정확히 잰다.
 */

test('투자의견 구간이 사양과 정확히 맞는다 (경계 포함)', () => {
  // 대형주: 90 초과 / 80 이상 / 70 이상 / 60 이상 / 그 아래
  assert.equal(opinionFor(TYPES.LARGE, 90.1), '적극 매수');
  assert.equal(opinionFor(TYPES.LARGE, 90), '매수', '🔴 90.0 은 "초과" 가 아니다');
  assert.equal(opinionFor(TYPES.LARGE, 80), '매수');
  assert.equal(opinionFor(TYPES.LARGE, 79.9), '중립');
  assert.equal(opinionFor(TYPES.LARGE, 70), '중립');
  assert.equal(opinionFor(TYPES.LARGE, 69.9), '비중축소 / 약중립');
  assert.equal(opinionFor(TYPES.LARGE, 60), '비중축소 / 약중립');
  assert.equal(opinionFor(TYPES.LARGE, 59.9), '매도 권고');
});

/** 🔴 **중소형은 문턱이 낮다** — 같은 점수라도 의견이 다르다. 섞으면 기준이 무너진다 */
test('중소형 성장주는 기준이 다르다', () => {
  assert.equal(opinionFor(TYPES.SMALL_GROWTH, 85.1), '적극 매수');
  assert.equal(opinionFor(TYPES.SMALL_GROWTH, 85), '매수');
  assert.equal(opinionFor(TYPES.SMALL_GROWTH, 75), '매수');
  assert.equal(opinionFor(TYPES.SMALL_GROWTH, 65), '중립');
  assert.equal(opinionFor(TYPES.SMALL_GROWTH, 55), '관찰 / 고위험 중립');
  assert.equal(opinionFor(TYPES.SMALL_GROWTH, 54), '매도 권고');
  // 같은 82점인데 유형에 따라 다르다 — 이게 유형 구분의 이유다
  assert.equal(opinionFor(TYPES.LARGE, 82), '매수');
  assert.equal(opinionFor(TYPES.SMALL_GROWTH, 82), '매수');
  assert.equal(opinionFor(TYPES.LARGE, 68), '비중축소 / 약중립');
  assert.equal(opinionFor(TYPES.SMALL_GROWTH, 68), '중립');
});

test('유형을 시총·배당으로 판정한다', () => {
  assert.equal(classify({ marketCap: 5.3e12, quality: { dividendYield: 0.0002 } }).type, TYPES.LARGE);
  assert.equal(classify({ marketCap: 4e11, quality: { dividendYield: 0.031 } }).type, TYPES.LARGE_DIV);
  assert.equal(classify({ marketCap: 2e9, quality: {} }).type, TYPES.SMALL_GROWTH);
  // ⚠️ 배당률은 소스에 따라 0.031 또는 3.1 로 온다 — 둘 다 받아야 한다
  assert.equal(classify({ marketCap: 4e11, quality: { dividendYield: 3.1 } }).type, TYPES.LARGE_DIV);
});

/**
 * 🔴 **시총을 못 받으면 유형을 단정하지 않는다** — `assumed` 를 켜서 그 사실을 남긴다.
 *    조용히 대형주로 치면 기준이 후해지고, 중소형 종목이 **더 쉬운 잣대**로 평가된다.
 */
test('시가총액이 없으면 가정했다고 표시한다', () => {
  const c = classify({ quality: {} });
  assert.equal(c.assumed, true);
  assert.match(c.why, /미확인/);
});

test('유형마다 항목이 10개이고 유형별로 다르다', () => {
  for (const t of Object.values(TYPES)) {
    assert.equal(RUBRICS[t].length, 10, `${t} 항목이 10개가 아니다 — 총점이 100 이 안 된다`);
  }
  assert.ok(RUBRICS[TYPES.LARGE_DIV].includes('배당 지속성·안정성'), '배당주에 배당 항목이 없다');
  assert.ok(RUBRICS[TYPES.SMALL_GROWTH].includes('자금조달·희석 리스크'), '중소형에 희석 항목이 없다');
  assert.ok(!RUBRICS[TYPES.LARGE].includes('배당 지속성·안정성'), '대형주에 배당 항목이 섞였다');
});

/** ⚠️ 사양: 점수 기준표는 **표가 아니라 텍스트**로 출력한다 */
test('구간표를 유형에 맞는 텍스트로 낸다', () => {
  const t = bandText(TYPES.SMALL_GROWTH);
  assert.match(t, /중소형 성장주 기준/);
  assert.match(t, /85점 초과: 적극 매수/);
  assert.ok(!t.includes('|'), '표 문법이 섞였다 — 사양은 텍스트로 내라고 했다');
  assert.match(bandText(TYPES.LARGE), /90점 초과: 적극 매수/);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { shapeScores, RUBRICS, TYPES } = require('../server/stockRating');

/**
 * 평가 항목 점수 — **모양으로 읽는다** (2026-09-21)
 *
 * ## 왜 있나
 *
 * 라이브 첫 평가에서 **10개 항목이 전부 `None`** 이 나왔다. 그런데 컨테이너 로그를 보니
 * **모델은 10개를 다 채우고 있었다.** 내가 못 읽었을 뿐이다.
 *
 * ★ 이 저장소가 같은 비대칭을 밟은 것이 이번이 **다섯 번째**다
 *   (도구 호출 키 → 목록 키 → **깊이** → 리포트 모양 → 평가 모양).
 *   처방은 매번 같았다: *"키 이름을 열거하지 말고 모양으로 찾는다."*
 *   그런데 **평가 경로에 안 퍼뜨렸다** — *"규칙을 정하면 그 자리에서 적용 범위를 훑을 것"* 위반.
 *
 * ## 🔴 지문은 **라이브 로그에서 그대로** 가져왔다
 *
 * 지어낸 픽스처는 지어낸 동작을 지켜 준다(오늘 아침 `limit` 누락으로 이미 겪었다).
 * 아래 세 모양은 전부 `stock_rating` 의 `ai.generate.finish outputPreview` 실물이다.
 */

const NAMES = RUBRICS[TYPES.LARGE];
const scoresOf = (items) => items.map((x) => x.score);

/** 라이브 회차 1·2 — 항목명을 키로 하는 **평평한 객체**(배열이 아니다) */
test('🔴 평평한 객체 `{"항목명": 10}` 를 읽는다 (라이브 실측)', () => {
  const live = {
    '강한 기업 선호': 10,
    '구조적 우위': 10,
    '숫자로 검증된 성장': 10,
    '매출·이익 동반 성장': 10,
    '장기 지속 성장성': 9.5,
    '실적 기준 경쟁위협 점검': 9,
    '투자 논리 안정성': 8.5,
    '정당한 프리미엄': 8,
    '이해·추적 가능성': 9,
    '사용자 투자 스타일 적합성': 8,
  };
  const items = shapeScores(live, NAMES);
  assert.deepEqual(scoresOf(items), [10, 10, 10, 10, 9.5, 9, 8.5, 8, 9, 8]);
  assert.equal(items.filter((x) => x.score == null).length, 0, '🔴 모델이 채운 걸 못 읽었다');
});

/**
 * 라이브 회차 4 — **공백이 밑줄**이고 `·` 도 밑줄이다.
 * ⚠️ 키 이름을 열거했다면 이 회차만 또 통째로 놓쳤을 것이다.
 */
test('🔴 표기 변형 `강한_기업_선호`·`매출_이익_동반_성장` 을 같은 항목으로 본다 (라이브 실측)', () => {
  const live = {
    강한_기업_선호: 10,
    구조적_우위: 10,
    숫자로_검증된_성장: 10,
    매출_이익_동반_성장: 10,
    장기_지속_성장성: 9,
    실적_기준_경쟁위협_점검: 9,
    투자_논리_안정성: 8,
    정당한_프리미엄: 8,
    이해_추적_가능성: 7,
    사용자_투자_스타일_적합성: 7,
  };
  assert.deepEqual(scoresOf(shapeScores(live, NAMES)), [10, 10, 10, 10, 9, 9, 8, 8, 7, 7]);
});

/** 스키마대로 답한 경우도 당연히 읽어야 한다 — 고치면서 원래 되던 걸 깨면 안 된다 */
test('스키마대로 `items:[{name,score,comment}]` 도 그대로 읽는다', () => {
  const out = {
    items: NAMES.map((name, i) => ({ name, score: i + 1, comment: `근거${i}` })),
  };
  const items = shapeScores(out, NAMES);
  assert.deepEqual(scoresOf(items), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(items[3].comment, '근거3', '코멘트를 버렸다');
});

/** 목록 키 이름이 바뀌어도 (`scores`·`평가`) 모양이 같으면 읽는다 */
test('목록 키 이름이 달라도 읽는다 (`items` 가 아니어도)', () => {
  const out = { 평가: NAMES.map((name) => ({ 항목: name, 점수: 7, 근거: 'x' })) };
  assert.deepEqual(scoresOf(shapeScores(out, NAMES)), Array(10).fill(7));
});

/** 한 겹 더 깊어도 (`result.scores.…`) 찾는다 — **깊이** 로 이미 한 번 당했다 */
test('한 겹 감싸도 찾는다', () => {
  const out = { result: { scores: { '강한 기업 선호': 6, 구조적우위: 5 } } };
  const items = shapeScores(out, NAMES);
  assert.equal(items[0].score, 6);
  assert.equal(items[1].score, 5, '공백 없는 표기를 못 읽었다');
});

/** `{"항목명": {score, comment}}` 중첩 모양 */
test('`{"항목명": {score, comment}}` 도 읽는다', () => {
  const out = { '정당한 프리미엄': { score: 4.5, comment: 'PER 29 는 부담' } };
  const items = shapeScores(out, NAMES);
  const v = items.find((x) => x.name === '정당한 프리미엄');
  assert.equal(v.score, 4.5);
  assert.equal(v.comment, 'PER 29 는 부담');
});

/**
 * 🔴 **아무 숫자나 주우면 안 된다.**
 * 총점·시총이 항목 점수로 새면 **틀린 총점이 조용히** 나온다(빈 것보다 나쁘다).
 */
test('🔴 채점표에 없는 키의 숫자는 줍지 않는다', () => {
  const out = { total: 88, marketCap: 5367000000000, 목표주가: 210, '강한 기업 선호': 9 };
  const items = shapeScores(out, NAMES);
  assert.equal(items[0].score, 9);
  assert.equal(items.filter((x) => x.score != null).length, 1, '🔴 엉뚱한 숫자를 항목 점수로 주웠다');
});

/** 범위를 벗어난 점수는 자른다 — 12 를 그대로 더하면 100 을 넘는다 */
test('0~10 을 벗어난 점수는 자른다', () => {
  const items = shapeScores({ '강한 기업 선호': 12, 구조적우위: -3 }, NAMES);
  assert.equal(items[0].score, 10);
  assert.equal(items[1].score, 0);
});

/**
 * 🔴 **위치 폴백은 이름을 하나도 못 찾았을 때만.**
 * 일부만 맞는데 나머지를 위치로 메우면 **엉뚱한 항목에 점수가 붙는다** —
 * 총점이 나오므로 화면에서는 정상으로 보이고, 그게 빈 것보다 나쁘다.
 */
test('🔴 이름이 일부만 맞으면 나머지를 위치로 메우지 않는다', () => {
  const out = {
    items: [
      { name: '강한 기업 선호', score: 9, comment: '' },
      { name: '엉뚱한 항목', score: 1, comment: '' },
      ...Array.from({ length: 8 }, (_, i) => ({ name: `잡음${i}`, score: 2, comment: '' })),
    ],
  };
  const items = shapeScores(out, NAMES);
  assert.equal(items[0].score, 9);
  assert.equal(items[1].score, null, '🔴 위치로 메웠다 — 엉뚱한 항목에 점수가 붙는다');
});

/** 이름이 **하나도** 안 맞고 개수가 정확히 맞으면 위치로 받는다(마지막 수단) */
test('이름을 하나도 못 찾고 개수가 맞으면 위치로 받는다', () => {
  const out = { items: NAMES.map((_, i) => ({ name: `항목${i + 1}`, score: 5 })) };
  assert.deepEqual(scoresOf(shapeScores(out, NAMES)), Array(10).fill(5));
});

/** 빈 응답은 빈 채로 — 없는 것을 0 으로 치면 "매도 권고" 가 된다 */
test('빈 응답은 전부 null (0 으로 메우지 않는다)', () => {
  const items = shapeScores({}, NAMES);
  assert.deepEqual(scoresOf(items), Array(10).fill(null));
});

/**
 * 🔴 **자의 판별력** — 지문을 망가뜨리면 실제로 깨지는가.
 * 안 깨지면 이 테스트들은 "검사한 것" 이 아니라 "안 본 것" 이다.
 */
test('🔴 자기검증: 점수를 빼면 반드시 null 이 된다', () => {
  const full = Object.fromEntries(NAMES.map((n) => [n, 7]));
  assert.equal(shapeScores(full, NAMES).filter((x) => x.score == null).length, 0);

  const holed = { ...full };
  delete holed['투자 논리 안정성'];
  const items = shapeScores(holed, NAMES);
  assert.equal(items.find((x) => x.name === '투자 논리 안정성').score, null, '🔴 없는 점수를 만들어냈다');
  assert.equal(items.filter((x) => x.score == null).length, 1);
});

/**
 * 유형이 달라지면 채점표도 달라진다 — **채점하는** 유형 모두 같은 자로 읽히는가.
 *
 * ⚠️ `ETF·펀드` 는 **일부러 채점표가 없다**(기업 항목을 펀드에 대면 지어낸 숫자가 나온다).
 *    면제에는 이유를 적는다 — 이유 없는 면제는 곧 구멍이다.
 */
test('채점 유형의 채점표는 모두 평평한 객체를 읽는다', () => {
  const scored = Object.values(TYPES).filter((t) => t !== TYPES.FUND);
  assert.equal(scored.length, 3, '채점 유형 개수가 바뀌었다 — 이 자를 다시 보라');
  for (const type of scored) {
    const names = RUBRICS[type];
    assert.equal(names.length, 10, `${type} 채점표가 10개가 아니다`);
    const flat = Object.fromEntries(names.map((n) => [n, 8]));
    const items = shapeScores(flat, names);
    assert.equal(items.filter((x) => x.score == null).length, 0, `${type} 에서 못 읽었다`);
  }
  // 면제한 것이 **실제로 그 이유 때문인지** 확인한다(존재만 보면 장식이 된다)
  assert.equal((RUBRICS[TYPES.FUND] || []).length, 0, 'ETF 에 기업 채점표가 생겼다 — 없는 축을 재게 된다');
});

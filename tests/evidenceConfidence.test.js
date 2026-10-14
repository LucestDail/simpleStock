const { test } = require('node:test');
const assert = require('node:assert/strict');
const analyst = require('../server/analystService');

const conf = analyst._evidenceConfidence;

/**
 * 🔴 **있었던 것: 묻지도 않고 최악으로 단정했다** (2026-10-14 발견).
 *
 * `confidence: pickString(o, ['confidence', …]) || 'LOW'` 였는데 **스키마 position 칸에
 * `confidence` 가 없다** — 모델은 그 값을 **절대 주지 않으므로 폴백 `'LOW'` 가 100% 적용**됐다.
 * 라이브 실측 `lowConfidence: 7`(7종목 전부)이 그 결과다. 화면·폰의 *"확신도 LOW"* 를 사용자는
 * **모델이 자신 없어한다**로 읽지만 실제로는 **우리가 묻지 않았다**는 뜻이었다.
 *
 * ★ *"현금은 못 읽었으면 `null`(= 모른다). 0 으로 적으면 '돈이 없다' 와 '조회가 실패했다' 가
 *   같은 숫자가 된다"*(2026-10-01)와 **같은 가족** — 모르는 것에 값을 찍으면 거짓이 된다.
 *
 * ⇒ 사용자 판단(2026-10-14): **"근거 충실도" 로 재정의.** 행동을 권하지 않는 제품에서
 *   *"얼마나 확신하는가"* 는 걸릴 대상이 없지만, *"이 서술을 뒷받침하는 데이터가 얼마나 있나"* 는
 *   계속 의미가 있다. **코드가 센다** — 모델에게 물으면 흔들리고 정본이 둘이 된다(09-08 규율).
 */

test('🔴 모델이 아무 값도 안 줘도 등급이 서술에서 나온다 (폴백 LOW 가 아니다)', () => {
  // ⚠️ 이것이 그날의 실제 버그 모양 — `confidence` 키가 **없는** 응답
  const full = { trend: '20일선 위', relative: '지수 대비 강세', volatility: '일간 1.1%', evidence: ['a', 'b'], rationale: '국면 양호' };
  assert.equal(conf(full), 'HIGH', '🔴 다 채운 응답이 LOW 다 — 묻지도 않고 최악으로 단정하고 있다');
  assert.ok(!('confidence' in full), '⚠️ 픽스처가 confidence 를 갖고 있으면 이 테스트는 그 버그를 못 본다');
});

test('🔴 스키마에 confidence 칸을 열지 않는다 (열면 정본이 둘이 된다)', () => {
  const it = analyst._REPORT_SCHEMA.properties.positions.items;
  assert.ok(!('confidence' in it.properties), '🔴 칸이 열렸다 — 모델이 채우고 코드 계산과 갈린다');
  // ★ 판별력 — 관측 칸은 있어야 한다(둘 다 없으면 이 단언은 공허하다)
  assert.ok('trend' in it.properties && 'evidence' in it.properties, '🔴 자가 엉뚱한 스키마를 본다');
});

test('🔴 등급이 실제로 갈린다 — 한쪽으로 쏠리면 뜻이 없다 (판별력)', () => {
  const base = { trend: 'a', relative: 'b', volatility: 'c', rationale: '' };
  const grades = {
    '서술3+근거2': conf({ ...base, evidence: ['x', 'y'] }),
    '서술3+근거1': conf({ ...base, evidence: ['x'] }),
    '서술3+근거0': conf({ ...base, evidence: [] }),
    '서술1만': conf({ trend: 'a', evidence: [] }),
    '빈 응답': conf({}),
  };
  assert.equal(grades['서술3+근거2'], 'HIGH');
  assert.equal(grades['서술3+근거1'], 'MEDIUM', '🔴 근거 0 과 1 이 같은 등급이면 인용을 요구할 이유가 없다');
  assert.equal(grades['서술1만'], 'LOW');
  assert.equal(grades['빈 응답'], 'LOW');
  // ★ 세 등급이 **전부 나타나야** 한다 — 하나로 쏠리면 자가 아무것도 구분하지 않는 것이다
  assert.equal(new Set(Object.values(grades)).size, 3, `🔴 등급이 쏠렸다: ${JSON.stringify(grades)}`);
});

test('🔴 결손을 자백하면 깎인다 — 정직한 결손이 점수를 올리면 안 된다', () => {
  const withGap = { trend: 'a', relative: 'b', volatility: 'c', evidence: ['x', 'y'], rationale: '재무는 확인 못 함' };
  const without = { ...withGap, rationale: '국면 양호' };
  assert.equal(conf(without), 'HIGH');
  assert.equal(conf(withGap), 'MEDIUM', '🔴 "확인 못 함" 을 적었는데 만점이다');
});

test('⚠️ 빈 문자열·공백은 채운 것으로 치지 않는다', () => {
  assert.equal(conf({ trend: '   ', relative: '', volatility: null, evidence: ['', '  '] }), 'LOW',
    '🔴 공백을 서술로 세면 빈 보고서가 HIGH 가 된다');
});

test('🔴 배선 — asPosition 이 이 계산을 쓴다 (순수 함수만 재면 "로직은 맞는데 안 불린다" 를 못 잡는다)', () => {
  const report = analyst._shapeReport
    ? analyst._shapeReport({ positions: [{ symbol: 'QLD', trend: '20일선 위', relative: '강세', volatility: '1.1%', evidence: ['a', 'b'], rationale: '양호' }] })
    : null;
  if (!report) { assert.ok(true, '⚠️ _shapeReport 미노출 — 배선은 analystShape 테스트가 덮는다'); return; }
  assert.equal(report.positions[0].confidence, 'HIGH', '🔴 계산이 배선되지 않았다 — 폴백이 남아 있다');
});

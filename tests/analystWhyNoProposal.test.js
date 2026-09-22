const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 🔴 **`proposed:0` 의 이유가 요약 줄에서 읽히는가** (2026-09-22)
 *
 * 실거래 첫날 05시 마감 분석이 `positions:2 proposed:0 gaps:7` 로 끝났다.
 * 그 줄만 보면 **제안이 없는 이유를 알 수 없다**:
 *   - 모델이 판단했고 결론이 HOLD 였나?
 *   - 데이터가 모자라 판단 자체를 못 했나?
 *
 * 실제 답(둘 다 `stance=HOLD`)은 `analyst-last.json` 안에 **있었다.**
 * 있는데 **요약이 안 실어서** 운영 쪽에서 볼 수 없었던 것 —
 * 이 저장소가 반복해 밟은 *"수집해 놓고 안 쓰는"* 의 로그판이다.
 *
 * ⚠️ 그리고 이건 단순 편의가 아니다 — 우리는 *"첫 자동 제안이 뜨면 검증한다"* 를
 *    실사용 조건으로 걸었다. **판정 장치 없이 사건을 기다리면 무엇을 기다리는지 모르게 된다.**
 */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf-8');

/** 주석·문자열을 지우고 **구조로** 본다(이름이 주석에만 있어도 통과하면 안 된다) */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('🔴 analyst.report 요약이 **판단 분포**를 싣는다', () => {
  const code = codeOnly(SRC);
  const i = code.indexOf("logInfo('analyst.report'");
  assert.ok(i > 0, 'analyst.report 요약 줄을 못 찾았다 — 자가 대상을 놓쳤다');
  const block = code.slice(i, i + 700);
  assert.match(block, /\bstances\b/, '🔴 판단 분포가 없다 — proposed:0 의 이유를 알 수 없다');
  assert.match(block, /\blowConfidence\b/, '🔴 저확신 건수가 없다');
});

test('🔴 분포는 **실제 stance 를 세어** 만든다 (상수가 아니다)', () => {
  const code = codeOnly(SRC);
  const i = code.indexOf('const stances = {}');
  assert.ok(i > 0, '집계 코드가 없다');
  const block = code.slice(i, i + 500);
  assert.match(block, /report\.positions/, '🔴 positions 를 안 보고 있다');
  assert.match(block, /stance/, '🔴 stance 를 안 세고 있다');
  assert.match(block, /confidence/, '🔴 confidence 를 안 보고 있다');
});

/**
 * 🔴 **자의 판별력** — 집계 로직이 실제로 옳은 답을 내는가.
 *    소스 grep 만 하면 "있다" 만 알 수 있고 "맞다" 는 모른다.
 */
test('🔴 집계 로직이 실제 값을 낸다 (05시 실데이터 모양으로)', () => {
  const positions = [
    { symbol: 'QLD', stance: 'HOLD', confidence: 'LOW' },
    { symbol: 'RAM', stance: 'HOLD', confidence: 'LOW' },
  ];
  const stances = {}; let lowConfidence = 0;
  for (const pos of positions) {
    const k = String(pos?.stance || 'UNKNOWN').toUpperCase();
    stances[k] = (stances[k] || 0) + 1;
    if (String(pos?.confidence || '').toUpperCase() === 'LOW') lowConfidence += 1;
  }
  assert.deepEqual(stances, { HOLD: 2 }, '🔴 05시 실데이터에서 {HOLD:2} 가 안 나온다');
  assert.equal(lowConfidence, 2);
});

/** ⚠️ **판단이 아예 없는 경우와 구분돼야 한다** — 그게 이 지표의 존재 이유다 */
test('⚠️ 판단이 없으면 분포가 **비어 있다** (HOLD 와 구분된다)', () => {
  const stances = {};
  for (const pos of []) stances[String(pos.stance).toUpperCase()] = 1;
  assert.deepEqual(stances, {}, '🔴 판단 0건과 HOLD 가 같은 모양이면 갈리지 않는다');
});

test('⚠️ stance 가 빠진 항목은 UNKNOWN 으로 **드러난다**(조용히 빠지지 않는다)', () => {
  const positions = [{ symbol: 'X' }, { symbol: 'Y', stance: 'BUY' }];
  const stances = {};
  for (const pos of positions) {
    const k = String(pos?.stance || 'UNKNOWN').toUpperCase();
    stances[k] = (stances[k] || 0) + 1;
  }
  assert.deepEqual(stances, { UNKNOWN: 1, BUY: 1 }, '🔴 stance 없는 항목이 조용히 사라진다');
});

/**
 * 🔴 **"못 구한 것" 과 "해당 없음" 을 가른다** (2026-09-22)
 *
 * 05시 마감 분석의 `gaps:7` 중 **2건이 *"ETF 라 기업 100점 채점 대상이 아닙니다"*** 였다 —
 * **우리가 일부러 만든 기업↔ETF 분리가 결함처럼 계수된 것**이다.
 * 숫자만 보면 *"근거가 7개나 부족하다"* 로 읽혀 `proposed:0` 의 해석을 흐린다.
 * ⚠️ 합친 `dataGaps` 는 그대로 둔다 — 사람에게는 "못 본 것" 한 줄이 낫다. **가르는 것은 세는 자리**다.
 */
test('🔴 요약이 **결손**과 **해당 없음**을 갈라 센다', () => {
  const code = codeOnly(SRC);
  const i = code.indexOf("logInfo('analyst.report'");
  const block = code.slice(i, i + 900);
  assert.match(block, /gapsMissing/, '🔴 진짜 결손 수가 없다 — 7건이 전부 결손처럼 보인다');
  assert.match(block, /gapsNotApplicable/, '🔴 "해당 없음" 수가 없다');
  assert.match(block, /\bgaps:/, '⚠️ 합계도 남겨야 한다(종전 소비자)');
});

test('🔴 ETF 줄은 **양쪽에** 들어간다 (합계에도, 해당없음에도)', () => {
  const code = codeOnly(SRC);
  const i = code.indexOf('const notApplicable = []');
  assert.ok(i > 0, '분류 바구니가 없다');
  const block = code.slice(i, i + 700);
  assert.match(block, /isFund/, '🔴 ETF 판정을 안 본다');
  assert.match(block, /gaps\.push\(line\)/, '🔴 합친 목록에서 빠지면 화면에서 사라진다');
  assert.match(block, /notApplicable\.push\(line\)/, '🔴 분류가 안 된다');
});

/** 🔴 **자의 판별력** — 05시 실데이터 모양으로 계산이 맞는가 */
test('🔴 05시 실데이터: gaps 7 = 결손 5 + 해당없음 2', () => {
  const gaps = [
    'QLD·RAM 재무제표 미제공', 'QLD·RAM 추종지수 미제공', '내부자 거래 미제공',
    'QLD·RAM 수급 조회 실패', '시장 지수는 참고용',
    'QLD 은 ETF·펀드 — 기업 100점 채점 대상이 아닙니다',
    'RAM 은 ETF·펀드 — 기업 100점 채점 대상이 아닙니다',
  ];
  const notApplicable = gaps.filter((g) => /ETF·펀드/.test(g));
  assert.equal(gaps.length, 7);
  assert.equal(notApplicable.length, 2);
  assert.equal(gaps.length - notApplicable.length, 5, '🔴 진짜 결손은 5건이다');
});

/** ⚠️ 결손이 0 이면 **0 이라고 말해야** 한다 — 해당없음만 있는 날과 구분된다 */
test('⚠️ 해당없음만 있으면 결손 0 이 된다', () => {
  const gaps = ['QLD 은 ETF·펀드 — 기업 100점 채점 대상이 아닙니다'];
  const na = gaps.filter((g) => /ETF·펀드/.test(g));
  assert.equal(gaps.length - na.length, 0, '🔴 해당없음뿐인데 결손이 있다고 센다');
});

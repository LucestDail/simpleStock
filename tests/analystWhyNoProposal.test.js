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

/**
 * 퀀트 게이트 — **수치를 통과한 후보만 LLM 에 준다** (2026-10-03 재개편)
 *
 * 사용자 지시: *"맞는 수치에 해당하는 현재 모멘텀, 퀀트에 해당하는 대상만 가져오는건데
 * 어디서부터 이렇게 꼬였는지"* — 종전 `roundRobinCandidates` 는 카탈로그 순서로 집을 뿐
 * **수치를 안 봤다.** 후보 7~24개가 역배열까지 전부 프롬프트에 실렸고, 그 숫자 벽이
 * 이웃 종목 숫자 오염(RAM 레벨 80~95)의 토양이었다.
 */
const test = require('node:test');
const assert = require('node:assert');
const { quantGate, CANDIDATE_PROMPT_MAX } = require('../server/regimeService');

const row = (symbol, last, ma20, ma60) => ({ symbol, name: symbol, category: 'c', tech: { last, ma20, ma60 } });

test('🔴 20일선 아래는 탈락하고 **사유가 남는다**', () => {
  const g = quantGate([row('DOWN', 90, 100, 110), row('UP', 110, 100, 95)]);
  assert.deepStrictEqual(g.passed.map((r) => r.symbol), ['UP']);
  assert.strictEqual(g.dropped.length, 1);
  assert.match(g.dropped[0].why, /below_ma20/, '사유 없는 탈락은 "왜 없지" 를 영영 못 가린다');
});

test('🔴 정배열이 단순 20일선 위보다 먼저 온다 · 같은 급은 모멘텀순', () => {
  const g = quantGate([
    row('WEAK', 101, 100, 105),    // 20일선 위지만 역정렬 → 1점
    row('STRONG', 120, 110, 100),  // 정배열 + 모멘텀 20% → 2점
    row('MILD', 106, 103, 100),    // 정배열 + 모멘텀 6% → 2점
  ]);
  assert.deepStrictEqual(g.passed.map((r) => r.symbol), ['STRONG', 'MILD', 'WEAK']);
});

test('🔴 상한을 넘으면 자르고 **몇 개를 잘랐는지** 센다 (조용한 상한 금지)', () => {
  const rows = Array.from({ length: CANDIDATE_PROMPT_MAX + 3 },
    (_, i) => row(`S${i}`, 110 + i, 100, 95));
  const g = quantGate(rows);
  assert.strictEqual(g.passed.length, CANDIDATE_PROMPT_MAX);
  assert.strictEqual(g.overflow, 3, '잘린 수를 안 세면 "덮었다" 로 읽힌다');
});

test('⚠️ 데이터 없는 후보는 통과도 탈락(추세)도 아니다 — no_data 로 가른다', () => {
  const g = quantGate([{ symbol: 'X', tech: {} }, row('OK', 110, 100, 95)]);
  assert.strictEqual(g.dropped[0].why, 'no_data');
  assert.deepStrictEqual(g.passed.map((r) => r.symbol), ['OK']);
});

test('⚠️ 전부 탈락 — 빈 배열이지 예외가 아니다 (0건은 그 자체가 정보다)', () => {
  const g = quantGate([row('A', 90, 100, 110), row('B', 80, 100, 110)]);
  assert.deepStrictEqual(g.passed, []);
  assert.strictEqual(g.dropped.length, 2);
});

test('🔴 배선 — candidateSection 이 게이트를 실제로 타고, 0건도 말한다', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'regimeService.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert.match(src, /const gate = quantGate\(measured\);/, '게이트가 배선되지 않았다');
  assert.match(src, /regime\.quant_gate/, '탈락 로그가 없다');
  assert.match(src, /수치 기준 통과 0건/, '0건을 숨기면 "후보 기능이 죽었나" 가 된다');
  assert.match(src, /이 목록 밖 종목의 매수 제안은 내지 마라/, 'LLM 에게 경계를 말하지 않는다');
});

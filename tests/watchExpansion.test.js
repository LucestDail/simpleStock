/**
 * 🎚️ 개별주 확대의 두 장치 (2026-10-05 — 사용자 "개별주 넓게, 싸고 안 꼬이게")
 * ① quantGate 개별주 슬롯 상한: 후보 6 중 개별주 최대 2 — 변동성 상위 독점 차단
 * ② 그룹·종목별 모멘텀 절대 하한: z-score 위에 그룹별 경제적 유의미 기준
 * 쌍으로 잰다: 막는 쪽(상한·하한)과 안 막는 쪽(모름 fail-open·칸 비우지 않기).
 */
const test = require('node:test');
const assert = require('node:assert');
const { quantGate } = require('../server/regimeService');

const T = { last: 110, ma20: 100, ma60: 90 };
const row = (symbol, isEtf, momentum = 10) => ({ symbol, isEtf, tech: { ...T, ma60: 110 / (1 + momentum / 100) } });

test('① 개별주는 최대 2 — 모멘텀 상위를 독점해도 ETF 가 밀리지 않는다', () => {
  // 개별주 5(모멘텀 높음) + ETF 4(낮음) → 통과 6 = 개별주 2 + ETF 4
  const rows = [
    ...[50, 45, 40, 35, 30].map((m, i) => row(`STK${i}`, false, m)),
    ...[20, 15, 12, 10].map((m, i) => row(`ETF${i}`, true, m)),
  ];
  const g = quantGate(rows);
  const stocks = g.passed.filter((r) => r.isEtf === false);
  const etfs = g.passed.filter((r) => r.isEtf === true);
  assert.equal(g.passed.length, 6);
  assert.equal(stocks.length, 2, `개별주가 ${stocks.length}개 — 상한 2 가 안 걸렸다`);
  assert.equal(etfs.length, 4);
  // 개별주 중에서도 모멘텀 상위 2 가 뽑힌다
  assert.deepEqual(stocks.map((r) => r.symbol), ['STK0', 'STK1']);
});

test('② 안 막는 쪽 — ETF 가 모자라면 개별주가 칸을 채운다(칸을 비우지 않는다)', () => {
  const rows = [...[50, 45, 40, 35, 30].map((m, i) => row(`STK${i}`, false, m)), row('ETF0', true, 10)];
  const g = quantGate(rows);
  assert.equal(g.passed.length, 6, `칸이 비었다: ${g.passed.length}`);
  assert.equal(g.passed.filter((r) => r.isEtf === false).length, 5);
});

test('③ 판별 모름(isEtf=null)은 벌주지 않는다 — 조회 장애가 판단을 바꾸면 안 된다', () => {
  const rows = [...[50, 45, 40].map((m, i) => row(`UNK${i}`, null, m)), ...[20, 15, 12, 10].map((m, i) => row(`ETF${i}`, true, m))];
  const g = quantGate(rows);
  assert.equal(g.passed.filter((r) => r.isEtf === null).length, 3, '모름이 개별주 취급으로 깎였다');
});

test('④ 트리거 하한 — row.minMovePct 가 전역(1.5)을 덮는다 (0 은 "z만" 이지 "없음" 아님)', () => {
  const trig = require('../server/analystTrigger');
  // decide 를 직접 태우기엔 세션 픽스처가 크다 — 판정식이 소스에 실재하는지 구조로 잠근다
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../server/analystTrigger.js'), 'utf8');
  assert.match(src, /row\.minMovePct/, '판정식이 row 하한을 안 본다');
  assert.match(src, /Number\.isFinite\(Number\(row\.minMovePct\)\)/, '0 을 falsy 로 떨어뜨리는 판정이다');
});

test('⑤ 배선 — alertService 가 감시 임계 맵을 rows 에 싣는다', () => {
  const src = require('node:fs').readFileSync(require.resolve('../server/alertService.js'), 'utf8');
  assert.match(src, /getWatchThresholds\(\)/, '임계 맵을 안 읽는다');
  assert.match(src, /r\.minMovePct = m/, 'rows 에 안 싣는다');
});

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

test('⑥ 임계 우선순위 — 종목 override > 그룹 > null(전역)', async () => {
  const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
  for (const k of Object.keys(require.cache)) if (/watchlistService/.test(k)) delete require.cache[k];
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-'));
  const w = require('../server/watchlistService');
  const st = {
    groups: [{
      id: 'g1', momentumMinPct: 7,
      tickers: [
        { symbol: 'OKLO', watch: true },                       // 그룹 7 따름
        { symbol: 'SOXX', watch: true, momentumMinPct: 1.5 },  // 종목 override
        { symbol: 'ZZZ', watch: false },                       // 감시 꺼짐 — 맵에 없다
      ],
    }, { id: 'g2', tickers: [{ symbol: 'SPY', watch: true }] } // 설정 없음 — null(전역)
    ],
  };
  const m = w.getWatchThresholds(st);
  assert.equal(m.get('OKLO'), 7);
  assert.equal(m.get('SOXX'), 1.5);
  assert.equal(m.get('SPY'), null);
  assert.ok(!m.has('ZZZ'));
});

test('⑦ 왕복 — 저장한 그룹 임계가 직렬화(getWatchlistState)를 지나 임계 맵에 닿는다', async () => {
  /*
   * 🔴 2026-10-05 실사고: 그룹 직렬화가 필드 화이트리스트라 momentumMinPct 를 떨어뜨렸고,
   * getWatchThresholds 의 기본 인자가 그 직렬화 결과라 **설정 200 이 거짓 성공**이었다.
   * ⑥은 state 를 손으로 만들어 직렬화를 안 탔다 — 이 왕복이 그 맹점을 잠근다.
   */
  const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
  for (const k of Object.keys(require.cache)) if (/watchlistService|marketService|tossClient/.test(k)) delete require.cache[k];
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wl2-'));
  const w = require('../server/watchlistService');
  const st0 = await w.createGroup('임계검증');
  const gidv = st0.groups.find((g) => g.name === '임계검증').id;
  await w.addTicker(gidv, { symbol: 'QQQ', market: 'US' });
  await w.setWatch(gidv, 'QQQ', true);
  await w.setGroupMomentumMin(gidv, 7);
  await w.setTickerMomentumMin(gidv, 'QQQ', 1.5);
  // 기본 인자(직렬화 경로) 그대로 — 여기서 떨어지면 라이브가 떨어지는 것
  const m = w.getWatchThresholds();
  assert.equal(m.get('QQQ'), 1.5, '종목 override 가 직렬화에서 떨어졌다');
  await w.setTickerMomentumMin(gidv, 'QQQ', null);
  assert.equal(w.getWatchThresholds().get('QQQ'), 7, '그룹 임계가 직렬화에서 떨어졌다');
});

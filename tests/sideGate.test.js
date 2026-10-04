/**
 * 횡보 게이트 (2026-10-04) — "횡보장의 손실은 매매 그 자체" 를 코드로.
 *
 * 근거(라이브 백테스트, 같은 세계·고정 시드): chop 1회차 모델이 방어 로테이션을 택해
 * **-5.34%**, 2회차는 관망해 **0.00%**(벤치 -0.17%). 이기는 쪽이 판단 변동성에 달려
 * 있었다 ⇒ 관망을 게이트로 결정화. **막는 쪽과 안 막는 쪽을 한 쌍으로** 잰다
 * (오탐을 고치다 발동을 죽이는 가족 — 2026-09-30 마스킹 사건의 교훈).
 */
const test = require('node:test');
const assert = require('node:assert');
const { sideGate } = require('../server/analystService');

const SIDE_CALM = { us: { trend: 'side' }, kr: { trend: 'side' }, vix: { value: 18, band: 0 } };
const buy = (symbol) => ({ symbol, side: 'BUY', quantity: 1, price: 100, reason: 't' });

test('🔴 발동 — 횡보+평온의 미보유 시장가 매수를 막는다', () => {
  const g = sideGate(buy('XLP'), SIDE_CALM, { heldSymbols: ['QLD'], proposals: [] });
  assert.strictEqual(g.ok, false);
  assert.match(g.why, /횡보/, '이유에 횡보가 명시돼야 화면·로그에서 읽힌다');
});

test('통과 ① — SELL 은 막지 않는다 (레버리지 축소는 횡보의 정석)', () => {
  const g = sideGate({ symbol: 'QLD', side: 'SELL', quantity: 1 }, SIDE_CALM, { heldSymbols: ['QLD'] });
  assert.strictEqual(g.ok, true);
});

test('통과 ② — 보유 종목 매수는 로테이션이 아니다', () => {
  const g = sideGate(buy('QLD'), SIDE_CALM, { heldSymbols: ['QLD'] });
  assert.strictEqual(g.ok, true);
});

test('통과 ③ — 1배 전환(같은 카테고리 보유 레버리지 SELL 동반)은 허용 — side_grind 의 핵심 처방', () => {
  const sellQld = { symbol: 'QLD', side: 'SELL', quantity: 10 };
  const buyQqq = buy('QQQ');
  const g = sideGate(buyQqq, SIDE_CALM, { heldSymbols: ['QLD'], proposals: [sellQld, buyQqq] });
  assert.strictEqual(g.ok, true, 'QLD→QQQ 전환이 막히면 플레이북과 게이트가 모순이다');
});

test('통과 ④ — 추세가 생기면 작동하지 않는다 (상승·하락 판단은 다른 게이트의 일)', () => {
  for (const trend of ['up', 'down']) {
    const st = { us: { trend }, kr: { trend }, vix: { value: 18, band: 0 } };
    assert.strictEqual(sideGate(buy('XLP'), st, { heldSymbols: [] }).ok, true, trend);
  }
});

test('통과 ⑤ — VIX band ≥ 1(공포 영역)에서는 작동하지 않는다 — 사다리의 존재 이유를 지키라', () => {
  const st = { us: { trend: 'side' }, kr: { trend: 'side' }, vix: { value: 22, band: 1 } };
  assert.strictEqual(sideGate(buy('QQQ'), st, { heldSymbols: [] }).ok, true);
});

test('통과 ⑥ — VIX 모름(null)이면 작동하지 않는다 (평온을 확인 못 하면 fail-open)', () => {
  const st = { us: { trend: 'side' }, kr: { trend: 'side' }, vix: { value: null, band: null } };
  assert.strictEqual(sideGate(buy('QQQ'), st, { heldSymbols: [] }).ok, true);
});

test('🔴 전환 예외의 판별력 — 다른 카테고리 SELL 로는 안 열린다', () => {
  // GLD 매도(금)를 들고 QQQ(기술) 신규 매수 — 전환이 아니라 로테이션이다
  const sellGld = { symbol: 'GLD', side: 'SELL', quantity: 5 };
  const g = sideGate(buy('QQQ'), SIDE_CALM, { heldSymbols: ['GLD'], proposals: [sellGld, buy('QQQ')] });
  assert.strictEqual(g.ok, false, '카테고리가 다른 매도로 전환 예외가 열리면 게이트가 장식이 된다');
});

test('🔴 배선 — decideOnContext 가 sideGate 를 실제로 태운다 (게이트는 존재가 아니라 배선이 안전망)', async () => {
  /*
   * 순수 함수만 재면 "로직은 맞는데 안 불린다" 를 못 잡는다(2026-09-12 배선 테스트 교훈).
   * ⚠️ analystService 는 generateStructuredOutput 을 **구조분해로** 들고 있어 사후
   *    monkey-patch 가 안 먹는다(09-30 에 밟은 함정) — scenarioSuite 와 같은
   *    require.cache 선주입으로 스텁한다.
   */
  for (const k of Object.keys(require.cache)) {
    if (/simpleStock\/server\//.test(k)) delete require.cache[k];
  }
  const p = require.resolve('../server/aiService');
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: {
      generateStructuredOutput: async () => ({
        marketView: 't', momentumRead: 't', dataGaps: [], positions: [],
        proposals: [{ symbol: 'XLP', side: 'BUY', quantity: 1, price: 100, reason: 't' }],
      }),
      getAiSettings: () => ({}),
    },
  };
  try {
    const svc = require('../server/analystService');
    const { proposals, rejected } = await svc.decideOnContext({
      contextText: 't',
      regimeState: { us: { trend: 'side' }, kr: { trend: 'side' }, vix: { value: 18, band: 0 } },
      holdings: ['QLD'],
    });
    assert.strictEqual(proposals.length, 0, '게이트가 배선에서 빠졌다 — 제안이 통과했다');
    assert.strictEqual(rejected.length, 1);
    assert.match(String(rejected[0].error), /횡보/);
  } finally {
    for (const k of Object.keys(require.cache)) {
      if (/simpleStock\/server\//.test(k)) delete require.cache[k];
    }
  }
});

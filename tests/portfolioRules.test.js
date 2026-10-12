/**
 * 🔴 **포트폴리오 진단 기준선** (2026-10-12 — 구 `positionCount.test.js` 를 이어받음)
 *
 * 종전 이 자리는 *"종목 수가 상한을 넘으면 주문을 거부한다"* 를 쟀다.
 * 주문 집행을 걷어내면서 같은 값이 **진단 기준선**이 됐다 — 막지 않고 **말한다.**
 *
 * ⚠️ 그래서 쌍으로 잰다: **넘으면 `over`** · **안 넘으면 `ok`** ·
 *    🔴 **못 재면 `unknown`**(가장 중요하다 — 0 으로 떨어지면 "검사 못 함" 이 "통과" 가 된다).
 */
const test = require('node:test');
const assert = require('node:assert');

function fresh({ single = 40, max = 3, lev = 40, cash = 0 } = {}) {
  for (const k of Object.keys(require.cache)) if (/portfolioRules/.test(k)) delete require.cache[k];
  process.env.SINGLE_POSITION_MAX_PCT = String(single);
  process.env.MAX_POSITIONS = String(max);
  process.env.LEVERAGE_MAX_PCT = String(lev);
  process.env.CASH_FLOOR_PCT = String(cash);
  return require('../server/portfolioRules');
}

test('넘으면 over — 막지 않고 사실만 말한다', () => {
  const r = fresh().diagnose({ maxWeightPct: 43, positionCount: 4, leveragePct: 48.5, cashPct: 10 });
  const by = Object.fromEntries(r.checks.map((c) => [c.key, c]));
  assert.equal(by.concentration.status, 'over', 'QLD 43% 는 기준선 40% 위다');
  assert.equal(by.positions.status, 'over', '4종목은 상한 3 위다');
  assert.equal(by.leverage.status, 'over');
  assert.equal(r.overCount, 3);
});

test('안 넘으면 ok', () => {
  const r = fresh().diagnose({ maxWeightPct: 31.8, positionCount: 3, leveragePct: 36 });
  assert.equal(r.overCount, 0, '기준선 안이면 초과 0건');
  assert.ok(r.checks.every((c) => c.status === 'ok'));
});

test('🔴 못 재면 unknown — "검사 못 함" 이 "통과" 가 되지 않는다', () => {
  const r = fresh().diagnose({ maxWeightPct: null, positionCount: 2, leveragePct: undefined });
  const by = Object.fromEntries(r.checks.map((c) => [c.key, c]));
  assert.equal(by.concentration.status, 'unknown');
  assert.equal(by.leverage.status, 'unknown');
  assert.equal(by.concentration.actual, null, 'null 을 0 으로 채우지 않는다');
  assert.equal(r.overCount, 0, 'unknown 은 초과가 아니다');
  assert.equal(r.unknownCount, 2, '못 잰 개수를 따로 센다');
});

test('상한 0 은 "그 기준을 안 쓴다" — 판정 자체를 내지 않는다', () => {
  const r = fresh({ max: 0, cash: 0 }).diagnose({ maxWeightPct: 10, positionCount: 9, cashPct: 0 });
  const keys = r.checks.map((c) => c.key);
  assert.ok(!keys.includes('positions'), 'MAX_POSITIONS=0 이면 종목 수를 판정하지 않는다');
  assert.ok(!keys.includes('cash'), 'CASH_FLOOR_PCT=0 이면 현금 버퍼를 판정하지 않는다');
});

test('현금 버퍼는 **아래로** 넘으면 over 다(방향이 반대)', () => {
  const r = fresh({ cash: 15 }).diagnose({ maxWeightPct: 10, positionCount: 1, leveragePct: 0, cashPct: 9 });
  const cash = r.checks.find((c) => c.key === 'cash');
  assert.equal(cash.direction, 'min');
  assert.equal(cash.status, 'over', '9% 는 하한 15% 미만이라 초과(미달)다');
});

test('🔴 한도 값이 바뀌면 판정도 바뀐다 — 복사본을 보고 있지 않다', () => {
  const tight = fresh({ single: 20 }).diagnose({ maxWeightPct: 31.8, positionCount: 2, leveragePct: 0 });
  const loose = fresh({ single: 40 }).diagnose({ maxWeightPct: 31.8, positionCount: 2, leveragePct: 0 });
  assert.equal(tight.checks.find((c) => c.key === 'concentration').status, 'over');
  assert.equal(loose.checks.find((c) => c.key === 'concentration').status, 'ok');
});

test('limitsSummary 는 쓰는 기준만 말한다', () => {
  assert.match(fresh({ max: 3, cash: 15 }).limitsSummary(), /보유 3종목/);
  assert.doesNotMatch(fresh({ max: 0, cash: 0 }).limitsSummary(), /보유|현금/);
});

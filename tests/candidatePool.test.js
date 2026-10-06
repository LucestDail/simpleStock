/**
 * 🔴 **후보는 감시 목록 안에서만** (2026-10-06 사용자: "별 쓰레기같은 ETF 다 넣으라는게
 * 아니라 실제 필요한 것들로 추리라고 카테고리 뭔 다 감시를 걸어놓은거야 대체 왜").
 *
 * ## 무엇이 일어났나
 * 후보 선정이 **카탈로그 940종** 기반이고 감시 목록과 **무관**했다. 그래서 감시를 16종으로
 * 추려도 보고서에는 VONG·XLE·IBIT·IONQ 처럼 본 적 없는 종목이 계속 올라왔다
 * (전부 `HOLD`·`LOW` = 근거 불충분인데 자리만 차지하고, 사용자는 "이거 뭐야" 를 묻게 된다).
 *
 * ## 이 자가 지키는 것 — 쌍으로
 *   발동: 감시 밖 종목은 후보에서 제외된다
 *   폴백: 감시 목록을 **못 읽으면**(null) 종전 동작 — "모름" 을 "없음" 으로 읽어 후보를
 *        0 으로 만들면 조회 장애가 판단을 멈춘다. ⚠️**빈 배열은 0 이 맞다**(아무것도 안 켠 상태).
 */
const test = require('node:test');
const assert = require('node:assert');
const regime = require('../server/regimeService');

const CAT = {
  categories: {
    tech_broad: { etfs: [
      { symbol: 'QQQM', leverage: 1 }, { symbol: 'QQQ', leverage: 1 },
      { symbol: 'VONG', leverage: 1 }, { symbol: 'QLD', leverage: 2 },
    ] },
    energy_oil_gas: { etfs: [{ symbol: 'XLE', leverage: 1 }] },
  },
};
const SCEN = [{ id: 's1', steps: ['tech_broad 와 energy_oil_gas 를 본다'] }];

function pick(watched) {
  const out = regime.roundRobinCandidates(SCEN, CAT, new Set(), watched);
  return out.map((w) => w.symbol).sort();
}

/**
 * ⚠️ 자를 고친 기록: 처음엔 `VONG` 으로 판정했는데 **라운드로빈이 카테고리당 하나씩**
 *    뽑으므로 VONG(tech_broad 셋째)은 후보 수가 적을 때 애초에 안 뽑힌다 — 자가 엉뚱한
 *    것을 재고 있었다. 감시 필터의 효과는 **다른 카테고리의 XLE** 로 갈린다(실측으로 확정).
 */
test('감시 안에서만 고른다 — 감시 밖(XLE)은 후보에서 빠진다', () => {
  const got = pick(['QQQM', 'QQQ']);
  assert.ok(got.includes('QQQM'), '감시중인 QQQM 이 후보에 없다');
  assert.ok(!got.includes('XLE'), 'XLE 이 후보에 남았다 — 감시 밖인데 보고서에 오른다');
  assert.ok(!got.includes('VONG'), 'VONG 이 후보에 남았다');
});

test('목표 심볼만 감시하면 그것만 후보 — 사용자가 추린 대로', () => {
  assert.deepEqual(pick(['QQQM']), ['QQQM']);
});

test('폴백 쌍 — null(못 읽음)은 종전 동작 · 빈 배열은 후보 0', () => {
  const all = pick(null);
  assert.ok(all.includes('XLE'),
    'null 인데 감시 밖(XLE)이 빠졌다 — 조회 장애가 판단을 멈춘다(모름 ≠ 없음)');
  assert.deepEqual(pick([]), [], '빈 배열인데 후보가 생겼다 — 아무것도 안 켠 상태를 무시했다');
});

test('레버리지·보유 필터는 그대로 — 감시 필터가 기존 규칙을 덮지 않는다', () => {
  // QLD(2배)는 감시중이어도 후보가 아니다(후보는 1배만)
  assert.ok(!pick(['QLD', 'QQQM']).includes('QLD'), '2배가 후보로 올라왔다');
  const held = regime.roundRobinCandidates(SCEN, CAT, new Set(['QQQM']), ['QQQM', 'QQQ']);
  assert.deepEqual(held.map((w) => w.symbol), ['QQQ'], '보유 종목이 후보로 올라왔다');
});

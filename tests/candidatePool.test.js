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

/**
 * 🔴 **후보 풀의 정본은 목표 배분이다** (2026-10-06 사용자 지적:
 * *"지금 감시 대상이 뭔데 레버리지도 포함중이야? 섹터별로 다 포함중이야?"*).
 *
 * 내가 후보 풀을 **감시 목록**으로 묶은 것이 틀렸다 — 감시에는 **국면 판정용 신호**
 * (SPY·TLT·UUP·VIXY·HYG)가 섞여 있어서 **금리 상승 국면에 TLT 매수 제안**이 가능해졌다.
 * 역할이 다른 둘을 한 목록으로 묶은 것이 원인이다.
 *   감시 = 시세·모멘텀을 본다(넓게, 신호 포함)
 *   후보 = 목표 배분 심볼만(좁게, 사람이 선언한 것)
 */
test('후보 풀 = 목표 배분 — 신호용(TLT·UUP·VIXY·SPY·HYG)은 후보가 아니다', () => {
  const regime2 = require('../server/regimeService');
  const pool = regime2.candidateUniverse();
  assert.ok(Array.isArray(pool) && pool.length, '후보 풀이 비었다 — 제안이 통째로 멈춘다');
  for (const sig of ['TLT', 'UUP', 'VIXY', 'SPY', 'HYG', 'SMH']) {
    assert.ok(!pool.includes(sig), `${sig} 가 후보 풀에 있다 — 신호용인데 매수 대상이 된다`);
  }
  // 목표 배분 심볼은 전부 들어 있다(슬롯의 primary·momentum 포함)
  for (const want of ['QQQM', 'TQQQ', 'QLD', 'O', 'SCHD', 'VNQ']) {
    assert.ok(pool.includes(want), `${want} 가 후보 풀에 없다 — 목표인데 못 산다`);
  }
  // 🔴 QQQ 는 목표 밖 — 팔아도 후보로 돌아오지 않는다(사용자가 "털어야 해" 라고 한 종목)
  assert.ok(!pool.includes('QQQ'), 'QQQ 가 후보 풀에 있다 — 털어도 다시 추천된다');
});

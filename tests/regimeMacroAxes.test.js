const { test } = require('node:test');
const assert = require('node:assert/strict');
const regime = require('../server/regimeService');

/**
 * 🔴 **매크로 국면 축** — 2026-10-02 사용자 지시로 신설
 *
 * > *"금리 인상/횡보/하락 등등 … 발생할 시장 국면성을 전부다 열거 및 상세 시나리오,
 * >  포트폴리오, 케이스 다 구성해."*
 *
 * ## 왜 필요했나
 * 종전 국면은 `trend × shock × vixBand` **셋뿐**이었고 **금리 축이 아예 없었다.**
 * 그래서 2026-10-02 의 실측 국면을 시스템이 **볼 수 없었다**:
 * ```
 * 美 10년물 5.34% — 24년만의 최고 · 글로벌 국채 투매(英 30년물 6% 돌파)   ← 웹 검색
 * TLT·IEF·SHY 전부 하락 · HYG·LQD 하락 · UUP 상승 · QQQ만 상승            ← 브로커 실측
 * ```
 * 그 결과 리얼티 인컴 하락을 *"52주 신저가"* 라는 **증상**으로만 읽어 매도를 제안했다
 * (01:47·05:03 두 번, 사용자가 둘 다 거절). 실제 원인은 **금리**였고 VNQ·XLU·SCHD 가 같이 내렸다.
 *
 * ## ⚠️ 이 자가 지키는 가장 중요한 것 — **모르면 null 이다**
 * 데이터 없는 축을 "중립" 으로 채우면 **결손이 안심 신호**가 된다. VIX 밴드가 이미 배운 것이고,
 * 여기서 어기면 매뉴얼이 데이터 없이 발동한다.
 */

const series = (dir) => ({
  closes: dir === 'down' ? Array.from({ length: 70 }, (_, i) => 100 - i * 0.5)
    : dir === 'up' ? Array.from({ length: 70 }, (_, i) => 50 + i * 0.5)
      : Array.from({ length: 70 }, () => 100),
  last: null,
});

/** 2026-10-02 실측 그대로 */
const LIVE = {
  tlt: series('down'), ief: series('down'), shy: series('down'), uup: series('up'),
  hyg: series('down'), lqd: series('down'), tip: series('down'),
  qqq: series('up'), spy: series('side'),
};

test('🔴 2026-10-02 실측 국면을 그대로 판정한다 (금리 전 구간 상승 · 신용 경색 · 좁은 시장)', () => {
  const m = regime.judgeMacro(LIVE);
  assert.equal(m.rates, 'rising', '채권이 전부 내리는데 금리 상승으로 안 읽었다');
  assert.equal(m.rateShape, 'whole-curve', '단기물까지 내렸으면 전 구간이다(정책금리 기대 이동)');
  assert.equal(m.credit, 'stress');
  assert.equal(m.dollar, 'strong');
  assert.equal(m.breadth, 'narrow', 'QQQ만 오르고 SPY가 못 따라가면 좁은 시장이다');
  assert.equal(m.realRate, 'rising');
});

test('장기물만 내리면 **전 구간이 아니다** (처방이 다르다)', () => {
  const m = regime.judgeMacro({ ...LIVE, shy: series('side') });
  assert.equal(m.rates, 'rising');
  assert.equal(m.rateShape, 'long-end', '단기물이 버티면 재정·기간프리미엄 문제다');
});

test('채권이 오르면 금리 하락으로 읽는다', () => {
  const m = regime.judgeMacro({ tlt: series('up'), ief: series('up') });
  assert.equal(m.rates, 'falling');
  assert.equal(m.rateShape, null, '하락 국면에 상승 모양을 붙이지 않는다');
});

test('🔴 데이터가 없으면 null 이다 — "중립" 으로 채우지 않는다', () => {
  const m = regime.judgeMacro({});
  for (const k of ['rates', 'credit', 'dollar', 'breadth', 'realRate']) {
    assert.equal(m[k], null, `${k} 를 추측해 채웠다 — 결손이 안심 신호가 된다`);
  }
});

test('한쪽만 있으면 그것으로 판정하되 지어내지 않는다', () => {
  const m = regime.judgeMacro({ tlt: series('down') });
  assert.equal(m.rates, 'rising', 'TLT 하나로도 방향은 읽는다');
  assert.equal(m.credit, null, '신용 데이터가 없는데 판정했다');
});

// ── 매칭 ────────────────────────────────────────────────────

const PB = () => JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'config', 'playbook.json'), 'utf8'));
const stateWith = (macro, extra = {}) => ({ kr: null, us: { trend: 'up', shock: false }, vix: { band: 0 }, manual: [], macro, ...extra });

test('🔴 실측 국면에서 금리·신용·시장폭 매뉴얼이 발동한다', () => {
  const ids = regime.matchScenarios(stateWith(regime.judgeMacro(LIVE)), PB()).map((s) => s.id);
  assert.ok(ids.includes('rate_shock_whole_curve'), '🔴 금리 축이 안 떴다 — 2026-10-02 사고의 핵심이다');
  assert.ok(ids.includes('narrow_leadership'), '좁은 시장을 못 봤다');
  assert.ok(ids.some((x) => /^credit_stress/.test(x)), '신용 축이 안 떴다');
});

/**
 * 🔴 **특수가 일반을 밀어낸다** — 같은 가족이 둘 다 뜨면 상한 칸을 두 번 먹어
 *    **정작 중요한 다른 축이 잘린다**(실측: credit_stress 둘이 떠서 rate_shock_whole_curve 가 밀렸다).
 */
test('🔴 특수 시나리오가 일반 부모를 밀어낸다 (칸을 두 번 먹지 않는다)', () => {
  const ids = regime.matchScenarios(stateWith(regime.judgeMacro(LIVE)), PB()).map((s) => s.id);
  assert.ok(ids.includes('credit_stress_low_vix'), '특수형(신용 경색 + 저VIX)이 안 떴다');
  assert.ok(!ids.includes('credit_stress'), '🔴 일반형이 같이 떠서 칸을 두 번 먹었다');
});

/**
 * 🔴 **포트폴리오 자신도 국면이다** (2026-10-02). 시장이 멀쩡해도 내 배분이 위험하면
 *    다뤄야 할 상태다 — 실측 레버리지 합계 **90.7%** 인데 어떤 매뉴얼도 안 보고 있었다.
 */
test('🔴 레버리지 쏠림이 "내 포트폴리오" 국면으로 발동한다', () => {
  const got = regime.matchScenarios(stateWith(regime.judgeMacro(LIVE), { portfolio: { leveragePct: 90.7, cashPct: 8.6 } }), PB());
  const lev = got.find((s) => s.id === 'leverage_concentration');
  assert.ok(lev, '🔴 레버리지 90.7% 인데 아무 매뉴얼도 안 떴다');
  assert.equal(lev.via, '내 포트폴리오', '발동 근원이 시장으로 적혔다');
});

test('🔴 비중을 못 읽으면 포트폴리오 매뉴얼은 발동하지 않는다 (모름 ≠ 맞음)', () => {
  const ids = regime.matchScenarios(stateWith(regime.judgeMacro(LIVE)), PB()).map((s) => s.id);
  assert.ok(!ids.includes('leverage_concentration'), '비중 데이터가 없는데 발동했다');
  assert.ok(!ids.includes('cash_drag'));
});

test('오탐 축: 레버리지가 낮으면 쏠림 매뉴얼은 안 뜬다', () => {
  const ids = regime.matchScenarios(stateWith(regime.judgeMacro(LIVE), { portfolio: { leveragePct: 12, cashPct: 20 } }), PB()).map((s) => s.id);
  assert.ok(!ids.includes('leverage_concentration'));
  assert.ok(!ids.includes('cash_drag'), '현금 20%는 과다가 아니다');
});

test('🔴 위험을 줄이는 매뉴얼이 공격 매뉴얼을 이긴다 (정반대 지시가 같이 가면 안 된다)', () => {
  const got = regime.matchScenarios(stateWith(regime.judgeMacro(LIVE)), PB());
  const ids = got.map((s) => s.id);
  assert.ok(!ids.includes('bull_calm'),
    '🔴 "공격 축 확대 허용"(bull_calm)과 "레버리지를 쓰지 않는다"(stagflation)가 **동시에** 모델에게 갔다');
  assert.ok(got.length <= 6, `상한을 넘었다(${got.length}) — 전부 실으면 길이가 판단을 밀어낸다`);
  const pri = got.map((s) => s.priority ?? 50);
  assert.deepEqual(pri, [...pri].sort((a, b) => b - a), '정렬이 안 됐다');
});

test('🔴 모르는 축은 발동시키지 않는다 (null 을 "맞다" 로 읽으면 결손이 매뉴얼을 켠다)', () => {
  const ids = regime.matchScenarios(stateWith(null), PB()).map((s) => s.id);
  for (const macroOnly of ['rate_shock_whole_curve', 'credit_stress', 'dollar_surge', 'stagflation', 'narrow_leadership']) {
    assert.ok(!ids.includes(macroOnly), `매크로 데이터가 없는데 ${macroOnly} 가 발동했다`);
  }
});

test('금리 하락 국면에서는 되사는 매뉴얼이 발동한다 (reits·utilities·bonds)', () => {
  const m = regime.judgeMacro({ tlt: series('up'), ief: series('up'), hyg: series('up'), qqq: series('up'), spy: series('up') });
  const got = regime.matchScenarios(stateWith(m), PB());
  const ids = got.map((s) => s.id);
  assert.ok(ids.includes('rate_falling_pivot'), '금리 하락 전환 매뉴얼이 없다');
  const cats = new Set(got.flatMap((s) => s.categories || []));
  assert.ok(cats.has('reits') || cats.has('bonds'), '되살 대상(리츠·채권)이 도구상자에 없다');
});

// ── 프롬프트 ─────────────────────────────────────────────────

test('🔴 매크로 축이 **모델에게 실린다** (판정만 하고 안 쓰면 "수집해 놓고 안 쓰는" 이다)', () => {
  const sec = regime.promptSection(stateWith(regime.judgeMacro(LIVE)));
  assert.match(sec, /매크로:/, '매크로 절이 없다');
  assert.match(sec, /금리 상승/, '금리 축이 안 실렸다');
  assert.match(sec, /신용 경색/, '신용 축이 안 실렸다');
  assert.match(sec, /증상이지 원인이 아니다/, '국면 우선 지시가 없다 — 이게 10-02 사고의 핵심이다');
});

test('오탐 축: 매크로가 없으면 그 절을 아예 만들지 않는다', () => {
  const sec = regime.promptSection(stateWith(null));
  assert.ok(!sec.includes('매크로:'), '데이터가 없는데 빈 매크로 절이 생겼다');
});

test('라벨이 겹치지 않는다 ("금리 금리 상승" 같은 것)', () => {
  const sec = regime.promptSection(stateWith(regime.judgeMacro(LIVE)));
  assert.ok(!/금리 금리|신용 신용/.test(sec), '라벨이 두 번 붙었다');
});

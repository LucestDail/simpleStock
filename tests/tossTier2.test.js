const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { computeTrade } = require('../server/analystService');

/**
 * 2순위 — 증시상황 · 수급 · 수수료 (2026-09-22)
 *
 * ## 이 커밋의 절반은 **새 API 가 아니라 "있는데 안 쓰던 것"** 이다
 * ```
 * 테이프 28종(나스닥·S&P·VIX·미국채30년·환율)  → 프롬프트에 0건이었다
 * getInvestorTrading 구현·라우트 있음          → 프롬프트는 "기관 수급 없다" 고 적었다
 * ```
 */

// ── 수수료 반영 손익비 ───────────────────────────────────────

test('🔴 수수료를 반영하면 손익비가 내려간다', () => {
  const a = computeTrade({ side: 'BUY', entry: 100, stop: 95, target: 110 });
  const b = computeTrade({ side: 'BUY', entry: 100, stop: 95, target: 110, costRate: 0.001 });
  assert.equal(a.rr, 2);
  assert.ok(b.rrAfterFee < a.rr, `🔴 비용을 반영했는데 안 내려갔다(${b.rrAfterFee})`);
  assert.equal(b.costRate, 0.001, '어떤 요율을 썼는지 남아야 한다');
});

/** 🔴 폭이 좁으면 **이익이 안 남는다** — 그걸 말해야 한다(조용히 좋은 수를 내면 안 된다) */
test('🔴 수수료를 빼면 이익이 없을 때 그렇게 말한다', () => {
  const c = computeTrade({ side: 'BUY', entry: 100, stop: 99, target: 100.15, costRate: 0.001 });
  assert.ok(c.rr > 0, '수수료 전에는 이익으로 보인다');
  assert.equal(c.rrAfterFee, null);
  assert.match(c.rrAfterFeeNote, /이익이 남지 않습니다/);
});

/** ⚠️ 요율을 못 받으면 **0 으로 치지 않는다** — 비용을 안 넣을 뿐이다 */
test('⚠️ 요율이 없으면 rrAfterFee 를 내지 않는다 (0% 로 가정하지 않는다)', () => {
  const r = computeTrade({ side: 'BUY', entry: 100, stop: 95, target: 110 });
  assert.equal(r.rrAfterFee, undefined, '🔴 비용 미상인데 "비용 반영" 숫자를 냈다');
  assert.equal(computeTrade({ side: 'BUY', entry: 100, stop: 95, target: 110, costRate: 0 }).rrAfterFee, undefined);
});

test('매도 방향에도 적용된다', () => {
  const r = computeTrade({ side: 'SELL', entry: 100, stop: 105, target: 90, costRate: 0.001 });
  assert.ok(r.rr > 0 && r.rrAfterFee > 0 && r.rrAfterFee < r.rr);
});

// ── 수수료 유효기간 (명세 ≠ 라이브) ──────────────────────────

/**
 * 🔴 **명세와 라이브가 다르다**(에이전트가 잡았다):
 * 명세는 무기한을 `endDate:null` 로 적는데 **라이브 국내는 `"9999-12-31"`** 이다.
 * `null` 만 보면 *"만료됐다"* 로 오판한다.
 * 🔴 그리고 실측 미국 `endDate` 가 **오늘**이었다 — 캐시하면 조용히 틀린 요율로 계산한다.
 */
test('🔴 무기한 표기 두 가지를 모두 살린다 (null · 9999-12-31)', () => {
  const { pickLiveCommissions } = require('../server/tossClient');
  const rows = [
    { marketCountry: 'KR', commissionRate: '0.00015', startDate: '2021-01-01', endDate: '9999-12-31' },
    { marketCountry: 'US', commissionRate: '0.001', startDate: null, endDate: null },
    { marketCountry: 'JP', commissionRate: '0.005', startDate: '2020-01-01', endDate: '2020-12-31' },
  ];
  const live = pickLiveCommissions(rows, '2026-09-22');
  assert.deepEqual(live.map((r) => r.market).sort(), ['KR', 'US'],
    '🔴 9999-12-31 을 만료로 읽거나 null 을 버렸다');
  assert.equal(live.find((r) => r.market === 'KR').rate.num, 0.00015);
});

/** 🔴 실측 그대로 — 미국 요율 `endDate` 가 **당일**이었다. 당일은 아직 유효하고 "곧 끝남" 이다 */
test('🔴 당일 만료는 아직 유효하되 **곧 끝난다고 표시**한다 (라이브 실측)', () => {
  const { pickLiveCommissions } = require('../server/tossClient');
  const rows = [{ marketCountry: 'US', commissionRate: '0.001', startDate: null, endDate: '2026-09-22' }];
  const live = pickLiveCommissions(rows, '2026-09-22', Date.parse('2026-09-22T10:00:00+09:00'));
  assert.equal(live.length, 1, '🔴 당일 만료를 이미 끝난 것으로 버렸다');
  assert.equal(live[0].endsSoon, true, '🔴 곧 끝나는데 표시가 없다 — 캐시가 조용히 낡는다');
});

test('지난 요율은 버린다', () => {
  const { pickLiveCommissions } = require('../server/tossClient');
  const live = pickLiveCommissions(
    [{ marketCountry: 'US', commissionRate: '0.001', startDate: null, endDate: '2026-09-21' }],
    '2026-09-22'
  );
  assert.deepEqual(live, [], '🔴 만료된 요율로 손익을 계산하게 된다');
});

test('아직 시작 안 한 요율도 버린다', () => {
  const { pickLiveCommissions } = require('../server/tossClient');
  assert.deepEqual(pickLiveCommissions(
    [{ marketCountry: 'KR', commissionRate: '0.0001', startDate: '2027-01-01', endDate: null }], '2026-09-22'
  ), []);
});

// ── 구조 가드: 없다고 적어 놓고 주는 데이터가 없어야 한다 ─────

/**
 * 🔴 **프롬프트가 거짓말하지 않는다** — *"이 시스템에 없는 데이터"* 목록에
 * **실제로 받아오는 축**을 적어 두면, 모델에게 없다고 말하고 데이터는 주는 꼴이 된다.
 * 실제로 `기관/외국인 수급 상세` 가 그 상태였다(`getInvestorTrading` 이 구현·배선돼 있었다).
 */
test('🔴 "없는 데이터" 목록에 실제로 받는 축을 적지 않는다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf8');
  const raw = /const missingAxes = \[([\s\S]*?)\];/.exec(src)?.[1] || '';
  assert.ok(raw, 'missingAxes 를 못 찾았다 — 자가 헛돈다');
  /**
   * 🔴 **주석을 먼저 지운다.** 첫 판에서 이 자가 **주석 안의 `'기관/외국인 수급 상세'`** 를
   *    목록으로 읽어 오탐했다 — 그 줄은 *"뺐다"* 는 설명이었다.
   *    오늘 여러 번 쓴 *"이름이 아니라 구조로 판정 · 주석·문자열을 먼저 지운다"* 를 내가 또 어겼다.
   */
  const block = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const listed = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(listed.length >= 4, `목록이 ${listed.length}개뿐이다`);

  /** 우리가 **실제로 받아오는** 축 → 이 말이 목록에 있으면 거짓이다 */
  const WE_HAVE = [
    ['수급', 'getInvestorTrading 으로 받는다'],
    ['지수', '테이프 28종으로 받는다'],
    ['수수료', 'getCommissions 로 받는다'],
  ];
  const lies = [];
  for (const [word, why] of WE_HAVE) {
    const hit = listed.find((x) => x.includes(word));
    if (hit) lies.push(`"${hit}" — ${why}`);
  }
  assert.deepEqual(lies, [], `\n🔴 없다고 적었는데 실제로는 받는다:\n${lies.join('\n')}`);
});

/** 🔴 자기검증: 그 목록이 **비어 있지도** 않아야 한다(진짜 없는 축은 밝혀야 한다) */
test('🔴 자기검증: 정말 없는 축은 여전히 적혀 있다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf8');
  const block = /const missingAxes = \[([\s\S]*?)\];/.exec(src)?.[1] || '';
  for (const must of ['재무제표', '내부자', '옵션']) {
    assert.ok(block.includes(must), `🔴 "${must}" 가 목록에서 빠졌다 — 없는 걸 있다고 믿게 된다`);
  }
});

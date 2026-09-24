/**
 * 시장 국면 데몬 — 순수부 (2026-09-23)
 *
 * 🔴 재는 것: 판정이 산수인가(같은 입력=같은 판정) · "모름" 과 "횡보" 가 갈리는가 ·
 * 전이만 이벤트가 되는가(엣지) · 매뉴얼 매칭이 조합에서 전부 발동하는가 ·
 * 프롬프트 절이 발동 절과 관련 카테고리만 싣는가.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const regime = require('../server/regimeService');

/** n 개의 종가를 등차로 — 상승/하락 추세 합성 */
const ramp = (start, step, n) => Array.from({ length: n }, (_, i) => start + step * i);

test('🔴 지수 캔들은 받는 자리에서 시간순 정렬된다 — 역순이면 ma20 이 "가장 오래된 20개" 가 된다', () => {
  // 실측(2026-09-23): 지수 캔들은 최신이 앞, 종목 캔들은 반대(reverse 처리 기존재).
  // 첫 실판정에서 KOSPI 당일 등락이 -19.5%(70일 전 대비)로 나와 잡았다.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server', 'tossClient.js'), 'utf8');
  const idx = src.indexOf('async function getIndexCandles');
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.ok(/rows\.sort\(.*Date\.parse\(a\.t\) - Date\.parse\(b\.t\)/.test(body), 'getIndexCandles 에 시간순 정렬이 없다');
});

test('추세 판정은 산수다 — up/down/side, 데이터 부족은 null(횡보가 아니다)', () => {
  assert.equal(regime.judgeMarket({ closes: ramp(100, 1, 70) }).trend, 'up');
  assert.equal(regime.judgeMarket({ closes: ramp(170, -1, 70) }).trend, 'down');
  // 반등 초입(현재가 > 20일선, 그러나 20일선 < 60일선) = side — up 도 down 도 아니다
  const rebound = [...Array(50).fill(120), ...Array(20).fill(100)];
  assert.equal(regime.judgeMarket({ closes: rebound, last: 101 }).trend, 'side');
  // 🔴 데이터 부족(60봉 미만)은 null — "모름" 을 "횡보" 로 지어내면 매뉴얼이 엉뚱하게 발동한다
  assert.equal(regime.judgeMarket({ closes: ramp(100, 1, 30) }).trend, null);
});

test('급락(-3%)과 VIX 밴드 — 사용자 규칙(20/25/30/35) 그대로', () => {
  const closes = [...ramp(100, 0.1, 69), 96]; // 마지막 봉이 -3.4%
  assert.equal(regime.judgeMarket({ closes }).shock, true);
  // 현재가(last)를 주면 마지막 확정 종가 대비로 잰다
  assert.equal(regime.judgeMarket({ closes: ramp(100, 0, 70), last: 96.9 }).shock, true);
  assert.equal(regime.judgeMarket({ closes: ramp(100, 0, 70), last: 97.1 }).shock, false);
  assert.deepEqual([14, 20, 25, 30, 35, null].map(regime.vixBandOf), [0, 1, 2, 3, 4, null]);
});

test('🔴 매뉴얼 매칭 — 하락추세+VIX26 이면 bear_trend 와 fear_ladder 가 **둘 다** 발동한다', () => {
  const state = regime.compute({
    us: { closes: ramp(170, -1, 70) },
    vix: 26,
  });
  const pb = regime.readPlaybook();
  const ids = regime.matchScenarios(state, pb).map((s) => s.id);
  assert.ok(ids.includes('bear_trend'), `bear_trend 미발동: ${ids}`);
  assert.ok(ids.includes('fear_ladder'), `fear_ladder 미발동: ${ids}`);
  // 상승+평온이면 bull_calm 만
  const calm = regime.compute({ us: { closes: ramp(100, 1, 70) }, vix: 14 });
  const calmIds = regime.matchScenarios(calm, pb).map((s) => s.id);
  assert.ok(calmIds.includes('bull_calm'));
  assert.ok(!calmIds.includes('fear_ladder'));
  // 수동 국면은 태그로만 발동
  const manual = regime.compute({ us: { closes: ramp(100, 1, 70) }, vix: 14, manual: ['geopolitics'] });
  assert.ok(regime.matchScenarios(manual, pb).map((s) => s.id).includes('war_geopolitics'));
});

test('전이만 이벤트다 — 같은 상태는 0건, 바뀐 축만 목록에 (엣지 트리거)', () => {
  const a = regime.compute({ us: { closes: ramp(100, 1, 70) }, vix: 14 });
  const b = regime.compute({ us: { closes: ramp(170, -1, 70) }, vix: 26 });
  assert.equal(regime.diffTransitions(a, { ...a, at: 'x' }).length, 0);
  const t = regime.diffTransitions(a, b);
  assert.ok(t.some((x) => /US 상승추세 → 하락추세/.test(x)), t.join(' | '));
  assert.ok(t.some((x) => /VIX/.test(x)), t.join(' | '));
  // 🔴 null(판정 불가)로의 변화는 전이가 아니다 — 데이터 결손이 알림이 되면 오경보다
  const broken = regime.compute({ us: { closes: [] }, vix: null });
  assert.equal(regime.diffTransitions(a, broken).length, 0);
});

test('프롬프트 절 — 판정·발동 매뉴얼·관련 도구상자만 싣고, 코드 판정을 다시 하지 말라고 명시', () => {
  const state = regime.compute({ us: { closes: ramp(170, -1, 70) }, vix: 26 });
  const sec = regime.promptSection(state);
  assert.match(sec, /## 시장 국면/);
  assert.match(sec, /다시 판정하지 마라/);
  assert.match(sec, /하락추세/);
  assert.match(sec, /발동된 매뉴얼/);
  assert.match(sec, /공포 사다리/);
  // 발동 스텝이 참조한 카테고리(staples 등)의 도구상자가 실린다 — 티커 지어내기 차단
  assert.match(sec, /도구상자/);
  assert.match(sec, /XLP/);
  // VIX 미확인이면 "낮다고 가정 금지" 가 실린다
  const noVix = regime.promptSection(regime.compute({ us: { closes: ramp(100, 1, 70) } }));
  assert.match(noVix, /확인 못 함/);
});

test('🔴 인버스 게이트 — 동작으로 잰다(구조 grep 아님) + 실전·백테스트가 같은 함수를 탄다', () => {
  // 스펙트럼 시뮬 실증(09-24): 규칙이 프롬프트에 있는데 모델이 횡보에서 PSQ 매수를 냈다
  const { inverseGate } = require('../server/analystService');
  const down = { us: { trend: 'down' }, kr: { trend: 'side' } };
  const side = { us: { trend: 'side' }, kr: { trend: 'side' } };
  // 발동: 횡보에서 PSQ 매수 차단(그 시뮬 그대로) · 3배는 하락에서도 차단 · KR 인버스는 KR 추세를 본다
  assert.equal(inverseGate({ symbol: 'PSQ', side: 'BUY' }, side).ok, false);
  assert.equal(inverseGate({ symbol: 'SQQQ', side: 'BUY' }, down).ok, false);
  assert.equal(inverseGate({ symbol: '114800', side: 'BUY' }, down).ok, false); // kr 은 side
  // 오탐 없음: 확정 하락 1배 통과 · 인버스 매도(청산)는 언제나 통과 · 일반 종목 무관
  assert.equal(inverseGate({ symbol: 'PSQ', side: 'BUY' }, down).ok, true);
  assert.equal(inverseGate({ symbol: 'PSQ', side: 'SELL' }, side).ok, true);
  assert.equal(inverseGate({ symbol: 'QQQ', side: 'BUY' }, side).ok, true);
  // 🔴 게이트 한 벌: 실전 루프와 decideOnContext 둘 다 inverseGate( 를 부른다(두 벌이면 갈라진다)
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server', 'analystService.js'), 'utf8');
  assert.ok((src.match(/inverseGate\(/g) || []).length >= 3, 'inverseGate 호출이 2곳 미만 — 한쪽이 게이트를 안 탄다');
});

test('🔴 VIX 사다리 — 코드가 제안을 만든다(백테스트 실증: LLM 은 공포에서 안 산다)', () => {
  // 전이에서만 · 단계 금액 10/20/30/40% · 밴드 건너뛰면 각 단계 순차(잔여 현금 기준)
  assert.deepEqual(regime.ladderProposals({ prevBand: 0, band: 0, cashUsd: 1000 }), []);
  assert.deepEqual(regime.ladderProposals({ prevBand: 1, band: 1, cashUsd: 1000 }), []); // 같은 밴드 반복 금지
  assert.deepEqual(regime.ladderProposals({ prevBand: 2, band: 1, cashUsd: 1000 }), []); // 하강은 아님
  const one = regime.ladderProposals({ prevBand: 0, band: 1, cashUsd: 1000 });
  assert.equal(one.length, 1); assert.equal(one[0].budget, 100); assert.equal(one[0].side, 'BUY');
  const jump = regime.ladderProposals({ prevBand: 0, band: 3, cashUsd: 1000 });
  assert.deepEqual(jump.map((x) => x.budget), [100, 180, 216]); // 10% → 잔여의 20% → 잔여의 30%
  assert.deepEqual(regime.ladderProposals({ prevBand: 0, band: 2, cashUsd: 0 }), []); // 현금 0 이면 없음
  assert.deepEqual(regime.ladderProposals({ prevBand: null, band: 2, cashUsd: 1000 }), []); // 기준 없으면 안 쏨(재기동 오발 방지)
});

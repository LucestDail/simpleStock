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

test('🔴 인버스 게이트가 코드에 실재하고 분석 제안 경로에 있다 — 프롬프트만 믿지 않는다', () => {
  // 스펙트럼 시뮬 실증(09-24): 규칙이 프롬프트에 있는데 모델이 횡보에서 PSQ 매수를 냈다
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server', 'analystService.js'), 'utf8');
  const i = src.indexOf('inverse_hedge');
  assert.ok(i > 0, '인버스 게이트가 없다');
  const block = src.slice(i - 200, i + 900);
  assert.match(block, /trend === 'down'/, '확정 하락추세 조건이 없다');
  assert.match(block, /Math\.abs\(hit\.leverage\) !== 1/, '1배 제한이 없다');
  assert.match(block, /rejected\.push/, '막고 조용하면 사용자가 이유를 모른다');
  // checkAccountLimits **앞**에 있어야 한다 — 뒤면 계좌 호출만 낭비
  assert.ok(i < src.indexOf('const chk = await orderService.checkAccountLimits'), '게이트가 계좌 검증 뒤에 있다');
});

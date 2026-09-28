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

/**
 * 🔴 VIX stale 가시성 (2026-09-28, pm1 지시) — `marketDataService.getVix()` 가 야후 429 때
 * 최대 60분 낡은 값을 `stale:true` 로 재사용하는데, 유일한 소비자(`refresh()`)가 그 표시를
 * 버려서 **최대 60분 낡은 공포지수로 낸 매수 제안인지 사람이 알 방법이 없었다.**
 *
 * ⚠️ **설계 결정(바꾸지 않는다)**: 사다리 발화 조건·현금 계산은 그대로다. stale 이어도
 * 그대로 발화한다 — HITL 승인이 최종 결정이므로 우리가 할 일은 판단을 막는 게 아니라
 * **사실을 보여주는 것**뿐이다.
 */
test('🔴 VIX stale 메타는 밴드 판정을 안 바꾼다(같은 입력 → 같은 band)', () => {
  const fresh = regime.compute({ vix: 26 });
  const stale = regime.compute({ vix: 26, vixStale: true, vixAgeMin: 38 });
  assert.equal(fresh.vix.band, stale.vix.band, 'stale 메타가 밴드 판정 산수를 흔들었다');
  assert.equal(fresh.vix.band, 2);
  assert.equal(fresh.vix.stale, false);
  assert.equal(stale.vix.stale, true);
  assert.equal(stale.vix.ageMin, 38);
});

test('vixStaleNote — 신선하면 빈 문자열(오탐 0), stale 이면 값·나이를 적고 나이 모르면 "확인 불가"', () => {
  assert.equal(regime.vixStaleNote({ stale: false, value: 26, ageMin: 38 }), '');
  assert.equal(regime.vixStaleNote(null), ''); // vix 자체가 없어도 깨지지 않는다
  assert.equal(regime.vixStaleNote({ stale: true, value: 26.4, ageMin: 38 }), ' (VIX 26.4 — 38분 전 값, 갱신 실패)');
  assert.equal(regime.vixStaleNote({ stale: true, value: 26.4, ageMin: null }), ' (VIX 26.4 — 확인 불가, 갱신 실패)');
});

test('🔴 사다리 reason — 신선하면 문구 그대로(군더더기 금지), stale 이면 나이가 붙고 몰라도 문장이 깨지지 않는다', () => {
  const fresh = regime.ladderProposals({ prevBand: 0, band: 1, cashUsd: 1000 });
  assert.equal(fresh[0].reason, 'VIX 공포 사다리 1단계(사용자 규칙) — 가용 현금의 10% 를 1배 광범위에 분할 매수');

  const stale = regime.ladderProposals({
    prevBand: 0, band: 1, cashUsd: 1000, vixValue: 26.4, vixStale: true, vixAgeMin: 38,
  });
  assert.equal(
    stale[0].reason,
    'VIX 공포 사다리 1단계(사용자 규칙) — 가용 현금의 10% 를 1배 광범위에 분할 매수 (VIX 26.4 — 38분 전 값, 갱신 실패)'
  );

  // stale 인데 나이를 모르는 경우도 문장이 성립해야 한다
  const staleUnknownAge = regime.ladderProposals({
    prevBand: 0, band: 1, cashUsd: 1000, vixValue: 26.4, vixStale: true, vixAgeMin: null,
  });
  assert.match(staleUnknownAge[0].reason, /확인 불가/);

  // 🔴 stale 이어도 사다리 발화·금액 산수는 그대로다(설계 결정 — 억제 로직을 넣지 않았다)
  assert.equal(stale.length, fresh.length);
  assert.equal(stale[0].budget, fresh[0].budget);
  assert.equal(stale[0].band, fresh[0].band);
});

test('🔴 국면 전이 알림 문장에도 stale 표시가 붙는다(밴드 문구는 그대로, 뒤에 덧붙는다)', () => {
  const a = regime.compute({ us: { closes: ramp(100, 1, 70) }, vix: 14 });
  const bFresh = regime.compute({ us: { closes: ramp(100, 1, 70) }, vix: 26 });
  const bStale = regime.compute({ us: { closes: ramp(100, 1, 70) }, vix: 26, vixStale: true, vixAgeMin: 12 });

  const tFresh = regime.diffTransitions(a, bFresh).find((x) => /VIX/.test(x));
  const tStale = regime.diffTransitions(a, bStale).find((x) => /VIX/.test(x));
  assert.ok(tFresh, '신선한 VIX 전이 문장이 없다');
  assert.ok(tStale, 'stale VIX 전이 문장이 없다');
  assert.doesNotMatch(tFresh, /갱신 실패/, '신선한 전이에 stale 문구가 붙었다(오탐)');
  assert.match(tStale, /12분 전 값, 갱신 실패/);
  // 밴드 라벨(판정)은 stale 여부와 무관하게 같다 — 메타만 덧붙었다
  assert.equal(tStale.replace(/ \(VIX.*\)$/, ''), tFresh);
});

test('🔴 옛 regime.json(새 필드 없음)을 읽어도 예외 없이 돈다 — prev 에 stale/ageMin 이 없는 경우', () => {
  // 배포 전 저장된 형태를 흉내 낸다(마이그레이션 없이 그대로 읽는 것이 요구사항)
  const legacyPrev = {
    at: '2026-09-27T00:00:00.000Z',
    kr: null,
    us: { trend: 'up', shock: false, dayPct: 1, price: 101, ma20: 100, ma60: 99 },
    vix: { value: 14, band: 0 }, // ⚠️ stale·ageMin 필드 자체가 없다
    manual: [],
  };
  const next = regime.compute({ us: { closes: ramp(100, 1, 70) }, vix: 26 });
  assert.doesNotThrow(() => regime.diffTransitions(legacyPrev, next));
  const t = regime.diffTransitions(legacyPrev, next);
  assert.ok(t.some((x) => /VIX/.test(x)), t.join(' | '));
});

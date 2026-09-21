const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shapeReport } = require('../server/analystService');

/**
 * 애널리스트 리포트 **모양 읽기** (2026-09-21 실사고 회귀 가드)
 *
 * ## 🔴 무슨 일이 있었나
 *
 * 라이브 분석이 화면·텔레그램·타임라인에 전부 **"(시황 요약 없음)"** 으로 나왔다.
 * 모델은 답했는데 **스키마를 무시하고 평평한 모양**으로 줬고 내 파서가 버렸다:
 * ```
 * {"dataGaps":[…], "stance":"HOLD", "stanceConfidence":…}
 * ```
 * `marketView`·`positions`·`proposals` 가 통째로 없었다.
 *
 * ★ 도구 판단기에서 **키 이름**(name/tool/id)과 **깊이**로 세 번 데이고도,
 *   리포트에는 같은 처방을 안 해 뒀다. *"규칙을 정하면 적용 범위를 그 자리에서 훑는다"* 를
 *   또 어겼다. 아래는 **관측된 모양과 그 변형**이다.
 */

test('정상 스키마를 그대로 읽는다', () => {
  const r = shapeReport({
    marketView: '지수는 혼조입니다', momentumRead: '큰 움직임 없음', dataGaps: ['재무 없음'],
    positions: [{ symbol: 'QLD', stance: 'HOLD', confidence: 'MEDIUM', rationale: '20일선 위', evidence: [], risk: '변동성' }],
    proposals: [],
  });
  assert.equal(r.marketView, '지수는 혼조입니다');
  assert.equal(r.positions.length, 1);
  assert.equal(r.positions[0].stance, 'HOLD');
  assert.equal(r.dataGaps.length, 1);
});

/** 🔴 **라이브에서 실제로 온 모양** — 이것 때문에 리포트가 통째로 비었다 */
test('평평하게 와도 판단을 건진다 (실측된 모양)', () => {
  const r = shapeReport({
    dataGaps: ['5년 재무제표 미제공', '환율 미제공'],
    stance: 'HOLD', stanceConfidence: 'MEDIUM', symbol: 'QLD',
    rationale: '20일선 위에서 버티는 중이라 보유',
  });
  assert.equal(r.positions.length, 1, '평평한 응답을 통째로 버렸다');
  assert.equal(r.positions[0].symbol, 'QLD');
  assert.equal(r.positions[0].stance, 'HOLD');
  assert.equal(r.dataGaps.length, 2);
  assert.equal(r._unreadable, null, '읽었는데 못 읽었다고 표시했다');
});

test('키 이름을 바꿔도 읽는다', () => {
  const r = shapeReport({
    market_view: '시황입니다', momentum: '조용', gaps: ['g'],
    judgements: [{ ticker: 'RAM', action: 'SELL', conviction: 'HIGH', why: '손실 확대' }],
  });
  assert.equal(r.marketView, '시황입니다');
  assert.equal(r.momentumRead, '조용');
  assert.equal(r.positions[0].symbol, 'RAM');
  assert.equal(r.positions[0].stance, 'SELL');
});

/**
 * ⚠️ **주문을 판단으로 오인하면 안 된다.** `side:'SELL'` 은 STANCES 에 걸린다 —
 *    자체 점검에서 실제로 잡혔다. 수량·가격이 다 있으면 그건 **제안**이다.
 */
test('완전한 주문은 제안이지 판단이 아니다', () => {
  const r = shapeReport({ marketView: 'v', orders: [{ symbol: 'QLD', side: 'SELL', quantity: 10, price: 93.5, reason: 'r' }] });
  assert.equal(r.proposals.length, 1);
  assert.equal(r.positions.length, 0, '주문이 종목 판단으로 새어 들어갔다');
  assert.deepEqual(
    { s: r.proposals[0].symbol, q: r.proposals[0].quantity, p: r.proposals[0].price },
    { s: 'QLD', q: 10, p: 93.5 },
  );
});

/** 🔴 **반쪽 제안은 줍지 않는다** — `orderService` 가 거부하고 사용자는 "왜 사라졌지" 를 겪는다 */
test('수량·가격이 빠진 제안은 제안으로 만들지 않는다', () => {
  const r = shapeReport({ marketView: 'v', orders: [{ symbol: 'QLD', side: 'SELL', quantity: 10 }] });
  assert.equal(r.proposals.length, 0, '가격 없는 제안을 만들었다 — 거부될 것을 만들지 않는다');
});

test('판단과 제안이 섞여 와도 갈라낸다', () => {
  const r = shapeReport({
    view: '시황',
    calls: [
      { ticker: 'RAM', action: 'BUY', conviction: 'LOW', why: 'w' },
      { symbol: 'QLD', side: 'SELL', quantity: 5, price: 90, reason: 'r' },
    ],
  });
  assert.equal(r.positions.length, 1);
  assert.equal(r.proposals.length, 1);
  assert.equal(r.positions[0].symbol, 'RAM');
});

/** 🔴 아무것도 못 읽었으면 **그 사실을 남긴다** — 조용히 빈 리포트를 내지 않는다 */
test('못 읽은 응답은 표시를 남긴다', () => {
  const r = shapeReport({ 알수없는키: 123, 또다른: true });
  assert.equal(r.positions.length, 0);
  assert.ok(r._unreadable, '못 읽었는데 조용하다 — 화면이 "분석 없음" 으로만 보인다');
});

test('빈 응답·null 도 터지지 않는다', () => {
  for (const x of [null, undefined, {}, [], 'string', 42]) {
    const r = shapeReport(x);
    assert.equal(typeof r.marketView, 'string');
    assert.ok(Array.isArray(r.positions));
  }
});

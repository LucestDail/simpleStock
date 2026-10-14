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
 * ## ⚠️ 2026-10-14 — **계약이 바뀌었다** (보고서 제품으로 재정의)
 *
 * `stance`(BUY/SELL/HOLD)·`entry`·`stop`·`target` 이 **스키마에서 사라졌고**, 유효한 항목인지는
 * 이제 `trend`(추세 서술)로 가른다. 아래 테스트가 지키려는 것은 **"모델이 어떤 모양으로 줘도
 * 읽어낸다"** 이지 BUY/SELL 자체가 아니므로, **픽스처와 단언의 축만** 옮겼다.
 * 🔴 옛 모양(`stance`)으로 오면 **버리고 `legacyStanceKey` 로 짖는다** — 아래 전용 테스트가 그걸 잠근다.
 *
 * ★ 도구 판단기에서 **키 이름**(name/tool/id)과 **깊이**로 세 번 데이고도,
 *   리포트에는 같은 처방을 안 해 뒀다. *"규칙을 정하면 적용 범위를 그 자리에서 훑는다"* 를
 *   또 어겼다. 아래는 **관측된 모양과 그 변형**이다.
 */

test('정상 스키마를 그대로 읽는다', () => {
  const r = shapeReport({
    marketView: '지수는 혼조입니다', momentumRead: '큰 움직임 없음', dataGaps: ['재무 없음'],
    positions: [{ symbol: 'QLD', trend: '20일선 부근 횡보', confidence: 'MEDIUM', rationale: '20일선 위', evidence: [], risk: '변동성' }],
    proposals: [],
  });
  assert.equal(r.marketView, '지수는 혼조입니다');
  assert.equal(r.positions.length, 1);
  assert.equal(r.positions[0].trend, '20일선 부근 횡보');
  assert.equal(r.dataGaps.length, 1);
});

/** 🔴 **라이브에서 실제로 온 모양** — 이것 때문에 리포트가 통째로 비었다 */
test('평평하게 와도 판단을 건진다 (실측된 모양)', () => {
  const r = shapeReport({
    dataGaps: ['5년 재무제표 미제공', '환율 미제공'],
    trend: '20일선 부근 횡보', stanceConfidence: 'MEDIUM', symbol: 'QLD',
    rationale: '20일선 위에서 버티는 중이라 보유',
  });
  assert.equal(r.positions.length, 1, '평평한 응답을 통째로 버렸다');
  assert.equal(r.positions[0].symbol, 'QLD');
  assert.equal(r.positions[0].trend, '20일선 부근 횡보');
  assert.equal(r.dataGaps.length, 2);
  assert.equal(r._unreadable, null, '읽었는데 못 읽었다고 표시했다');
});

test('키 이름을 바꿔도 읽는다', () => {
  const r = shapeReport({
    market_view: '시황입니다', momentum: '조용', gaps: ['g'],
    // ⚠️ 2026-10-14: 축이 action→trend 로 바뀌었다. 별칭(ticker/conviction/why)은 그대로 읽어야 한다
    judgements: [{ ticker: 'RAM', 추세: '20일선 아래 역배열', conviction: 'HIGH', why: '손실 확대' }],
  });
  assert.equal(r.marketView, '시황입니다');
  assert.equal(r.momentumRead, '조용');
  assert.equal(r.positions[0].symbol, 'RAM');
  assert.equal(r.positions[0].trend, '20일선 아래 역배열');
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

/** 🔴 **반쪽 모의 거래는 줍지 않는다** — 백테스트 시뮬레이션에서 쓸 수 없다 */
test('수량·가격이 빠진 제안은 제안으로 만들지 않는다', () => {
  const r = shapeReport({ marketView: 'v', orders: [{ symbol: 'QLD', side: 'SELL', quantity: 10 }] });
  assert.equal(r.proposals.length, 0, '가격 없는 제안을 만들었다 — 거부될 것을 만들지 않는다');
});

test('판단과 제안이 섞여 와도 갈라낸다', () => {
  const r = shapeReport({
    view: '시황',
    calls: [
      { ticker: 'RAM', trendRead: '20일선 위 정배열', conviction: 'LOW', why: 'w' },
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

// ── 🔴 같은 종목이 두 번 판단되는 것 (2026-09-27 라이브 dryRun 실측) ──────

/**
 * 🔴 라이브에서 실제로 나온 배열: QLD·RAM 이 각각 HOLD 와 SELL 로 **동시에** 나왔다
 *    (보유2+후보2=4건이 정상인데 6건). "팔라는 건가 들라는 건가" 를 사용자가 모른다.
 */
/**
 * ⛔ **2026-10-14 — 뒤집었다: 모순은 `rationale` 로 말하고 `confidence` 는 안 건드린다.**
 *
 * 종전엔 모순이 나오면 `confidence: 'LOW'` 로 덮었다. 그때 `confidence` 는 *"판단에 얼마나
 * 확신하는가"* 였으니 말이 됐다. 2026-10-14 에 그 칸을 **근거 충실도**(코드가 센다)로
 * 재정의하면서 **축이 달라졌고**, 덮어쓰면 *"모순이라 깎인 것"* 과 *"근거가 없어 낮은 것"* 이
 * **같은 값**이 된다 — 이 저장소가 반복해 밟은 **「검사했는데 0 ≠ 애초에 없음」** 가족이다.
 * ★ **내가 재정의하면서 만든 결함이고, 이 테스트 3건이 잡았다.**
 *
 * ⇒ 축을 가른다: 모순 = `rationale` 맨 앞 ⚠️(화면·폰에 보인다) · 근거 충실도 = 근거만.
 * ★ **판별력을 위해 픽스처에 근거를 채웠다** — 서술 3축 + 인용 2개를 주면 HIGH 가 나오므로,
 *   *"모순인데도 HIGH 가 유지되는가"* 로 **축이 실제로 분리됐는지**를 잰다.
 *   (근거를 안 채우면 어차피 LOW 라 분리됐는지 **원리상 못 본다** — 공허한 통과였을 것이다.)
 * ⚠️ 입력의 `confidence` 는 **일부러 주지 않는다** — 주면 "모델 값을 쓰지 않는다" 를 못 잰다.
 */
test('같은 종목이 상반된 서술로 중복되면 1건만 남고 rationale 이 그 사실을 말한다', () => {
  const rich = (extra) => ({ relative: '지수 대비 강세', volatility: '일간 1.1%', evidence: ['20일선 55.0', '거래량 평균 대비 1.3배'], ...extra });
  const r = shapeReport({
    marketView: 'v',
    positions: [
      { symbol: 'QLD', trend: '20일선 부근 횡보', ...rich({ rationale: '20일선 위' }) },
      { symbol: 'RAM', trend: '20일선 부근 횡보', ...rich({ rationale: '손실 방어' }) },
      { symbol: 'SOXX', trend: '20일선 위 정배열', ...rich({ rationale: '신규 후보' }) },
      { symbol: 'QQQ', trend: '20일선 위 정배열', ...rich({ rationale: '신규 후보2' }) },
      { symbol: 'RAM', trend: '20일선 아래 역배열', ...rich({ rationale: '기준선 이탈' }) },
      { symbol: 'QLD', trend: '20일선 아래 역배열', ...rich({ rationale: '추세 이탈' }) },
    ],
  });

  assert.equal(r.positions.length, 4, '중복이 걸러지지 않았다');
  const bySymbol = Object.fromEntries(r.positions.map((p) => [p.symbol, p]));

  // 먼저 나온 서술을 남긴다 — 모델이 보유를 먼저 서술하는 순서를 존중
  assert.equal(bySymbol.QLD.trend, '20일선 부근 횡보');
  assert.equal(bySymbol.RAM.trend, '20일선 부근 횡보');
  assert.match(bySymbol.QLD.rationale, /상반된 서술/);
  // ⚠️ **버려진 쪽이 무엇이었는지** 적어야 한다 — 그게 이 테스트의 핵심이다
  assert.match(bySymbol.QLD.rationale, /20일선 아래 역배열/);
  assert.match(bySymbol.QLD.rationale, /20일선 위/, '원래 rationale 을 지우지 않고 붙였다');
  // 🔴 더 이상 낮추지 않으므로 그 문구도 거짓이 됐다 — 함께 지웠는지 본다
  assert.doesNotMatch(bySymbol.QLD.rationale, /확신도를 낮춤/, '🔴 거짓이 된 문구가 남았다');

  // ★ 축 분리의 증거 — 모순이어도 **근거가 충실하면 등급은 그대로**다
  assert.equal(bySymbol.QLD.confidence, 'HIGH', '🔴 모순이 근거 충실도를 덮었다 — 두 뜻이 한 값에 섞인다');
  assert.equal(bySymbol.SOXX.confidence, 'HIGH', '🔴 모순 없는 종목의 등급이 바뀌었다');
});

test('같은 종목·같은 stance 중복은 1건만 남고 확신도는 원래대로다(모순이 아니므로)', () => {
  const r = shapeReport({
    marketView: 'v',
    positions: [
      { symbol: 'QLD', trend: '20일선 부근 횡보', confidence: 'MEDIUM', rationale: '20일선 위' },
      { symbol: 'QLD', trend: '20일선 부근 횡보', confidence: 'MEDIUM', rationale: '20일선 위(재확인)' },
    ],
  });
  assert.equal(r.positions.length, 1);
  // ⚠️ 2026-10-14: 입력 `confidence` 는 무시된다(코드가 센다) — 서술 1축뿐이라 LOW 가 **맞는 값**
  assert.equal(r.positions[0].confidence, 'LOW', '🔴 모델이 준 값을 그대로 썼다 — 정본이 둘이 된다');
  assert.equal(r.positions[0].rationale, '20일선 위', '모순이 아닌데 경고 문구를 붙였다');
});

/** 🔴 오탐 0 축 — 중복이 없으면 아무것도 바뀌면 안 된다 */
test('중복 없는 정상 입력은 그대로다', () => {
  const r = shapeReport({
    marketView: 'v',
    positions: [
      { symbol: 'QLD', trend: '20일선 부근 횡보', confidence: 'MEDIUM', rationale: '20일선 위' },
      { symbol: 'SOXX', trend: '20일선 위 정배열', confidence: 'HIGH', rationale: '신규 후보' },
    ],
  });
  assert.equal(r.positions.length, 2);
  // ⚠️ 2026-10-14: 입력값(MEDIUM/HIGH)이 아니라 **계산값**이다 — 서술 1축 + 근거 0 ⇒ LOW
  assert.equal(r.positions[0].confidence, 'LOW', '🔴 모델이 준 값을 그대로 썼다');
  // ⚠️ SOXX 도 서술 1축 + 근거 0 이라 LOW — 입력의 'HIGH' 는 무시된다
  assert.equal(r.positions[1].confidence, 'LOW', '🔴 모델이 준 값을 그대로 썼다');
  assert.equal(r.positions[0].rationale, '20일선 위');
});

test('proposals 의 완전 동일 중복(같은 symbol+side)은 1건만 남는다', () => {
  const r = shapeReport({
    marketView: 'v',
    orders: [
      { symbol: 'QLD', side: 'BUY', quantity: 10, price: 90, reason: 'r1' },
      { symbol: 'QLD', side: 'BUY', quantity: 10, price: 90, reason: 'r1(중복)' },
      { symbol: 'RAM', side: 'SELL', quantity: 5, price: 20, reason: 'r2' },
    ],
  });
  assert.equal(r.proposals.length, 2, '완전 동일 중복이 안 걸러졌다');
  assert.equal(r.proposals[0].symbol, 'QLD');
  assert.equal(r.proposals[0].reason, 'r1', '먼저 나온 것을 남겨야 한다');
  assert.equal(r.proposals[1].symbol, 'RAM');
});

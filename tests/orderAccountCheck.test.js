const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 계좌로 막기 — 현금·판매가능수량 (2026-09-22)
 *
 * ## 왜 있나
 *
 * 사용자: *"내 자산에 내 현금 보유액은 안보이는데 토스에서 제공하나?"* → **제공한다.**
 * 그런데 우리는 안 부르고 있었고, 그 상태로 프롬프트는
 * *"quantity 는 보유 수량과 **현금 여력을 넘지 않게**"* 라고 **지시만** 하고 있었다 —
 * **지킬 수 없는 규칙을 요구한 것**이고, 매수 제안 수량에 근거가 없었다.
 *
 * ★ 프롬프트는 지시일 뿐이다. **거부는 코드가 한다.**
 */

function freshOrders(stub) {
  for (const k of Object.keys(require.cache)) {
    if (/orderService|tossClient/.test(k)) delete require.cache[k];
  }
  const tp = require.resolve('../server/tossClient');
  const real = require(tp);
  require.cache[tp] = { id: tp, filename: tp, loaded: true, exports: { ...real, ...stub } };
  return require('../server/orderService');
}

// 🔴 라이브 실측 그대로 — 둘 다 **문자열**이다
const CASH = (raw) => async () => ({ currency: 'USD', cash: { raw, num: Number(raw) } });
const SELLABLE = (raw) => async (sym) => ({ symbol: sym, quantity: { raw, num: Number(raw) } });

test('🔴 현금보다 비싸면 매수를 막는다', async () => {
  const o = freshOrders({ getBuyingPower: CASH('1.48') });
  const r = await o.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 10, price: 92 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'insufficient');
  assert.match(r.error, /현금이 부족/);
  assert.match(r.error, /1\.48/, '가능 금액을 안 알려주면 사용자가 뭘 고쳐야 할지 모른다');
});

test('현금이 충분하면 통과한다', async () => {
  const o = freshOrders({ getBuyingPower: CASH('5000') });
  const r = await o.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 10, price: 92 });
  assert.equal(r.ok, true);
});

test('🔴 보유보다 많이 팔려 하면 막는다 (라이브: QLD 99주)', async () => {
  const o = freshOrders({ getSellableQuantity: SELLABLE('99') });
  const r = await o.checkAccountLimits({ symbol: 'QLD', side: 'SELL', quantity: 120 });
  assert.equal(r.ok, false);
  assert.match(r.error, /판매 가능 수량을 넘습니다/);
  assert.match(r.error, /99/);
  assert.equal((await o.checkAccountLimits({ symbol: 'QLD', side: 'SELL', quantity: 99 })).ok, true, '딱 맞는 수량은 통과해야 한다');
});

/** ⚠️ 해외주식은 **소수점 수량**이 온다(`"5.5"`) — 정수로 파싱하면 깨진다 */
test('⚠️ 소수점 수량을 정수로 깎지 않는다', async () => {
  const o = freshOrders({ getSellableQuantity: SELLABLE('5.5') });
  assert.equal((await o.checkAccountLimits({ symbol: 'AAPL', side: 'SELL', quantity: 5.5 })).ok, true);
  assert.equal((await o.checkAccountLimits({ symbol: 'AAPL', side: 'SELL', quantity: 6 })).ok, false);
});

/**
 * 🔴 **"못 물어봤다" 를 "통과" 로 읽지 않는다.**
 * 이게 이 가드의 핵심이다 — 조회가 실패했는데 제안이 나가면 가드가 없는 것보다 나쁘다
 * (있다고 믿게 만든다).
 */
test('🔴 계좌 조회가 실패하면 **막는다** (통과 아님)', async () => {
  const o = freshOrders({ getBuyingPower: async () => { throw new Error('토스 응답 없음'); } });
  const r = await o.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1, price: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'unknown', '🔴 실패를 insufficient 로 뭉뚱그리면 원인을 못 가른다');
});

test('🔴 금액을 못 받으면(null) 막는다 — 0 으로 읽지 않는다', async () => {
  const o = freshOrders({ getBuyingPower: async () => ({ currency: 'USD', cash: { raw: null, num: null } }) });
  const r = await o.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1, price: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'unknown');
});

/** ⚠️ 시장가는 필요 금액을 모른다 — **모른다고 말한다**(통과시키지 않는다) */
test('⚠️ 가격이 없으면 금액 판정을 못 한다고 말한다', async () => {
  const o = freshOrders({ getBuyingPower: CASH('99999') });
  const r = await o.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'unknown');
  assert.match(r.error, /지정가가 없어/);
});

test('국내 6자리는 원화로 묻는다', async () => {
  let asked = null;
  const o = freshOrders({ getBuyingPower: async (cur) => { asked = cur; return { currency: cur, cash: { raw: '1000000', num: 1000000 } }; } });
  await o.checkAccountLimits({ symbol: '005930', side: 'BUY', quantity: 1, price: 70000 });
  assert.equal(asked, 'KRW');
  await o.checkAccountLimits({ symbol: 'NVDA', side: 'BUY', quantity: 1, price: 100 });
  assert.equal(asked, 'USD');
  // ⚠️ 호출자가 통화를 주면 **그게 우선**이다(심볼 모양 추정보다)
  await o.checkAccountLimits({ symbol: 'NVDA', side: 'BUY', quantity: 1, price: 100, currency: 'KRW' });
  assert.equal(asked, 'KRW');
});

/**
 * 🔴 **구조 가드** — `propose(` 를 부르는 파일은 `checkAccountLimits` 도 불러야 한다.
 * 문이 둘인데 한쪽만 막으면 **안 막는 것**이다. 새 호출자가 생기면 여기서 걸린다.
 */
test('🔴 propose() 를 부르는 곳은 계좌 검증도 부른다', () => {
  const ROOT = path.join(__dirname, '..');
  const files = [...fs.readdirSync(path.join(ROOT, 'server')).map((f) => path.join('server', f)), 'server.js']
    .filter((f) => f.endsWith('.js'));
  const problems = [];
  let callers = 0;
  /** 면제 — **이유를 적는다** */
  const EXEMPT = new Map([
    ['server/orderService.js', '정의한 쪽이다(자기 자신을 부르지 않는다)'],
  ]);
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // 주석을 지운 뒤 본다 — 설명문의 `propose(` 를 호출로 읽으면 오탐이다
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (!/\.propose\s*\(/.test(code)) continue;
    if (EXEMPT.has(rel)) continue;
    callers += 1;
    if (!/checkAccountLimits\s*\(/.test(code)) problems.push(`${rel} — propose() 는 부르는데 계좌 검증이 없다`);
  }
  assert.ok(callers >= 2, `🔴 검사한 호출자가 ${callers}곳뿐이다 — 자가 헛돈다(분석·라우트 둘은 있어야 한다)`);
  assert.deepEqual(problems, [], `\n🔴 이 경로로는 살 수 없는 제안이 나간다:\n${problems.join('\n')}`);
});

/**
 * ⚠️ **기본값은 0 이 됐다** (2026-10-02 사용자 지시 — "매수 현금바닥 구조 없애").
 *    그래도 **기계는 계속 잰다** — 지운 게 아니라 끈 것이고, `CASH_FLOOR_PCT=15` 한 줄이면
 *    되살아난다. 기계를 안 재면 되살렸을 때 동작하는지 아무도 모른다.
 */
test('현금 버퍼 기계 — 켜면(15%) 바닥을 깨는 매수는 거부, 사다리는 면제', async () => {
  const savedFloor = process.env.CASH_FLOOR_PCT;
  const savedConc = process.env.SINGLE_POSITION_MAX_PCT;
  process.env.CASH_FLOOR_PCT = '15';
  // ⚠️ 집중 상한(2026-10-04 신설)을 끈다 — 이 픽스처의 800 매수는 40% 라 집중 게이트가
  //    먼저 걸린다. 여기서 재는 축은 **버퍼**다(집중 축은 전용 테스트가 따로 잰다).
  process.env.SINGLE_POSITION_MAX_PCT = '0';
  // 현금 1000 · 보유(USD) 1000 → 평가 2000 · 버퍼 300. 700 초과 매수는 거부돼야 한다
  for (const k of Object.keys(require.cache)) {
    if (/orderService|tossClient|tossPortfolio/.test(k)) delete require.cache[k];
  }
  const tp = require.resolve('../server/tossClient');
  require.cache[tp] = { id: tp, filename: tp, loaded: true, exports: { ...require(tp), getBuyingPower: CASH('1000'), getPriceLimits: async () => ({}) } };
  const pp = require.resolve('../server/tossPortfolio');
  require.cache[pp] = { id: pp, filename: pp, loaded: true, exports: { getHoldings: async () => ({ summary: {}, items: [{ symbol: 'QQQ', currency: 'USD', marketValue: 1000 }] }) } };
  const o = require('../server/orderService');
  const over = await o.checkAccountLimits({ symbol: 'SPY', side: 'BUY', quantity: 8, price: 100 }); // 800 > 700
  assert.equal(over.ok, false);
  assert.equal(over.kind, 'cash-floor');
  assert.equal(over.maxQuantity, 7); // (1000-300)/100
  const under = await o.checkAccountLimits({ symbol: 'SPY', side: 'BUY', quantity: 7, price: 100 });
  assert.equal(under.ok, true, under.error);
  // 🔴 사다리 면제 — 공포에 실탄 소진이 취지(백테스트: floor 는 LLM 매수에만)
  const ladder = await o.checkAccountLimits({ symbol: 'SPY', side: 'BUY', quantity: 9, price: 100, exemptCashFloor: true });
  assert.equal(ladder.ok, true, ladder.error);
  if (savedFloor === undefined) delete process.env.CASH_FLOOR_PCT; else process.env.CASH_FLOOR_PCT = savedFloor;
  if (savedConc === undefined) delete process.env.SINGLE_POSITION_MAX_PCT; else process.env.SINGLE_POSITION_MAX_PCT = savedConc;
});

/**
 * 🔴 **기본값이 0 이라는 것 자체를 못박는다** (2026-10-02). 라이브 5회차 중 3회가
 *    `no_buying_capacity · capacity:blocked` 였고 그 사이 **매도 제안만** 나갔다 —
 *    현금이 없는데 파는 쪽만 열려 있던 상태다. 사용자가 그 구조를 없애라고 했다.
 */
test('🔴 기본값은 0 — 버퍼가 매수를 막지 않는다 (사용자 결정 2026-10-02)', async () => {
  const savedFloor = process.env.CASH_FLOOR_PCT;
  const savedConc2 = process.env.SINGLE_POSITION_MAX_PCT;
  delete process.env.CASH_FLOOR_PCT;
  process.env.SINGLE_POSITION_MAX_PCT = '0'; // 축 분리 — 전액 매수(50%)는 집중 게이트가 잡는 게 맞다(전용 테스트)
  for (const k of Object.keys(require.cache)) {
    if (/orderService|tossClient|tossPortfolio/.test(k)) delete require.cache[k];
  }
  const tp2 = require.resolve('../server/tossClient');
  require.cache[tp2] = { id: tp2, filename: tp2, loaded: true, exports: { ...require(tp2), getBuyingPower: CASH('1000'), getPriceLimits: async () => ({}) } };
  const pp2 = require.resolve('../server/tossPortfolio');
  require.cache[pp2] = { id: pp2, filename: pp2, loaded: true, exports: { getHoldings: async () => ({ summary: {}, items: [{ symbol: 'QQQ', currency: 'USD', marketValue: 1000 }] }) } };
  const o2 = require('../server/orderService');
  assert.equal(Number(o2.CASH_FLOOR_PCT), 0, '기본 버퍼가 0 이 아니다');
  const all = await o2.checkAccountLimits({ symbol: 'SPY', side: 'BUY', quantity: 10, price: 100 });
  assert.equal(all.ok, true, `현금 전액 매수가 막혔다: ${all.error}`);
  if (savedFloor === undefined) delete process.env.CASH_FLOOR_PCT; else process.env.CASH_FLOOR_PCT = savedFloor;
  if (savedConc2 === undefined) delete process.env.SINGLE_POSITION_MAX_PCT; else process.env.SINGLE_POSITION_MAX_PCT = savedConc2;
});

/**
 * 🔴 종목 집중 상한 (2026-10-04) — 한도표가 "20% 초과 시 추가 매수 차단 (계좌 검증)" 이라
 * **주장만** 하고 게이트가 없었다. vshape 백테스트 몰빵(-23.5% · 사다리 실탄 0)이 증거.
 */
test('종목 집중 상한 — 한도를 넘기는 매수는 거절, 사다리는 면제', async () => {
  for (const k of Object.keys(require.cache)) {
    if (/orderService|tossClient|tossPortfolio|riskMetrics|incomeLedger/.test(k)) delete require.cache[k];
  }
  /**
   * 🔴 한도 **값**이 아니라 **메커니즘**을 잰다 (2026-10-06). 사용자가 한도를 20→35 로
   *    올리자 이 테스트의 기대 수량이 4→7 로 깨졌다 — 로직 회귀가 아니라 **의미 변경**이다.
   *    ⇒ env 로 20 을 핀해 "상한이 추가 매수를 막고 사다리는 면제한다" 는 **동작**만 재고,
   *      한도 값 자체는 아래 '종목 한도 35' 테스트가 전담한다(관심사 분리).
   */
  process.env.SINGLE_POSITION_MAX_PCT = '20';
  /**
   * ⚠️ 2026-10-06 — 집중 상한에 **수익 기반 적립 면제**(incomeLedger)가 붙었다. 그 판정은
   *    `config/target-allocation.json` 을 읽으므로, 핀을 안 박으면 그 파일이 생기는 날
   *    이 테스트가 통과/실패를 왕복한다(저장소 상태에 기댄 테스트). 없는 경로로 고정해
   *    **fail-closed = 종전 동작**을 재는 것을 분명히 한다. 면제 축은 incomeLedger.test.js 가 잰다.
   */
  process.env.TARGET_ALLOCATION_FILE = path.join(__dirname, 'no-such-target-allocation.json');
  const tp3 = require.resolve('../server/tossClient');
  require.cache[tp3] = { id: tp3, filename: tp3, loaded: true, exports: { ...require(tp3), getBuyingPower: CASH('1000'), getPriceLimits: async () => ({}) } };
  const pp3 = require.resolve('../server/tossPortfolio');
  require.cache[pp3] = { id: pp3, filename: pp3, loaded: true, exports: { getHoldings: async () => ({ summary: {}, items: [{ symbol: 'QQQ', currency: 'USD', marketValue: 1000 }] }) } };
  const o3 = require('../server/orderService');
  // 평가 2000 · 한도 400. SPY 800 매수 → 거절 + 가능 수량 4
  const over = await o3.checkAccountLimits({ symbol: 'SPY', side: 'BUY', quantity: 8, price: 100 });
  assert.equal(over.ok, false);
  assert.equal(over.kind, 'concentration');
  assert.equal(over.maxQuantity, 4);
  // 한도 안(400)은 통과
  const under = await o3.checkAccountLimits({ symbol: 'SPY', side: 'BUY', quantity: 4, price: 100 });
  assert.equal(under.ok, true, under.error);
  // 이미 50% 인 QQQ 는 1주 추가도 거절 (기존 초과분은 안 건드리고 **추가만** 막는다)
  const held = await o3.checkAccountLimits({ symbol: 'QQQ', side: 'BUY', quantity: 1, price: 100 });
  assert.equal(held.ok, false);
  assert.equal(held.kind, 'concentration');
  // 사다리 면제 — 공포 기계매수는 집중도 함께 면제(막으면 존재 이유가 죽는다)
  const ladder = await o3.checkAccountLimits({ symbol: 'QQQ', side: 'BUY', quantity: 5, price: 100, exemptCashFloor: true });
  assert.equal(ladder.ok, true, ladder.error);
});

test('🔴 가격-현재가 괴리 게이트(±2.5%) — 체결 불가능한 지정가는 조건주문으로 안내', async () => {
  // 실물(09-23): 제안 3건 전부 당일 고가 옆(현재가 +2~6%) — TTL 10분 안에 체결 불가
  const o = freshOrders({
    getPrices: async () => new Map([['SPY', { price: 100 }]]),
    getBuyingPower: CASH('100000'),
    getSellableQuantity: SELLABLE('100'),
    getPriceLimits: async () => ({}),
  });
  const far = await o.checkAccountLimits({ symbol: 'SPY', side: 'SELL', quantity: 1, price: 104 });
  assert.equal(far.ok, false);
  assert.equal(far.kind, 'price-drift');
  assert.match(far.error, /조건주문/);
  const near = await o.checkAccountLimits({ symbol: 'SPY', side: 'SELL', quantity: 1, price: 101.5 });
  assert.equal(near.ok, true, near.error);
  const farBuy = await o.checkAccountLimits({ symbol: 'SPY', side: 'BUY', quantity: 1, price: 95 });
  assert.equal(farBuy.kind, 'price-drift');
});

/**
 * 🔴 종목 한도 35 (2026-10-06 사용자 결정: "35% 까지 · 4종목 이상 안 가져간다").
 * 두 근거점을 자가 지킨다 — **QLD 31.8% 는 통과**(추가 매수 가능해야 전략이 성립)하고
 * **40% 는 여전히 차단**(35 가 해제가 아니라는 것). 그리고 riskMetrics 가 같은 상수를 본다.
 */
test('종목 한도 40 — 31.8% 는 통과, 45% 는 차단, riskMetrics 와 한 벌', () => {
  delete process.env.SINGLE_POSITION_MAX_PCT;
  for (const k of Object.keys(require.cache)) if (/orderService|riskMetrics/.test(k)) delete require.cache[k];
  const os = require('../server/orderService');
  assert.equal(os.SINGLE_POSITION_MAX_PCT, 40, '기본값이 40 이 아니다 — 사용자 20/40/40 비율과 어긋난다');
  const rm = require('../server/riskMetrics');
  const m = rm.compute({ items: [], candlesBySymbol: new Map(), cashPct: 50, leveragePct: 30 });
  assert.equal(m.limits.single, 40, 'riskMetrics 가 다른 한도를 본다 — 화면 경고와 게이트가 갈린다');
  // 최소 3종목 강제: 35×3 = 105 > 100 이므로 2종목만으로는 100% 를 못 채운다
  assert.ok(os.SINGLE_POSITION_MAX_PCT * 2 < 100, '두 종목으로 전액이 가능하면 분산 강제가 사라진다');
  assert.ok(os.SINGLE_POSITION_MAX_PCT * 3 >= 100, '세 종목으로도 전액이 불가하면 4종목 운용과 모순된다');
  // 사용자가 제시한 20/40/40 이 정확히 경계 — 40 이 두 칸이고 남는 20 이 세 번째 칸이다
  assert.equal(os.SINGLE_POSITION_MAX_PCT * 2 + 20, 100, '20/40/40 비율이 상한과 안 맞는다');
});

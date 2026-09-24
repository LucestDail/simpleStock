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

test('🔴 현금 버퍼 15%(사용자 확정 09-24) — 바닥을 깨는 매수는 거부, 사다리는 면제', async () => {
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

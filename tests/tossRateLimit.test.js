const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tossGroupOf } = require('../server/tossClient');

/**
 * 토스 Rate Limits Group 매핑 (2026-09-22)
 *
 * ## 왜 있나
 *
 * pm2 가 한도를 **호출 간격에서 역산**하고 있었다. 명세를 읽으니 토스는 엔드포인트를
 * **그룹 17개**로 묶고 `X-RateLimit-*` 헤더로 한도·잔여를 **직접 알려준다.**
 *
 * 🔴 그리고 pm2 실측: `candles` 는 **성공하면 로그가 0건**이라 기준선에 그 축이 없었다.
 *    그 상태의 *"429 0건"* 은 **여유가 아니라 판정 불가**다 ⇒ 분모(호출 수)를 함께 센다.
 *
 * ⚠️ 경로로 역추정하면 **종목마다 버킷이 갈려** 여유를 합산하지 못한다 — 그래서 그룹이 필요하다.
 */

test('🔴 주문정보 셋은 같은 그룹이다 (서로 경합한다)', () => {
  for (const p of ['/api/v1/buying-power', '/api/v1/commissions', '/api/v1/sellable-quantity']) {
    assert.equal(tossGroupOf(p), 'ORDER_INFO', p);
  }
});

/** 🔴 pm2 의 걱정을 지운 지점 — 계좌 계열(1/s)이 **아니다** */
test('🔴 buying-power 는 ACCOUNT 도 ASSET 도 아니다', () => {
  assert.notEqual(tossGroupOf('/api/v1/buying-power'), 'ACCOUNT');
  assert.notEqual(tossGroupOf('/api/v1/buying-power'), 'ASSET');
  assert.equal(tossGroupOf('/api/v1/accounts'), 'ACCOUNT');
  assert.equal(tossGroupOf('/api/v1/holdings'), 'ASSET');
});

/** ⚠️ 캔들은 **별도 그룹**이다 — 감시 종목당 일봉 캐시가 여기를 쓴다 */
test('⚠️ candles 는 MARKET_DATA 가 아니라 MARKET_DATA_CHART', () => {
  assert.equal(tossGroupOf('/api/v1/candles'), 'MARKET_DATA_CHART');
  assert.equal(tossGroupOf('/api/v1/prices'), 'MARKET_DATA');
  assert.equal(tossGroupOf('/api/v1/orderbook'), 'MARKET_DATA');
});

test('종목 단위 경로는 심볼이 달라도 **같은 그룹**이다', () => {
  const a = tossGroupOf('/api/v1/stocks/005930/investor-trading');
  const b = tossGroupOf('/api/v1/stocks/NVDA/short-selling');
  assert.equal(a, 'STOCK_TRADING_TREND');
  assert.equal(a, b, '🔴 심볼마다 그룹이 갈리면 여유를 합산하지 못한다');
});

test('시장지표는 현재가와 캔들이 갈린다', () => {
  assert.equal(tossGroupOf('/api/v1/market-indicators/prices'), 'MARKET_INDICATOR');
  assert.equal(tossGroupOf('/api/v1/market-indicators/KOSPI/candles'), 'MARKET_INDICATOR_CHART');
});

test('주문·조건주문·캘린더·랭킹', () => {
  assert.equal(tossGroupOf('/api/v1/orders'), 'ORDER');
  assert.equal(tossGroupOf('/api/v1/orders/abc/cancel'), 'ORDER');
  assert.equal(tossGroupOf('/api/v1/conditional-orders'), 'CONDITIONAL_ORDER');
  assert.equal(tossGroupOf('/api/v1/market-calendar/US'), 'MARKET_INFO');
  assert.equal(tossGroupOf('/api/v1/exchange-rate'), 'MARKET_INFO');
  assert.equal(tossGroupOf('/api/v1/rankings'), 'RANKING');
});

test('쿼리가 붙어도 같은 그룹', () => {
  assert.equal(tossGroupOf('/api/v1/buying-power?currency=USD'), 'ORDER_INFO');
});

/**
 * 🔴 **모르면 추측하지 않는다** — 명세에 없는 경로는 `null` 이다.
 * 아무 그룹에나 넣으면 그 그룹의 여유 계산이 조용히 틀어진다.
 */
test('🔴 모르는 경로는 null (추측하지 않는다)', () => {
  assert.equal(tossGroupOf('/api/v2/something-new'), null);
  assert.equal(tossGroupOf('/totally/unknown'), null);
});

/**
 * 🔴 **자기검증: 명세의 모든 경로가 그룹을 받는가.**
 * 하나라도 `null` 이면 그 경로의 호출은 **분모에서 그룹이 아니라 경로로** 잡혀
 * 여유 계산이 갈라진다. 새 엔드포인트를 붙일 때 여기서 걸려야 한다.
 */
test('🔴 명세의 36개 경로가 전부 그룹을 받는다', () => {
  const fs = require('node:fs');
  const SPEC = '/Users/seunghyun.oh/Workspace/Documents/오승현/업무/오승현/Investment/toss_security.json';
  if (!fs.existsSync(SPEC)) {
    // ⚠️ 명세가 없으면 **건너뛰지 않고 실패**시킬 수도 있지만, 이 파일은 사용자 vault 라
    //    CI·다른 머신에는 없다. ⇒ 건너뛰되 **건너뛴 사실을 남긴다**(조용한 통과 금지).
    console.log('    ⚠️ 명세 파일 없음 — 이 검사는 실행되지 않았다(통과가 아니다)');
    return;
  }
  const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
  const missing = [];
  let checked = 0;
  for (const p of Object.keys(spec.paths)) {
    const concrete = p.replace(/\{[^}]+\}/g, 'X');
    checked += 1;
    if (tossGroupOf(concrete) === null) missing.push(p);
  }
  assert.ok(checked >= 30, `검사한 경로가 ${checked}개뿐이다 — 자가 헛돈다`);
  assert.deepEqual(missing, [], `\n🔴 그룹을 못 받는 경로:\n${missing.join('\n')}`);
});

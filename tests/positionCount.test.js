/**
 * 🔴 **보유 종목 수 상한 3** (2026-10-06 사용자: "총 종목수 3종목 이하로 관리하도록 구성, 설정해").
 *
 * 종목 한도 40% 와 짝이다 — 40+40+20 = 100 이라 **3종목이 구조적 상한**이고, 사용자가 그
 * 운용 방식을 명시했다. 넷째를 담으면 평균 비중이 25% 로 내려가 "소수에 집중" 이 흐려진다.
 *
 * ## 쌍으로 잠근다
 *   발동: 3종목 보유 중 **신규** 종목 매수 → 거부
 *   오탐: **이미 보유한** 종목 추가 매수는 통과 · 매도는 언제나 통과 ·
 *        수량 0 레코드는 칸을 먹지 않는다(청산 직후 잔여 레코드)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fresh(items) {
  for (const k of Object.keys(require.cache)) if (/simpleStock\/server\//.test(k)) delete require.cache[k];
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
  process.env.ORDERS_FILE = path.join(process.env.DATA_DIR, 'p.json');
  process.env.TARGET_ALLOCATION_FILE = path.join(process.env.DATA_DIR, 'none.json');
  const tc = require.resolve('../server/tossClient');
  require.cache[tc] = { id: tc, filename: tc, loaded: true, exports: {
    ...require(tc),
    getPrices: async () => new Map([['XLK', { price: 100 }], ['QLD', { price: 100 }]]),
    getOrderbook: async () => ({ bids: [{ price: 100 }], asks: [{ price: 100 }] }),
    getPriceLimits: async () => ({}),
    getSellableQuantity: async () => ({ quantity: { num: 100, raw: '100' } }),
    getBuyingPower: async () => ({ cash: { num: 1000000, raw: '1000000' } }),
    getCommissions: async () => [],
  } };
  const tp = require.resolve('../server/tossPortfolio');
  require.cache[tp] = { id: tp, filename: tp, loaded: true, exports: {
    getHoldings: async () => ({ summary: {}, items }),
  } };
  return require('../server/orderService');
}
const H = (sym, qty = 1) => ({ symbol: sym, currency: 'USD', marketValue: 100 * qty, quantity: qty });

test('발동 — 3종목 보유 중 신규 종목 매수는 거부', async () => {
  delete process.env.MAX_POSITIONS;
  const o = fresh([H('QLD'), H('SOXX'), H('SCHD')]);
  const r = await o.checkAccountLimits({ symbol: 'XLK', side: 'BUY', quantity: 1, price: 100 });
  assert.equal(r.ok, false, '넷째 종목이 통과했다 — 3종목 관리가 깨진다');
  assert.equal(r.kind, 'position-count');
  assert.equal(r.maxPositions, 3);
  assert.match(r.error, /보유 종목이 이미 3개/);
});

test('오탐 금지 — 기존 보유 추가 매수·매도는 통과 · 2종목이면 신규도 통과', async () => {
  delete process.env.MAX_POSITIONS;
  const o = fresh([H('QLD'), H('SOXX'), H('SCHD')]);
  assert.equal((await o.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1, price: 100 })).kind,
    undefined, '이미 보유한 종목의 추가 매수를 막았다');
  assert.equal((await o.checkAccountLimits({ symbol: 'QLD', side: 'SELL', quantity: 1, price: 100 })).ok,
    true, '매도를 막았다 — 정리할 길이 없어진다');
  const o2 = fresh([H('QLD'), H('SOXX')]);
  assert.notEqual((await o2.checkAccountLimits({ symbol: 'XLK', side: 'BUY', quantity: 1, price: 100 })).kind,
    'position-count', '2종목인데 신규를 막았다');
});

test('수량 0 레코드는 칸을 먹지 않는다(청산 직후 잔여)', async () => {
  delete process.env.MAX_POSITIONS;
  const o = fresh([H('QLD'), H('SOXX'), H('SCHD', 0)]);
  assert.notEqual((await o.checkAccountLimits({ symbol: 'XLK', side: 'BUY', quantity: 1, price: 100 })).kind,
    'position-count', '수량 0 인 종목이 칸을 먹었다');
});

test('MAX_POSITIONS=0 이면 끈다 · env 로 조절된다', async () => {
  process.env.MAX_POSITIONS = '0';
  const o = fresh([H('A'), H('B'), H('C'), H('D')]);
  assert.notEqual((await o.checkAccountLimits({ symbol: 'XLK', side: 'BUY', quantity: 1, price: 100 })).kind,
    'position-count', '0 인데 막았다');
  process.env.MAX_POSITIONS = '2';
  const o2 = fresh([H('A'), H('B')]);
  assert.equal((await o2.checkAccountLimits({ symbol: 'XLK', side: 'BUY', quantity: 1, price: 100 })).maxPositions, 2);
  delete process.env.MAX_POSITIONS;
});

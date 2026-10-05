/**
 * 🔴 불리 방향 지정가 (2026-10-05 — 사용자: "현재가 98 근접인데 왜 97.5 에 파는거야")
 * 매도 지정가 < 현재가는 marketable limit 이지만 **그 가격이 슬리피지 하한**이 된다 —
 * 주간거래처럼 얕은 호가에선 거기까지 밀려 체결될 수 있다. 모델이 하한을 정하게 두지 않는다.
 * 쌍: 불리 0.3%+ 거부 / 유리 방향·0.3% 이내는 통과 / analyst 는 거부 대신 현재가 보정.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function fresh(nowPrice) {
  for (const k of Object.keys(require.cache)) if (/simpleStock\/server\//.test(k)) delete require.cache[k];
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-'));
  const tp = require.resolve('../server/tossClient');
  require.cache[tp] = { id: tp, filename: tp, loaded: true, exports: {
    ...require(tp),
    getPrices: async () => new Map([['QLD', { price: nowPrice }]]),
    getPriceLimits: async () => ({}),
    getSellableQuantity: async () => ({ quantity: { num: 100, raw: '100' } }),
    getBuyingPower: async () => ({ cash: { num: 100000, raw: '100000' } }),
  } };
  return require('../server/orderService');
}

test('🔴 매도 지정가가 현재가보다 0.3% 넘게 낮으면 거부(adverse-price) + 현재가 동봉', async () => {
  const o = fresh(97.87);
  const r = await o.checkAccountLimits({ symbol: 'QLD', side: 'SELL', quantity: 5, price: 97.3 }); // -0.58%
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'adverse-price');
  assert.equal(r.currentPrice, 97.87);
});

test('통과 쌍 — 유리 방향(매도를 현재가 위로)·0.3% 이내 불리는 막지 않는다', async () => {
  const o = fresh(97.87);
  const hi = await o.checkAccountLimits({ symbol: 'QLD', side: 'SELL', quantity: 5, price: 98.5 }); // 유리 +0.64%
  assert.equal(hi.ok, true, hi.error);
  const near = await o.checkAccountLimits({ symbol: 'QLD', side: 'SELL', quantity: 5, price: 97.7 }); // -0.17%
  assert.equal(near.ok, true, near.error);
});

test('매수는 반대 — 현재가보다 0.3% 넘게 높으면 거부', async () => {
  const o = fresh(100);
  const r = await o.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1, price: 100.8 });
  assert.equal(r.kind, 'adverse-price');
  const ok = await o.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1, price: 99.5 }); // 유리(싸게)
  assert.equal(ok.ok, true, ok.error);
});

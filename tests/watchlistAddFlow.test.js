const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildEquityDetailsPatch,
  repairWatchlistHolding,
} = require('../server/holdingTickerUtil');
const { listTrackedTickerConfigs } = require('../server/marketDataService');

/**
 * 채팅 "엔비디아 정보도 추가해줘" 시 서버 파이프라인(applyConversationActions 이전 단계) 검증.
 * 실제 채팅은: supervisor actions → applyConversationActions → broadcast + scheduleMarketRefresh(300ms)
 */
test('NVDA: AI가 deposit·details 없이 넣어도 티커·stock·USD로 정규화된다', () => {
  const aiLike = {
    name: 'NVIDIA (NVDA, 0주 관찰용 데이터 추가됨)',
    category: 'deposit',
    details: null,
  };
  const { detailsPatch, cleanName } = buildEquityDetailsPatch(aiLike);
  assert.equal(cleanName, 'NVIDIA');
  assert.equal(detailsPatch.ticker, 'NVDA');
  assert.equal(detailsPatch.currency, 'USD');
  assert.equal(detailsPatch.market, 'US');
  assert.equal(detailsPatch.quantity, 0);

  const holding = repairWatchlistHolding({
    id: 'test-nvda',
    name: aiLike.name,
    category: aiLike.category,
    amount: 0,
    details: null,
  });
  assert.equal(holding.category, 'stock');
  const tracked = listTrackedTickerConfigs({ portfolio: { holdings: [holding] } });
  assert.equal(tracked[0]?.symbol, 'NVDA');
  assert.equal(tracked[0]?.market, 'US');
});

test('NVDA: listTrackedTickerConfigs에 포함되면 시세 갱신 대상이 된다', () => {
  const store = {
    portfolio: {
      holdings: [
        {
          id: 'nvda',
          name: 'NVIDIA',
          category: 'stock',
          amount: 0,
          details: {
            ticker: 'NVDA',
            currency: 'USD',
            market: 'US',
            quantity: 0,
          },
        },
      ],
    },
  };
  const tracked = listTrackedTickerConfigs(store);
  const nvda = tracked.find((item) => item.symbol === 'NVDA');
  assert.ok(nvda);
  assert.equal(nvda.market, 'US');
  assert.deepEqual(nvda.holdingIds, ['nvda']);
});

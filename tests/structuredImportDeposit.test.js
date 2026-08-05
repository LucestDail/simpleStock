const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildStructuredImportPlan } = require('../server/structuredImportService');
const { buildSlimSupervisorContext } = require('../server/contextBuilder');
const { getAiLatencySnapshot, recordAiLatency } = require('../server/aiLatencyMetrics');

test('parseMultilineDepositUpdate handles 예금 갱신 multiline input', () => {
  const content = [
    '예금 갱신해',
    '달러 예수금 17.75$',
    '원화 예수금 646053원',
    '토스뱅크 통장2021319원',
  ].join('\n');

  const plan = buildStructuredImportPlan(content);
  assert.ok(plan);
  assert.equal(plan.skipLlm, true);
  assert.equal(plan.ruleBased, true);
  assert.equal(plan.actions.length, 3);

  const names = plan.actions.map((action) => action.holding.name);
  assert.ok(names.includes('달러 예수금'));
  assert.ok(names.includes('원화 예수금'));
  assert.ok(names.some((name) => /토스뱅크/.test(name)));

  const krwCash = plan.actions.find((action) => action.holding.name === '원화 예수금');
  assert.equal(krwCash.holding.amount, 646053);
});

test('buildSimpleAssetImportPlan matches 갱신 keyword', () => {
  const plan = buildStructuredImportPlan('KB 펀드 5,516,165원으로 갱신');
  assert.ok(plan);
  assert.equal(plan.skipLlm, true);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].holding.amount, 5516165);
});

test('buildSlimSupervisorContext filters holdings by keywords', () => {
  const fullContext = {
    portfolio: {
      total: 100,
      totalLabel: '100원',
      holdings: [
        { id: '1', name: '삼성전자', category: 'stock', amount: 1000, details: { ticker: '005930' } },
        { id: '2', name: '원화 예수금', category: 'deposit', amount: 5000, details: {} },
        { id: '3', name: 'KB 펀드', category: 'fund', amount: 8000, details: {} },
      ],
      categoryShares: [],
    },
    recentMessages: [
      { role: 'user', content: 'old message one' },
      { role: 'assistant', content: 'old reply one' },
      { role: 'user', content: '원화 예수금 갱신' },
      { role: 'assistant', content: 'ok' },
    ],
    profile: { userProfile: { responseStyle: 'brief' } },
    memory: { threadSummary: 'summary' },
  };

  const slim = buildSlimSupervisorContext(fullContext, '원화 예수금 646053원으로 갱신');
  assert.equal(slim.recentMessages.length, 2);
  assert.ok(!slim.profile);
  assert.ok(!slim.memory);
  assert.ok(slim.portfolio.holdings.some((holding) => holding.name === '원화 예수금'));
  assert.equal(slim.portfolio.holdings.length, 1);
});

test('aiLatencyMetrics records and snapshots latency', () => {
  recordAiLatency({ logLabel: 'test_label', durationMs: 1200, success: true });
  const snapshot = getAiLatencySnapshot();
  assert.ok(snapshot.totals.count >= 1);
  assert.ok(snapshot.byLabel.test_label);
  assert.equal(snapshot.byLabel.test_label.lastMs, 1200);
});

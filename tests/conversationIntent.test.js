const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyConversationIntent,
  shouldUseFastMutationPath,
} = require('../server/conversationIntent');
const { buildAnswerFromActionResults } = require('../server/actionAnswerUtil');

test('classifyConversationIntent detects mutation', () => {
  assert.equal(classifyConversationIntent('미래에셋 35주 추가해줘'), 'mutation');
});

test('classifyConversationIntent detects research', () => {
  assert.equal(classifyConversationIntent('테슬라 전망 분석해줘'), 'research');
});

test('shouldUseFastMutationPath when actions present without research', () => {
  const plan = {
    actions: [{ type: 'upsertHolding', rationale: 'add' }],
    tasks: [],
  };
  assert.equal(shouldUseFastMutationPath('KB 펀드 100만원 추가', plan), true);
});

test('shouldUseFastMutationPath skips when research task needs search', () => {
  const plan = {
    actions: [{ type: 'upsertHolding', rationale: 'add' }],
    tasks: [{ agentType: 'research', needsSearch: true }],
  };
  assert.equal(shouldUseFastMutationPath('삼성전자 추가하고 전망도 알려줘', plan), false);
});

test('buildAnswerFromActionResults lists applied changes', () => {
  const answer = buildAnswerFromActionResults(
    [{ status: 'applied', message: 'KB 펀드 5,516,165원으로 갱신' }],
    'KB 펀드 갱신'
  );
  assert.match(answer, /반영했습니다/);
  assert.match(answer, /KB 펀드/);
});

test('buildAnswerFromActionResults handles empty results', () => {
  const answer = buildAnswerFromActionResults([], 'hello');
  assert.match(answer, /찾지 못했습니다/);
});

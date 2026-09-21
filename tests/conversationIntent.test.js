const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyConversationIntent,
  shouldUseFastMutationPath,
} = require('../server/conversationIntent');

test('classifyConversationIntent detects mutation', () => {
  assert.equal(classifyConversationIntent('미래에셋 35주 추가해줘'), 'mutation');
});

test('classifyConversationIntent detects research', () => {
  assert.equal(classifyConversationIntent('테슬라 전망 분석해줘'), 'research');
});

test('shouldUseFastMutationPath when actions present without research', () => {
  const plan = {
    actions: [{ type: 'scheduleTask', rationale: 'add' }],
    tasks: [],
  };
  assert.equal(shouldUseFastMutationPath('KB 펀드 100만원 추가', plan), true);
});

test('shouldUseFastMutationPath skips when research task needs search', () => {
  const plan = {
    actions: [{ type: 'scheduleTask', rationale: 'add' }],
    tasks: [{ agentType: 'research', needsSearch: true }],
  };
  assert.equal(shouldUseFastMutationPath('삼성전자 추가하고 전망도 알려줘', plan), false);
});

test('shouldUseFastMutationPath uses fast path for mutation even with research tasks', () => {
  const plan = {
    actions: [{ type: 'cancelScheduledTask', rationale: 'cancel' }],
    tasks: [{ agentType: 'research', needsSearch: true }],
  };
  assert.equal(shouldUseFastMutationPath('JEPI 없애고 AMDL 101주 추가해줘', plan), true);
});

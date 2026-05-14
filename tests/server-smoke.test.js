const { test } = require('node:test');
const assert = require('node:assert/strict');

test('aiService loads without LangGraph (single pipeline)', async () => {
  const ai = require('../server/aiService');
  assert.equal(typeof ai.runConversationGraph, 'function');
  assert.equal(typeof ai.runScheduledCustomAnalysis, 'function');
  assert.equal(typeof ai.runScheduledIndicatorAnalysis, 'function');
});

test('taskService exports executeScheduledTask', () => {
  const tasks = require('../server/taskService');
  assert.equal(typeof tasks.executeScheduledTask, 'function');
});

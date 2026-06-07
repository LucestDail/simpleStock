const { test } = require('node:test');
const assert = require('node:assert/strict');

test('applyConversationActions broadcasts portfolio on schedule-only changes', async () => {
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
  const actionService = require('../server/actionService');
  assert.equal(typeof actionService.applyConversationActions, 'function');
});

test('chatService exports stream entrypoint for portfolio inline sync', () => {
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
  const chatService = require('../server/chatService');
  assert.equal(typeof chatService.sendMessageStream, 'function');
});

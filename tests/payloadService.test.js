const { test } = require('node:test');
const assert = require('node:assert/strict');

test('payload builders expose system status without circular import failure', async () => {
  const { buildPortfolioPayload, buildChatThreadsPayload, buildServerStatusPayload } = await import(
    '../server/payloadService.js'
  );
  const portfolio = buildPortfolioPayload();
  const threads = buildChatThreadsPayload();
  const status = buildServerStatusPayload();

  assert.ok(portfolio.system);
  assert.equal(typeof portfolio.system.aiConfigured, 'boolean');
  assert.ok(Array.isArray(threads.threads));
  assert.ok(status.system);
  assert.equal(typeof status.system.timezone, 'string');
});

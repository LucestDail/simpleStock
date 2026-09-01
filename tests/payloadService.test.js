const { test } = require('node:test');
const assert = require('node:assert/strict');

test('buildServerStatusPayload 는 순환 import 없이 시스템 상태를 노출한다', async () => {
  const { buildServerStatusPayload } = await import('../server/payloadService.js');
  const status = buildServerStatusPayload();

  assert.ok(status.system);
  assert.equal(typeof status.system.timezone, 'string');
  assert.equal(typeof status.system.aiConfigured, 'boolean');
  assert.ok(status.system.market, 'market 스냅샷 포함');
});

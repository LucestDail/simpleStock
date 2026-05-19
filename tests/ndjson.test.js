const { test } = require('node:test');
const assert = require('node:assert/strict');

test('parseNdjsonText parses multiple NDJSON lines', async () => {
  const { parseNdjsonText } = await import('../frontend/src/lib/ndjson.js');
  const events = parseNdjsonText('{"type":"start"}\n\n{"type":"delta","delta":"hi"}\n');
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'start');
  assert.equal(events[1].delta, 'hi');
});

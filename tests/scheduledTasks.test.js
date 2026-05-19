const { test } = require('node:test');
const assert = require('node:assert/strict');

test('matchesCronExpression matches daily 9am in Seoul', async () => {
  const { matchesCronExpression } = await import('../frontend/src/lib/cronSchedule.js');
  const date = new Date('2026-05-19T00:00:00.000Z');
  assert.equal(matchesCronExpression('0 9 * * *', date, 'Asia/Seoul'), true);
});

test('getNextRunDate returns a future minute', async () => {
  const { getNextRunDate } = await import('../frontend/src/lib/cronSchedule.js');
  const next = getNextRunDate('0 9 * * *', 'Asia/Seoul');
  assert.ok(next instanceof Date);
  assert.ok(next.getTime() > Date.now() - 60_000);
});

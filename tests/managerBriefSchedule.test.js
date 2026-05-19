const { test } = require('node:test');
const assert = require('node:assert/strict');
const cron = require('node-cron');
const { DEFAULT_MANAGER_BRIEF_TASKS } = require('../server/managerBriefSchedule');

test('preset manager brief tasks cover six weekday slots', () => {
  assert.equal(DEFAULT_MANAGER_BRIEF_TASKS.length, 6);
  const hours = DEFAULT_MANAGER_BRIEF_TASKS.map((task) => task.cronExpression.split(' ')[1]);
  assert.deepEqual(new Set(hours), new Set(['6', '9', '10', '18', '22', '23']));
  for (const task of DEFAULT_MANAGER_BRIEF_TASKS) {
    assert.equal(task.taskType, 'managerBrief');
    assert.ok(cron.validate(task.cronExpression));
    assert.match(task.cronExpression, / 1-5$/);
    assert.ok(String(task.prompt || '').trim().length > 20);
  }
});

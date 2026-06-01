const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  inferCronFromScheduleText,
  backfillScheduleTaskCrons,
} = require('../server/scheduleCronUtil');

test('inferCronFromScheduleText parses daily morning slot', () => {
  assert.equal(inferCronFromScheduleText('매일 오전 9시에 브리핑'), '0 9 * * *');
});

test('inferCronFromScheduleText parses weekday evening slot', () => {
  assert.equal(inferCronFromScheduleText('평일 오후 6시 시황 점검'), '0 18 * * 1-5');
});

test('inferCronFromScheduleText accepts explicit cron', () => {
  assert.equal(inferCronFromScheduleText('cron: 30 21 * * 1-5'), '30 21 * * 1-5');
});

test('backfillScheduleTaskCrons fills missing cron from user message', () => {
  const actions = [
    {
      type: 'scheduleTask',
      rationale: 'test',
      scheduleTask: {
        title: '아침 브리핑',
        taskType: 'custom',
      },
    },
  ];
  const patched = backfillScheduleTaskCrons(actions, '매일 오전 9시에 아침 브리핑 해줘', 'thread-1');
  assert.equal(patched[0].scheduleTask.cronExpression, '0 9 * * *');
  assert.equal(patched[0].scheduleTask.taskType, 'managerBrief');
  assert.equal(patched[0].scheduleTask.timezone, 'Asia/Seoul');
});

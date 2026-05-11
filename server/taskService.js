const cron = require('node-cron');
const { loadStore, mutateStore } = require('./dataStore');
const { APP_TIMEZONE } = require('./time');
const { runManagerReview } = require('./managerService');
const { logInfo, logError } = require('./logger');

const scheduledHandles = new Map();

function stopRemovedTasks(activeIds) {
  for (const [taskId, handle] of scheduledHandles.entries()) {
    if (activeIds.has(taskId)) continue;
    handle.stop();
    scheduledHandles.delete(taskId);
  }
}

async function markTaskRun(taskId, status, message) {
  await mutateStore((store) => {
    const target = store.memory.scheduledTasks.find((item) => item.id === taskId);
    if (!target) return;
    target.lastRunAt = new Date().toISOString();
    target.lastRunStatus = status;
    target.lastRunMessage = String(message || '').slice(0, 300);
    target.updatedAt = new Date().toISOString();
  });
}

async function executeScheduledTask(taskId) {
  const store = loadStore();
  const task = store.memory.scheduledTasks.find((item) => item.id === taskId && item.enabled);
  if (!task) return;

  try {
    logInfo('task.execute.start', {
      taskId,
      taskType: task.taskType,
      title: task.title,
      cronExpression: task.cronExpression,
    });
    if (task.taskType === 'managerBrief' || task.taskType === 'marketReview') {
      await runManagerReview(`scheduled:${task.taskType}`);
      await markTaskRun(taskId, 'success', `${task.title} 작업을 실행했습니다.`);
      logInfo('task.execute.finish', {
        taskId,
        taskType: task.taskType,
        title: task.title,
        status: 'success',
      });
      return;
    }

    await markTaskRun(taskId, 'success', `${task.title} 작업 예약을 유지합니다.`);
    logInfo('task.execute.finish', {
      taskId,
      taskType: task.taskType,
      title: task.title,
      status: 'success',
    });
  } catch (error) {
    await markTaskRun(taskId, 'error', error.message || '예약 작업 실행 실패');
    logError('task.execute.failed', error, {
      taskId,
      taskType: task.taskType,
      title: task.title,
    });
  }
}

function syncScheduledTasks() {
  const store = loadStore();
  const validTasks = store.memory.scheduledTasks.filter(
    (task) => task.enabled && task.cronExpression && cron.validate(task.cronExpression)
  );
  const activeIds = new Set(validTasks.map((task) => task.id));
  stopRemovedTasks(activeIds);

  for (const task of validTasks) {
    if (scheduledHandles.has(task.id)) continue;
    const handle = cron.schedule(
      task.cronExpression,
      async () => {
        await executeScheduledTask(task.id);
      },
      {
        timezone: task.timezone || APP_TIMEZONE,
      }
    );
    scheduledHandles.set(task.id, handle);
    logInfo('task.registered', {
      taskId: task.id,
      taskType: task.taskType,
      title: task.title,
      cronExpression: task.cronExpression,
      timezone: task.timezone || APP_TIMEZONE,
    });
  }
}

function getScheduledTasks() {
  const store = loadStore();
  return store.memory.scheduledTasks || [];
}

module.exports = {
  syncScheduledTasks,
  getScheduledTasks,
};

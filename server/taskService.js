const { randomUUID } = require('crypto');
const cron = require('node-cron');
const { loadStore, mutateStore } = require('./dataStore');
const { APP_TIMEZONE } = require('./time');
const { runManagerReview } = require('./managerService');
const {
  isAiConfigured,
  runScheduledIndicatorAnalysis,
  runScheduledCustomAnalysis,
} = require('./aiService');
const { logInfo, logError } = require('./logger');
const telegram = require('./telegramService');
const { buildServerStatusPayload } = require('./payloadService');
const { broadcast } = require('./realtimeService');

const scheduledHandles = new Map();

/**
 * ⚠️ 지연 재시도는 **일부러 없다** (2026-09-23, 실패한 실험 기록).
 *    정각 브리핑이 이틀 연속 죽어(09-22 06시·09-23 09시, LLM 120초×3 타임아웃)
 *    "정각 게이트웨이 혼잡 → 15분 뒤 재시도" 를 넣으려 했는데 **가설이 반증됐다**(pm2 실측):
 *    그 시각 게이트웨이 요청은 simpleStock 뿐이었고(경합 없음), 원인은 **출력 토큰 길이**다 —
 *    생성 속도가 초당 ~24토큰으로 고정이라 120초 예산 ≈ 2,900토큰인데 브리핑 출력이
 *    3,115~3,550토큰으로 **구조적으로** 넘었다. 같은 프롬프트는 같은 길이를 또 쓰므로
 *    재시도는 낭비다(어제 3/3 실패가 증거). ⇒ 처방은 출력 축소(managerService 스키마·지시).
 */

function stopRemovedTasks(activeIds) {
  for (const [taskId, handle] of scheduledHandles.entries()) {
    if (activeIds.has(taskId)) continue;
    handle.stop();
    scheduledHandles.delete(taskId);
  }
}

async function appendScheduledTaskInsight({ taskId, taskType, title, summaryText }) {
  const trimmed = String(summaryText || '').trim().slice(0, 2000);
  if (!trimmed) return;
  await mutateStore((store) => {
    if (!Array.isArray(store.memory.longTermMemories)) {
      store.memory.longTermMemories = [];
    }
    store.memory.longTermMemories.unshift({
      id: randomUUID(),
      kind: 'schedule_run',
      text: trimmed,
      confidence: 'ai',
      sourceThreadId: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        scheduledTaskId: taskId,
        taskType,
        title: String(title || '').slice(0, 120),
      },
    });
    store.memory.longTermMemories = store.memory.longTermMemories.slice(0, 60);
  });
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
  broadcast('schedule.run.updated', buildServerStatusPayload());
  broadcast('activity.created', {
    activity: {
      type: 'schedule',
      title: '예약 작업 실행',
      description: String(message || '예약 작업 상태가 갱신되었습니다.'),
      tone: status === 'success' ? 'info' : 'warning',
      entityId: taskId,
      metadata: { taskId, status },
    },
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
      const extraBits = [task.prompt, task.description].map((s) => String(s || '').trim()).filter(Boolean);
      await runManagerReview(`scheduled:${task.taskType}`, {
        extraContext: extraBits.join('\n'),
      });
      await markTaskRun(taskId, 'success', `${task.title} 작업을 실행했습니다.`);
      logInfo('task.execute.finish', {
        taskId,
        taskType: task.taskType,
        title: task.title,
        status: 'success',
      });
      return;
    }

    if (task.taskType === 'indicatorCheck') {
      if (!isAiConfigured()) {
        throw new Error('GEMINI_API_KEY가 설정되지 않아 지표 점검을 실행할 수 없습니다.');
      }
      const indicatorName = String(task.indicatorName || '').trim();
      const prompt = String(task.prompt || '').trim();
      const description = String(task.description || '').trim();
      if (!indicatorName && !prompt && !description) {
        throw new Error('지표 점검에는 indicatorName 또는 프롬프트/설명이 필요합니다.');
      }
      const text = await runScheduledIndicatorAnalysis({
        title: task.title,
        description,
        prompt,
        indicatorName,
        portfolio: { holdings: [], snapshots: [] },
        profile: { userProfile: {}, aiProfile: {}, metadata: {} },
        memory: store.memory,
      });
      await appendScheduledTaskInsight({
        taskId,
        taskType: task.taskType,
        title: task.title,
        summaryText: `[예약: 지표] ${task.title}\n${text}`,
      });
      await markTaskRun(
        taskId,
        'success',
        `${task.title} 지표 점검을 실행했습니다.`
      );
      logInfo('task.execute.finish', {
        taskId,
        taskType: task.taskType,
        title: task.title,
        status: 'success',
      });
      return;
    }

    if (task.taskType === 'custom') {
      if (!isAiConfigured()) {
        throw new Error('GEMINI_API_KEY가 설정되지 않아 사용자 예약 작업을 실행할 수 없습니다.');
      }
      const text = await runScheduledCustomAnalysis({
        title: task.title,
        description: task.description,
        prompt: task.prompt,
        portfolio: { holdings: [], snapshots: [] },
        profile: { userProfile: {}, aiProfile: {}, metadata: {} },
        memory: store.memory,
      });
      await appendScheduledTaskInsight({
        taskId,
        taskType: task.taskType,
        title: task.title,
        summaryText: `[예약: 사용자 지시] ${task.title}\n${text}`,
      });
      await markTaskRun(taskId, 'success', `${task.title} 사용자 예약 작업을 실행했습니다.`);
      logInfo('task.execute.finish', {
        taskId,
        taskType: task.taskType,
        title: task.title,
        status: 'success',
      });
      return;
    }

    await markTaskRun(taskId, 'error', `알 수 없는 작업 유형: ${task.taskType}`);
    logInfo('task.execute.finish', {
      taskId,
      taskType: task.taskType,
      title: task.title,
      status: 'error',
    });
  } catch (error) {
    await markTaskRun(taskId, 'error', error.message || '예약 작업 실행 실패');
    logError('task.execute.failed', error, {
      taskId,
      taskType: task.taskType,
      title: task.title,
    });
    /**
     * 🔴 실패를 폰에도 알린다 (2026-09-23) — 종전엔 로그·화면 이력에만 남아 사용자는
     *    브리핑이 안 온 것을 눈치로만 알았다(09-22 06시·09-23 09시 이틀 연속).
     * ⚠️ 통보 실패가 원래 실패를 가리면 안 된다 — 삼키되 로그는 남긴다.
     */
    try {
      await telegram.send(
        `⚠️ ${task.title} 생성에 실패했습니다(${String(error?.message || '').slice(0, 80)}). 웹 화면에서 수동 실행할 수 있습니다.`,
        { reason: 'task_failed' }
      );
    } catch (e) {
      logError('task.failure_notify_failed', e, { taskId });
    }
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

  broadcast('schedule.updated', buildServerStatusPayload());
}

function getScheduledTasks() {
  const store = loadStore();
  return store.memory.scheduledTasks || [];
}

module.exports = {
  syncScheduledTasks,
  getScheduledTasks,
  executeScheduledTask,
};

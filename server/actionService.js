const crypto = require('crypto');
const cron = require('node-cron');
const { CATEGORIES, mutateStore } = require('./dataStore');
const { APP_TIMEZONE } = require('./time');
const { syncScheduledTasks } = require('./taskService');

const PROFILE_FIELDS = new Set([
  'displayName',
  'investorType',
  'investmentGoal',
  'riskTolerance',
  'timeHorizon',
  'liquidityNeeds',
  'responseStyle',
  'focusAreas',
  'notes',
]);

function normalizeText(value) {
  return String(value || '').trim();
}

function findHoldingIndex(holdings, name, category) {
  const targetName = normalizeText(name).toLowerCase();
  const targetCategory = normalizeText(category);
  return holdings.findIndex((item) => {
    const sameName = normalizeText(item.name).toLowerCase() === targetName;
    const sameCategory = !targetCategory || item.category === targetCategory;
    return sameName && sameCategory;
  });
}

async function applyConversationActions(actions = []) {
  const safeActions = Array.isArray(actions) ? actions.slice(0, 12) : [];
  let needsScheduleSync = false;

  const result = await mutateStore((store) => {
    const actionResults = [];
    let changedPortfolio = false;
    let changedProfile = false;
    let changedSchedules = false;

    for (const action of safeActions) {
      const type = normalizeText(action?.type);
      if (!type) continue;

      if (type === 'upsertHolding') {
        const payload = action.holding || {};
        const name = normalizeText(payload.name);
        const category = CATEGORIES.includes(payload.category) ? payload.category : 'deposit';
        const amount = Math.max(0, Math.round(Number(payload.amount) || 0));
        const mode = payload.mode === 'delta' ? 'delta' : 'set';
        if (!name) {
          actionResults.push({ type, status: 'ignored', message: '자산 이름이 없어 반영하지 않았습니다.' });
          continue;
        }

        const index = findHoldingIndex(store.portfolio.holdings, name, category);
        if (index >= 0) {
          const current = store.portfolio.holdings[index];
          current.amount = mode === 'delta' ? Math.max(0, current.amount + amount) : amount;
          current.category = category;
          actionResults.push({
            type,
            status: 'applied',
            message: `${name} 자산을 ${current.amount.toLocaleString('ko-KR')}원으로 반영했습니다.`,
          });
        } else {
          store.portfolio.holdings.push({
            id: crypto.randomUUID(),
            name,
            category,
            amount,
          });
          actionResults.push({
            type,
            status: 'applied',
            message: `${name} 자산을 새로 추가했습니다.`,
          });
        }
        changedPortfolio = true;
        continue;
      }

      if (type === 'removeHolding') {
        const payload = action.holding || {};
        const name = normalizeText(payload.name);
        if (!name) {
          actionResults.push({ type, status: 'ignored', message: '삭제할 자산 이름이 없습니다.' });
          continue;
        }

        const index = store.portfolio.holdings.findIndex(
          (item) => normalizeText(item.name).toLowerCase() === name.toLowerCase()
        );
        if (index < 0) {
          actionResults.push({ type, status: 'ignored', message: `${name} 자산을 찾지 못했습니다.` });
          continue;
        }

        store.portfolio.holdings.splice(index, 1);
        actionResults.push({ type, status: 'applied', message: `${name} 자산을 삭제했습니다.` });
        changedPortfolio = true;
        continue;
      }

      if (type === 'updateProfile') {
        const payload = action.profileChanges || {};
        const touched = [];
        for (const key of Object.keys(payload)) {
          if (!PROFILE_FIELDS.has(key)) continue;
          store.profile.userProfile[key] = normalizeText(payload[key]);
          touched.push(key);
        }

        if (!touched.length) {
          actionResults.push({ type, status: 'ignored', message: '변경할 설정 필드가 없어 반영하지 않았습니다.' });
          continue;
        }

        store.profile.metadata.lastManualUpdateAt = new Date().toISOString();
        actionResults.push({
          type,
          status: 'applied',
          message: `설정 ${touched.join(', ')} 항목을 갱신했습니다.`,
        });
        changedProfile = true;
        continue;
      }

      if (type === 'scheduleTask') {
        const payload = action.scheduleTask || {};
        const title = normalizeText(payload.title);
        const cronExpression = normalizeText(payload.cronExpression);
        const taskType = normalizeText(payload.taskType || 'custom') || 'custom';
        const timezone = normalizeText(payload.timezone || APP_TIMEZONE) || APP_TIMEZONE;
        if (!title || !cronExpression || !cron.validate(cronExpression)) {
          actionResults.push({
            type,
            status: 'ignored',
            message: `${title || '예약 작업'}의 cron 정보가 유효하지 않아 저장하지 않았습니다.`,
          });
          continue;
        }

        const existing = store.memory.scheduledTasks.find(
          (item) => item.title === title && item.taskType === taskType
        );
        const now = new Date().toISOString();
        const nextTask = {
          id: existing?.id || crypto.randomUUID(),
          title,
          description: normalizeText(payload.description),
          taskType,
          cronExpression,
          timezone,
          nextRunLabel: normalizeText(payload.nextRunLabel),
          prompt: normalizeText(payload.prompt),
          indicatorName: normalizeText(payload.indicatorName),
          enabled: payload.enabled !== false,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
          lastRunAt: existing?.lastRunAt || null,
          lastRunStatus: existing?.lastRunStatus || '',
          lastRunMessage: existing?.lastRunMessage || '',
          source: 'conversation',
        };

        if (existing) {
          Object.assign(existing, nextTask);
        } else {
          store.memory.scheduledTasks.unshift(nextTask);
        }

        actionResults.push({
          type,
          status: 'applied',
          message: `${title} 반복 작업을 저장했습니다.`,
        });
        changedSchedules = true;
        needsScheduleSync = true;
        continue;
      }

      if (type === 'cancelScheduledTask') {
        const payload = action.cancelTarget || {};
        const title = normalizeText(payload.title);
        const taskType = normalizeText(payload.taskType);
        const target = store.memory.scheduledTasks.find((item) => {
          const sameTitle = title ? item.title === title : true;
          const sameType = taskType ? item.taskType === taskType : true;
          return sameTitle && sameType;
        });

        if (!target) {
          actionResults.push({ type, status: 'ignored', message: '취소할 예약 작업을 찾지 못했습니다.' });
          continue;
        }

        target.enabled = false;
        target.updatedAt = new Date().toISOString();
        actionResults.push({
          type,
          status: 'applied',
          message: `${target.title} 예약을 비활성화했습니다.`,
        });
        changedSchedules = true;
        needsScheduleSync = true;
        continue;
      }
    }

    return {
      actionResults,
      changedPortfolio,
      changedProfile,
      changedSchedules,
    };
  });

  if (needsScheduleSync) {
    syncScheduledTasks();
  }

  return result;
}

module.exports = {
  applyConversationActions,
};

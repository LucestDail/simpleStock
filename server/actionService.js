const crypto = require('crypto');
const cron = require('node-cron');
const { CATEGORIES, mutateStore } = require('./dataStore');
const { APP_TIMEZONE } = require('./time');
const { syncScheduledTasks } = require('./taskService');
const { logInfo, logWarn, logError } = require('./logger');
const { buildPortfolioPayload, buildProfilePayload } = require('./payloadService');
const { broadcast } = require('./realtimeService');
const { scheduleMarketRefresh } = require('./marketDataService');
const {
  isEquityTicker,
  buildEquityDetailsPatch,
  applyEquityWatchDefaults,
  mergeHoldingDetailFields,
} = require('./holdingTickerUtil');

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

function mergeHoldingDetails(existing, patch) {
  return mergeHoldingDetailFields(existing, patch);
}

function normalizeHoldingDetails(details) {
  if (!details || typeof details !== 'object') return null;
  return {
    account: normalizeText(details.account),
    currency: normalizeText(details.currency),
    ticker: normalizeText(details.ticker),
    market: normalizeText(details.market),
    quantity: Number.isFinite(Number(details.quantity)) ? Number(details.quantity) : null,
    averagePrice: Number.isFinite(Number(details.averagePrice)) ? Number(details.averagePrice) : null,
    currentPrice: Number.isFinite(Number(details.currentPrice)) ? Number(details.currentPrice) : null,
    lastQuote: Number.isFinite(Number(details.lastQuote)) ? Number(details.lastQuote) : null,
    previousClose: Number.isFinite(Number(details.previousClose)) ? Number(details.previousClose) : null,
    priceChange: Number.isFinite(Number(details.priceChange)) ? Number(details.priceChange) : null,
    priceChangePct: Number.isFinite(Number(details.priceChangePct)) ? Number(details.priceChangePct) : null,
    marketState: normalizeText(details.marketState),
    lastQuoteAt: normalizeText(details.lastQuoteAt),
    quoteSource: normalizeText(details.quoteSource),
    nativeAmount: Number.isFinite(Number(details.nativeAmount)) ? Number(details.nativeAmount) : null,
    fxRate: Number.isFinite(Number(details.fxRate)) ? Number(details.fxRate) : null,
    summary: normalizeText(details.summary),
    orders: Array.isArray(details.orders) ? details.orders.map(normalizeText).filter(Boolean).slice(0, 6) : [],
  };
}

function normalizeActionType(action) {
  const rawType = normalizeText(action?.type);
  if (rawType === 'upsertHolding') return 'upsertHolding';
  if (rawType === 'removeHolding') return 'removeHolding';
  if (rawType === 'updateProfile') return 'updateProfile';
  if (rawType === 'scheduleTask') return 'scheduleTask';
  if (rawType === 'cancelScheduledTask') return 'cancelScheduledTask';

  if (['holding', 'asset', 'addHolding', 'saveHolding', 'updateHolding'].includes(rawType)) {
    return 'upsertHolding';
  }

  if (['deleteHolding', 'deleteAsset', 'removeAsset'].includes(rawType)) {
    return 'removeHolding';
  }

  if (['profile', 'updateSettings', 'saveProfile'].includes(rawType)) {
    return 'updateProfile';
  }

  if (['schedule', 'createSchedule', 'upsertSchedule'].includes(rawType)) {
    return 'scheduleTask';
  }

  if (['cancelSchedule', 'disableSchedule'].includes(rawType)) {
    return 'cancelScheduledTask';
  }

  if (action?.holding && !action?.profileChanges && !action?.scheduleTask && !action?.cancelTarget) {
    return 'upsertHolding';
  }
  if (action?.profileChanges) return 'updateProfile';
  if (action?.scheduleTask) return 'scheduleTask';
  if (action?.cancelTarget) return 'cancelScheduledTask';
  return '';
}

function normalizeIncomingAction(action) {
  if (!action || typeof action !== 'object') return null;
  return {
    ...action,
    type: normalizeActionType(action),
  };
}

function normalizeForMatch(text) {
  return normalizeText(text).toLowerCase().replace(/[\s\-_·()（）]/g, '');
}

function findHoldingIndex(holdings, name, category, id = '') {
  const targetId = normalizeText(id);
  if (targetId) {
    const byId = holdings.findIndex((item) => item.id === targetId);
    if (byId >= 0) return byId;
  }

  const targetName = normalizeForMatch(name);
  if (!targetName) return -1;
  const targetCategory = normalizeText(category);

  const exactIndex = holdings.findIndex((item) => {
    const sameName = normalizeForMatch(item.name) === targetName;
    const sameCategory = !targetCategory || item.category === targetCategory;
    return sameName && sameCategory;
  });
  if (exactIndex >= 0) return exactIndex;

  return holdings.findIndex((item) => {
    const itemName = normalizeForMatch(item.name);
    const fuzzy = itemName.includes(targetName) || targetName.includes(itemName);
    const sameCategory = !targetCategory || item.category === targetCategory;
    return fuzzy && sameCategory;
  });
}

function hasExplicitAmount(payload) {
  return payload.amount !== undefined && payload.amount !== null && String(payload.amount).trim() !== '';
}

const SUBSTANTIVE_DETAIL_KEYS = ['ticker', 'quantity', 'averagePrice', 'account', 'currency', 'market', 'nativeAmount', 'orders'];

function hasSubstantiveDetails(patch, existing) {
  if (!patch || typeof patch !== 'object') return false;
  for (const key of SUBSTANTIVE_DETAIL_KEYS) {
    const value = patch[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    if (key === 'orders' && Array.isArray(value) && !value.length) continue;
    if (key === 'quantity' && value === 0 && existing && Number.isFinite(Number(existing.quantity)) && Number(existing.quantity) > 0) {
      continue;
    }
    if (typeof value === 'number' && value === 0) continue;
    return true;
  }
  return false;
}

function inferHoldingCategory(category, detailsPatch) {
  const ticker = normalizeText(detailsPatch?.ticker);
  if (isEquityTicker(ticker)) return 'stock';
  return CATEGORIES.includes(category) ? category : 'deposit';
}

async function applyConversationActions(actions = []) {
  const safeActions = Array.isArray(actions) ? actions.slice(0, 12) : [];
  let needsScheduleSync = false;
  logInfo('action.batch.start', {
    actionCount: safeActions.length,
    actions: safeActions.map((action) => ({
      type: action?.type || '',
      rationale: normalizeText(action?.rationale).slice(0, 160),
      holdingName: normalizeText(action?.holding?.name).slice(0, 60),
      holdingId: normalizeText(action?.holding?.id).slice(0, 40),
      holdingTicker: normalizeText(action?.holding?.details?.ticker).slice(0, 20),
      holdingQuantity: action?.holding?.details?.quantity ?? null,
      holdingAmount: action?.holding?.amount ?? null,
    })),
  });

  let result;
  try {
    result = await mutateStore((store) => {
    const actionResults = [];
    let changedPortfolio = false;
    let changedProfile = false;
    let changedSchedules = false;

    for (const rawAction of safeActions) {
      const action = normalizeIncomingAction(rawAction);
      const type = normalizeText(action?.type);
      if (!type) {
        actionResults.push({
          type: normalizeText(rawAction?.type) || 'unknown',
          status: 'ignored',
          message: '액션 타입을 해석하지 못해 반영하지 않았습니다.',
        });
        continue;
      }

      if (type === 'upsertHolding') {
        const payload = action.holding || {};
        const rawName = normalizeText(payload.name);
        const rawDetailsPatch = normalizeHoldingDetails(payload.details);
        const equityPatch = buildEquityDetailsPatch({
          name: rawName,
          details: rawDetailsPatch,
        });
        const name = equityPatch.cleanName || rawName;
        const detailsPatch = equityPatch.detailsPatch;
        const category = inferHoldingCategory(payload.category, detailsPatch);
        const amount = Math.max(0, Math.round(Number(payload.amount) || 0));
        const mode = payload.mode === 'delta' ? 'delta' : 'set';
        const holdingId = normalizeText(payload.id);
        if (!name && !holdingId) {
          actionResults.push({ type, status: 'ignored', message: '자산 이름이 없어 반영하지 않았습니다.' });
          continue;
        }

        const index = findHoldingIndex(store.portfolio.holdings, name, category, holdingId);
        if (index >= 0) {
          const current = store.portfolio.holdings[index];
          const amountChanged = hasExplicitAmount(payload);
          const previousAmount = current.amount;
          if (amountChanged) {
            current.amount = mode === 'delta' ? Math.max(0, current.amount + amount) : amount;
          }
          const previousCategory = current.category;
          current.category = category;
          const shouldMergeDetails =
            detailsPatch &&
            hasSubstantiveDetails(detailsPatch, current.details) &&
            !(current.details?.ticker && !rawDetailsPatch);
          if (shouldMergeDetails) {
            current.details = applyEquityWatchDefaults(
              mergeHoldingDetails(current.details, detailsPatch)
            );
          }
          if (isEquityTicker(current.details?.ticker) && current.category !== 'stock') {
            current.category = 'stock';
          }

          const actuallyChanged =
            amountChanged ||
            shouldMergeDetails ||
            previousCategory !== current.category;
          if (!actuallyChanged) {
            actionResults.push({
              type,
              status: 'ignored',
              message: `${current.name} 자산에 적용할 변경 데이터가 없어 반영하지 않았습니다. (AI가 amount/details 필드를 누락했을 가능성)`,
            });
            continue;
          }

          const tickerNote =
            detailsPatch?.ticker && current.details?.ticker
              ? ` (티커 ${current.details.ticker})`
              : '';
          const amountNote = amountChanged
            ? ` ₩${previousAmount.toLocaleString('ko-KR')} → ₩${current.amount.toLocaleString('ko-KR')}`
            : '';
          actionResults.push({
            type,
            status: 'applied',
            message: `${current.name} 자산을 반영했습니다${amountNote}${tickerNote}.`,
          });
        } else {
          store.portfolio.holdings.push({
            id: holdingId || crypto.randomUUID(),
            name,
            category,
            amount: hasExplicitAmount(payload) ? amount : 0,
            details: detailsPatch ? applyEquityWatchDefaults(detailsPatch) : null,
          });
          actionResults.push({
            type,
            status: 'applied',
            message: `${name} 자산을 새로 추가했습니다.`,
          });
        }
        const last = actionResults[actionResults.length - 1];
        if (last && last.status === 'applied') {
          changedPortfolio = true;
        }
        continue;
      }

      if (type === 'removeHolding') {
        const payload = action.holding || {};
        const name = normalizeText(payload.name);
        if (!name) {
          actionResults.push({ type, status: 'ignored', message: '삭제할 자산 이름이 없습니다.' });
          continue;
        }

        const category = CATEGORIES.includes(payload.category) ? payload.category : '';
        const index = findHoldingIndex(store.portfolio.holdings, name, category);
        if (index < 0) {
          const hint = category ? ` (${category})` : '';
          actionResults.push({
            type,
            status: 'ignored',
            message: `${name}${hint} 자산을 찾지 못했습니다. 동일 이름이 여러 종류에 있으면 category를 지정하세요.`,
          });
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
        const taskId = normalizeText(payload.taskId);
        const title = normalizeText(payload.title);
        const taskType = normalizeText(payload.taskType);
        let target = null;
        if (taskId) {
          target = store.memory.scheduledTasks.find((item) => item.id === taskId);
        }
        if (!target) {
          target = store.memory.scheduledTasks.find((item) => {
            const sameTitle = title ? item.title === title : true;
            const sameType = taskType ? item.taskType === taskType : true;
            return sameTitle && sameType;
          });
        }

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

      actionResults.push({
        type,
        status: 'ignored',
        message: `${type} 액션 타입은 아직 처리하지 않습니다.`,
      });
    }

    return {
      actionResults,
      changedPortfolio,
      changedProfile,
      changedSchedules,
    };
  });
  } catch (error) {
    logError('action.batch.failed', error, {
      actionCount: safeActions.length,
    });
    throw error;
  }

  if (needsScheduleSync) {
    syncScheduledTasks();
  }

  logInfo('action.batch.finish', {
    actionCount: safeActions.length,
    changedPortfolio: result.changedPortfolio,
    changedProfile: result.changedProfile,
    changedSchedules: result.changedSchedules,
    actionResults: result.actionResults,
  });

  if (result.actionResults.some((item) => item.status !== 'applied')) {
    logWarn('action.batch.partial', {
      actionResults: result.actionResults.filter((item) => item.status !== 'applied'),
    });
  }

  if (result.changedPortfolio) {
    broadcast('portfolio.updated', buildPortfolioPayload());
    scheduleMarketRefresh('portfolio:conversation_action', {
      force: true,
      delayMs: 300,
    });
  }

  if (result.changedProfile) {
    broadcast('profile.user.updated', buildProfilePayload());
  }

  return result;
}

module.exports = {
  applyConversationActions,
  findHoldingIndex,
  mergeHoldingDetails,
  hasExplicitAmount,
  inferHoldingCategory,
};

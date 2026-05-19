const { loadStore, mutateStore } = require('./dataStore');
const { buildManagerReport, getAiSettings, isAiConfigured } = require('./aiService');
const {
  getTokenUsageSummary,
  AI_PRESETS,
  loadSettings,
  getEffectiveMarketProviders,
} = require('./settingsService');
const { getMemoryState } = require('./memoryService');
const { getDateInTimezone } = require('./time');
const { broadcast } = require('./realtimeService');
const { upsertPortfolioSnapshot } = require('./snapshotService');

function getLatestManagerReport() {
  const store = loadStore();
  return store.memory.managerReports[0] || null;
}

async function runManagerReview(trigger = 'manual', options = {}) {
  if (!isAiConfigured()) {
    throw new Error('GEMINI_API_KEY가 설정되지 않아 AI 기능이 비활성화되어 있습니다.');
  }

  const store = loadStore();
  if (!Array.isArray(store.portfolio.holdings) || store.portfolio.holdings.length === 0) {
    throw new Error('등록된 자산이 없어 AI 브리핑을 생성할 수 없습니다.');
  }

  const extraContext =
    typeof options.extraContext === 'string'
      ? options.extraContext
      : typeof options.scheduledTaskPrompt === 'string'
        ? options.scheduledTaskPrompt
        : '';

  const report = await buildManagerReport({
    portfolio: store.portfolio,
    profile: store.profile,
    memory: store.memory,
    trigger,
    extraContext,
  });

  let snapshotSaved = false;
  await mutateStore((draft) => {
    draft.memory.managerReports.unshift(report);
    draft.memory.managerReports = draft.memory.managerReports.slice(0, 30);
    const today = getDateInTimezone(new Date(), getAiSettings().timezone);
    snapshotSaved = upsertPortfolioSnapshot(draft.portfolio, today);
  });

  const nextStore = loadStore();
  broadcast('manager.report.created', {
    manager: {
      latestReport: nextStore.memory.managerReports[0] || report,
      history: nextStore.memory.managerReports.slice(0, 10),
    },
    system: getSystemStatus(),
  });
  if (snapshotSaved) {
    const { buildPortfolioPayload } = require('./payloadService');
    broadcast('snapshots.updated', buildPortfolioPayload());
  }
  broadcast('activity.created', {
    activity: {
      type: 'manager',
      title: 'Quant Manager 브리핑 갱신',
      description: `${report.targetDate || '오늘'} 기준 브리핑이 생성되었습니다.`,
      tone: 'info',
      entityId: report.id,
      metadata: {
        reportId: report.id,
        trigger,
      },
    },
  });

  return report;
}

function getSystemStatus() {
  const store = loadStore();
  const ai = getAiSettings();
  const krAttempts = store.memory.market?.stats?.krQuoteAttempts || 0;
  const krFailures = store.memory.market?.stats?.krQuoteFailures || 0;
  return {
    timezone: ai.timezone,
    todayLocalDate: getDateInTimezone(new Date(), ai.timezone),
    serverTimeIso: new Date().toISOString(),
    serverTimeLocal: new Intl.DateTimeFormat('ko-KR', {
      timeZone: ai.timezone,
      dateStyle: 'full',
      timeStyle: 'long',
    }).format(new Date()),
    aiConfigured: isAiConfigured(),
    ai,
    aiPresets: AI_PRESETS,
    savedSettings: loadSettings(),
    tokenUsage: getTokenUsageSummary(store),
    memory: getMemoryState(),
    importUndoAvailable: Boolean(store.memory?.lastImportUndo?.portfolioHoldings),
    marketProviders: getEffectiveMarketProviders(),
    marketMatchHealth: {
      krFailureRate:
        krAttempts > 0 ? Math.round((krFailures / krAttempts) * 1000) / 10 : null,
      krQuoteAttempts: krAttempts,
      krQuoteFailures: krFailures,
      lastKrFailureSymbol: store.memory.market?.stats?.lastKrFailureSymbol || '',
    },
    latestManagerReport: store.memory.managerReports[0] || null,
    scheduledTasks: (store.memory.scheduledTasks || []).slice(0, 12),
  };
}

module.exports = {
  getLatestManagerReport,
  runManagerReview,
  getSystemStatus,
};

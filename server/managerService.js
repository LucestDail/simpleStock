const { loadStore, mutateStore } = require('./dataStore');
const { buildManagerReport, getAiSettings, isAiConfigured } = require('./aiService');
const { getDateInTimezone } = require('./time');

function getLatestManagerReport() {
  const store = loadStore();
  return store.memory.managerReports[0] || null;
}

async function runManagerReview(trigger = 'manual') {
  if (!isAiConfigured()) {
    throw new Error('GEMINI_API_KEY가 설정되지 않아 AI 기능이 비활성화되어 있습니다.');
  }

  const store = loadStore();
  if (!Array.isArray(store.portfolio.holdings) || store.portfolio.holdings.length === 0) {
    throw new Error('등록된 자산이 없어 AI 브리핑을 생성할 수 없습니다.');
  }

  const report = await buildManagerReport({
    portfolio: store.portfolio,
    profile: store.profile,
    memory: store.memory,
    trigger,
  });

  await mutateStore((draft) => {
    draft.memory.managerReports.unshift(report);
    draft.memory.managerReports = draft.memory.managerReports.slice(0, 30);
  });

  return report;
}

function getSystemStatus() {
  const store = loadStore();
  return {
    timezone: getAiSettings().timezone,
    todayLocalDate: getDateInTimezone(new Date(), getAiSettings().timezone),
    serverTimeIso: new Date().toISOString(),
    serverTimeLocal: new Intl.DateTimeFormat('ko-KR', {
      timeZone: getAiSettings().timezone,
      dateStyle: 'full',
      timeStyle: 'long',
    }).format(new Date()),
    aiConfigured: isAiConfigured(),
    ai: getAiSettings(),
    latestManagerReport: store.memory.managerReports[0] || null,
  };
}

module.exports = {
  getLatestManagerReport,
  runManagerReview,
  getSystemStatus,
};

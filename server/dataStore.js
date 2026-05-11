const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILES = {
  portfolio: path.join(DATA_DIR, 'portfolio.json'),
  chat: path.join(DATA_DIR, 'chat.json'),
  memory: path.join(DATA_DIR, 'memory.json'),
  profile: path.join(DATA_DIR, 'profile.json'),
};

const CATEGORIES = ['deposit', 'installment', 'stock', 'fund', 'pension'];

let mutationQueue = Promise.resolve();

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function createDefaultPortfolio() {
  return {
    holdings: [],
    snapshots: [],
  };
}

function createDefaultChat() {
  return {
    threads: [],
    messagesByThread: {},
  };
}

function createDefaultMemory() {
  return {
    threadSummaries: [],
    longTermMemories: [],
    managerReports: [],
    scheduledTasks: [],
  };
}

function createDefaultProfile() {
  return {
    userProfile: {
      displayName: '',
      investorType: '',
      investmentGoal: '',
      riskTolerance: '',
      timeHorizon: '',
      liquidityNeeds: '',
      responseStyle: '',
      focusAreas: '',
      notes: '',
    },
    aiProfile: {
      summary: '',
      inferredTraits: [],
      preferences: [],
      concerns: [],
      updatedAt: null,
      sourceMemoryIds: [],
    },
    metadata: {
      lastManualUpdateAt: null,
      lastAiRefreshAt: null,
    },
  };
}

function readJson(filePath, fallbackFactory) {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallbackFactory();
  }
}

function writeJson(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function normalizeHoldingDetails(details) {
  if (!details || typeof details !== 'object') return null;
  return {
    account: String(details.account || '').slice(0, 120),
    currency: String(details.currency || '').slice(0, 16),
    ticker: String(details.ticker || '').slice(0, 40),
    market: String(details.market || '').slice(0, 24),
    quantity: Number.isFinite(Number(details.quantity)) ? Number(details.quantity) : null,
    averagePrice: Number.isFinite(Number(details.averagePrice)) ? Number(details.averagePrice) : null,
    currentPrice: Number.isFinite(Number(details.currentPrice)) ? Number(details.currentPrice) : null,
    lastQuote: Number.isFinite(Number(details.lastQuote)) ? Number(details.lastQuote) : null,
    lastQuoteAt: details.lastQuoteAt ? String(details.lastQuoteAt).slice(0, 40) : null,
    quoteSource: String(details.quoteSource || '').slice(0, 80),
    nativeAmount: Number.isFinite(Number(details.nativeAmount)) ? Number(details.nativeAmount) : null,
    fxRate: Number.isFinite(Number(details.fxRate)) ? Number(details.fxRate) : null,
    summary: String(details.summary || '').slice(0, 240),
    orders: Array.isArray(details.orders) ? details.orders.map((item) => String(item || '').slice(0, 160)).filter(Boolean).slice(0, 6) : [],
  };
}

function normalizePortfolio(data) {
  const portfolio = data && typeof data === 'object' ? data : createDefaultPortfolio();
  if (!Array.isArray(portfolio.holdings)) portfolio.holdings = [];
  if (!Array.isArray(portfolio.snapshots)) portfolio.snapshots = [];

  portfolio.holdings = portfolio.holdings.map((item) => ({
    id: String(item.id || ''),
    name: String(item.name || '이름 없음').slice(0, 200),
    category: CATEGORIES.includes(item.category) ? item.category : 'deposit',
    amount: Math.max(0, Math.round(Number(item.amount) || 0)),
    details: normalizeHoldingDetails(item.details),
  }));

  portfolio.snapshots = portfolio.snapshots
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      date: String(item.date || ''),
      total: Math.max(0, Math.round(Number(item.total) || 0)),
      byCategory: Object.fromEntries(
        CATEGORIES.map((category) => [
          category,
          Math.max(0, Math.round(Number(item.byCategory?.[category]) || 0)),
        ])
      ),
    }))
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date))
    .sort((a, b) => a.date.localeCompare(b.date));

  return portfolio;
}

function normalizeChat(data) {
  const chat = data && typeof data === 'object' ? data : createDefaultChat();
  if (!Array.isArray(chat.threads)) chat.threads = [];
  if (!chat.messagesByThread || typeof chat.messagesByThread !== 'object') {
    chat.messagesByThread = {};
  }

  chat.threads = chat.threads
    .filter((thread) => thread && typeof thread === 'object' && thread.id)
    .map((thread) => ({
      id: String(thread.id),
      title: String(thread.title || '새 대화').slice(0, 120),
      createdAt: thread.createdAt || null,
      updatedAt: thread.updatedAt || null,
      summary: String(thread.summary || ''),
      messageCount: Math.max(0, Math.round(Number(thread.messageCount) || 0)),
      archived: Boolean(thread.archived),
    }))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  const nextMessages = {};
  for (const thread of chat.threads) {
    const rows = Array.isArray(chat.messagesByThread[thread.id])
      ? chat.messagesByThread[thread.id]
      : [];

    nextMessages[thread.id] = rows
      .filter((message) => message && typeof message === 'object' && message.id && message.role)
      .map((message) => ({
        id: String(message.id),
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.content || ''),
        createdAt: message.createdAt || null,
        model: message.model || null,
        metadata: message.metadata && typeof message.metadata === 'object' ? message.metadata : {},
      }));
  }

  chat.messagesByThread = nextMessages;
  return chat;
}

function normalizeMemory(data) {
  const memory = data && typeof data === 'object' ? data : createDefaultMemory();
  if (!Array.isArray(memory.threadSummaries)) memory.threadSummaries = [];
  if (!Array.isArray(memory.longTermMemories)) memory.longTermMemories = [];
  if (!Array.isArray(memory.managerReports)) memory.managerReports = [];
  if (!Array.isArray(memory.scheduledTasks)) memory.scheduledTasks = [];

  memory.threadSummaries = memory.threadSummaries
    .filter((item) => item && item.id && item.threadId)
    .map((item) => ({
      id: String(item.id),
      threadId: String(item.threadId),
      summary: String(item.summary || ''),
      importantFacts: Array.isArray(item.importantFacts) ? item.importantFacts.map(String) : [],
      unresolvedQuestions: Array.isArray(item.unresolvedQuestions)
        ? item.unresolvedQuestions.map(String)
        : [],
      personaHints: Array.isArray(item.personaHints) ? item.personaHints.map(String) : [],
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null,
      sourceMessageIds: Array.isArray(item.sourceMessageIds) ? item.sourceMessageIds.map(String) : [],
    }))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  memory.longTermMemories = memory.longTermMemories
    .filter((item) => item && item.id && item.text)
    .map((item) => ({
      id: String(item.id),
      kind: String(item.kind || 'insight'),
      text: String(item.text || ''),
      confidence: String(item.confidence || 'ai'),
      sourceThreadId: item.sourceThreadId ? String(item.sourceThreadId) : null,
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null,
      metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {},
    }))
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));

  memory.managerReports = memory.managerReports
    .filter((item) => item && item.id && item.summary)
    .map((item) => ({
      id: String(item.id),
      targetDate: String(item.targetDate || ''),
      createdAt: item.createdAt || null,
      trigger: String(item.trigger || 'manual'),
      model: String(item.model || ''),
      summary: String(item.summary || ''),
      dailyObjective: String(item.dailyObjective || ''),
      actionItems: Array.isArray(item.actionItems) ? item.actionItems.map(String) : [],
      riskChecks: Array.isArray(item.riskChecks) ? item.riskChecks.map(String) : [],
      allocationNotes: Array.isArray(item.allocationNotes) ? item.allocationNotes.map(String) : [],
      conversationInsights: Array.isArray(item.conversationInsights)
        ? item.conversationInsights.map(String)
        : [],
      profileUpdates: Array.isArray(item.profileUpdates) ? item.profileUpdates.map(String) : [],
    }))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  memory.scheduledTasks = memory.scheduledTasks
    .filter((item) => item && item.id && item.title)
    .map((item) => ({
      id: String(item.id),
      title: String(item.title || '').slice(0, 120),
      description: String(item.description || '').slice(0, 400),
      taskType: String(item.taskType || 'custom'),
      cronExpression: String(item.cronExpression || ''),
      timezone: String(item.timezone || 'Asia/Seoul'),
      nextRunLabel: String(item.nextRunLabel || ''),
      prompt: String(item.prompt || '').slice(0, 500),
      indicatorName: String(item.indicatorName || '').slice(0, 120),
      enabled: Boolean(item.enabled),
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null,
      lastRunAt: item.lastRunAt || null,
      lastRunStatus: String(item.lastRunStatus || ''),
      lastRunMessage: String(item.lastRunMessage || '').slice(0, 300),
      source: String(item.source || 'manual'),
    }))
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));

  return memory;
}

function normalizeProfile(data) {
  const profile = data && typeof data === 'object' ? data : createDefaultProfile();
  const defaults = createDefaultProfile();

  profile.userProfile = {
    ...defaults.userProfile,
    ...(profile.userProfile && typeof profile.userProfile === 'object' ? profile.userProfile : {}),
  };

  profile.aiProfile = {
    ...defaults.aiProfile,
    ...(profile.aiProfile && typeof profile.aiProfile === 'object' ? profile.aiProfile : {}),
  };

  profile.metadata = {
    ...defaults.metadata,
    ...(profile.metadata && typeof profile.metadata === 'object' ? profile.metadata : {}),
  };

  for (const key of Object.keys(profile.userProfile)) {
    profile.userProfile[key] = String(profile.userProfile[key] || '');
  }

  profile.aiProfile.summary = String(profile.aiProfile.summary || '');
  profile.aiProfile.inferredTraits = Array.isArray(profile.aiProfile.inferredTraits)
    ? profile.aiProfile.inferredTraits.map(String)
    : [];
  profile.aiProfile.preferences = Array.isArray(profile.aiProfile.preferences)
    ? profile.aiProfile.preferences.map(String)
    : [];
  profile.aiProfile.concerns = Array.isArray(profile.aiProfile.concerns)
    ? profile.aiProfile.concerns.map(String)
    : [];
  profile.aiProfile.updatedAt = profile.aiProfile.updatedAt || null;
  profile.aiProfile.sourceMemoryIds = Array.isArray(profile.aiProfile.sourceMemoryIds)
    ? profile.aiProfile.sourceMemoryIds.map(String)
    : [];

  profile.metadata.lastManualUpdateAt = profile.metadata.lastManualUpdateAt || null;
  profile.metadata.lastAiRefreshAt = profile.metadata.lastAiRefreshAt || null;

  return profile;
}

function loadStore() {
  return {
    portfolio: normalizePortfolio(readJson(FILES.portfolio, createDefaultPortfolio)),
    chat: normalizeChat(readJson(FILES.chat, createDefaultChat)),
    memory: normalizeMemory(readJson(FILES.memory, createDefaultMemory)),
    profile: normalizeProfile(readJson(FILES.profile, createDefaultProfile)),
  };
}

function saveStore(store) {
  writeJson(FILES.portfolio, normalizePortfolio(store.portfolio));
  writeJson(FILES.chat, normalizeChat(store.chat));
  writeJson(FILES.memory, normalizeMemory(store.memory));
  writeJson(FILES.profile, normalizeProfile(store.profile));
}

async function mutateStore(mutator) {
  const run = async () => {
    const store = loadStore();
    const result = await mutator(store);
    saveStore(store);
    return result === undefined ? store : result;
  };

  const next = mutationQueue.then(run, run);
  mutationQueue = next.catch(() => undefined);
  return next;
}

module.exports = {
  CATEGORIES,
  FILES,
  createDefaultPortfolio,
  createDefaultChat,
  createDefaultMemory,
  createDefaultProfile,
  loadStore,
  saveStore,
  mutateStore,
  normalizePortfolio,
  normalizeChat,
  normalizeMemory,
  normalizeProfile,
};

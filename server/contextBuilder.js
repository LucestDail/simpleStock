const { CATEGORIES } = require('./dataStore');

function formatCurrency(amount) {
  return new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency: 'KRW',
    maximumFractionDigits: 0,
  }).format(Number(amount) || 0);
}

function getCategoryShares(holdings) {
  const byCategory = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  let total = 0;

  for (const item of holdings || []) {
    const category = CATEGORIES.includes(item.category) ? item.category : 'deposit';
    const amount = Math.max(0, Math.round(Number(item.amount) || 0));
    byCategory[category] += amount;
    total += amount;
  }

  return {
    total,
    byCategory,
    shares: CATEGORIES.map((category) => ({
      category,
      amount: byCategory[category],
      pct: total > 0 ? Math.round((byCategory[category] / total) * 1000) / 10 : 0,
    })),
  };
}

function buildPortfolioContext(portfolio) {
  const { total, shares } = getCategoryShares(portfolio.holdings || []);
  const latestSnapshot = [...(portfolio.snapshots || [])]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 3);

  return {
    total,
    totalLabel: formatCurrency(total),
    holdings: portfolio.holdings || [],
    categoryShares: shares,
    latestSnapshots: latestSnapshot,
  };
}

function buildProfileContext(profile) {
  return {
    userProfile: profile.userProfile || {},
    aiProfile: profile.aiProfile || {},
  };
}

function getThreadMessages(chat, threadId) {
  return Array.isArray(chat.messagesByThread?.[threadId]) ? chat.messagesByThread[threadId] : [];
}

function getRecentMessages(messages, limit = 14) {
  return [...messages].slice(-limit);
}

function formatMessagesForPrompt(messages) {
  return messages
    .map((message) => `[${message.role}] ${message.content}`)
    .join('\n');
}

function getThreadSummary(memory, threadId) {
  return (memory.threadSummaries || []).find((item) => item.threadId === threadId) || null;
}

function getRelevantMemories(memory, limit = 8) {
  return [...(memory.longTermMemories || [])].slice(0, limit);
}

function buildMemoryContext(memory, threadId) {
  return {
    threadSummary: getThreadSummary(memory, threadId),
    recentLongTermMemories: getRelevantMemories(memory),
    latestManagerReports: [...(memory.managerReports || [])].slice(0, 3),
  };
}

function buildConversationContext({ portfolio, profile, memory, chat, threadId }) {
  const messages = getThreadMessages(chat, threadId);
  return {
    portfolio: buildPortfolioContext(portfolio),
    profile: buildProfileContext(profile),
    memory: buildMemoryContext(memory, threadId),
    messages,
    recentMessages: getRecentMessages(messages),
    recentTranscript: formatMessagesForPrompt(getRecentMessages(messages)),
  };
}

module.exports = {
  buildConversationContext,
  buildPortfolioContext,
  buildProfileContext,
  buildMemoryContext,
  getCategoryShares,
  getThreadMessages,
  getRecentMessages,
  formatMessagesForPrompt,
  formatCurrency,
};

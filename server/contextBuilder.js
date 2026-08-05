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

function getRecentMessages(messages, limit = 8) {
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

function buildSupervisorContext(fullContext) {
  const portfolio = fullContext.portfolio || {};
  const holdings = (portfolio.holdings || []).map((h) => ({
    id: h.id,
    name: h.name,
    category: h.category,
    amount: h.amount,
    ticker: h.details?.ticker || '',
    currency: h.details?.currency || '',
    market: h.details?.market || '',
    quantity: h.details?.quantity ?? null,
  }));
  const messages = (fullContext.recentMessages || []).slice(-6).map((m) => ({
    role: m.role,
    content: String(m.content || '').slice(0, 300),
  }));
  return {
    portfolio: {
      total: portfolio.total,
      totalLabel: portfolio.totalLabel,
      holdings,
      categoryShares: portfolio.categoryShares,
    },
    profile: fullContext.profile,
    memory: {
      threadSummary: fullContext.memory?.threadSummary || null,
    },
    recentMessages: messages,
  };
}

function extractContextKeywords(userInput) {
  const text = String(userInput || '');
  const tokens = text
    .split(/[\s,，·]+/)
    .map((part) => part.replace(/[^\p{L}\p{N}]/gu, '').trim())
    .filter((part) => part.length >= 2);
  const extras = [];
  if (/예수금|달러|원화|통장|계좌|적금|예금|펀드|irp|연금/i.test(text)) {
    extras.push('예수금', '예금', '통장', '계좌');
  }
  return [...new Set([...tokens, ...extras])].slice(0, 12);
}

function holdingMatchesKeywords(holding, keywords) {
  if (!keywords.length) return true;
  const haystack = [
    holding.name,
    holding.id,
    holding.category,
    holding.details?.ticker,
    holding.details?.account,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return keywords.some((keyword) => haystack.includes(String(keyword).toLowerCase()));
}

/** mutation supervisor용 — holdings·메시지 축소, profile/memory 제외 */
function buildSlimSupervisorContext(fullContext, userInput = '') {
  const portfolio = fullContext.portfolio || {};
  const keywords = extractContextKeywords(userInput);
  let holdings = (portfolio.holdings || []).map((h) => ({
    id: h.id,
    name: h.name,
    category: h.category,
    amount: h.amount,
    ticker: h.details?.ticker || '',
    currency: h.details?.currency || '',
    quantity: h.details?.quantity ?? null,
  }));

  if (keywords.length) {
    const matched = holdings.filter((h) => holdingMatchesKeywords(h, keywords));
    if (matched.length) holdings = matched;
  }
  if (holdings.length > 18) {
    holdings = holdings.slice(0, 18);
  }

  const messages = (fullContext.recentMessages || []).slice(-2).map((m) => ({
    role: m.role,
    content: String(m.content || '').slice(0, 120),
  }));

  return {
    portfolio: {
      total: portfolio.total,
      totalLabel: portfolio.totalLabel,
      holdings,
      categoryShares: portfolio.categoryShares,
    },
    recentMessages: messages,
  };
}

module.exports = {
  buildConversationContext,
  buildSupervisorContext,
  buildSlimSupervisorContext,
  extractContextKeywords,
  buildPortfolioContext,
  buildProfileContext,
  buildMemoryContext,
  getCategoryShares,
  getThreadMessages,
  getRecentMessages,
  formatMessagesForPrompt,
  formatCurrency,
};

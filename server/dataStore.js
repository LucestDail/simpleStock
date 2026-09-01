const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILES = {
  memory: path.join(DATA_DIR, 'memory.json'),
  watchlist: path.join(DATA_DIR, 'watchlist.json'),
};

// v3 종합 트래커: 테마 그룹으로 묶은 관심종목(개인 자산/금액 개념 없음).
const WATCHLIST_MARKETS = ['KR', 'US', 'ETF'];

const CATEGORIES = ['deposit', 'installment', 'stock', 'fund', 'pension'];

let mutationQueue = Promise.resolve();

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function createDefaultMemory() {
  return {
    threadSummaries: [],
    longTermMemories: [],
    managerReports: [],
    scheduledTasks: [],
    market: createDefaultMarketState(),
    tickerLookup: createDefaultTickerLookup(),
  };
}

function createDefaultTickerLookup() {
  return {
    byName: {},
  };
}

function createDefaultMarketState() {
  return {
    provider: 'yahoo-finance',
    refreshStatus: 'idle',
    lastRefreshAt: null,
    lastSuccessAt: null,
    lastError: '',
    stats: {
      krQuoteAttempts: 0,
      krQuoteFailures: 0,
      usQuoteAttempts: 0,
      usQuoteFailures: 0,
      lastKrFailureAt: null,
      lastKrFailureSymbol: '',
    },
    trackedTickers: [],
    quotes: {},
    fx: {
      USDKRW: {
        pair: 'USDKRW',
        rate: null,
        previousClose: null,
        change: null,
        changePct: null,
        updatedAt: null,
        source: '',
      },
    },
    sessions: {
      kr: {
        market: 'KRX',
        state: 'closed',
      },
      us: {
        market: 'US',
        state: 'closed',
      },
    },
  };
}

function createDefaultWatchlist() {
  return { groups: [] };
}

function normalizeWatchlistTicker(item) {
  if (!item || typeof item !== 'object') return null;
  const symbol = String(item.symbol || '').trim().toUpperCase().slice(0, 40);
  if (!symbol) return null;
  const rawMarket = String(item.market || '').trim().toUpperCase();
  const currency = String(item.currency || '').trim().toUpperCase().slice(0, 16);
  let market = WATCHLIST_MARKETS.includes(rawMarket) ? rawMarket : '';
  if (!market) market = currency === 'USD' ? 'US' : 'KR';
  return {
    symbol,
    name: String(item.name || symbol).slice(0, 120),
    market,
    currency: currency || (market === 'US' ? 'USD' : 'KRW'),
    addedAt: item.addedAt || null,
  };
}

function normalizeWatchlist(data) {
  const source = data && typeof data === 'object' ? data : createDefaultWatchlist();
  const groups = Array.isArray(source.groups) ? source.groups : [];
  const seenGroupIds = new Set();
  const normalized = groups
    .filter((g) => g && typeof g === 'object')
    .map((g, idx) => {
      let id = String(g.id || '').trim();
      if (!id || seenGroupIds.has(id)) id = `grp-${idx}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
      seenGroupIds.add(id);
      const seenSymbols = new Set();
      const tickers = (Array.isArray(g.tickers) ? g.tickers : [])
        .map(normalizeWatchlistTicker)
        .filter(Boolean)
        .filter((t) => {
          const key = `${t.market}:${t.symbol}`;
          if (seenSymbols.has(key)) return false;
          seenSymbols.add(key);
          return true;
        })
        .slice(0, 200);
      return {
        id,
        name: String(g.name || '관심그룹').slice(0, 80),
        order: Number.isFinite(Number(g.order)) ? Number(g.order) : idx,
        tickers,
      };
    });
  normalized.sort((a, b) => a.order - b.order);
  normalized.forEach((g, idx) => {
    g.order = idx;
  });
  return { groups: normalized };
}

function readJson(filePath, fallbackFactory) {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    try {
      if (fs.existsSync(filePath)) {
        const corruptPath = `${filePath}.corrupt-${Date.now()}.bak`;
        fs.copyFileSync(filePath, corruptPath);
      }
    } catch {
      // ignore backup failure
    }
    return fallbackFactory();
  }
}

function writeJson(filePath, data) {
  ensureDataDir();
  const payload = JSON.stringify(data, null, 2);
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, payload, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // ignore
    }
    throw error;
  }
}

function normalizeMemory(data) {
  const memory = data && typeof data === 'object' ? data : createDefaultMemory();
  if (!Array.isArray(memory.threadSummaries)) memory.threadSummaries = [];
  if (!Array.isArray(memory.longTermMemories)) memory.longTermMemories = [];
  if (!Array.isArray(memory.managerReports)) memory.managerReports = [];
  if (!Array.isArray(memory.scheduledTasks)) memory.scheduledTasks = [];
  memory.market = normalizeMarketState(memory.market);
  memory.tickerLookup = normalizeTickerLookup(memory.tickerLookup);

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

  if (!memory.tokenUsageByMonth || typeof memory.tokenUsageByMonth !== 'object') {
    memory.tokenUsageByMonth = {};
  }
  memory.lastImportUndo =
    memory.lastImportUndo && typeof memory.lastImportUndo === 'object'
      ? memory.lastImportUndo
      : null;

  return memory;
}

function normalizeTickerLookup(data) {
  const lookup = data && typeof data === 'object' ? data : createDefaultTickerLookup();
  const byName = lookup.byName && typeof lookup.byName === 'object' ? lookup.byName : {};
  const cleaned = {};
  for (const [key, value] of Object.entries(byName)) {
    if (!key || !value || typeof value !== 'object') continue;
    const ticker = String(value.ticker || '').trim();
    if (!ticker) continue;
    cleaned[String(key).trim()] = {
      ticker,
      market: String(value.market || '').trim() || null,
      currency: String(value.currency || '').trim() || null,
      shortName: String(value.shortName || '').trim() || null,
      source: String(value.source || '').trim() || null,
      cachedAt: value.cachedAt || null,
    };
  }
  return { byName: cleaned };
}

function normalizeMarketState(data) {
  const market = data && typeof data === 'object' ? data : createDefaultMarketState();
  const defaults = createDefaultMarketState();

  market.provider = String(market.provider || defaults.provider);
  market.refreshStatus = String(market.refreshStatus || defaults.refreshStatus);
  market.lastRefreshAt = market.lastRefreshAt || null;
  market.lastSuccessAt = market.lastSuccessAt || null;
  market.lastError = String(market.lastError || '').slice(0, 300);
  const defaultStats = defaults.stats || {};
  const rawStats = market.stats && typeof market.stats === 'object' ? market.stats : {};
  market.stats = {
    krQuoteAttempts: Math.max(0, Number(rawStats.krQuoteAttempts) || 0),
    krQuoteFailures: Math.max(0, Number(rawStats.krQuoteFailures) || 0),
    usQuoteAttempts: Math.max(0, Number(rawStats.usQuoteAttempts) || 0),
    usQuoteFailures: Math.max(0, Number(rawStats.usQuoteFailures) || 0),
    lastKrFailureAt: rawStats.lastKrFailureAt || defaultStats.lastKrFailureAt || null,
    lastKrFailureSymbol: String(rawStats.lastKrFailureSymbol || '').slice(0, 40),
  };
  market.trackedTickers = Array.isArray(market.trackedTickers)
    ? market.trackedTickers
        .filter((item) => item && item.symbol)
        .map((item) => ({
          symbol: String(item.symbol || '').slice(0, 40),
          name: String(item.name || '').slice(0, 120),
          market: String(item.market || '').slice(0, 24),
          currency: String(item.currency || '').slice(0, 16),
          holdingIds: Array.isArray(item.holdingIds) ? item.holdingIds.map(String).slice(0, 30) : [],
        }))
    : [];

  const rawQuotes = market.quotes && typeof market.quotes === 'object' ? market.quotes : {};
  market.quotes = Object.fromEntries(
    Object.entries(rawQuotes)
      .filter(([symbol]) => symbol)
      .map(([symbol, quote]) => [
        String(symbol).slice(0, 40),
        {
          symbol: String(quote?.symbol || symbol).slice(0, 40),
          shortName: String(quote?.shortName || '').slice(0, 120),
          market: String(quote?.market || '').slice(0, 24),
          currency: String(quote?.currency || '').slice(0, 16),
          price: Number.isFinite(Number(quote?.price)) ? Number(quote.price) : null,
          previousClose: Number.isFinite(Number(quote?.previousClose)) ? Number(quote.previousClose) : null,
          change: Number.isFinite(Number(quote?.change)) ? Number(quote.change) : null,
          changePct: Number.isFinite(Number(quote?.changePct)) ? Number(quote.changePct) : null,
          marketState: String(quote?.marketState || '').slice(0, 24),
          updatedAt: quote?.updatedAt || null,
          source: String(quote?.source || '').slice(0, 80),
        },
      ])
  );

  const rawFx = market.fx && typeof market.fx === 'object' ? market.fx : {};
  market.fx = {
    USDKRW: {
      ...defaults.fx.USDKRW,
      ...(rawFx.USDKRW && typeof rawFx.USDKRW === 'object' ? rawFx.USDKRW : {}),
      pair: 'USDKRW',
      rate: Number.isFinite(Number(rawFx.USDKRW?.rate)) ? Number(rawFx.USDKRW.rate) : null,
      previousClose: Number.isFinite(Number(rawFx.USDKRW?.previousClose))
        ? Number(rawFx.USDKRW.previousClose)
        : null,
      change: Number.isFinite(Number(rawFx.USDKRW?.change)) ? Number(rawFx.USDKRW.change) : null,
      changePct: Number.isFinite(Number(rawFx.USDKRW?.changePct)) ? Number(rawFx.USDKRW.changePct) : null,
      updatedAt: rawFx.USDKRW?.updatedAt || null,
      source: String(rawFx.USDKRW?.source || '').slice(0, 80),
    },
  };

  const rawSessions = market.sessions && typeof market.sessions === 'object' ? market.sessions : {};
  market.sessions = {
    kr: {
      ...defaults.sessions.kr,
      ...(rawSessions.kr && typeof rawSessions.kr === 'object' ? rawSessions.kr : {}),
      market: String(rawSessions.kr?.market || defaults.sessions.kr.market).slice(0, 24),
      state: String(rawSessions.kr?.state || defaults.sessions.kr.state).slice(0, 24),
    },
    us: {
      ...defaults.sessions.us,
      ...(rawSessions.us && typeof rawSessions.us === 'object' ? rawSessions.us : {}),
      market: String(rawSessions.us?.market || defaults.sessions.us.market).slice(0, 24),
      state: String(rawSessions.us?.state || defaults.sessions.us.state).slice(0, 24),
    },
  };

  return market;
}

// v3 종합 트래커: 개인 데이터(portfolio/chat/profile) 로딩 제거. memory(시세캐시·브리핑·예약)+watchlist 만.
function loadStore() {
  return {
    memory: normalizeMemory(readJson(FILES.memory, createDefaultMemory)),
    watchlist: normalizeWatchlist(readJson(FILES.watchlist, createDefaultWatchlist)),
  };
}

function saveStore(store) {
  writeJson(FILES.memory, normalizeMemory(store.memory));
  writeJson(FILES.watchlist, normalizeWatchlist(store.watchlist));
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
  readJson,
  writeJson,
  createDefaultMemory,
  createDefaultMarketState,
  createDefaultWatchlist,
  loadStore,
  saveStore,
  mutateStore,
  normalizeMemory,
  normalizeMarketState,
  normalizeWatchlist,
  WATCHLIST_MARKETS,
};

// v3 종합 트래커 — 범용 시장 브리핑.
// 개인 포트폴리오/프로필 대신 watchlist(테마 그룹)와 시세 스냅샷을 근거로 시장 브리핑을 생성한다.
// 저장은 기존 memory.managerReports 를 재사용(프론트/스키마 호환).

const crypto = require('crypto');
const { loadStore, mutateStore } = require('./dataStore');
const tossPortfolio = require('./tossPortfolio');
const { getDashboardSettings } = require('./settingsService');
const { generateStructuredOutput, getAiSettings, isAiConfigured, getLastServedBy } = require('./aiService');
const {
  getTokenUsageSummary,
  AI_PRESETS,
  loadSettings,
  getEffectiveMarketProviders,
} = require('./settingsService');
const { getMemoryState } = require('./memoryService');
const { getDateInTimezone } = require('./time');
const { broadcast } = require('./realtimeService');
const { getAiLatencySnapshot } = require('./aiLatencyMetrics');
const { logInfo , logWarn } = require('./logger');
// watchlistService 는 순환 의존(watchlist→market→payload→manager) 회피를 위해 지연 require.

const BRIEFING_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '오늘 시장 전반 한 문단 요약(한국어)' },
    marketOutlook: { type: 'string', description: '관전 포인트/전망 한 문단' },
    tickerSignals: { type: 'array', items: { type: 'string' }, description: '관심종목별 주목 시그널(등락·특이사항)' },
    riskChecks: { type: 'array', items: { type: 'string' }, description: '리스크·체크할 이벤트' },
    themeNotes: { type: 'array', items: { type: 'string' }, description: '테마/섹터 코멘트' },
  },
  required: ['summary'],
};

function formatQuote(ticker) {
  const q = ticker.quote;
  if (!q || q.price == null) return `${ticker.name}(${ticker.symbol}/${ticker.market}) 시세대기`;
  const pct = q.changePct != null ? `${q.changePct > 0 ? '+' : ''}${q.changePct.toFixed(2)}%` : '';
  return `${ticker.name}(${ticker.symbol}/${ticker.market}) ${q.price}${q.currency || ''} ${pct}`.trim();
}

function buildWatchlistContext(watchlist) {
  const lines = [];
  for (const group of watchlist.groups || []) {
    if (!group.tickers || group.tickers.length === 0) continue;
    lines.push(`■ ${group.name}`);
    for (const ticker of group.tickers) {
      lines.push(`  - ${formatQuote(ticker)}`);
    }
  }
  const fx = watchlist.fx?.USDKRW;
  if (fx && fx.rate != null) {
    lines.push(`■ 환율: USD/KRW ${fx.rate}`);
  }
  return lines.join('\n');
}

function countTickers(watchlist) {
  return (watchlist.groups || []).reduce((sum, g) => sum + (g.tickers?.length || 0), 0);
}

function getLatestManagerReport() {
  const store = loadStore();
  return store.memory.managerReports[0] || null;
}

async function runManagerReview(trigger = 'manual', options = {}) {
  if (!isAiConfigured()) {
    throw new Error('GEMINI_API_KEY가 설정되지 않아 AI 기능이 비활성화되어 있습니다.');
  }

  const { getWatchlistState } = require('./watchlistService');
  const watchlist = getWatchlistState();
  if (countTickers(watchlist) === 0) {
    throw new Error('관심종목이 없어 시장 브리핑을 생성할 수 없습니다. 종목을 먼저 추가하세요.');
  }

  const extraContext =
    typeof options.extraContext === 'string'
      ? options.extraContext
      : typeof options.scheduledTaskPrompt === 'string'
        ? options.scheduledTaskPrompt
        : '';

  // 토스 보유·사용자 지시를 함께 넣는다. **실패해도 브리핑은 만든다**(자산 없는 브리핑으로).
  let holdings = null;
  try {
    if (tossPortfolio.isEnabled()) holdings = await tossPortfolio.getHoldings();
  } catch (e) {
    logWarn('briefing.holdings_unavailable', { kind: e?.kind || 'unknown', message: e?.message });
  }
  const userInstruction = (getDashboardSettings().briefingPrompt || '').trim();

  const ai = getAiSettings();
  const today = getDateInTimezone(new Date(), ai.timezone);
  const watchlistContext = buildWatchlistContext(watchlist);

  /**
   * 🔴 2026-09-21: 이 프롬프트가 **제품과 정면으로 어긋나 있었다.**
   *    v3 에서 개인 자산을 걷어냈을 때 *"개인 자산 정보는 없습니다 · 보유/수익률 표현은
   *    절대 쓰지 마세요"* 라고 적었는데, 이제 **토스 실계좌 보유가 들어온다.**
   *    그대로 두면 모델이 **자산을 보고도 못 본 척**한다 — 오늘 아침 `upsertHolding`
   *    죽은 지시서의 **거울상**이다(그건 없는 걸 있다고 했고, 이건 있는 걸 없다고 했다).
   * ⚠️ 보유가 없을 때는 종전 문장을 그대로 쓴다(없는 걸 있다고 말하게 하지 않는다).
   */
  const hasHoldings = Boolean(holdings?.items?.length);
  const systemPrompt = [
    '당신은 한국/미국 주식·ETF를 추적하는 종합 시장 애널리스트입니다.',
    hasHoldings
      ? '사용자의 **실제 보유 종목과 평가손익**이 함께 제공됩니다. 보유 비중·손익·당일 변동을 근거로 삼으세요.'
      : '개인 자산·보유수량·매수단가 정보는 없습니다. 오직 관심종목(watchlist)과 현재 시세만 근거로 삼습니다.',
    hasHoldings
      ? '다만 **매수/매도를 지시하지 마세요.** 관찰과 판단 근거까지만 쓰고, 실행 결정은 사람이 합니다.'
      : '보유/수익률/매매지시 같은 개인 자산 표현은 절대 쓰지 마세요. 종목 추적·시장 관찰 관점으로만 서술합니다.',
    '반드시 한국어로, 제공된 시세 데이터에 근거해 간결하게 작성하세요. 근거 없는 수치를 지어내지 마세요.',
    // 사용자가 설정 화면에서 넣은 지시 — **없으면 아무것도 붙이지 않는다**
    userInstruction ? `추가 지시(사용자): ${userInstruction}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const holdingsContext = hasHoldings
    ? [
        '',
        '## 실제 보유 (토스증권)',
        `평가금액(원화환산): ${holdings.summary?.value?.krw ?? '-'} · 평가손익률: ${holdings.summary?.profitRate ?? '-'}%`,
        `당일 손익률: ${holdings.summary?.dailyRate ?? '-'}%`,
        ...holdings.items.map(
          (h) =>
            `- ${h.name}(${h.symbol}/${h.market}) 수량 ${h.quantity} · 평단 ${h.avgPrice} · 현재 ${h.lastPrice} · ` +
            `평가손익 ${h.profitRate}% · 당일 ${h.dailyRate}%`
        ),
      ].join('\n')
    : '';

  const userPrompt = [
    `기준일: ${today}`,
    holdingsContext,
    '',
    '# 관심종목 현황(테마 그룹별 현재 시세)',
    watchlistContext || '(등록된 종목 없음)',
    extraContext ? `\n# 추가 지시\n${extraContext}` : '',
    '',
    '위 관심종목을 바탕으로 오늘의 시장 브리핑을 작성하세요.',
    '반드시 아래 JSON 형식으로만, 키 이름을 정확히 그대로 사용해 한국어로 답하세요(다른 키 금지):',
    '{"summary":"시장 요약 한 문단","marketOutlook":"관전 포인트 한 문단","tickerSignals":["관심종목별 시그널", "..."],"riskChecks":["리스크 체크", "..."],"themeNotes":["테마/섹터 코멘트", "..."]}',
  ].join('\n');

  const fallback = { summary: '', marketOutlook: '', tickerSignals: [], riskChecks: [], themeNotes: [] };
  const result = await generateStructuredOutput(
    { systemPrompt, userPrompt, schema: BRIEFING_SCHEMA, useGoogleSearch: false, logLabel: 'market_briefing' },
    fallback
  );

  // 게이트웨이 경유 모델이 responseSchema 키를 무시하고 다른 키(예: "브리핑")로 답하는 경우 방어.
  if (!result.summary) {
    const firstStr = Object.values(result).find((v) => typeof v === 'string' && v.trim());
    if (firstStr) result.summary = firstStr;
  }

  const report = {
    id: crypto.randomUUID(),
    targetDate: today,
    createdAt: new Date().toISOString(),
    trigger,
    // 🔴 `ai.model` 은 **우리가 요청한 이름**이다. 게이트웨이가 실제로 쓴 것을 알면 그걸 쓴다.
    //    모르면 요청 이름을 남기되 화면이 구분할 수 있게 servedBy 를 함께 준다(없으면 null).
    model: ai.model,
    servedBy: getLastServedBy(),
    summary: String(result.summary || '').slice(0, 4000),
    dailyObjective: String(result.marketOutlook || ''),
    actionItems: Array.isArray(result.tickerSignals) ? result.tickerSignals.map(String) : [],
    riskChecks: Array.isArray(result.riskChecks) ? result.riskChecks.map(String) : [],
    allocationNotes: Array.isArray(result.themeNotes) ? result.themeNotes.map(String) : [],
    conversationInsights: [],
    profileUpdates: [],
  };

  await mutateStore((draft) => {
    draft.memory.managerReports.unshift(report);
    draft.memory.managerReports = draft.memory.managerReports.slice(0, 30);
  });

  const nextStore = loadStore();
  broadcast('manager.report.created', {
    manager: {
      latestReport: nextStore.memory.managerReports[0] || report,
      history: nextStore.memory.managerReports.slice(0, 10),
    },
    system: getSystemStatus(),
  });
  broadcast('activity.created', {
    activity: {
      type: 'briefing',
      title: '시장 브리핑 갱신',
      description: `${report.targetDate || '오늘'} 기준 시장 브리핑이 생성되었습니다.`,
      tone: 'info',
      entityId: report.id,
      metadata: { reportId: report.id, trigger },
    },
  });

  logInfo('briefing.created', { id: report.id, trigger, tickers: countTickers(watchlist) });
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
    marketProviders: getEffectiveMarketProviders(),
    marketMatchHealth: {
      krFailureRate: krAttempts > 0 ? Math.round((krFailures / krAttempts) * 1000) / 10 : null,
      krQuoteAttempts: krAttempts,
      krQuoteFailures: krFailures,
      lastKrFailureSymbol: store.memory.market?.stats?.lastKrFailureSymbol || '',
    },
    latestManagerReport: store.memory.managerReports[0] || null,
    scheduledTasks: (store.memory.scheduledTasks || []).slice(0, 12),
    aiLatency: getAiLatencySnapshot(),
  };
}

module.exports = {
  getLatestManagerReport,
  runManagerReview,
  getSystemStatus,
};

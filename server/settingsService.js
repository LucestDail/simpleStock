const { readJson, writeJson, mutateStore } = require('./dataStore');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'settings.json');

const AI_PRESETS = [
  {
    id: 'fast',
    label: '빠른 응답',
    model: 'gemini-3.5-flash',
    thinkingBudget: 1024,
    includeThoughts: true,
  },
  {
    id: 'balanced',
    label: '균형 (기본)',
    model: 'gemini-3.5-flash',
    thinkingBudget: 2048,
    includeThoughts: true,
  },
  {
    id: 'deep',
    label: '깊은 추론',
    model: 'gemini-2.5-flash',
    thinkingBudget: 4096,
    includeThoughts: true,
  },
];

const MARKET_PROVIDER_OPTIONS = ['yahoo-finance', 'finnhub', 'public-data-portal', 'myapi', 'toss'];

function createDefaultSettings() {
  return {
    ai: {
      presetId: null,
      model: null,
      thinkingBudget: null,
      includeThoughts: null,
    },
    market: {
      usProvider: null,
      krProvider: null,
      fxProvider: null,
    },
    /**
     * 대시보드·모멘텀·브리핑 운영 손잡이 (2026-09-21)
     * 사용자: *"모멘텀 체크나 상황/시황판단을 위한 여러가지 옵션 및 설정, 프롬프트 세팅, 주기"*
     * ⚠️ 여기 값은 **화면에서 바꾼다.** 그래서 위험한 것(주문 켜기)은 절대 여기 두지 않는다 —
     *    그건 `/etc/simplestock.env` 의 ORDERS_ENABLED 다(화면에서 실수로 못 켜게).
     */
    dashboard: {
      momentumPct: null,        // 당일 등락 |%| 이 이상이면 모멘텀 후보
      refreshSec: null,         // 대시보드 자동 갱신 주기(초)
      rankingTypes: null,       // 랭킹 종류
      briefingPrompt: null,     // 브리핑에 덧붙일 사용자 지시
      briefingCron: null,       // 브리핑 자동 생성 주기(cron)
    },
    updatedAt: null,
  };
}

const RANKING_TYPES = ['TOP_GAINERS', 'TOP_LOSERS', 'tradingVolume', 'tradingAmount'];
const DASHBOARD_DEFAULTS = Object.freeze({
  momentumPct: 3,
  refreshSec: 60,
  rankingTypes: ['TOP_GAINERS', 'TOP_LOSERS'],
  briefingPrompt: '',
  briefingCron: '',
});

/**
 * ⚠️ 범위를 벗어난 값은 **조용히 자르지 않고 기본값으로 되돌린다.**
 *    화면에서 0 을 넣으면 "모든 종목이 모멘텀" 이 되는데, 그게 설정된 줄 모르면
 *    "알림이 왜 이렇게 많지" 로만 보인다.
 */
function normalizeDashboard(d) {
  const n = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : null);
  const types = Array.isArray(d?.rankingTypes)
    ? d.rankingTypes.filter((t) => RANKING_TYPES.includes(t))
    : null;
  return {
    momentumPct: n(d?.momentumPct, 0.1, 50),
    refreshSec: n(d?.refreshSec, 15, 3600),
    rankingTypes: types && types.length ? types : null,
    // 프롬프트는 모델에게 가는 값이다 — 길이를 제한한다(토큰과 비용이 붙는다)
    briefingPrompt: d?.briefingPrompt ? String(d.briefingPrompt).slice(0, 1000) : null,
    briefingCron: d?.briefingCron ? String(d.briefingCron).slice(0, 64) : null,
  };
}

/** 기본값이 적용된 대시보드 설정. **무엇이 기본값인지도 함께** 알려준다 */
function getDashboardSettings() {
  const s = loadSettings();
  const d = s.dashboard || {};
  const out = {};
  const usingDefault = [];
  for (const [k, def] of Object.entries(DASHBOARD_DEFAULTS)) {
    if (d[k] == null || d[k] === '') {
      out[k] = def;
      usingDefault.push(k);
    } else {
      out[k] = d[k];
    }
  }
  return { ...out, usingDefault };
}

function normalizeSettings(data) {
  const base = createDefaultSettings();
  if (!data || typeof data !== 'object') return base;
  return {
    ai: {
      presetId: data.ai?.presetId ? String(data.ai.presetId) : null,
      model: data.ai?.model ? String(data.ai.model) : null,
      thinkingBudget: Number.isFinite(Number(data.ai?.thinkingBudget))
        ? Math.min(8192, Math.max(0, Number(data.ai.thinkingBudget)))
        : null,
      includeThoughts:
        typeof data.ai?.includeThoughts === 'boolean' ? data.ai.includeThoughts : null,
    },
    dashboard: normalizeDashboard(data.dashboard),
    market: {
      usProvider: MARKET_PROVIDER_OPTIONS.includes(data.market?.usProvider)
        ? data.market.usProvider
        : null,
      krProvider: MARKET_PROVIDER_OPTIONS.includes(data.market?.krProvider)
        ? data.market.krProvider
        : null,
      fxProvider: MARKET_PROVIDER_OPTIONS.includes(data.market?.fxProvider)
        ? data.market.fxProvider
        : null,
    },
    updatedAt: data.updatedAt || null,
  };
}

function loadSettings() {
  return normalizeSettings(readJson(SETTINGS_FILE, createDefaultSettings));
}

function saveSettings(settings) {
  writeJson(SETTINGS_FILE, {
    ...normalizeSettings(settings),
    updatedAt: new Date().toISOString(),
  });
}

function getPresetById(presetId) {
  return AI_PRESETS.find((item) => item.id === presetId) || null;
}

function getEnvAiDefaults() {
  return {
    model: String(process.env.GEMINI_MODEL ?? 'gemini-3.5-flash').trim() || 'gemini-3.5-flash',
    thinkingBudget: Math.min(
      8192,
      Math.max(0, Number.parseInt(String(process.env.GEMINI_THINKING_BUDGET || '2048'), 10) || 2048)
    ),
    includeThoughts:
      String(process.env.GEMINI_INCLUDE_THOUGHTS ?? 'true').trim().toLowerCase() !== 'false',
  };
}

function getEffectiveAiConfig() {
  const env = getEnvAiDefaults();
  const saved = loadSettings();
  const preset = saved.ai.presetId ? getPresetById(saved.ai.presetId) : null;
  const model = saved.ai.model || preset?.model || env.model;
  const thinkingBudget =
    saved.ai.thinkingBudget ?? preset?.thinkingBudget ?? env.thinkingBudget;
  const includeThoughts =
    saved.ai.includeThoughts ?? preset?.includeThoughts ?? env.includeThoughts;
  return {
    model,
    thinkingBudget,
    includeThoughts,
    presetId: saved.ai.presetId,
    source: saved.ai.presetId ? 'preset' : saved.ai.model ? 'custom' : 'env',
  };
}

function getEffectiveMarketProviders() {
  const saved = loadSettings();
  const envUs = String(process.env.MARKET_US_PROVIDER || process.env.MARKET_DATA_PROVIDER || '').trim();
  const envKr = String(process.env.MARKET_KR_PROVIDER || '').trim();
  const envFx = String(process.env.MARKET_FX_PROVIDER || '').trim();
  return {
    us: saved.market.usProvider || envUs || null,
    kr: saved.market.krProvider || envKr || null,
    fx: saved.market.fxProvider || envFx || null,
  };
}

async function updateSettings(patch = {}) {
  const current = loadSettings();
  const nextPreset = patch.ai?.presetId !== undefined ? patch.ai.presetId : current.ai.presetId;
  const preset = nextPreset ? getPresetById(nextPreset) : null;
  const next = {
    ai: {
      presetId: nextPreset || null,
      model:
        patch.ai?.model !== undefined
          ? patch.ai.model
          : preset
            ? preset.model
            : current.ai.model,
      thinkingBudget:
        patch.ai?.thinkingBudget !== undefined
          ? patch.ai.thinkingBudget
          : preset
            ? preset.thinkingBudget
            : current.ai.thinkingBudget,
      includeThoughts:
        patch.ai?.includeThoughts !== undefined
          ? patch.ai.includeThoughts
          : preset
            ? preset.includeThoughts
            : current.ai.includeThoughts,
    },
    market: {
      usProvider:
        patch.market?.usProvider !== undefined ? patch.market.usProvider : current.market.usProvider,
      krProvider:
        patch.market?.krProvider !== undefined ? patch.market.krProvider : current.market.krProvider,
      fxProvider:
        patch.market?.fxProvider !== undefined ? patch.market.fxProvider : current.market.fxProvider,
    },
  };
  saveSettings(next);
  return loadSettings();
}

async function recordTokenUsage(usage = {}, label = 'generate') {
  const promptTokens = Math.max(0, Number(usage.promptTokens) || 0);
  const candidatesTokens = Math.max(0, Number(usage.candidatesTokens) || 0);
  const totalTokens = Math.max(0, Number(usage.totalTokens) || promptTokens + candidatesTokens);
  if (!totalTokens) return null;

  const monthKey = new Date().toISOString().slice(0, 7);
  return mutateStore((store) => {
    if (!store.memory.tokenUsageByMonth || typeof store.memory.tokenUsageByMonth !== 'object') {
      store.memory.tokenUsageByMonth = {};
    }
    const prev = store.memory.tokenUsageByMonth[monthKey] || {
      totalTokens: 0,
      promptTokens: 0,
      candidatesTokens: 0,
      requestCount: 0,
    };
    store.memory.tokenUsageByMonth[monthKey] = {
      totalTokens: prev.totalTokens + totalTokens,
      promptTokens: prev.promptTokens + promptTokens,
      candidatesTokens: prev.candidatesTokens + candidatesTokens,
      requestCount: prev.requestCount + 1,
      lastLabel: String(label || '').slice(0, 40),
      updatedAt: new Date().toISOString(),
    };
    return store.memory.tokenUsageByMonth[monthKey];
  });
}

function getTokenUsageSummary(store) {
  const byMonth = store?.memory?.tokenUsageByMonth || {};
  const monthKey = new Date().toISOString().slice(0, 7);
  return {
    currentMonth: monthKey,
    current: byMonth[monthKey] || null,
    recentMonths: Object.entries(byMonth)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 6)
      .map(([month, stats]) => ({ month, ...stats })),
  };
}

module.exports = {
  SETTINGS_FILE,
  AI_PRESETS,
  MARKET_PROVIDER_OPTIONS,
  loadSettings,
  saveSettings,
  updateSettings,
  getEffectiveAiConfig,
  getEffectiveMarketProviders,
  getDashboardSettings,
  DASHBOARD_DEFAULTS,
  RANKING_TYPES,
  getEnvAiDefaults,
  getPresetById,
  recordTokenUsage,
  getTokenUsageSummary,
};

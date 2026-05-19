const { randomUUID } = require('crypto');
const { APP_TIMEZONE, getDateInTimezone } = require('./time');
const { logInfo, logError, logWarn } = require('./logger');
const {
  getEffectiveAiConfig,
  recordTokenUsage,
  AI_PRESETS,
  loadSettings,
  getEnvAiDefaults,
} = require('./settingsService');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
/** @see https://ai.google.dev/gemini-api/docs/models — 기본 Stable: Gemini 3.1 Flash-Lite */
const GEMINI_MODEL =
  String(process.env.GEMINI_MODEL ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '') || 'gemini-3.1-flash-lite';
const GEMINI_INCLUDE_THOUGHTS =
  String(process.env.GEMINI_INCLUDE_THOUGHTS ?? 'true').trim().toLowerCase() !== 'false';
const GEMINI_THINKING_BUDGET = Math.min(
  8192,
  Math.max(0, Number.parseInt(String(process.env.GEMINI_THINKING_BUDGET || '2048'), 10) || 2048)
);
const GEMINI_TIMEOUT_MS = Math.max(15_000, Number(process.env.GEMINI_TIMEOUT_MS) || 90_000);
const GEMINI_MAX_RETRIES = Math.max(0, Number(process.env.GEMINI_MAX_RETRIES) || 2);
const GEMINI_RETRY_BASE_MS = Math.max(250, Number(process.env.GEMINI_RETRY_BASE_MS) || 1_500);
const usePresetBriefSchedule =
  String(process.env.MANAGER_BRIEF_PRESET_SCHEDULE ?? 'true').trim().toLowerCase() !== 'false';
const AI_DAILY_CRON =
  process.env.AI_DAILY_CRON || (usePresetBriefSchedule ? '' : '5 21 * * *');

let googleGenAiModulePromise = null;
const CATEGORY_LABELS = {
  deposit: '예금',
  installment: '적금',
  stock: '주식',
  fund: '펀드',
  pension: '연금',
};

const GENERATED_INSIGHT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    summary: { type: 'string' },
    tone: {
      type: 'string',
      enum: ['default', 'primary', 'positive', 'warning'],
    },
    metrics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['label', 'value'],
      },
    },
    bullets: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['id', 'title', 'summary', 'tone', 'metrics', 'bullets'],
};

const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['upsertHolding', 'removeHolding', 'updateProfile', 'scheduleTask', 'cancelScheduledTask'],
    },
    rationale: {
      type: 'string',
    },
    holding: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        category: {
          type: 'string',
          enum: ['deposit', 'installment', 'stock', 'fund', 'pension'],
        },
        amount: { type: 'number' },
        mode: {
          type: 'string',
          enum: ['set', 'delta'],
        },
      },
    },
    profileChanges: {
      type: 'object',
      properties: {
        displayName: { type: 'string' },
        investorType: { type: 'string' },
        investmentGoal: { type: 'string' },
        riskTolerance: { type: 'string' },
        timeHorizon: { type: 'string' },
        liquidityNeeds: { type: 'string' },
        responseStyle: { type: 'string' },
        focusAreas: { type: 'string' },
        notes: { type: 'string' },
      },
    },
    scheduleTask: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        taskType: {
          type: 'string',
          enum: ['managerBrief', 'marketReview', 'indicatorCheck', 'custom'],
        },
        cronExpression: { type: 'string' },
        timezone: { type: 'string' },
        nextRunLabel: { type: 'string' },
        prompt: { type: 'string' },
        indicatorName: { type: 'string' },
        enabled: { type: 'boolean' },
      },
    },
    cancelTarget: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        title: { type: 'string' },
        taskType: {
          type: 'string',
          enum: ['managerBrief', 'marketReview', 'indicatorCheck', 'custom'],
        },
      },
    },
  },
  required: ['type', 'rationale'],
};

const WORKSPACE_PATCH_SCHEMA = {
  type: 'object',
  properties: {
    focusMode: {
      type: 'string',
      enum: ['balanced', 'chat', 'rebalance', 'manager', 'research'],
    },
    highlightPanelIds: {
      type: 'array',
      items: {
        type: 'string',
        enum: [
          'status',
          'overview',
          'chat',
          'insights',
          'managerBrief',
          'managerHub',
          'snapshots',
          'activity',
          'profile',
          'system',
        ],
      },
    },
    generatedInsights: {
      type: 'array',
      items: GENERATED_INSIGHT_SCHEMA,
    },
    panelPatches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            enum: [
              'status',
              'overview',
              'chat',
              'insights',
              'managerBrief',
              'managerHub',
              'snapshots',
              'activity',
              'profile',
              'system',
            ],
          },
          column: {
            type: 'string',
            enum: ['left', 'center', 'right'],
          },
          span: {
            type: 'string',
            enum: ['sm', 'md', 'lg', 'xl', 'full'],
          },
          priority: {
            type: 'number',
          },
          visible: {
            type: 'boolean',
          },
        },
        required: ['id', 'column', 'span', 'priority', 'visible'],
      },
    },
    reason: {
      type: 'string',
    },
  },
  required: ['focusMode', 'highlightPanelIds', 'generatedInsights', 'panelPatches', 'reason'],
};

const SUPERVISOR_SCHEMA = {
  type: 'object',
  properties: {
    personaLabel: { type: 'string' },
    personaSystemPrompt: { type: 'string' },
    synthesisInstructions: { type: 'string' },
    workspacePatch: WORKSPACE_PATCH_SCHEMA,
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          agentType: {
            type: 'string',
            enum: ['portfolio', 'memory', 'manager', 'research'],
          },
          title: { type: 'string' },
          objective: { type: 'string' },
          systemPrompt: { type: 'string' },
          needsSearch: { type: 'boolean' },
          searchQuery: { type: 'string' },
        },
        required: ['id', 'agentType', 'title', 'objective', 'systemPrompt', 'needsSearch', 'searchQuery'],
      },
    },
    actions: {
      type: 'array',
      items: ACTION_SCHEMA,
    },
  },
  required: ['personaLabel', 'personaSystemPrompt', 'synthesisInstructions', 'workspacePatch', 'tasks', 'actions'],
};

const THREAD_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    importantFacts: { type: 'array', items: { type: 'string' } },
    unresolvedQuestions: { type: 'array', items: { type: 'string' } },
    personaHints: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'importantFacts', 'unresolvedQuestions', 'personaHints', 'tags'],
};

const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    inferredTraits: { type: 'array', items: { type: 'string' } },
    preferences: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'inferredTraits', 'preferences', 'concerns'],
};

const MANAGER_REPORT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    dailyObjective: { type: 'string' },
    actionItems: { type: 'array', items: { type: 'string' } },
    riskChecks: { type: 'array', items: { type: 'string' } },
    allocationNotes: { type: 'array', items: { type: 'string' } },
    conversationInsights: { type: 'array', items: { type: 'string' } },
    profileUpdates: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'summary',
    'dailyObjective',
    'actionItems',
    'riskChecks',
    'allocationNotes',
    'conversationInsights',
    'profileUpdates',
  ],
};

function isAiConfigured() {
  return Boolean(GEMINI_API_KEY);
}

function readAiRuntime() {
  return getEffectiveAiConfig();
}

function extractUsageFromResponse(response) {
  const usage = response?.usageMetadata || response?.usage_metadata || {};
  return {
    promptTokens: Number(usage.promptTokenCount || usage.prompt_tokens || 0),
    candidatesTokens: Number(usage.candidatesTokenCount || usage.candidates_tokens || 0),
    totalTokens: Number(usage.totalTokenCount || usage.total_tokens || 0),
  };
}

async function trackAiUsage(response, label) {
  try {
    await recordTokenUsage(extractUsageFromResponse(response), label);
  } catch {
    // usage tracking must not break AI flow
  }
}

function getAiSettings() {
  const runtime = readAiRuntime();
  const env = getEnvAiDefaults();
  return {
    configured: isAiConfigured(),
    model: runtime.model,
    streamThoughts: runtime.includeThoughts,
    thinkingBudget: runtime.thinkingBudget,
    thinkingLevel: runtime.includeThoughts ? `thoughts+budget:${runtime.thinkingBudget}` : 'off',
    presetId: runtime.presetId,
    source: runtime.source,
    envDefaults: env,
    presets: AI_PRESETS,
    savedSettings: loadSettings().ai,
    timezone: APP_TIMEZONE,
    dailyCron: AI_DAILY_CRON,
  };
}

async function getGoogleGenAI() {
  if (!googleGenAiModulePromise) {
    googleGenAiModulePromise = import('@google/genai');
  }
  return googleGenAiModulePromise.then((module) => module.GoogleGenAI);
}

async function getGoogleGenAiModule() {
  if (!googleGenAiModulePromise) {
    googleGenAiModulePromise = import('@google/genai');
  }
  return googleGenAiModulePromise;
}

function convertJsonSchemaToGeminiSchema(schema, Type) {
  if (!schema || typeof schema !== 'object') return null;

  const type = String(schema.type || 'string').toLowerCase();
  const converted = {};

  if (type === 'object') {
    converted.type = Type.OBJECT;
    const properties = Object.fromEntries(
      Object.entries(schema.properties || {})
        .map(([key, value]) => [key, convertJsonSchemaToGeminiSchema(value, Type)])
        .filter(([, value]) => Boolean(value))
    );
    if (Object.keys(properties).length) {
      converted.properties = properties;
    }
    if (Array.isArray(schema.required) && schema.required.length) {
      converted.required = schema.required;
    }
  } else if (type === 'array') {
    converted.type = Type.ARRAY;
    const items = convertJsonSchemaToGeminiSchema(schema.items, Type);
    if (items) {
      converted.items = items;
    }
  } else if (type === 'number') {
    converted.type = Type.NUMBER;
  } else if (type === 'integer') {
    converted.type = Type.INTEGER;
  } else if (type === 'boolean') {
    converted.type = Type.BOOLEAN;
  } else {
    converted.type = Type.STRING;
  }

  if (schema.description) {
    converted.description = String(schema.description);
  }
  if (Array.isArray(schema.enum) && schema.enum.length) {
    converted.enum = schema.enum;
  }
  if (schema.nullable === true) {
    converted.nullable = true;
  }

  return converted;
}

async function buildGenerateConfig({ schema = null, useGoogleSearch = false, streamWithThoughts = false }) {
  const runtime = readAiRuntime();
  const config = {
    ...(useGoogleSearch ? { tools: [{ googleSearch: {} }] } : {}),
  };

  if (streamWithThoughts && runtime.includeThoughts && runtime.thinkingBudget > 0) {
    config.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: runtime.thinkingBudget,
    };
  }

  if (!schema) {
    return config;
  }

  const { Type } = await getGoogleGenAiModule();
  config.responseMimeType = 'application/json';
  config.responseSchema = convertJsonSchemaToGeminiSchema(schema, Type);
  return config;
}

function buildEnvelope(systemPrompt, userPrompt) {
  return [
    'System instructions:',
    systemPrompt.trim(),
    '',
    'User request:',
    userPrompt.trim(),
  ].join('\n');
}

function extractTextFromResponse(response) {
  if (!response) return '';
  if (typeof response.text === 'string' && response.text.trim()) return response.text.trim();
  if (typeof response.outputText === 'string' && response.outputText.trim()) return response.outputText.trim();

  const text = response.candidates?.[0]?.content?.parts
    ?.map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();

  return text || '';
}

function stripFence(value) {
  return value
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function safeParseJson(value, fallback, options = {}) {
  const {
    throwOnFailure = false,
    logLabel = 'structured_output',
  } = options;
  try {
    return JSON.parse(stripFence(value));
  } catch (error) {
    logWarn('ai.json_parse_fallback', {
      logLabel,
      preview: String(value || '').slice(0, 240),
      message: String(error?.message || error),
    });
    if (throwOnFailure) {
      const parseError = new Error('AI 구조화 응답을 파싱하지 못했습니다.');
      parseError.code = 'AI_JSON_PARSE_FAILED';
      parseError.rawText = String(value || '').slice(0, 4000);
      throw parseError;
    }
    return fallback;
  }
}

function formatCompactCurrency(amount) {
  return new Intl.NumberFormat('ko-KR', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Number(amount) || 0);
}

function buildFallbackInsights(userInput, context) {
  const total = Number(context?.portfolio?.total || 0);
  const shares = Array.isArray(context?.portfolio?.categoryShares)
    ? [...context.portfolio.categoryShares]
    : [];
  const dominant = [...shares].sort((a, b) => b.amount - a.amount)[0] || null;
  const latestSnapshot = context?.portfolio?.latestSnapshots?.[0] || null;
  const previousSnapshot = context?.portfolio?.latestSnapshots?.[1] || null;
  const delta =
    latestSnapshot && previousSnapshot ? Number(latestSnapshot.total || 0) - Number(previousSnapshot.total || 0) : null;
  const recentMessages = Array.isArray(context?.recentMessages) ? context.recentMessages.length : 0;
  const memoryCount = Array.isArray(context?.memory?.recentLongTermMemories)
    ? context.memory.recentLongTermMemories.length
    : 0;
  const managerCount = Array.isArray(context?.memory?.latestManagerReports)
    ? context.memory.latestManagerReports.length
    : 0;
  const displayName = context?.profile?.userProfile?.displayName || '사용자';

  return [
    {
      id: 'conversation-focus',
      title: '현재 대화 포커스',
      summary: `${displayName}님의 현재 질의 흐름과 응답 스타일에 맞춰 Quant Manager가 이번 턴의 우선순위를 재해석하고 있습니다.`,
      tone: 'primary',
      metrics: [
        { label: '최근 메시지', value: `${recentMessages}개` },
        { label: '기억 신호', value: `${memoryCount}개` },
      ],
      bullets: [
        `핵심 요청: ${String(userInput || '').slice(0, 72) || '현재 대화 맥락 파악 중'}`,
        managerCount ? `최근 브리핑 ${managerCount}건을 함께 참고합니다.` : '브리핑 히스토리가 적어 현재 대화 비중이 높습니다.',
      ],
    },
    {
      id: 'portfolio-pulse',
      title: '포트폴리오 펄스',
      summary: dominant
        ? `${CATEGORY_LABELS[dominant.category] || dominant.category} 비중이 ${dominant.pct}%로 가장 큽니다. 자산 집중도와 최근 스냅샷 변화를 함께 봐야 합니다.`
        : '아직 등록된 자산이 적어 포트폴리오 펄스를 만들기 전 단계입니다.',
      tone: dominant && dominant.pct >= 55 ? 'warning' : 'positive',
      metrics: [
        { label: '총 자산', value: formatCompactCurrency(total) },
        {
          label: '우세 카테고리',
          value: dominant
            ? `${CATEGORY_LABELS[dominant.category] || dominant.category} ${dominant.pct}%`
            : '데이터 없음',
        },
      ],
      bullets: [
        latestSnapshot ? `최근 스냅샷: ${latestSnapshot.date}` : '최근 스냅샷이 아직 없습니다.',
        delta == null ? '스냅샷 비교 데이터가 부족합니다.' : `직전 대비 ${delta >= 0 ? '+' : ''}${formatCompactCurrency(delta)} 변동`,
      ],
    },
    {
      id: 'manager-signal',
      title: '실시간 매니저 시그널',
      summary: '대화, 자산, 브리핑, 프로필을 동시에 보면서 지금 당장 필요한 행동과 관찰 포인트를 압축합니다.',
      tone: 'default',
      metrics: [
        { label: '활성 브리핑', value: managerCount ? `${managerCount}건` : '없음' },
        { label: '프로필 요약', value: context?.profile?.aiProfile?.summary ? '반영됨' : '학습 중' },
      ],
      bullets: [
        dominant
          ? `${CATEGORY_LABELS[dominant.category] || dominant.category} 관련 질문이 나오면 보유 자산과 리스크 체크를 우선 노출합니다.`
          : '자산 등록 이후 시계열 인사이트 품질이 더 높아집니다.',
        '새 응답이 오면 이 카드와 보조 패널의 구성도 함께 갱신됩니다.',
      ],
    },
  ];
}

function buildPrimaryChatWorkspacePatch({
  userInput,
  context,
  focusMode = 'balanced',
  highlightPanelIds = ['chat', 'managerHub'],
  openDrawer = null,
  reason = 'Quant Manager 대화를 중심으로 워크스페이스를 유지합니다.',
  panelOverrides = [],
}) {
  const basePanels = [
    { id: 'status', column: 'left', span: 'sm', priority: 5, visible: true },
    { id: 'overview', column: 'left', span: 'xl', priority: 10, visible: true },
    { id: 'system', column: 'left', span: 'sm', priority: 30, visible: false },
    { id: 'chat', column: 'center', span: 'full', priority: 100, visible: true },
    { id: 'managerHub', column: 'right', span: 'full', priority: 5, visible: true },
    { id: 'insights', column: 'right', span: 'lg', priority: 5, visible: false },
    { id: 'managerBrief', column: 'right', span: 'md', priority: 10, visible: false },
    { id: 'snapshots', column: 'right', span: 'sm', priority: 20, visible: false },
    { id: 'activity', column: 'right', span: 'md', priority: 30, visible: false },
    { id: 'profile', column: 'right', span: 'sm', priority: 40, visible: false },
  ];
  const overrideMap = new Map((panelOverrides || []).map((item) => [item.id, item]));

  return {
    focusMode,
    highlightPanelIds,
    generatedInsights: buildFallbackInsights(userInput, context),
    panelPatches: basePanels.map((panel) => ({
      ...panel,
      ...(overrideMap.get(panel.id) || {}),
    })),
    ...(openDrawer?.type ? { openDrawer } : {}),
    reason,
  };
}

function getGroundingSources(response) {
  const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  return chunks
    .map((chunk) => ({
      title: chunk.web?.title || chunk.retrievedContext?.title || '참고 자료',
      url: chunk.web?.uri || chunk.retrievedContext?.uri || '',
    }))
    .filter((item) => item.url)
    .filter((item, index, array) => array.findIndex((x) => x.url === item.url) === index)
    .slice(0, 6);
}

function mergeGroundingSources(...groups) {
  return groups
    .flat()
    .filter((item) => item?.url)
    .filter((item, index, array) => array.findIndex((x) => x.url === item.url) === index)
    .slice(0, 6);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAiTimeoutError(timeoutMs) {
  const error = new Error(`Gemini 응답이 ${Math.round(timeoutMs / 1000)}초 안에 완료되지 않았습니다.`);
  error.code = 'AI_TIMEOUT';
  error.retryable = true;
  return error;
}

async function withTimeout(promise, timeoutMs) {
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(createAiTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function isRetryableAiError(error) {
  if (!error) return false;
  if (error.retryable || error.code === 'AI_TIMEOUT') return true;

  const status = Number(error.status || error.statusCode || error.cause?.status || 0);
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const message = String(error.message || error);
  return /(fetch failed|sending request|network|socket|timed out|timeout|econnreset|etimedout|eai_again|enotfound|unavailable|resource_exhausted|temporarily unavailable|overloaded|internal error|service unavailable)/i.test(
    message
  );
}

function buildAiUserFacingError(error, { maxAttempts } = {}) {
  if (error?.code === 'AI_TIMEOUT') {
    return new Error(
      `AI 응답이 ${Math.round(GEMINI_TIMEOUT_MS / 1000)}초 안에 완료되지 않아 중단했습니다. 잠시 후 다시 시도해 주세요.`
    );
  }

  if (isRetryableAiError(error)) {
    return new Error(
      maxAttempts > 1
        ? 'AI 응답 생성이 일시적으로 불안정했습니다. 자동 재시도 후에도 완료되지 않아 중단했습니다. 잠시 후 다시 시도해 주세요.'
        : 'AI 응답 생성이 일시적으로 불안정합니다. 잠시 후 다시 시도해 주세요.'
    );
  }

  return new Error('AI 응답 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.');
}

async function generateContent({
  systemPrompt,
  userPrompt,
  schema = null,
  useGoogleSearch = false,
  logLabel = 'generate_content',
}) {
  if (!isAiConfigured()) {
    throw new Error('GEMINI_API_KEY가 설정되지 않아 AI 기능이 비활성화되어 있습니다.');
  }

  const GoogleGenAI = await getGoogleGenAI();
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const runtime = readAiRuntime();
  const startedAt = Date.now();
  const maxAttempts = GEMINI_MAX_RETRIES + 1;
  const config = await buildGenerateConfig({ schema, useGoogleSearch });

  logInfo('ai.generate.start', {
    logLabel,
    model: runtime.model,
    streamThoughts: runtime.includeThoughts,
    useGoogleSearch,
    hasSchema: Boolean(schema),
    timeoutMs: GEMINI_TIMEOUT_MS,
    maxAttempts,
    systemPromptPreview: String(systemPrompt || '').slice(0, 160),
    userPromptPreview: String(userPrompt || '').slice(0, 200),
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStartedAt = Date.now();
    let emittedChunk = false;

    try {
      const response = await withTimeout(
        ai.models.generateContent({
          model: runtime.model,
          contents: buildEnvelope(systemPrompt, userPrompt),
          config,
        }),
        GEMINI_TIMEOUT_MS
      );

      logInfo('ai.generate.finish', {
        logLabel,
        attempt,
        durationMs: Date.now() - startedAt,
        attemptDurationMs: Date.now() - attemptStartedAt,
        outputPreview: extractTextFromResponse(response).slice(0, 200),
        groundingSourceCount: getGroundingSources(response).length,
      });

      await trackAiUsage(response, logLabel);
      return response;
    } catch (error) {
      const retryable = isRetryableAiError(error);
      const waitMs = retryable && attempt < maxAttempts
        ? GEMINI_RETRY_BASE_MS * 2 ** (attempt - 1)
        : 0;

      if (waitMs > 0) {
        logWarn('ai.generate.retry', {
          logLabel,
          attempt,
          maxAttempts,
          durationMs: Date.now() - startedAt,
          attemptDurationMs: Date.now() - attemptStartedAt,
          waitMs,
          retryable,
          message: String(error?.message || error).slice(0, 220),
          useGoogleSearch,
          hasSchema: Boolean(schema),
        });
        await sleep(waitMs);
        continue;
      }

      const userFacingError = buildAiUserFacingError(error, { maxAttempts });
      logError('ai.generate.failed', error, {
        logLabel,
        attempt,
        maxAttempts,
        durationMs: Date.now() - startedAt,
        attemptDurationMs: Date.now() - attemptStartedAt,
        useGoogleSearch,
        hasSchema: Boolean(schema),
        retryable,
        userMessage: userFacingError.message,
      });
      throw userFacingError;
    }
  }

  try {
    throw new Error('AI 응답 생성 루프가 예상치 못하게 종료되었습니다.');
  } catch (error) {
    logError('ai.generate.failed', error, {
      logLabel,
      durationMs: Date.now() - startedAt,
      useGoogleSearch,
      hasSchema: Boolean(schema),
      retryable: false,
    });
    throw buildAiUserFacingError(error, { maxAttempts });
  }
}

function extractStreamingParts(chunk) {
  const parts = chunk?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts) && parts.length) {
    let answerText = '';
    let thoughtText = '';
    for (const part of parts) {
      if (typeof part.text !== 'string' || !part.text) continue;
      if (part.thought) thoughtText += part.text;
      else answerText += part.text;
    }
    return { answerText, thoughtText };
  }
  const fallback = String(chunk?.text || extractTextFromResponse(chunk) || '');
  return { answerText: fallback, thoughtText: '' };
}

async function generateContentStream({
  systemPrompt,
  userPrompt,
  useGoogleSearch = false,
  logLabel = 'generate_content_stream',
  onChunk = null,
  onThinkingChunk = null,
}) {
  if (!isAiConfigured()) {
    throw new Error('GEMINI_API_KEY가 설정되지 않아 AI 기능이 비활성화되어 있습니다.');
  }

  const GoogleGenAI = await getGoogleGenAI();
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const runtime = readAiRuntime();
  const startedAt = Date.now();
  const maxAttempts = GEMINI_MAX_RETRIES + 1;
  const config = await buildGenerateConfig({ useGoogleSearch, streamWithThoughts: true });

  logInfo('ai.generate.start', {
    logLabel,
    model: runtime.model,
    streamThoughts: runtime.includeThoughts,
    useGoogleSearch,
    hasSchema: false,
    timeoutMs: GEMINI_TIMEOUT_MS,
    maxAttempts,
    streaming: true,
    systemPromptPreview: String(systemPrompt || '').slice(0, 160),
    userPromptPreview: String(userPrompt || '').slice(0, 200),
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStartedAt = Date.now();
    let emittedChunk = false;

    try {
      const stream = await withTimeout(
        ai.models.generateContentStream({
          model: runtime.model,
          contents: buildEnvelope(systemPrompt, userPrompt),
          config,
        }),
        GEMINI_TIMEOUT_MS
      );
      let answer = '';
      const groundingSources = [];

      for await (const chunk of stream) {
        const { answerText, thoughtText } = extractStreamingParts(chunk);
        if (thoughtText && typeof onThinkingChunk === 'function') {
          emittedChunk = true;
          await onThinkingChunk(thoughtText);
        }
        if (answerText) {
          answer += answerText;
          emittedChunk = true;
          if (typeof onChunk === 'function') {
            await onChunk(answerText);
          }
        }
        groundingSources.push(...getGroundingSources(chunk));
      }

      logInfo('ai.generate.finish', {
        logLabel,
        attempt,
        durationMs: Date.now() - startedAt,
        attemptDurationMs: Date.now() - attemptStartedAt,
        outputPreview: answer.slice(0, 200),
        groundingSourceCount: mergeGroundingSources(groundingSources).length,
        streaming: true,
      });

      return {
        text: answer,
        citations: mergeGroundingSources(groundingSources),
      };
    } catch (error) {
      const retryable = isRetryableAiError(error);
      const waitMs = retryable && attempt < maxAttempts && !emittedChunk
        ? GEMINI_RETRY_BASE_MS * 2 ** (attempt - 1)
        : 0;

      if (waitMs > 0) {
        logWarn('ai.generate.retry', {
          logLabel,
          attempt,
          maxAttempts,
          durationMs: Date.now() - startedAt,
          attemptDurationMs: Date.now() - attemptStartedAt,
          waitMs,
          retryable,
          message: String(error?.message || error).slice(0, 220),
          useGoogleSearch,
          hasSchema: false,
          streaming: true,
        });
        await sleep(waitMs);
        continue;
      }

      const userFacingError = buildAiUserFacingError(error, { maxAttempts });
      logError('ai.generate.failed', error, {
        logLabel,
        attempt,
        maxAttempts,
        durationMs: Date.now() - startedAt,
        attemptDurationMs: Date.now() - attemptStartedAt,
        useGoogleSearch,
        hasSchema: false,
        retryable,
        streaming: true,
        userMessage: userFacingError.message,
      });
      throw userFacingError;
    }
  }

  try {
    throw new Error('AI 스트리밍 응답 생성 루프가 예상치 못하게 종료되었습니다.');
  } catch (error) {
    logError('ai.generate.failed', error, {
      logLabel,
      durationMs: Date.now() - startedAt,
      useGoogleSearch,
      hasSchema: false,
      retryable: false,
      streaming: true,
    });
    throw buildAiUserFacingError(error, { maxAttempts });
  }
}

async function generateStructuredOutput(options, fallback, extraOptions = {}) {
  const response = await generateContent({
    ...options,
    logLabel: options.logLabel || 'structured_output',
  });
  return safeParseJson(extractTextFromResponse(response), fallback, {
    throwOnFailure: Boolean(extraOptions.throwOnParseFailure),
    logLabel: options.logLabel || 'structured_output',
  });
}

function buildFallbackPlan(userInput, context) {
  const lowered = userInput.toLowerCase();
  const tasks = [
    {
      id: randomUUID(),
      agentType: 'portfolio',
      title: '포트폴리오 분석',
      objective: '보유 자산과 최근 변동을 요약한다.',
      systemPrompt:
        '당신은 한국 개인 투자자를 돕는 포트폴리오 분석가다. 수치와 분류 구조를 먼저 읽고, 실제 자산 상태를 간결하게 설명한다.',
      needsSearch: false,
      searchQuery: '',
    },
    {
      id: randomUUID(),
      agentType: 'memory',
      title: '대화 기억 정리',
      objective: '기존 대화와 사용자 성향에서 관련 맥락을 뽑아낸다.',
      systemPrompt:
        '당신은 장기 기억 관리자다. 최근 대화 요약, 장기 기억, 사용자 선호를 읽고 이번 질문에 필요한 맥락만 추린다.',
      needsSearch: false,
      searchQuery: '',
    },
  ];

  if (/(전략|리밸런싱|관리|지시|매니저|오늘)/.test(lowered)) {
    tasks.push({
      id: randomUUID(),
      agentType: 'manager',
      title: '매니저 시각',
      objective: '오늘의 실행 우선순위와 리스크 관리를 정리한다.',
      systemPrompt:
        '당신은 개인 자산 관리 매니저다. 단기 행동, 리스크 체크, 오늘의 우선순위를 제시한다.',
      needsSearch: false,
      searchQuery: '',
    });
  }

  if (/(뉴스|시장|시황|검색|찾아|외부|web|search)/.test(lowered)) {
    tasks.push({
      id: randomUUID(),
      agentType: 'research',
      title: '외부 조사',
      objective: '질문에 맞는 외부 시장 정보를 요약한다.',
      systemPrompt:
        '당신은 외부 시장 조사 에이전트다. 검색 질의를 재구성하고, 필요한 사실만 간결히 보고한다.',
      needsSearch: true,
      searchQuery: userInput,
    });
  }

  let workspacePatch = buildPrimaryChatWorkspacePatch({
    userInput,
    context,
    focusMode: 'balanced',
    highlightPanelIds: ['chat', 'managerHub', 'overview'],
    reason: 'Quant Manager 대화를 중심으로 자산 대시보드와 매니저 허브를 함께 유지합니다.',
  });

  if (/(리밸런싱|비중|분산|재배치|재조정)/.test(lowered)) {
    workspacePatch = buildPrimaryChatWorkspacePatch({
      userInput,
      context,
      focusMode: 'rebalance',
      highlightPanelIds: ['chat', 'managerHub', 'overview'],
      reason: '리밸런싱 요청이라 채팅·자산 개요·매니저 허브를 강조합니다.',
      panelOverrides: [
        { id: 'overview', span: 'xl', priority: 10 },
        { id: 'managerHub', span: 'full', priority: 5, visible: true },
      ],
    });
  } else if (/(전략|관리|지시|매니저|오늘)/.test(lowered)) {
    workspacePatch = buildPrimaryChatWorkspacePatch({
      userInput,
      context,
      focusMode: 'manager',
      highlightPanelIds: ['chat', 'managerHub'],
      reason: '관리 지시 요청이라 매니저 허브(브리핑·예약·활동)를 크게 반영합니다.',
      panelOverrides: [{ id: 'managerHub', span: 'full', priority: 5, visible: true }],
    });
  } else if (/(뉴스|시장|시황|검색|찾아|외부|web|search)/.test(lowered)) {
    workspacePatch = buildPrimaryChatWorkspacePatch({
      userInput,
      context,
      focusMode: 'research',
      highlightPanelIds: ['chat', 'managerHub'],
      reason: '리서치 요청이라 매니저 허브 시황·활동 로그를 강조합니다.',
      panelOverrides: [{ id: 'managerHub', span: 'full', priority: 5, visible: true }],
    });
  } else if (/(프로필|성향|선호|응답 스타일|메모리)/.test(lowered)) {
    workspacePatch = buildPrimaryChatWorkspacePatch({
      userInput,
      context,
      focusMode: 'balanced',
      highlightPanelIds: ['chat', 'managerHub', 'profile'],
      reason: '프로필/성향 요청이라 대화와 매니저 허브를 유지합니다.',
      panelOverrides: [
        { id: 'managerHub', span: 'full', priority: 5, visible: true },
        { id: 'profile', span: 'lg', priority: 20, visible: true },
      ],
    });
  } else if (/(대화|채팅|상담|질문)/.test(lowered)) {
    workspacePatch = buildPrimaryChatWorkspacePatch({
      userInput,
      context,
      focusMode: 'chat',
      highlightPanelIds: ['chat', 'managerHub'],
      reason: '대화 중심 요청이라 채팅을 primary로 두고 매니저 허브를 보조합니다.',
      panelOverrides: [{ id: 'managerHub', span: 'full', priority: 5, visible: true }],
    });
  }

  return {
    personaLabel: 'Quant Manager',
    personaSystemPrompt: [
      '당신은 사용자의 자산·대화·성향을 모두 참조하는 개인 Quant Manager다.',
      '답변은 한국어로 작성한다.',
      '실행 가능한 제안, 리스크 체크, 숫자 근거를 우선한다.',
      context.profile.userProfile.responseStyle
        ? `사용자가 선호하는 응답 스타일: ${context.profile.userProfile.responseStyle}`
        : '사용자 응답 스타일 정보가 부족하면 지나친 추측 없이 차분하고 실무적으로 답한다.',
    ].join('\n'),
    synthesisInstructions:
      '전문가 출력들을 종합해서 하나의 최종 답변으로 정리하되, 필요한 경우 오늘 할 일과 주의사항을 분리한다.',
    tasks,
    actions: [],
    workspacePatch,
  };
}

async function buildSupervisorPlan(userInput, context) {
  if (!isAiConfigured()) {
    return buildFallbackPlan(userInput, context);
  }

  const fallback = buildFallbackPlan(userInput, context);
  return generateStructuredOutput(
    {
      systemPrompt: [
        '당신은 multi-agent supervisor 이다.',
        '사용자 질문, 자산 데이터, 장기 기억, 사용자 프로필을 읽고 매 턴마다 새로운 persona/system prompt 와 specialized agent 작업 목록을 생성한다.',
        '전문화된 agent 는 고정된 집합이 아니라 이번 질의에 맞게 동적으로 구성한다.',
        '외부 조사가 필요한 경우 research task 를 포함하고 searchQuery 를 한국어 또는 영어 혼합으로 더 검색 친화적으로 재작성한다.',
        'task 는 portfolio, memory, manager, research 타입만 사용한다.',
        '사용자 요청이 자산 입력/수정/삭제, 설정 변경, 반복 작업 예약/취소에 해당하면 actions 배열에 실제 변경 계획을 넣는다.',
        '자산 입력은 holding 정보, 설정 변경은 profileChanges, 반복 작업은 scheduleTask, 취소는 cancelTarget에 담는다.',
        'removeHolding 시 holding.name은 필수이며, 같은 이름이 서로 다른 category(예: 주식·예금)에 중복될 수 있으면 holding.category에 deposit/installment/stock/fund/pension 중 하나를 반드시 넣는다.',
        'cancelScheduledTask 는 가능하면 cancelTarget.taskId(예약 작업 id)로 지정하고, 모를 때만 title+taskType으로 지정한다.',
        '반복 작업은 가능하면 cronExpression, nextRunLabel, taskType 을 함께 채운다.',
        '추가로 workspacePatch 를 반환해 어떤 패널을 강조/확장/숨김/이동할지 제안한다.',
        'workspacePatch 안에는 generatedInsights 배열도 포함해 지금 턴에 보여줄 실시간 카드/통계/집계 패널 내용을 만든다.',
        'workspacePatch 는 허용된 panel id 와 제한된 focusMode/column/span 값만 사용한다.',
        'chat 패널은 primary 영역이므로 이를 전제로 나머지 패널을 재배치한다.',
        '요청이 모호하면 actions 는 비워 둔다.',
        '반드시 JSON 으로만 답한다.',
      ].join('\n'),
      userPrompt: JSON.stringify(
        {
          userInput,
          context,
        },
        null,
        2
      ),
      schema: SUPERVISOR_SCHEMA,
      logLabel: 'supervisor_plan',
    },
    fallback
  ).then((plan) => {
    logInfo('ai.supervisor.plan', {
      personaLabel: plan.personaLabel,
      taskCount: Array.isArray(plan.tasks) ? plan.tasks.length : 0,
      actionCount: Array.isArray(plan.actions) ? plan.actions.length : 0,
      focusMode: plan.workspacePatch?.focusMode || '',
      highlightPanelIds: plan.workspacePatch?.highlightPanelIds || [],
    });
    return plan;
  });
}

function buildFallbackResearchTask(userInput) {
  return {
    id: randomUUID(),
    agentType: 'research',
    title: '자동 외부 조사',
    objective: '사용자 질문에 맞는 외부 시장 정보를 요약한다.',
    systemPrompt:
      '당신은 외부 시장 조사 에이전트다. 검색 질의를 재구성하고, 필요한 사실만 간결히 보고한다.',
    needsSearch: true,
    searchQuery: String(userInput || '').trim() || '오늘의 주요 증시 뉴스',
  };
}

async function runTaskPrompt(task, taskContext, useGoogleSearch = false) {
  const response = await generateContent({
    systemPrompt: task.systemPrompt,
    userPrompt: taskContext,
    useGoogleSearch,
    logLabel: `specialist_${task.agentType}`,
  });

  return {
    text: extractTextFromResponse(response),
    citations: getGroundingSources(response),
  };
}

async function executeSpecialistTasks(plan, context, userInput) {
  const allowed = new Set(['portfolio', 'memory', 'manager', 'research']);
  let tasks = (plan.tasks || []).filter((task) => task && allowed.has(task.agentType));
  let specialistFallbackUsed = false;
  if (!tasks.length) {
    tasks = [buildFallbackResearchTask(userInput)];
    specialistFallbackUsed = true;
    logInfo('ai.specialist.fallback', { reason: 'empty_or_invalid_tasks', injectedAgentType: 'research' });
  }

  const outputs = await Promise.all(
    tasks.map(async (task) => {
      const startedAt = Date.now();
      logInfo('ai.specialist.start', {
        taskId: task.id,
        agentType: task.agentType,
        title: task.title,
        needsSearch: task.needsSearch,
      });
      let taskContext = '';
      if (task.agentType === 'portfolio') {
        taskContext = JSON.stringify(
          {
            userInput,
            objective: task.objective,
            portfolio: context.portfolio,
          },
          null,
          2
        );
      } else if (task.agentType === 'memory') {
        taskContext = JSON.stringify(
          {
            userInput,
            objective: task.objective,
            profile: context.profile,
            memory: context.memory,
            recentTranscript: context.recentTranscript,
          },
          null,
          2
        );
      } else if (task.agentType === 'manager') {
        taskContext = JSON.stringify(
          {
            userInput,
            objective: task.objective,
            portfolio: context.portfolio,
            profile: context.profile,
            memory: context.memory,
          },
          null,
          2
        );
      } else {
        taskContext = JSON.stringify(
          {
            userInput,
            objective: task.objective,
            tunedSearchQuery: task.searchQuery || userInput,
            profile: context.profile,
            recentTranscript: context.recentTranscript,
          },
          null,
          2
        );
      }

      try {
        const result = await runTaskPrompt(task, taskContext, task.needsSearch);
        logInfo('ai.specialist.finish', {
          taskId: task.id,
          agentType: task.agentType,
          title: task.title,
          durationMs: Date.now() - startedAt,
          citationCount: (result.citations || []).length,
          outputPreview: result.text.slice(0, 200),
        });
        return {
          id: task.id,
          agentType: task.agentType,
          title: task.title,
          objective: task.objective,
          text: result.text,
          citations: result.citations,
        };
      } catch (error) {
        logWarn('ai.specialist.task_failed', {
          taskId: task.id,
          agentType: task.agentType,
          title: task.title,
          message: String(error?.message || error).slice(0, 220),
        });
        return {
          id: task.id,
          agentType: task.agentType,
          title: task.title,
          objective: task.objective,
          text: `이 전문가 단계를 완료하지 못했습니다: ${String(error?.message || error)}`,
          citations: [],
        };
      }
    })
  );

  const allFailed =
    tasks.length > 0 &&
    outputs.every((item) => {
      const t = String(item?.text || '');
      return t.startsWith('이 전문가 단계를 완료하지 못했습니다:');
    });

  if (allFailed) {
    specialistFallbackUsed = true;
    const fb = buildFallbackResearchTask(userInput);
    logInfo('ai.specialist.fallback', { reason: 'all_tasks_failed', injectedAgentType: 'research' });
    try {
      const taskContext = JSON.stringify(
        {
          userInput,
          objective: fb.objective,
          tunedSearchQuery: fb.searchQuery,
          profile: context.profile,
          recentTranscript: context.recentTranscript,
        },
        null,
        2
      );
      const result = await runTaskPrompt(fb, taskContext, true);
      outputs.push({
        id: fb.id,
        agentType: fb.agentType,
        title: fb.title,
        objective: fb.objective,
        text: result.text,
        citations: result.citations,
      });
    } catch (error) {
      outputs.push({
        id: fb.id,
        agentType: fb.agentType,
        title: fb.title,
        objective: fb.objective,
        text: `폴백 조사도 실패했습니다: ${String(error?.message || error)}`,
        citations: [],
      });
    }
  }

  return {
    outputs,
    citations: outputs.flatMap((item) => item.citations || []),
    specialistFallbackUsed,
  };
}

async function synthesizeFinalAnswer({ userInput, context, plan, specialistOutputs }) {
  const response = await generateContent({
    systemPrompt: [
      plan.personaSystemPrompt,
      '',
      '추가 지시:',
      plan.synthesisInstructions,
      '최종 답변은 한국어로 작성하고, 필요한 경우 짧은 섹션 제목을 사용한다.',
      '숫자/우선순위/리스크/후속 행동을 최대한 구조적으로 정리한다.',
      'plannedActions 가 있으면 실제로 반영될 자산/설정/예약 변경 사항을 답변 안에 분명히 언급한다.',
    ].join('\n'),
    userPrompt: JSON.stringify(
      {
        userInput,
        context,
        specialistOutputs,
        plannedActions: plan.actions || [],
      },
      null,
      2
    ),
    logLabel: 'synthesizer',
  });

  return {
    answer: extractTextFromResponse(response),
  };
}

async function synthesizeFinalAnswerStream({ userInput, context, plan, specialistOutputs, onChunk, onThinkingChunk }) {
  const response = await generateContentStream({
    systemPrompt: [
      plan.personaSystemPrompt,
      '',
      '추가 지시:',
      plan.synthesisInstructions,
      '최종 답변은 한국어로 작성하고, 필요한 경우 짧은 섹션 제목을 사용한다.',
      '숫자/우선순위/리스크/후속 행동을 최대한 구조적으로 정리한다.',
      'plannedActions 가 있으면 실제로 반영될 자산/설정/예약 변경 사항을 답변 안에 분명히 언급한다.',
    ].join('\n'),
    userPrompt: JSON.stringify(
      {
        userInput,
        context,
        specialistOutputs,
        plannedActions: plan.actions || [],
      },
      null,
      2
    ),
    logLabel: 'synthesizer_stream',
    onChunk,
    onThinkingChunk,
  });

  return {
    answer: response.text,
    citations: response.citations || [],
  };
}

async function runConversationPipeline({
  userInput,
  threadId,
  context,
  onAnswerChunk = null,
  onStage = null,
  onThinkingChunk = null,
}) {
  if (typeof onStage === 'function') {
    await onStage({
      key: 'supervisor',
      phase: 'supervisor',
      message: '대화 맥락과 작업 계획을 정리하고 있습니다.',
    });
  }

  const supervisorPlan = await buildSupervisorPlan(userInput, context);

  if (typeof onStage === 'function') {
    await onStage({
      key: 'supervisor_done',
      phase: 'supervisor_done',
      message: '이번 턴의 전문가 작업 구성을 확정했습니다.',
    });
  }

  if (typeof onStage === 'function') {
    await onStage({
      key: 'specialists',
      phase: 'specialists',
      message: '자산, 기억, 매니저 컨텍스트를 분석하고 있습니다.',
    });
  }

  const specialistResult = await executeSpecialistTasks(supervisorPlan, context, userInput);

  if (typeof onStage === 'function') {
    await onStage({
      key: 'specialist_done',
      phase: 'specialist_done',
      message: '전문가 분석 단계를 마쳤습니다.',
    });
  }

  const synthesizerMessage =
    typeof onAnswerChunk === 'function'
      ? '답변을 스트리밍으로 작성하고 있습니다.'
      : '답변을 작성하고 있습니다.';

  if (typeof onStage === 'function') {
    await onStage({
      key: 'synthesizer',
      phase: 'synth_stream',
      message: synthesizerMessage,
    });
  }

  let synthesisResult;
  if (typeof onAnswerChunk === 'function') {
    synthesisResult = await synthesizeFinalAnswerStream({
      userInput,
      context,
      plan: supervisorPlan,
      specialistOutputs: specialistResult.outputs,
      onChunk: onAnswerChunk,
      onThinkingChunk,
    });
  } else {
    const nonStream = await synthesizeFinalAnswer({
      userInput,
      context,
      plan: supervisorPlan,
      specialistOutputs: specialistResult.outputs,
    });
    synthesisResult = {
      answer: nonStream.answer,
      citations: [],
    };
  }

  let answer = synthesisResult.answer;
  if (specialistResult.specialistFallbackUsed) {
    answer = [
      '> 일부 전문가 단계가 실패해 **조사(research) 전용 폴백**으로 답변을 구성했습니다. 시세·자산 수치는 최신 갱신 여부를 함께 확인해 주세요.',
      '',
      answer,
    ].join('\n');
  }

  return {
    answer,
    supervisorPlan,
    specialistOutputs: specialistResult.outputs,
    specialistFallbackUsed: Boolean(specialistResult.specialistFallbackUsed),
    citations: mergeGroundingSources(specialistResult.citations || [], synthesisResult.citations || []),
  };
}

async function runConversationGraph({
  userInput,
  threadId,
  context,
  onAnswerChunk = null,
  onStage = null,
  onThinkingChunk = null,
}) {
  if (!isAiConfigured()) {
    throw new Error('GEMINI_API_KEY가 설정되지 않아 채팅 기능이 비활성화되어 있습니다.');
  }

  const startedAt = Date.now();
  logInfo('ai.graph.start', {
    threadId,
    userInputPreview: String(userInput || '').slice(0, 160),
    recentMessageCount: Array.isArray(context?.recentMessages) ? context.recentMessages.length : 0,
  });

  let result;
  try {
    result = await runConversationPipeline({
      userInput,
      threadId,
      context,
      onAnswerChunk,
      onStage,
      onThinkingChunk,
    });

    logInfo('ai.graph.finish', {
      threadId,
      durationMs: Date.now() - startedAt,
      actionCount: Array.isArray(result.supervisorPlan?.actions) ? result.supervisorPlan.actions.length : 0,
      taskCount: Array.isArray(result.specialistOutputs) ? result.specialistOutputs.length : 0,
      answerPreview: String(result.answer || '').slice(0, 200),
    });
  } catch (error) {
    logError('ai.graph.failed', error, {
      threadId,
      durationMs: Date.now() - startedAt,
      userInputPreview: String(userInput || '').slice(0, 160),
    });
    throw error;
  }

  return {
    answer: result.answer,
    supervisorPlan: result.supervisorPlan,
    specialistOutputs: result.specialistOutputs,
    citations: result.citations || [],
    actions: result.supervisorPlan?.actions || [],
    workspacePatch: result.supervisorPlan?.workspacePatch || null,
  };
}

async function summarizeThread({ threadId, recentTranscript, existingSummary, sourceMessageIds }) {
  const fallback = {
    summary: existingSummary || '요약을 생성하지 못했습니다.',
    importantFacts: [],
    unresolvedQuestions: [],
    personaHints: [],
    tags: [],
  };

  const result = await generateStructuredOutput(
    {
      systemPrompt: [
        '당신은 대화 장기기억 정리 담당자다.',
        '최근 대화를 읽고 장기적으로 유용한 사실, 사용자 선호, 미해결 질문을 추린다.',
        '투자 조언을 새로 만들지 말고 대화에서 드러난 정보만 정리한다.',
      ].join('\n'),
      userPrompt: JSON.stringify(
        {
          threadId,
          existingSummary,
          recentTranscript,
        },
        null,
        2
      ),
      schema: THREAD_SUMMARY_SCHEMA,
    },
    fallback
  );

  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    threadId,
    summary: result.summary,
    importantFacts: result.importantFacts || [],
    unresolvedQuestions: result.unresolvedQuestions || [],
    personaHints: result.personaHints || [],
    tags: result.tags || [],
    createdAt: now,
    updatedAt: now,
    sourceMessageIds,
  };
}

async function inferAiProfile({ userProfile, threadSummaries, longTermMemories, managerReports }) {
  const fallback = {
    summary: '',
    inferredTraits: [],
    preferences: [],
    concerns: [],
  };

  const result = await generateStructuredOutput(
    {
      systemPrompt: [
        '당신은 사용자 프로필 추론기다.',
        '명시적 사용자 입력과 대화 기억을 바탕으로 투자 성향, 응답 선호, 우려 요소를 요약한다.',
        '과도한 추측은 피하고 근거가 부족한 항목은 생략한다.',
      ].join('\n'),
      userPrompt: JSON.stringify(
        {
          userProfile,
          threadSummaries: (threadSummaries || []).slice(0, 6),
          longTermMemories: (longTermMemories || []).slice(0, 10),
          managerReports: (managerReports || []).slice(0, 3),
        },
        null,
        2
      ),
      schema: PROFILE_SCHEMA,
    },
    fallback
  );

  return {
    summary: result.summary,
    inferredTraits: result.inferredTraits || [],
    preferences: result.preferences || [],
    concerns: result.concerns || [],
    updatedAt: new Date().toISOString(),
  };
}

async function buildManagerReport({ portfolio, profile, memory, trigger, extraContext = '' }) {
  const fallback = {
    summary: 'AI 브리핑을 생성하지 못했습니다.',
    dailyObjective: '',
    actionItems: [],
    riskChecks: [],
    allocationNotes: [],
    conversationInsights: [],
    profileUpdates: [],
  };

  const targetDate = getDateInTimezone(new Date(), APP_TIMEZONE);
  const trimmedExtra = String(extraContext || '').trim();
  const result = await generateStructuredOutput(
    {
      systemPrompt: [
        '당신은 개인 자산 운영을 돕는 Quant Manager다.',
        '보유 자산, 최근 스냅샷, 대화 기억, 사용자 성향을 함께 읽고 오늘의 관리 지시를 만든다.',
        '실행 항목은 과장 없이 현실적인 수준으로 작성한다.',
        trimmedExtra
          ? 'scheduledContext 필드는 사용자가 예약 작업에 남긴 추가 지시이므로 브리핑에 반영한다.'
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      userPrompt: JSON.stringify(
        {
          targetDate,
          trigger,
          portfolio,
          profile,
          memory,
          ...(trimmedExtra ? { scheduledContext: trimmedExtra } : {}),
        },
        null,
        2
      ),
      schema: MANAGER_REPORT_SCHEMA,
    },
    fallback,
    {
      throwOnParseFailure: true,
    }
  );

  return {
    id: randomUUID(),
    targetDate,
    createdAt: new Date().toISOString(),
    trigger,
    model: GEMINI_MODEL,
    summary: result.summary,
    dailyObjective: result.dailyObjective,
    actionItems: result.actionItems || [],
    riskChecks: result.riskChecks || [],
    allocationNotes: result.allocationNotes || [],
    conversationInsights: result.conversationInsights || [],
    profileUpdates: result.profileUpdates || [],
  };
}

async function runScheduledIndicatorAnalysis({
  title,
  description,
  prompt,
  indicatorName,
  portfolio,
  profile,
  memory,
}) {
  if (!isAiConfigured()) {
    throw new Error('GEMINI_API_KEY가 설정되지 않아 AI 기능이 비활성화되어 있습니다.');
  }

  const name = String(indicatorName || '').trim();
  const extra = String(prompt || description || '').trim();
  const userPrompt = JSON.stringify(
    {
      scheduledTaskTitle: String(title || '').trim(),
      indicatorName: name,
      instructions: extra || '지표·시장 관점에서 요약하고 사용자 포트폴리오와 연결할 수 있으면 연결한다.',
      portfolio,
      userProfile: profile?.userProfile || {},
      market: memory?.market || {},
    },
    null,
    2
  );

  const response = await generateContent({
    systemPrompt: [
      '당신은 개인 투자자를 돕는 시장·지표 리서처다.',
      'Google 검색으로 최근 시황·뉴스·지표 해석을 확인하고, 확인한 사실만 간결히 정리한다.',
      '한국어로 12문장 이내, 불필요한 인사말 없이 핵심 위주로 작성한다.',
    ].join('\n'),
    userPrompt,
    useGoogleSearch: true,
    logLabel: 'scheduled_indicator',
  });

  return extractTextFromResponse(response);
}

async function runScheduledCustomAnalysis({ title, description, prompt, portfolio, profile, memory }) {
  if (!isAiConfigured()) {
    throw new Error('GEMINI_API_KEY가 설정되지 않아 AI 기능이 비활성화되어 있습니다.');
  }

  const userInstructions = String(prompt || '').trim();
  if (!userInstructions) {
    throw new Error('예약 작업에 실행 프롬프트(prompt)가 없습니다.');
  }

  const userPrompt = JSON.stringify(
    {
      scheduledTaskTitle: String(title || '').trim(),
      taskDescription: String(description || '').trim(),
      userInstructions,
      portfolio,
      userProfile: profile?.userProfile || {},
      market: memory?.market || {},
      longTermMemories: (memory?.longTermMemories || []).slice(0, 8),
    },
    null,
    2
  );

  const response = await generateContent({
    systemPrompt: [
      '당신은 개인 자산·투자 보조 에이전트다.',
      '사용자가 예약한 지시(userInstructions)에만 집중해 실행 가능한 요약과 체크리스트를 만든다.',
      '한국어로 작성하고, 불필요한 인사말은 생략한다.',
    ].join('\n'),
    userPrompt,
    useGoogleSearch: false,
    logLabel: 'scheduled_custom',
  });

  return extractTextFromResponse(response);
}

module.exports = {
  AI_DAILY_CRON,
  GEMINI_MODEL,
  GEMINI_INCLUDE_THOUGHTS,
  GEMINI_THINKING_BUDGET,
  APP_TIMEZONE,
  isAiConfigured,
  getAiSettings,
  runConversationGraph,
  summarizeThread,
  inferAiProfile,
  buildManagerReport,
  runScheduledIndicatorAnalysis,
  runScheduledCustomAnalysis,
};

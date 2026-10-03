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
const {
  isAiConfigured,
  createGeminiClient,
  runWithLlmMeta,
  getAiTransportLabel,
  isGatewayMode,
} = require('./geminiClient');
const { recordAiLatency } = require('./aiLatencyMetrics');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
/** @see https://ai.google.dev/gemini-api/docs/models — 기본 Stable: Gemini 3.5 Flash */
/** 마지막으로 게이트웨이가 실제로 쓴 모델·사업자. 없으면 null(=모른다) */
let lastServedBy = null;

const GEMINI_MODEL =
  String(process.env.GEMINI_MODEL ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '') || 'gemini-3.5-flash';
/** supervisor/planning도 동일 계열 모델 사용 (구조화 JSON + 액션 정확도). */
const GEMINI_SUPERVISOR_MODEL =
  String(process.env.GEMINI_SUPERVISOR_MODEL ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '') || 'gemini-3.5-flash';
const GEMINI_INCLUDE_THOUGHTS =
  String(process.env.GEMINI_INCLUDE_THOUGHTS ?? 'false').trim().toLowerCase() === 'true';
const GEMINI_THINKING_BUDGET = Math.min(
  8192,
  Math.max(0, Number.parseInt(String(process.env.GEMINI_THINKING_BUDGET || '1024'), 10) || 1024)
);
const GEMINI_TIMEOUT_MS = Math.max(15_000, Number(process.env.GEMINI_TIMEOUT_MS) || 60_000);
const GEMINI_SUPERVISOR_TIMEOUT_MS = Math.max(
  15_000,
  Number(process.env.GEMINI_SUPERVISOR_TIMEOUT_MS) || 30_000
);
const GEMINI_MAX_RETRIES = Math.max(0, Number(process.env.GEMINI_MAX_RETRIES) || 2);
const GEMINI_RETRY_BASE_MS = Math.max(250, Number(process.env.GEMINI_RETRY_BASE_MS) || 1_500);
const usePresetBriefSchedule =
  String(process.env.MANAGER_BRIEF_PRESET_SCHEDULE ?? 'true').trim().toLowerCase() !== 'false';

let googleGenAiModulePromise = null;









function readAiRuntime() {
  return getEffectiveAiConfig();
}

function extractUsageFromResponse(response) {
  const usage = response?.usageMetadata || response?.usage_metadata || {};
  return {
    promptTokens: Number(usage.promptTokenCount || usage.prompt_tokens || 0),
    candidatesTokens: Number(usage.candidatesTokenCount || usage.candidates_tokens || 0),
    totalTokens: Number(usage.totalTokenCount || usage.total_tokens || 0),
    /**
     * 🔴 thinking 토큰 (2026-09-23) — maxOutputTokens 예산을 **생각이** 먹는지 **답이** 먹는지
     *    이게 없으면 영영 못 가른다(잘림 9연발의 원인 후보). 없으면 0 이 아니라 null —
     *    "안 쟀다" 와 "0 이다" 는 다르다.
     */
    thoughtsTokens: usage.thoughtsTokenCount != null || usage.thoughts_token_count != null
      ? Number(usage.thoughtsTokenCount ?? usage.thoughts_token_count)
      : null,
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
    transport: getAiTransportLabel(),
    gatewayMode: isGatewayMode(),
    streamThoughts: runtime.includeThoughts,
    thinkingBudget: runtime.thinkingBudget,
    thinkingLevel: runtime.includeThoughts ? `thoughts+budget:${runtime.thinkingBudget}` : 'off',
    presetId: runtime.presetId,
    source: runtime.source,
    envDefaults: env,
    presets: AI_PRESETS,
    savedSettings: loadSettings().ai,
    timezone: APP_TIMEZONE,
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

function isGemini3Model(model) {
  return /gemini-3(?:\.5)?[.-]/.test(model || '');
}

function budgetToThinkingLevel(budget) {
  if (budget <= 512) return 'low';
  if (budget <= 2048) return 'medium';
  return 'high';
}

async function buildGenerateConfig({ schema = null, useGoogleSearch = false, streamWithThoughts = false, maxOutputTokens = null }) {
  const runtime = readAiRuntime();
  const config = {
    ...(useGoogleSearch ? { tools: [{ googleSearch: {} }] } : {}),
    /**
     * 🔴 출력 토큰 하드캡 (2026-09-23) — 생성 속도가 초당 ~24토큰으로 고정이라(게이트웨이 실측)
     *    출력 길이가 곧 시간이다: 120초 예산 ≈ 2,900토큰. 브리핑이 3,115~3,550토큰을 써서
     *    이틀 연속 3/3 타임아웃했다. 프롬프트 지시가 1차 방어, 이 캡이 2차 안전망이다.
     * ⚠️ 캡에 잘리면 JSON 이 불완전해 파싱 실패 → 재시도가 감당한다(잘린 시도는 빨리 끝나므로
     *    타임아웃 3회(364초 소진)보다 훨씬 싸다). 게이트웨이가 이 키를 무시하면 무해하게 없던 일이 된다.
     */
    ...(Number(maxOutputTokens) > 0 ? { maxOutputTokens: Math.floor(Number(maxOutputTokens)) } : {}),
  };

  if (streamWithThoughts && runtime.includeThoughts && runtime.thinkingBudget > 0) {
    if (isGemini3Model(runtime.model)) {
      config.thinkingConfig = {
        includeThoughts: true,
        thinkingLevel: budgetToThinkingLevel(runtime.thinkingBudget),
      };
    } else {
      config.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: runtime.thinkingBudget,
      };
    }
  }

  if (!schema) {
    return config;
  }

  /**
   * 🔴 구조화 출력은 thinking 을 **끈다** (2026-09-23 실측 확정) — 종전엔 안 보내서
   *    모델 기본(reasoning ON)이 됐고, 출력 예산 2,400 을 **생각이 전부** 먹어 본문이
   *    0토큰이었다(candidates == thoughts == 2400). 프롬프트 자수 지시가 3전 3패한
   *    이유다 — 자수 지시는 답을 줄이지 생각을 못 줄인다.
   * 🔴 **모델 이름으로 분기하지 않는다** — 앱이 부르는 이름(gemini-3.5-flash)과 실제
   *    모델(deepseek-v4-flash)이 다르다(게이트웨이가 라우팅). isGemini3Model 분기로
   *    thinkingLevel:'low' 를 보냈더니 "적게 생각"일 뿐 안 꺼졌다(실측: low → thoughts 413 /
   *    budget 0 → thoughts 0, 8.8초 → 2.3초). 진짜 Gemini 직결 경로가 생기면 그때
   *    servedBy 근거로 예외를 두고 이유를 적을 것.
   * ⚠️ 게이트웨이가 이 키를 무시하면 무해하게 없던 일이 된다.
   */
  config.thinkingConfig = { thinkingBudget: 0 };

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
  /**
   * 🔴 **`kind` 를 메시지 정규식보다 먼저 본다** (2026-09-28, pm1 위임 — worker2 실사고
   *    분석 후속). 잘림(`output_truncated`)은 같은 프롬프트가 같은 길이로 또 잘리므로
   *    재시도가 낭비다. ⚠️ 기존 메시지 정규식 판정은 지우지 않는다 — `kind` 가 없으면
   *    종전 그대로(다른 오류 종류가 거기 걸려 있다).
   */
  if (error.kind === 'output_truncated') return false;
  if (error.retryable || error.code === 'AI_TIMEOUT') return true;

  const status = Number(error.status || error.statusCode || error.cause?.status || 0);
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const message = String(error.message || error);
  return /(fetch failed|sending request|network|socket|timed out|timeout|econnreset|etimedout|eai_again|enotfound|unavailable|resource_exhausted|temporarily unavailable|overloaded|internal server error|service unavailable|got status: 5\d\d)/i.test(
    message
  );
}

/**
 * 🔴 **원인의 `kind` 를 잃지 않는다** (2026-09-28, pm1 위임) — 이 함수는 원인을 감싸
 *    **새 `Error`** 로 갈아치우는데, 그러면서 `kind`(예: `'output_truncated'`)가
 *    사라지고 있었다("자기가 만든 값을 자기가 지운다"). 호출자가 이미 보는 모양
 *    (`Error` 인스턴스 + `.message`)은 그대로 두고, `kind` 가 있으면 **그대로 옮겨 붙인다.**
 */
function buildAiUserFacingError(error, { maxAttempts, effectiveTimeoutMs } = {}) {
  const withKind = (err) => {
    if (error?.kind) err.kind = error.kind;
    return err;
  };

  /**
   * 🔴 **잘림은 "다시 시도" 가 거짓말이다** — 같은 프롬프트는 같은 길이로 또 잘린다
   *    (aiService.js:829 주석 참조). 구체적인 다음 행동(줄이라)이 없으면 안 적는다 —
   *    "관리자에게 문의" 류는 사용자가 곧 관리자라 의미가 없다.
   */
  if (error?.kind === 'output_truncated') {
    return withKind(new Error(
      '분석 결과가 출력 상한에 잘려 불완전합니다 — 같은 요청은 다시 해도 같은 길이에서 또 잘립니다. '
      + '프롬프트나 확인할 종목 수를 줄여야 합니다.'
    ));
  }

  if (error?.code === 'AI_TIMEOUT') {
    const seconds = Math.round((effectiveTimeoutMs || GEMINI_TIMEOUT_MS) / 1000);
    return withKind(new Error(
      `AI 응답이 ${seconds}초 안에 완료되지 않아 중단했습니다. 잠시 후 다시 시도해 주세요.`
    ));
  }

  if (isRetryableAiError(error)) {
    return withKind(new Error(
      maxAttempts > 1
        ? 'AI 응답 생성이 일시적으로 불안정했습니다. 자동 재시도 후에도 완료되지 않아 중단했습니다. 잠시 후 다시 시도해 주세요.'
        : 'AI 응답 생성이 일시적으로 불안정합니다. 잠시 후 다시 시도해 주세요.'
    ));
  }

  return withKind(new Error('AI 응답 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.'));
}

async function generateContent({
  systemPrompt,
  userPrompt,
  schema = null,
  useGoogleSearch = false,
  logLabel = 'generate_content',
  modelOverride = null,
  timeoutOverrideMs = null,
  maxOutputTokens = null,
}) {
  if (!isAiConfigured()) {
    throw new Error('AI가 설정되지 않아 요청을 처리할 수 없습니다. GEMINI_API_KEY 또는 GEMINI_GATEWAY_BASE_URL을 확인하세요.');
  }

  const ai = await createGeminiClient();
  const runtime = readAiRuntime();
  const effectiveModel = modelOverride || runtime.model;
  const effectiveTimeoutMs = timeoutOverrideMs || GEMINI_TIMEOUT_MS;
  const startedAt = Date.now();
  const maxAttempts = GEMINI_MAX_RETRIES + 1;
  /**
   * 🔴 출력 캡을 **시간예산에서 유도**한다 (2026-09-23) — 값을 호출부마다 두면
   *    하나가 빠진 채 "형제 파일 중 하나만 빠졌다" 가 된다(실제로 세 경로 전부 빠져 있었다).
   *    생성 속도 ~24토큰/초(게이트웨이 실측, 23.9~26.8) × 예산 × 0.9 여유.
   *    120초 예산이면 2,592토큰 — 이걸 넘는 출력은 어차피 타임아웃으로 통째로 버려지면서
   *    돈만 태운다(09-23 실측: 하루 지출의 81%가 버려진 토큰이었다).
   *    호출부가 더 작은 값을 명시하면 그것을 쓴다(큰 값은 예산 밖이라 자동값으로 좁힌다).
   */
  const autoCap = Math.floor((effectiveTimeoutMs / 1000) * 24 * 0.9);
  const effectiveMaxOutputTokens = Number(maxOutputTokens) > 0
    ? Math.min(Math.floor(Number(maxOutputTokens)), autoCap)
    : autoCap;
  const config = await buildGenerateConfig({ schema, useGoogleSearch, maxOutputTokens: effectiveMaxOutputTokens });

  logInfo('ai.generate.start', {
    logLabel,
    model: effectiveModel,
    streamThoughts: runtime.includeThoughts,
    useGoogleSearch,
    hasSchema: Boolean(schema),
    timeoutMs: effectiveTimeoutMs,
    maxAttempts,
    systemPromptPreview: String(systemPrompt || '').slice(0, 160),
    userPromptPreview: String(userPrompt || '').slice(0, 200),
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStartedAt = Date.now();
    let emittedChunk = false;

    try {
      // 게이트웨이가 돌려주는 `x-llm-model`/`x-llm-provider` 를 이 호출 범위에서만 잡는다.
      // (SDK 가 헤더를 안 주므로 fetch 를 감싼다. 동시 호출이 섞이지 않게 ALS 를 쓴다)
      const { value: response, meta: servedBy } = await runWithLlmMeta(() =>
        withTimeout(
          ai.models.generateContent({
            model: effectiveModel,
            contents: buildEnvelope(systemPrompt, userPrompt),
            config,
          }),
          effectiveTimeoutMs
        )
      );
      // ⚠️ 헤더가 없으면 null 이다. **요청한 이름으로 메우지 않는다.**
      if (servedBy) lastServedBy = servedBy;

      const usageNow = extractUsageFromResponse(response);
      logInfo('ai.generate.finish', {
        logLabel,
        attempt,
        durationMs: Date.now() - startedAt,
        attemptDurationMs: Date.now() - attemptStartedAt,
        outputPreview: extractTextFromResponse(response).slice(0, 200),
        groundingSourceCount: getGroundingSources(response).length,
        // 🔴 생각/답 분해 — maxOutputTokens 를 누가 먹는지 앱 로그에서도 갈리게 (null = 안 재짐)
        promptTokens: usageNow.promptTokens,
        candidatesTokens: usageNow.candidatesTokens,
        thoughtsTokens: usageNow.thoughtsTokens,
        /**
         * 🔴 실제로 답한 모델 (2026-09-23) — 요청 모델명(gemini-3.5-flash)과 실제 서빙
         *    모델(deepseek-v4-flash)이 **다르다**(게이트웨이 라우팅). 이걸 안 찍어서
         *    "gemini 의 thinking 을 끄자" 며 대상이 틀린 처방을 반나절 논했다.
         */
        servedBy: servedBy ? `${servedBy.provider || ''}/${servedBy.model || ''}` : null,
      });

      await trackAiUsage(response, logLabel);
      recordAiLatency({
        logLabel,
        durationMs: Date.now() - startedAt,
        success: true,
        transport: getAiTransportLabel(),
        model: effectiveModel,
        streaming: false,
      });
      /**
       * 🔴 캡에 잘린 답은 **성공이 아니다** (2026-09-23 dryRun 실증) — JSON 이 중간에 끊겨
       *    파싱이 fallback 을 돌려주고, 빈 브리핑이 **성공으로 보였다**(타임아웃은 task_failed
       *    로 알리는데 빈 결과는 아무도 모른다 — 증상만 바뀐 같은 병).
       *    재시도하지 않는다: 같은 프롬프트는 같은 길이를 또 쓴다(메시지도 재시도 판정에
       *    안 걸리는 단어로 썼다). 실패로 승격해 통보 경로(task_failed)를 태운다.
       */
      const finishReason = String(response?.candidates?.[0]?.finishReason || '').toUpperCase();
      if (finishReason === 'MAX_TOKENS') {
        logWarn('ai.generate.truncated', { logLabel, maxOutputTokens: effectiveMaxOutputTokens, attempt });
        const truncErr = new Error(
          `AI 출력이 상한(${effectiveMaxOutputTokens}토큰)에 잘려 불완전합니다. 출력을 줄이도록 프롬프트·스키마를 좁혀야 합니다.`
        );
        truncErr.kind = 'output_truncated';
        throw truncErr;
      }
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

      const userFacingError = buildAiUserFacingError(error, { maxAttempts, effectiveTimeoutMs });
      recordAiLatency({
        logLabel,
        durationMs: Date.now() - startedAt,
        success: false,
        transport: getAiTransportLabel(),
        model: effectiveModel,
        streaming: false,
      });
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
    throw buildAiUserFacingError(error, { maxAttempts, effectiveTimeoutMs });
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
    throw new Error('AI가 설정되지 않아 요청을 처리할 수 없습니다. GEMINI_API_KEY 또는 GEMINI_GATEWAY_BASE_URL을 확인하세요.');
  }

  const ai = await createGeminiClient();
  const runtime = readAiRuntime();
  const startedAt = Date.now();
  const maxAttempts = GEMINI_MAX_RETRIES + 1;
  /**
   * ⚠️ 스트림에도 캡을 건다 (2026-09-23) — 캡 없는 경로가 하나라도 남으면 "형제 하나 빠짐" 이다
   *    (게이트웨이 실측: 캡 밖 경로가 output 20,634토큰 = 820초 = 회차 ₩4 를 태웠다).
   *    스트림은 사람이 실시간으로 읽는 경로라 구조적 예산이 없다 — 4,096(약 170초)로 넉넉히.
   */
  const config = await buildGenerateConfig({ useGoogleSearch, streamWithThoughts: true, maxOutputTokens: 4096 });

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

      recordAiLatency({
        logLabel,
        durationMs: Date.now() - startedAt,
        success: true,
        transport: getAiTransportLabel(),
        model: runtime.model,
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
      recordAiLatency({
        logLabel,
        durationMs: Date.now() - startedAt,
        success: false,
        transport: getAiTransportLabel(),
        model: runtime.model,
        streaming: true,
      });
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
    recordAiLatency({
      logLabel,
      durationMs: Date.now() - startedAt,
      success: false,
      transport: getAiTransportLabel(),
      model: runtime.model,
      streaming: true,
    });
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
  const logLabel = options.logLabel || 'structured_output';
  const parsed = safeParseJson(extractTextFromResponse(response), fallback, {
    throwOnFailure: Boolean(extraOptions.throwOnParseFailure),
    logLabel,
  });

  /**
   * 🔴 JSON 파싱은 성공했는데 결과가 "객체가 아닌" 경우 (2026-09-28) — 모델이 최상위로
   *    null·문자열·숫자·불리언을 뱉으면 `JSON.parse` 는 성공하고 그 값이 그대로 호출부로
   *    간다. 호출부는 `result.summary` 처럼 속성을 바로 읽어 TypeError 로 크래시한다
   *    (정적 분석 확정 9곳: aiService/managerService/stockRating).
   *
   *    배열은 다르게 다룬다 — 배열은 크래시가 아니라 조용한 `undefined` 를 만들 뿐이고,
   *    배열 응답을 정상 처리하는 호출부(예: analystChat 의 shapeToolCalls)가 실재하므로
   *    폴백으로 바꾸면 **정상 응답을 잃는다.** 그래서 배열은 로그만 남기고 그대로 통과시킨다.
   */
  const fallbackIsObject = typeof fallback === 'object' && fallback !== null;

  if (Array.isArray(parsed)) {
    logWarn('ai.json_shape_array', {
      logLabel,
      receivedType: 'array',
      preview: JSON.stringify(parsed).slice(0, 240),
    });
    return parsed;
  }

  if (fallbackIsObject && (parsed === null || typeof parsed !== 'object')) {
    logWarn('ai.json_shape_mismatch', {
      logLabel,
      receivedType: parsed === null ? 'null' : typeof parsed,
      preview: JSON.stringify(parsed).slice(0, 240),
    });
    return fallback;
  }

  return parsed;
}
















module.exports = {
  /**
   * ⚠️ 2026-10-03 — v2(대화 그래프·매니저 보고·예약 분석)를 걷어내고 **LLM 클라이언트만**
   *    남겼다. 이 파일의 일은 하나다: 게이트웨이로 LLM 을 안전하게 부르는 것
   *    (타임아웃·재시도·스키마 변환·토큰 집계). 판단·프롬프트는 호출자의 일이다.
   */
  GEMINI_MODEL,
  GEMINI_INCLUDE_THOUGHTS,
  GEMINI_THINKING_BUDGET,
  APP_TIMEZONE,
  isAiConfigured,
  getAiSettings,
  generateStructuredOutput,
  generateContent,
  generateContentStream,
  isRetryableAiError,
  buildAiUserFacingError,
};

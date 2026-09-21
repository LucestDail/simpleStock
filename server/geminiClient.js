const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const GEMINI_GATEWAY_BASE_URL = String(process.env.GEMINI_GATEWAY_BASE_URL || '').trim();
const GEMINI_GATEWAY_TOKEN = String(process.env.GEMINI_GATEWAY_TOKEN || '').trim();
const GEMINI_SERVICE_ID = String(process.env.GEMINI_SERVICE_ID || 'simpleStock').trim();

const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * 게이트웨이가 **실제로 쓴 모델·사업자**를 잡아 둔다 (2026-09-21)
 *
 * 화면에 `gemini-3.5-flash` 가 떴는데 사용자가 물었다: *"이거 맞아? openRouter 쓰잖아."*
 * 맞는 지적이었다 — 그건 **우리가 요청한 이름**이고, 실제로는 게이트웨이가
 * OpenRouter 로 보내 그때그때 다른 사업자가 답한다(usage 기록으로 확인).
 *
 * pm2 가 게이트웨이에 응답 헤더를 붙였다: `x-llm-model` · `x-llm-provider`.
 * 🔴 그런데 `@google/genai` SDK 는 **응답 헤더를 안 돌려준다**(HttpOptions 에 fetch 훅도 없다).
 * ⇒ `global.fetch` 를 감싸 게이트웨이 응답에서만 헤더를 읽는다.
 *
 * ⚠️ 전역을 감싸면 **동시 호출이 서로의 값을 덮어쓴다**(브리핑은 supervisor+synthesis 가 겹친다).
 *    그래서 전역 변수가 아니라 **AsyncLocalStorage** 에 담는다 — 호출마다 자기 저장소를 갖는다.
 * ⚠️ 헤더가 없으면 **비워 둔다.** 없는 것을 요청 이름으로 메우면 처음 문제로 돌아간다
 *    ("모른다" 가 "틀린 값" 보다 낫다).
 */
const llmMetaStore = new AsyncLocalStorage();
/**
 * 우리가 설치한 래퍼. 🔴 처음 한 번만 감싸면, **나중에 누가 global.fetch 를 바꿀 때
 * 포착이 조용히 멈춘다**(테스트가 이걸 먼저 잡았다 — 실패가 아니라 값이 안 잡히는
 * 모양이라 제품에서도 아무 소리 없이 "모델 미상" 이 됐을 것이다).
 * ⇒ 호출 때마다 **현재 fetch 가 내 래퍼인지 확인**하고, 아니면 그것을 감싼다.
 */
let installedWrapper = null;

function installFetchProbe() {
  if (global.fetch === installedWrapper) return;
  const original = global.fetch;
  global.fetch = async (input, init) => {
    const res = await original(input, init);
    try {
      const store = llmMetaStore.getStore();
      const url = String(typeof input === 'string' ? input : input?.url || '');
      if (store && GEMINI_GATEWAY_BASE_URL && url.startsWith(GEMINI_GATEWAY_BASE_URL.replace(/\/$/, ''))) {
        const model = res.headers?.get?.('x-llm-model');
        const provider = res.headers?.get?.('x-llm-provider');
        if (model) store.model = model;
        if (provider) store.provider = provider;
      }
    } catch {
      // 관측이 제품을 깨뜨리면 안 된다 — 실패하면 그냥 모르는 채로 둔다
    }
    return res;
  };
  installedWrapper = global.fetch;
}

/** 테스트용 — 래퍼를 떼어 낸다 */
function _resetFetchProbe() {
  installedWrapper = null;
}

/** 이 안에서 일어난 게이트웨이 호출의 실제 모델·사업자를 모아 돌려준다 */
async function runWithLlmMeta(fn) {
  installFetchProbe();
  const store = {};
  const value = await llmMetaStore.run(store, fn);
  return { value, meta: store.model || store.provider ? { ...store } : null };
}

function isGatewayMode() {
  return Boolean(GEMINI_GATEWAY_BASE_URL);
}

function isAiConfigured() {
  return Boolean(GEMINI_API_KEY || isGatewayMode());
}

function buildGeminiClientOptions() {
  if (!isGatewayMode()) {
    return { apiKey: GEMINI_API_KEY };
  }

  const headers = {
    'x-service-id': GEMINI_SERVICE_ID || 'simpleStock',
  };
  if (GEMINI_GATEWAY_TOKEN) {
    headers['x-gateway-token'] = GEMINI_GATEWAY_TOKEN;
  }

  return {
    apiKey: GEMINI_API_KEY || 'via-gateway',
    httpOptions: {
      baseUrl: GEMINI_GATEWAY_BASE_URL.replace(/\/$/, ''),
      headers,
    },
  };
}

async function createGeminiClient() {
  const { GoogleGenAI } = await import('@google/genai');
  return new GoogleGenAI(buildGeminiClientOptions());
}

function getAiTransportLabel() {
  if (isGatewayMode()) {
    return `gateway:${GEMINI_GATEWAY_BASE_URL}`;
  }
  return 'direct';
}

module.exports = {
  runWithLlmMeta,
  _resetFetchProbe,
  isGatewayMode,
  isAiConfigured,
  createGeminiClient,
  getAiTransportLabel,
  GEMINI_API_KEY,
};

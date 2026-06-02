const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const GEMINI_GATEWAY_BASE_URL = String(process.env.GEMINI_GATEWAY_BASE_URL || '').trim();
const GEMINI_GATEWAY_TOKEN = String(process.env.GEMINI_GATEWAY_TOKEN || '').trim();
const GEMINI_SERVICE_ID = String(process.env.GEMINI_SERVICE_ID || 'simpleStock').trim();

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
  isGatewayMode,
  isAiConfigured,
  createGeminiClient,
  getAiTransportLabel,
  GEMINI_API_KEY,
};

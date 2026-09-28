const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

/**
 * `generateStructuredOutput` — JSON 파싱은 성공했지만 결과가 "객체가 아닌" 경우
 * (2026-09-28, pm1 위임).
 *
 * `safeParseJson` 은 `JSON.parse` 가 **실패**할 때만 로그+폴백을 낸다. 모델이 최상위로
 * `null`·문자열·숫자·불리언을 뱉으면 파싱은 **성공**하고 그 값이 그대로 호출부로 간다.
 * 호출부는 `result.summary` 처럼 속성을 바로 읽어 TypeError 로 크래시한다.
 *
 * 이 파일은 그 자리(`generateStructuredOutput`, aiService.js:1112)만 잰다. 모델 호출은
 * `geminiClient` 를 `require.cache` 로 갈아끼워 가짜로 만든다(analystChat.test.js 와 같은
 * 수법) — 실 LLM 호출·분석 트리거는 하지 않는다.
 *
 * ⚠️ 이 파일은 `server/aiService.js` 만 건드린다. 같은 날 다른 worker 가
 * `analystChat.js`/`analystDream.js`/`analystService.js`/`stockRating.js` 에서 "fallback
 * 위치 인자 누락" 이라는 **다른 결함**을 고치고 있다 — 이 파일은 그것과 무관하다
 * (`tests/generateStructuredOutputFallback.test.js` 가 그쪽을 잰다).
 */

let fakeText = '';
let warnLogs = [];

function installFakeAi() {
  const geminiPath = require.resolve('../server/geminiClient');
  const real = require(geminiPath);
  require.cache[geminiPath].exports = {
    ...real,
    isAiConfigured: () => true,
    createGeminiClient: async () => ({
      models: {
        generateContent: async () => ({ text: fakeText }),
      },
    }),
  };

  const loggerPath = require.resolve('../server/logger');
  const realLogger = require(loggerPath);
  require.cache[loggerPath].exports = {
    ...realLogger,
    logWarn: (event, context) => {
      warnLogs.push({ event, context });
    },
  };
}

beforeEach(() => {
  fakeText = '';
  warnLogs = [];
  for (const k of Object.keys(require.cache)) {
    if (/[\\/](aiService|geminiClient|logger)\.js$/.test(k)) delete require.cache[k];
  }
  installFakeAi();
});

afterEach(() => {
  for (const k of Object.keys(require.cache)) {
    if (/[\\/](aiService|geminiClient|logger)\.js$/.test(k)) delete require.cache[k];
  }
});

function shapeWarns() {
  return warnLogs.filter((w) => w.event === 'ai.json_shape_array' || w.event === 'ai.json_shape_mismatch');
}

// ── ① 모델이 null 을 뱉음 + 객체 폴백 → 폴백 반환 + 로그 1건 ─────────────

test('🔴 모델이 최상위 null 을 뱉고 객체 폴백이 선언되면 폴백을 반환하고 logWarn 1건', async () => {
  const ai = require('../server/aiService');
  fakeText = 'null';
  const fallback = { summary: 'fallback-summary', actions: [] };

  const result = await ai.generateStructuredOutput({ systemPrompt: 's', userPrompt: 'u' }, fallback);

  assert.equal(result, fallback, '폴백 객체가 반환되지 않았다(크래시 유발 원시값이 그대로 샜다)');
  assert.equal(shapeWarns().length, 1, `모양-불일치 로그가 정확히 1건이어야 한다 — 실제 ${shapeWarns().length}건`);
  assert.equal(shapeWarns()[0].event, 'ai.json_shape_mismatch');
  assert.equal(shapeWarns()[0].context.receivedType, 'null');
});

// ── ② 모델이 문자열을 뱉음 + 객체 폴백 → 폴백 반환 + 로그 1건 ────────────

test('🔴 모델이 문자열을 뱉고 객체 폴백이 선언되면 폴백을 반환하고 logWarn 1건', async () => {
  const ai = require('../server/aiService');
  fakeText = '"unavailable"';
  const fallback = { summary: 'fallback-summary' };

  const result = await ai.generateStructuredOutput({ systemPrompt: 's', userPrompt: 'u' }, fallback);

  assert.equal(result, fallback, '폴백 객체가 반환되지 않았다');
  assert.equal(shapeWarns().length, 1, `모양-불일치 로그가 정확히 1건이어야 한다 — 실제 ${shapeWarns().length}건`);
  assert.equal(shapeWarns()[0].event, 'ai.json_shape_mismatch');
  assert.equal(shapeWarns()[0].context.receivedType, 'string');
});

// ── ③ 모델이 배열을 뱉음 → 배열 그대로 반환 + 로그 1건(폴백으로 안 바뀜) ──

test('🔴 모델이 배열을 뱉으면 배열이 그대로 반환되고 logWarn 1건(폴백으로 치환되지 않는다)', async () => {
  const ai = require('../server/aiService');
  fakeText = '[1,2,3]';
  const fallback = { tools: [] };

  const result = await ai.generateStructuredOutput({ systemPrompt: 's', userPrompt: 'u' }, fallback);

  assert.deepEqual(result, [1, 2, 3], '배열 응답이 폴백으로 바뀌었다 — 정상 응답을 잃는다');
  assert.equal(shapeWarns().length, 1, `모양 로그가 정확히 1건이어야 한다 — 실제 ${shapeWarns().length}건`);
  assert.equal(shapeWarns()[0].event, 'ai.json_shape_array');
});

// ── ④ 오탐 축(가장 중요): 정상 객체 → 값 그대로 + 로그 0건 ───────────────

test('★ 오탐 축: 모델이 정상 객체를 뱉으면 값 그대로 반환되고 로그는 0건이다', async () => {
  const ai = require('../server/aiService');
  fakeText = '{"summary":"정상 응답입니다","actions":[]}';
  const fallback = { summary: 'fallback-summary', actions: [] };

  const result = await ai.generateStructuredOutput({ systemPrompt: 's', userPrompt: 'u' }, fallback);

  assert.deepEqual(result, { summary: '정상 응답입니다', actions: [] }, '정상 객체 응답이 훼손됐다');
  assert.equal(shapeWarns().length, 0, `정상 객체인데 모양 로그가 났다(오탐) — 실제 ${shapeWarns().length}건: ${JSON.stringify(shapeWarns())}`);
});

// ── ⑤ fallback 이 객체가 아님(null) + 모델이 null → 종전과 동일, 크래시 없음 ──

test('⚠️ fallback 이 객체가 아니면(null) 모델이 null 을 뱉어도 값을 그대로 반환한다(바꿀 폴백이 없다)', async () => {
  const ai = require('../server/aiService');
  fakeText = 'null';

  const result = await ai.generateStructuredOutput({ systemPrompt: 's', userPrompt: 'u' }, null, { throwOnParseFailure: false });

  assert.equal(result, null, 'fallback 이 객체가 아닌데 값이 바뀌었다');
  assert.equal(shapeWarns().length, 0, `바꿀 폴백이 없는데 모양 로그가 났다 — 실제 ${shapeWarns().length}건`);
});

// ── ⑥ 변이 검증 준비: 숫자/불리언도 같은 규칙을 탄다(회귀 방지, ①②의 형제) ──

test('⚠️ 회귀: 모델이 숫자/불리언을 뱉어도(객체 폴백) 폴백으로 치환된다', async () => {
  const ai = require('../server/aiService');
  const fallback = { summary: 'fb' };

  fakeText = '42';
  const numResult = await ai.generateStructuredOutput({ systemPrompt: 's', userPrompt: 'u' }, fallback);
  assert.equal(numResult, fallback, '숫자 응답이 폴백으로 안 바뀌었다');

  warnLogs = [];
  fakeText = 'false';
  const boolResult = await ai.generateStructuredOutput({ systemPrompt: 's', userPrompt: 'u' }, fallback);
  assert.equal(boolResult, fallback, '불리언 응답이 폴백으로 안 바뀌었다');
});

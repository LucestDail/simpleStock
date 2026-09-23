/**
 * 브리핑 출력 예산 (2026-09-23)
 *
 * 배경: 생성 속도가 초당 ~24토큰으로 고정이라(게이트웨이 실측) **출력 길이가 곧 시간**이다.
 * market_briefing 이 3,115~3,550토큰을 써서 120초×3 전부 타임아웃 — 이틀 연속(09-22 06시 ·
 * 09-23 09시) 브리핑이 폰에 안 갔다. 재시도는 낭비였다(같은 프롬프트 = 같은 길이).
 *
 * 이 테스트는 **관계**를 잠근다: 출력 캡 ≤ 시간예산 × 생성속도. 값이 흩어져 있으면
 * 누군가 타임아웃만 줄이거나 캡만 올려서 역전된다(LlmTimeoutOrder 와 같은 가족).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const managerSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'managerService.js'), 'utf8');
const aiSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'aiService.js'), 'utf8');

/** 게이트웨이 실측 생성 속도(초당 토큰) — 23.9~26.8 관측, 보수적으로 24 */
const TOKENS_PER_SEC = 24;
/** market_briefing 이 쓰는 시도당 시간 예산(ms) — managerBrief 는 120초 override */
const BRIEFING_TIMEOUT_MS = 120000;

function briefingCap() {
  const m = managerSrc.match(/logLabel:\s*'market_briefing'[^}]*maxOutputTokens:\s*(\d+)/s);
  return m ? Number(m[1]) : null;
}

test('market_briefing 에 출력 캡이 있고, 시간예산 안에 들어온다', () => {
  const cap = briefingCap();
  // 🔴 캡이 아예 없으면(추출 실패 포함) 실패 — "검사 못 함" 이 통과로 보이면 안 된다
  assert.ok(cap, 'market_briefing 호출에 maxOutputTokens 가 없다(또는 형태가 바뀌어 자가 못 읽는다)');
  const budgetTokens = (BRIEFING_TIMEOUT_MS / 1000) * TOKENS_PER_SEC; // 2,880
  assert.ok(cap <= budgetTokens, `캡 ${cap} 이 시간예산 ${budgetTokens}토큰을 넘는다 — 타임아웃이 캡보다 먼저 온다`);
  assert.ok(cap >= 1200, `캡 ${cap} 이 너무 작다 — 브리핑 5개 절이 다 잘린다`);
});

test('aiService 가 캡을 시간예산에서 유도하고, config 에 실제로 싣는다', () => {
  // 🔴 유도식이 핵심이다 — 호출부마다 값을 두면 "형제 하나 빠짐" 이 재발한다(실제로 세 경로 전부 빠져 있었다)
  assert.match(aiSrc, /autoCap = Math\.floor\(\(effectiveTimeoutMs \/ 1000\) \* 24 \* 0\.9\)/);
  // 호출부 명시값이 자동값(예산)을 넘지 못하는 구조
  assert.match(aiSrc, /Math\.min\(Math\.floor\(Number\(maxOutputTokens\)\), autoCap\)/);
  // buildGenerateConfig 가 받아서 버리지 않고 config 에 싣는다
  assert.match(aiSrc, /maxOutputTokens:\s*Math\.floor\(Number\(maxOutputTokens\)\)/);
  assert.match(aiSrc, /buildGenerateConfig\(\{\s*schema,\s*useGoogleSearch,\s*maxOutputTokens:\s*effectiveMaxOutputTokens\s*\}\)/);
});

test('캡에 잘린 답은 실패로 승격된다 — 그리고 그 에러는 재시도 판정에 안 걸린다', () => {
  // 🔴 dryRun 실증: 잘린 JSON 이 fallback 으로 조용히 통과해 **빈 브리핑이 성공으로 보였다**
  assert.match(aiSrc, /finishReason === 'MAX_TOKENS'/);
  assert.match(aiSrc, /kind = 'output_truncated'/);
  // 에러 메시지가 isRetryableAiError 의 재시도 단어에 걸리면 3배 낭비가 재발한다
  const msgMatch = aiSrc.match(/AI 출력이 상한\([^)]*\)에 잘려[^`']*/);
  assert.ok(msgMatch, '잘림 에러 메시지를 찾지 못했다');
  assert.doesNotMatch(msgMatch[0], /(timeout|timed out|network|unavailable|overloaded)/i);
});

test('스트림 경로(둘 다)에도 캡이 있다 — 캡 밖 경로 하나가 output 20,634토큰을 태웠다', () => {
  const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystChat.js'), 'utf8');
  assert.match(aiSrc, /streamWithThoughts: true, maxOutputTokens: 4096/);
  assert.match(chatSrc, /maxOutputTokens: 4096/);
});

test('초과 실측 3경로(브리핑·분석·평가) 전부에 길이 지시가 있다', () => {
  const ratingSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'stockRating.js'), 'utf8');
  const analystSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf8');
  assert.match(managerSrc, /전체 출력 2,000토큰/); // market_briefing
  assert.match(analystSrc, /전체 출력 2,000토큰 이내/); // trade_analyst
  assert.match(ratingSrc, /전체 출력 2,000토큰 이내/); // 기업 rating
  assert.match(ratingSrc, /전체 출력 1,200토큰 이내/); // fund_rating
});

test('스키마와 프롬프트 양쪽에 개수 상한이 있다 (게이트웨이가 스키마를 무시해도 지시가 남는다)', () => {
  assert.match(managerSrc, /tickerSignals:.*maxItems:\s*8/);
  assert.match(managerSrc, /riskChecks:.*maxItems:\s*5/);
  assert.match(managerSrc, /themeNotes:.*maxItems:\s*5/);
  assert.match(managerSrc, /전체 출력 2,000토큰/);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../server/aiService');

/**
 * 🔴 잘림(`output_truncated`)이 "고칠 수 없는 실패인데 다시 해 보라"고 거짓말하던 것
 * (2026-09-28, pm1 위임 — worker2 가 앞서 찾은 결함).
 *
 * `aiService.js:838` 이 `truncErr.kind = 'output_truncated'` 를 달아도, 같은 함수의
 * `buildAiUserFacingError()`(711행)가 **새 `Error` 로 갈아치워** kind 를 잃는다.
 * `isRetryableAiError()`(696행)도 메시지 정규식만 봐서 kind 를 아예 안 본다.
 *
 * ⇒ 이 파일은 그 두 순수 함수(`isRetryableAiError`·`buildAiUserFacingError`)를 직접 잰다.
 *   실제 LLM 호출·분석 트리거는 하지 않는다(범위 밖).
 */

const truncErr = () => Object.assign(
  new Error('AI 출력이 상한(2592토큰)에 잘려 불완전합니다. 출력을 줄이도록 프롬프트·스키마를 좁혀야 합니다.'),
  { kind: 'output_truncated' }
);

// ── ① kind 보존 ──────────────────────────────────────────────

test('🔴 감싼 뒤에도 kind 를 들고 있다', () => {
  const wrapped = ai.buildAiUserFacingError(truncErr(), { maxAttempts: 3, effectiveTimeoutMs: 120000 });
  assert.equal(wrapped.kind, 'output_truncated', 'buildAiUserFacingError 가 kind 를 잃었다(자기가 만든 값을 자기가 지운다)');
});

// ── ② 사용자 문구 — "다시 시도" 가 아니다, 구체적 다음 행동이 있다 ──────

test('🔴 잘림이면 문구가 "다시 시도" 가 아니고, 구체적 다음 행동을 담는다', () => {
  const wrapped = ai.buildAiUserFacingError(truncErr(), { maxAttempts: 3, effectiveTimeoutMs: 120000 });
  assert.ok(!/다시 시도/.test(wrapped.message), `"다시 시도" 가 남아 있다(거짓말) — 실제: ${wrapped.message}`);
  // ⚠️ "관리자에게 문의" 류 금지 — 사용자가 곧 관리자다. 구체적 행동(줄여야 한다)이 있어야 한다
  assert.match(wrapped.message, /줄여야|줄이/, `구체적 다음 행동이 없다 — 실제: ${wrapped.message}`);
  assert.ok(!/관리자/.test(wrapped.message), '"관리자에게 문의" 류는 사용자가 곧 관리자라 의미가 없다');
});

// ── ③ isRetryableAiError 가 거짓 ──────────────────────────────

test('🔴 잘림이면 isRetryableAiError 가 거짓이다(재시도는 낭비 — 같은 프롬프트는 같은 길이)', () => {
  assert.equal(ai.isRetryableAiError(truncErr()), false);
});

// ── ④ 판별력 — kind 가 정규식보다 먼저 보이는지(순서 검증용) ────────────
//
// 🔴 실제 truncErr 메시지는 재시도 단어에 애초에 안 걸리게 지어졌다(코드 주석 확인) —
//    그래서 "메시지가 우연히 정규식에 안 걸려서 통과" 하는 것과 "kind 를 실제로 봐서
//    거짓을 낸 것" 을 구분 못 한다. kind 검사를 정규식 뒤로 옮겨도(죽은 코드가 돼도)
//    이 케이스는 그대로 통과해 버려 순서 결함을 못 잡는다. ⇒ 정규식에 **걸리는** 메시지에
//    kind 를 얹어 "그래도 kind 가 이긴다" 를 직접 확인한다 — 이게 순서를 실제로 재는 축이다.

test('🔴 판별력: 메시지가 재시도 단어(timeout)를 포함해도 kind 가 이긴다', () => {
  const trickyErr = Object.assign(new Error('network timeout while streaming'), { kind: 'output_truncated' });
  assert.equal(
    ai.isRetryableAiError(trickyErr), false,
    'kind 가 있는데도 메시지의 "timeout" 에 걸려 재시도 대상으로 판정됐다 — kind 검사가 정규식보다 먼저가 아니다'
  );
});

// ── ⑤ 회귀 — 잘림이 아닌 기존 재시도 대상은 여전히 재시도된다 ────────────

test('⚠️ 회귀: kind 가 없는 기존 재시도 대상들은 여전히 재시도 대상이다', () => {
  assert.equal(ai.isRetryableAiError({ message: 'fetch failed' }), true, 'fetch failed 회귀');
  assert.equal(ai.isRetryableAiError({ message: 'ECONNRESET' }), true, 'ECONNRESET 회귀');
  assert.equal(ai.isRetryableAiError({ code: 'AI_TIMEOUT' }), true, 'AI_TIMEOUT 회귀');
  assert.equal(ai.isRetryableAiError({ status: 503 }), true, '503 회귀');
  assert.equal(ai.isRetryableAiError({ retryable: true }), true, '명시적 retryable 플래그 회귀');
});

test('⚠️ 회귀: kind 없는 재시도형 에러는 buildAiUserFacingError 문구가 여전히 "다시 시도" 다', () => {
  const wrapped = ai.buildAiUserFacingError({ message: 'fetch failed' }, { maxAttempts: 3, effectiveTimeoutMs: 120000 });
  assert.match(wrapped.message, /다시 시도/, '재시도형 에러의 안내 문구가 사라졌다(회귀)');
  assert.equal(wrapped.kind, undefined, 'kind 가 없는 에러인데 kind 가 생겼다(오탐)');
});

test('⚠️ 회귀: AI_TIMEOUT 문구·초 단위 표기가 그대로다', () => {
  const wrapped = ai.buildAiUserFacingError({ code: 'AI_TIMEOUT' }, { maxAttempts: 3, effectiveTimeoutMs: 45000 });
  assert.match(wrapped.message, /45초/, 'AI_TIMEOUT 의 초 단위 표기가 깨졌다(회귀)');
});

// ── ⑥ kind 가 있어도 output_truncated 가 "아니면" 여전히 재시도 대상이다 ────
//
// 🔴 2026-09-28 pm1 위임 — 앞선 검증 라운드에서 발견: `error.kind === 'output_truncated'`
// 를 `Boolean(error.kind)` 로 잘못 넓혀도(=kind 가 있으면 무조건 차단) 기존 709개 테스트
// 중 단 하나도 못 잡았다. 원인은 이 파일을 포함해 기존 테스트가 전부 kind 가 **아예 없는**
// 에러로만 재시도 회귀를 쟀기 때문 — "kind 가 있다" 와 "kind 가 정확히 output_truncated
// 다" 를 구분하는 테스트가 없었다. ⇒ **kind 가 있되 output_truncated 가 아닌** 실제 값
// 2개로 직접 잰다(지어낸 값이 아니다 — 이 저장소 소스에서 확인):
//   - server/tossClient.js:403 `kind: 'rate-limited'` (객체 리터럴로 직접 확인)
//   - server/mcpClient.js:451 `new McpError(message, 'timeout')`
//     → McpError 생성자 2번째 인자가 kind 다(mcpClient.js:62 `this.kind = kind`)
//     → kind:'timeout'. (object-literal `kind:` grep 으로는 안 잡힌다 — 위치 인자라서
//     생성자 구현을 직접 읽어야 드러난다.)
// ⚠️ TossError/McpError 인스턴스 자체가 실제로 isRetryableAiError 호출부에 흘러들지는
// 않는다(806~854행 재시도 루프는 `ai.models.generateContent` 만 감싼다) — 이 함수는
// `error.kind`만 보는 덕타이핑이라, 여기선 "kind 존재 자체" 가 아니라 "정확히
// output_truncated 인지" 만 가르는 것이 목적이라 값의 출처(Toss/Mcp)는 무관하다.
// 각 fixture 는 kind 를 빼고도 이미 재시도 대상이 되도록 만들었다(status/message 로) —
// 그래야 "kind 가 잘못 차단하는지" 만 순수하게 잰다.

test('🔴 kind 가 있어도 output_truncated 가 아니면(실제 값 2개) isRetryableAiError 는 참이다', () => {
  assert.equal(
    ai.isRetryableAiError({ status: 429, kind: 'rate-limited' }), true,
    'kind:"rate-limited"(실제 값, tossClient.js:403) 인데 재시도 불가로 판정됐다'
  );
  assert.equal(
    ai.isRetryableAiError({ message: 'mcp request timed out', kind: 'timeout' }), true,
    'kind:"timeout"(실제 값, mcpClient.js:451 McpError 생성자) 인데 재시도 불가로 판정됐다'
  );
});

test('🔴 kind 가 output_truncated 가 아니면 문구도 여전히 "다시 시도" 계열이다(잘림 전용 문구가 아니다)', () => {
  const a = ai.buildAiUserFacingError({ status: 429, kind: 'rate-limited' }, { maxAttempts: 3, effectiveTimeoutMs: 120000 });
  assert.match(a.message, /다시 시도/, 'kind:"rate-limited" 인데 "다시 시도" 문구가 사라졌다');
  assert.ok(!/줄여야|줄이/.test(a.message), 'kind:"rate-limited" 인데 잘림 전용 문구("줄여야")가 섞여 나왔다');

  const b = ai.buildAiUserFacingError({ message: 'mcp request timed out', kind: 'timeout' }, { maxAttempts: 3, effectiveTimeoutMs: 120000 });
  assert.match(b.message, /다시 시도/, 'kind:"timeout" 인데 "다시 시도" 문구가 사라졌다');
  assert.ok(!/줄여야|줄이/.test(b.message), 'kind:"timeout" 인데 잘림 전용 문구("줄여야")가 섞여 나왔다');
});

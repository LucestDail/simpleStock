const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

/**
 * 🩺 `tossWriting.refine` — 사용자 발화 직전 문체 정제 후처리 (2026-09-30, 사용자 지시).
 *
 * ⚠️ `tossWriting.js` 는 `const { generateStructuredOutput } = require('./aiService')` 로
 *    **구조분해 시점에** 함수를 잡아 둔다. `require('../server/aiService').generateStructuredOutput
 *    = mock` 처럼 나중에 프로퍼티만 바꾸면 이미 구조분해된 지역 바인딩엔 안 닿는다.
 *    ⇒ `require.cache` 를 **먼저** 새 대역으로 채워 넣고, `tossWriting` 을 그 뒤에 처음
 *    require 해야 대역이 실제로 물린다(analystTelegram.test.js 의 mcp 대역과 같은 수법).
 */
function freshTossWriting(fakeGenerateStructuredOutput) {
  const aiPath = require.resolve('../server/aiService');
  const tossWritingPath = require.resolve('../server/tossWriting');
  delete require.cache[tossWritingPath];
  const realAi = require(aiPath);
  require.cache[aiPath] = {
    id: aiPath, filename: aiPath, loaded: true,
    exports: { ...realAi, generateStructuredOutput: fakeGenerateStructuredOutput },
  };
  const mod = require(tossWritingPath);
  delete require.cache[aiPath]; // 다음 테스트를 위해 원상복구 — 다른 파일이 실제 aiService 를 다시 잡게
  return mod;
}

afterEach(() => {
  // 혹시 남은 대역이 있으면 걷어낸다(다음 테스트 파일에 새지 않게)
  const aiPath = require.resolve('../server/aiService');
  const real = require.cache[aiPath];
  if (real && real.exports && real.exports.__isFake) delete require.cache[aiPath];
});

test('빈 초안은 AI 를 부르지 않고 그대로 돌려준다', async () => {
  let called = false;
  const tossWriting = freshTossWriting(async () => { called = true; return { refined: '' }; });
  const out = await tossWriting.refine('   ');
  assert.equal(out, '');
  assert.equal(called, false, '빈 문자열인데 AI 를 불렀다');
});

test('정상 정제 — 그럴듯한 길이의 결과면 정제된 텍스트를 쓴다', async () => {
  const draft = 'QLD 는 20일선 위에 있어서 보유를 유지하는 게 맞다고 판단됩니다. 손절선은 730 입니다.';
  const tossWriting = freshTossWriting(async (opts) => {
    assert.equal(opts.userPrompt, draft, '원문이 그대로 프롬프트에 실리지 않았다');
    assert.ok(opts.schema, '스키마 없이 불렀다 — 서술로 샐 위험');
    return { refined: 'QLD 는 20일선 위예요. 보유 유지, 손절선은 730이에요.' };
  });
  const out = await tossWriting.refine(draft, { logLabel: 'test' });
  assert.equal(out, 'QLD 는 20일선 위예요. 보유 유지, 손절선은 730이에요.');
});

test('🔴 방어: 정제 결과가 원문 대비 압도적으로 짧으면(15% 미만) 원문을 쓴다', async () => {
  const draft = 'QLD 는 20일선 위에 있어서 보유를 유지하는 게 맞다고 판단됩니다. 손절선은 730 입니다.';
  const tossWriting = freshTossWriting(async () => ({ refined: '네.' }));
  const out = await tossWriting.refine(draft);
  assert.equal(out, draft, '너무 짧게 잘린 결과를 그대로 채택했다 — 사실이 잘렸을 수 있다');
});

test('🔴 방어: AI 호출이 실패하면 원문을 그대로 돌려준다(발송을 막지 않는다)', async () => {
  const draft = 'RAM 은 13.50 아래로 마감되면 즉시 손절하세요.';
  const tossWriting = freshTossWriting(async () => { throw new Error('게이트웨이 타임아웃'); });
  const out = await tossWriting.refine(draft);
  assert.equal(out, draft);
});

test('🔴 방어: generateStructuredOutput 이 parse 실패로 폴백을 돌려줘도(=원문) 그대로 쓴다', async () => {
  const draft = 'QLD 보유 유지, RAM 은 손절 검토.';
  // generateStructuredOutput 자체의 계약: 모양이 안 맞으면 넘겨준 fallback 을 그대로 반환한다.
  // refine() 이 넘기는 fallback 은 항상 { refined: <원문> } 이므로, 이 상황을 흉내내면
  // "실제로 그 폴백 계약에 기대고 있는지" 를 검증한다.
  const tossWriting = freshTossWriting(async (opts, fallback) => fallback);
  const out = await tossWriting.refine(draft);
  assert.equal(out, draft);
});

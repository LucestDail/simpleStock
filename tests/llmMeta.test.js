const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * 게이트웨이가 실제로 쓴 모델·사업자 포착 (2026-09-21)
 *
 * 화면에 `gemini-3.5-flash` 가 떴는데 그건 **우리가 요청한 이름**이었다.
 * pm2 가 게이트웨이에 `x-llm-model`/`x-llm-provider` 헤더를 붙였고, 여기서 그걸 받는다.
 *
 * 🔴 이 테스트의 핵심은 **동시 호출이 서로의 값을 덮어쓰지 않는가** 다.
 *    전역 변수로 만들었으면 브리핑(supervisor + synthesis 가 겹친다)에서 섞였을 것이고,
 *    **섞여도 화면은 멀쩡해 보인다** — 틀린 모델명이 그럴듯하게 찍힐 뿐이다.
 */

process.env.GEMINI_GATEWAY_BASE_URL = 'http://gw.test/llm/gemini';
const { runWithLlmMeta } = require('../server/geminiClient');

const realFetch = global.fetch;

function fakeRes(headers) {
  return { headers: { get: (k) => headers[k.toLowerCase()] ?? null } };
}

test('게이트웨이 응답 헤더에서 실제 모델·사업자를 읽는다', async () => {
  global.fetch = async () => fakeRes({ 'x-llm-model': 'deepseek/deepseek-v4-flash', 'x-llm-provider': 'OpenInference' });
  const { meta } = await runWithLlmMeta(async () => {
    await fetch('http://gw.test/llm/gemini/v1beta/models:generateContent');
    return 'ok';
  });
  global.fetch = realFetch;
  assert.equal(meta.model, 'deepseek/deepseek-v4-flash');
  assert.equal(meta.provider, 'OpenInference');
});

test('🔴 동시 호출이 서로의 값을 덮어쓰지 않는다', async () => {
  global.fetch = async (url) => {
    const n = String(url).includes('A') ? 'A' : 'B';
    // B 를 일부러 느리게 — 전역 변수였다면 늦게 끝난 쪽이 둘 다 차지한다
    await new Promise((r) => setTimeout(r, n === 'B' ? 40 : 5));
    return fakeRes({ 'x-llm-model': `model-${n}`, 'x-llm-provider': `prov-${n}` });
  };
  const call = (tag) =>
    runWithLlmMeta(async () => {
      await fetch(`http://gw.test/llm/gemini/${tag}`);
      return tag;
    });
  const [a, b] = await Promise.all([call('A'), call('B')]);
  global.fetch = realFetch;
  assert.equal(a.meta.model, 'model-A', `A 가 ${a.meta.model} 을 받았다 — 값이 섞였다`);
  assert.equal(b.meta.model, 'model-B', `B 가 ${b.meta.model} 을 받았다 — 값이 섞였다`);
});

test('⚠️ 헤더가 없으면 **비운다** — 요청 이름으로 메우지 않는다', async () => {
  global.fetch = async () => fakeRes({});
  const { meta } = await runWithLlmMeta(async () => {
    await fetch('http://gw.test/llm/gemini/x');
    return 1;
  });
  global.fetch = realFetch;
  assert.equal(meta, null, '헤더가 없는데 값을 지어냈다 — "모른다" 가 "틀린 값" 보다 낫다');
});

test('게이트웨이가 아닌 호출의 헤더는 줍지 않는다', async () => {
  global.fetch = async () => fakeRes({ 'x-llm-model': 'someone-elses-model' });
  const { meta } = await runWithLlmMeta(async () => {
    await fetch('https://finnhub.io/api/v1/quote');
    return 1;
  });
  global.fetch = realFetch;
  assert.equal(meta, null, '남의 응답 헤더를 우리 모델로 기록했다');
});

test('★ 관측이 제품을 깨뜨리지 않는다 (헤더 읽다 터져도 호출은 산다)', async () => {
  global.fetch = async () => ({ headers: { get: () => { throw new Error('boom'); } }, body: 'ok' });
  const { value, meta } = await runWithLlmMeta(async () => {
    const r = await fetch('http://gw.test/llm/gemini/x');
    return r.body;
  });
  global.fetch = realFetch;
  assert.equal(value, 'ok', '헤더 파싱 실패가 호출 전체를 깨뜨렸다');
  assert.equal(meta, null);
});

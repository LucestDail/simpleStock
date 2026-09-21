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

test('🔴 저장 정규화가 servedBy 를 버리지 않는다 (화면은 저장본을 읽는다)', () => {
  /*
   * 2026-09-21 실패: 포착은 됐는데 화면에 안 나왔다. 원인은 `dataStore` 의
   * managerReports 정규화가 **허용목록**이라 servedBy 가 **저장 시 조용히 사라진** 것.
   * ★ 같은 날 `providerDefault` 와 똑같다 — **만든 객체와 화면이 읽는 객체가 다르다.**
   */
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'dataStore.js'), 'utf8');
  const i = src.indexOf("model: String(item.model || '')");
  assert.ok(i > 0, '리포트 정규화 블록을 못 찾았다 — 가드가 대상을 잃었다(통과 아님)');
  const block = src.slice(i, i + 1200);
  assert.ok(/servedBy:/.test(block), '정규화에 servedBy 가 없다 — 저장하면 사라진다');
});

test('포착 경로를 기동 때 밝힌다 (조용히 안 되는 것을 막는다)', () => {
  const gc = require('../server/geminiClient');
  const d = gc.describeFetchProbe();
  assert.ok(['global', 'pending', 'none'].includes(d.mode), `mode 가 ${d.mode}`);
  // ⚠️ SDK 주입은 불가능하다 — 옵션에 fetch 필드가 없다. 그 사실을 여기 박아 둔다.
  const dts = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'node_modules/@google/genai/dist/genai.d.ts'), 'utf8');
  const i = dts.indexOf('declare interface GoogleGenAIOptions');
  const fields = [...dts.slice(i, i + 2600).matchAll(/^\s{4}(\w+)\??:/gm)].map((m) => m[1]);
  assert.ok(fields.length > 0, '옵션 필드를 못 읽었다 — 가드가 대상을 잃었다');
  assert.equal(
    fields.filter((f) => /fetch/i.test(f)).length,
    0,
    'SDK 옵션에 fetch 가 생겼다 — 이제 전역 래핑 대신 **주입**으로 바꿔라(더 안전하다)'
  );
});

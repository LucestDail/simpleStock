const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * 채팅 마크다운 소독 (2026-09-21)
 *
 * ## 🔴 왜 자를 대나
 *
 * 애널리스트 답을 **`v-html` 로 화면에 넣는다**. 그리고 그 답에는
 * **웹 검색 결과가 섞여 들어온다** — 즉 **외부 입력**이다.
 * 소독이 빠지면 `<img onerror>` 한 줄로 끝난다. 그런데 **빠져도 화면은 멀쩡해 보인다** —
 * 그래서 사람이 못 잡는다. 자로 잠근다.
 *
 * ⚠️ 브라우저 DOM 이 필요해 `dompurify` 가 jsdom 을 요구한다. 없으면 **건너뛰지 않고
 *    실패**시킨다 — *"검사 못 함" 을 초록불로 만들지 않는다*(워크스페이스 규율).
 */

/**
 * 🔴 **`skip` 을 쓰지 않는다.** 첫 판은 jsdom 이 없으면 건너뛰게 했고 — 실행해 보니
 *    **4건 전부 SKIP 인데 `# fail 0`** 이었다. 주석에 *"건너뛰지 않는다"* 라 적어 놓고
 *    바로 아래에서 `t.skip` 을 부르고 있었다(*검사 못 함을 초록불로 만든 것*).
 *    ⇒ jsdom 을 **devDependency 로 박고**, 없으면 **실패**한다.
 */
async function load() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  return import('../frontend/src/lib/markdown.js');
}

test('마크다운을 렌더하고 **스크립트를 지운다**', async () => {
  const { renderMarkdown } = await load();

  const html = renderMarkdown('**굵게** 그리고 <script>alert(1)</script> 와 <img src=x onerror="alert(2)">');
  assert.match(html, /<strong>굵게<\/strong>/, '마크다운이 렌더되지 않았다');
  assert.ok(!/<script/i.test(html), '🔴 script 가 남았다');
  assert.ok(!/onerror/i.test(html), '🔴 이벤트 핸들러가 남았다');
  assert.ok(!/<img/i.test(html), 'img 는 허용 목록에 없다');
});

test('표와 코드는 살린다 — 애널리스트가 실제로 쓴다', async () => {
  const { renderMarkdown } = await load();
  const html = renderMarkdown('| 종목 | 수량 |\n|---|---|\n| QLD | 41 |\n\n`005930`');
  assert.match(html, /<table/);
  assert.match(html, /<code>005930<\/code>/);
});

test('링크는 새 창 + noopener, javascript: 는 막는다', async () => {
  const { renderMarkdown } = await load();

  const ok = renderMarkdown('[뉴스](https://example.com/a)');
  assert.match(ok, /target="_blank"/);
  assert.match(ok, /rel="noopener noreferrer"/);

  // 🔴 `javascript:` 링크는 클릭 한 번으로 실행된다 — href 가 남으면 안 된다
  const bad = renderMarkdown('[누르지마](javascript:alert(1))');
  assert.ok(!/javascript:/i.test(bad), '🔴 javascript: 스킴이 남았다');
});

test('빈 입력은 빈 문자열이다 (빈 말풍선을 만들지 않는다)', async () => {
  const mod = await load();
  assert.equal(mod.renderMarkdown(''), '');
  assert.equal(mod.renderMarkdown('   '), '');
  assert.equal(mod.renderMarkdown(null), '');
});

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

/**
 * `readArticle` 이 절대 throw 하지 않는가 (2026-09-27)
 *
 * 형제 함수 `searchMarketNews` 는 처음부터 `{ok:false,...}` 로 접었는데
 * `readArticle` 만 listTools()/callTool() 의 McpError 를 그대로 흘려보냈다.
 * my-computer 가 죽거나 느린 날 이 도구 호출 하나가 상위(analystChat.js)까지
 * 예외를 던져 대화 전체를 죽일 수 있었다. ⇒ **어떤 경우에도 resolve** 하는지 잠근다.
 */
process.env.MYCOMPUTER_MCP_URL = 'http://127.0.0.1:1/my-computer/mcp';
process.env.MYCOMPUTER_MCP_TOKEN = 'TEST_MCP_TOKEN';
process.env.MYCOMPUTER_MCP_ENABLED = 'true';

const mcp = require('../server/mcpClient');
const realFetch = global.fetch;

function sse(obj, { sessionId = 'sess-1' } = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Map([
      ['content-type', 'text/event-stream'],
      ['mcp-session-id', sessionId],
    ]),
    text: async () => `event: message\ndata: ${JSON.stringify(obj)}\n\n`,
  };
}

function install(handler) {
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const r = await handler(body, calls.length);
    return r;
  };
  return calls;
}

/** 실물 스키마(mcp.test.js 의 TOOLS_WITH_SEARCH 와 동일 계열) */
const TOOLS_WITH_READ = {
  tools: [
    {
      name: 'readWebPage',
      description: '웹 페이지 읽기(정적 HTML 만)',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' }, includeLinks: { type: 'boolean' } },
        required: ['url'],
      },
    },
  ],
};

function handshake(body, result) {
  if (body.method === 'initialize') return sse({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'my-computer' }, protocolVersion: '2025-06-18' } });
  if (body.method === 'notifications/initialized') return sse({ jsonrpc: '2.0', result: {} });
  return result(body);
}

beforeEach(() => {
  mcp._resetForTest();
});
afterEach(() => {
  global.fetch = realFetch;
});

/**
 * 🔴 가장 중요한 테스트: callTool 이 던져도 readArticle 은 reject 하지 않는다.
 *    `assert.doesNotReject` 로 확인 — reject 하면 이 테스트 자체가 실패한다.
 */
test('my-computer 가 도구 호출에서 실패해도 readArticle 은 throw 하지 않는다', async () => {
  install((b) =>
    handshake(b, (bb) =>
      bb.method === 'tools/list'
        ? sse({ jsonrpc: '2.0', id: bb.id, result: TOOLS_WITH_READ })
        : sse({ jsonrpc: '2.0', id: bb.id, result: { isError: true, content: [{ type: 'text', text: '페이지 로드 타임아웃' }] } })
    )
  );

  let r;
  await assert.doesNotReject(async () => {
    r = await mcp.readArticle('https://example.com/article');
  });

  assert.equal(r.ok, false);
  assert.equal(r.kind, 'tool-error', 'McpError 의 kind 가 그대로 보존돼야 한다');
  assert.match(r.error, /페이지 로드 타임아웃/);
});

/** listTools 단계(핸드셰이크·tools/list)가 실패해도 마찬가지다 */
test('초기화(handshake)가 실패해도 readArticle 은 throw 하지 않는다', async () => {
  install(() => ({ ok: false, status: 401, headers: new Map(), text: async () => 'denied' }));

  let r;
  await assert.doesNotReject(async () => {
    r = await mcp.readArticle('https://example.com/article');
  });

  assert.equal(r.ok, false);
  assert.equal(r.kind, 'auth', '401 은 auth 로 분류돼야 한다');
});

/** 연결 자체가 안 되는 경우(transport) — fetch 가 직접 던지는 경로 */
test('네트워크 연결 실패(transport)도 throw 하지 않고 kind 를 보존한다', async () => {
  global.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };

  let r;
  await assert.doesNotReject(async () => {
    r = await mcp.readArticle('https://example.com/article');
  });

  assert.equal(r.ok, false);
  assert.equal(r.kind, 'transport');
});

/** readWebPage 도구가 노출돼 있지 않은 경우 — 기존 동작(kind 없음) 그대로 */
test('readWebPage 도구가 없으면 기존처럼 이유를 돌려준다', async () => {
  install((b) => handshake(b, (bb) => sse({ jsonrpc: '2.0', id: bb.id, result: { tools: [{ name: 'computerShell' }] } })));

  const r = await mcp.readArticle('https://example.com/article');

  assert.equal(r.ok, false);
  assert.match(r.error, /readWebPage 도구가 없습니다/);
});

/** URL 형식 자체가 틀린 경우 — MCP 를 아예 부르지 않는다(기존 동작 그대로) */
test('URL 형식이 아니면 MCP 를 부르지 않고 즉시 실패한다', async () => {
  const calls = install(() => sse({ jsonrpc: '2.0', result: {} }));

  const r = await mcp.readArticle('not-a-url');

  assert.equal(r.ok, false);
  assert.match(r.error, /URL 이 아닙니다/);
  assert.equal(calls.length, 0);
});

/**
 * 🔴 15초 상한(2026-09-27, pm2 실측 최악 421ms 대비 35배 여유) — my-computer 응답이
 *    느리면 `readArticle` 이 그동안 기댔던 일반 MCP 타임아웃(기본 20초)까지 그대로
 *    기다렸다. 이제는 그보다 먼저 끊고 `{ok:false, kind:'timeout'}` 로 **resolve** 해야 한다
 *    (reject 하면 안 된다 — 위 "throw 하지 않는다" 계약과 같은 축).
 *
 * ⚠️ 실제로 15초를 기다리지 않는다("가짜 지연") — 내부 타이머(`setTimeout`)만 이 테스트
 *    동안 지연 0 으로 발화하게 바꿔서 "20초짜리 느린 호출" 을 빠르게 흉내낸다.
 *    상한 상수(15000ms)·에러 문구는 프로덕션 그대로 검사한다.
 */
test('callTool 이 상한을 넘겨 걸리면(가짜 지연) ok:false·kind:timeout 으로 resolve 한다(reject 아님)', async () => {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => realSetTimeout(fn, 0);

  install((b) =>
    handshake(b, (bb) => {
      if (bb.method === 'tools/list') return sse({ jsonrpc: '2.0', id: bb.id, result: TOOLS_WITH_READ });
      // tools/call — 20초짜리 느린 호출을 흉내낸다. 이 프라미스는 이 테스트 안에서
      // 절대 안 끝난다(끝날 필요가 없다 — 상한 타이머가 먼저 이긴다)
      return new Promise(() => {});
    })
  );

  let r;
  try {
    await assert.doesNotReject(async () => {
      r = await mcp.readArticle('https://example.com/slow-article');
    });
  } finally {
    global.setTimeout = realSetTimeout;
  }

  assert.equal(r.ok, false);
  assert.equal(r.kind, 'timeout');
  assert.match(r.error, /15초를 넘겨 중단했습니다/);
});

/** 정상 경로(긴 본문) — 기존 반환 모양({ok:true,chars,text})이 그대로인지 */
test('정상 경로: 긴 본문은 chars·text 를 그대로 담아 ok:true', async () => {
  const longBody = '가'.repeat(600);
  install((b) =>
    handshake(b, (bb) =>
      bb.method === 'tools/list'
        ? sse({ jsonrpc: '2.0', id: bb.id, result: TOOLS_WITH_READ })
        : sse({ jsonrpc: '2.0', id: bb.id, result: { content: [{ type: 'text', text: longBody }] } })
    )
  );

  const r = await mcp.readArticle('https://example.com/long-article');

  assert.equal(r.ok, true);
  assert.equal(r.chars, 600);
  assert.equal(r.text, longBody.slice(0, 6000));
  assert.equal(r.kind, undefined, '성공 경로는 kind 를 담지 않는다(기존 계약)');
});

/** 짧은 본문(500자 미만) — 기존 동작(ok:false + chars, kind 없음) 그대로 */
test('짧은 본문(500자 미만)은 기존처럼 ok:false + chars 를 돌려준다(kind 없음)', async () => {
  const shortBody = '짧은 본문'.repeat(10); // 훨씬 짧다
  install((b) =>
    handshake(b, (bb) =>
      bb.method === 'tools/list'
        ? sse({ jsonrpc: '2.0', id: bb.id, result: TOOLS_WITH_READ })
        : sse({ jsonrpc: '2.0', id: bb.id, result: { content: [{ type: 'text', text: shortBody }] } })
    )
  );

  const r = await mcp.readArticle('https://example.com/short-article');

  assert.equal(r.ok, false);
  assert.equal(r.chars, shortBody.length);
  assert.match(r.error, /본문 확보 실패/);
  assert.equal(r.kind, undefined, '이 실패 모양은 McpError 가 아니라 kind 가 없는 게 기존 계약이다');
});

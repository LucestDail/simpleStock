const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

/**
 * my-computer MCP 연계 (2026-09-21)
 *
 * ## 🔴 자격증명을 **넣고** 시작한다
 *
 * 오늘 텔레그램 테스트가 **엉뚱한 이유로 통과**했다 — 자격증명이 없어서 dry-run 이었던 것이지
 * 스위치를 검사한 게 아니었고, 변이를 넣어도 안 잡혔다. 같은 실수를 여기서 반복하지 않는다.
 * ⇒ URL·토큰을 넣어 두고 **`MYCOMPUTER_MCP_ENABLED` 스위치만** 검사 대상으로 남긴다.
 */
process.env.MYCOMPUTER_MCP_URL = 'http://127.0.0.1:1/my-computer/mcp';
process.env.MYCOMPUTER_MCP_TOKEN = 'TEST_MCP_TOKEN';
process.env.MYCOMPUTER_MCP_ENABLED = 'true';

const mcp = require('../server/mcpClient');
const realFetch = global.fetch;

/** 서버가 준 것처럼 응답을 만든다 */
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

/** Map 은 headers.get 을 그대로 준다 — 실제 Headers 와 같은 인터페이스 */
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

/**
 * 🔴 **피어가 준 실물 스키마다** — 내가 지어낸 것이 아니다.
 *
 * 첫 판의 내 픽스처는 `required: ['query']` 였고, 그래서 **`limit` 을 안 채우는 코드가
 * 초록불로 통과**했다. 실물은 `required: ['query','limit']` 이라 그대로 배포했으면 실패한다.
 * ★ *"틀린 픽스처는 틀린 동작을 지켜 준다"* — 오늘 토스 등락률에서 이미 한 번 밟았다.
 */
const TOOLS_WITH_SEARCH = {
  tools: [
    { name: 'computerShell', description: '셸 실행', inputSchema: { properties: { cmd: {} } } },
    {
      name: 'webSearch',
      description: '웹 검색',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '검색어' },
          limit: { type: 'integer', description: '최대 결과 수 (1-10)' },
        },
        required: ['query', 'limit'],
      },
    },
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

// ── SSE 파싱 ─────────────────────────────────────────────────

/**
 * 🔴 피어가 오늘 여기 걸렸다 — `data:` 뒤 공백이 **있을 수도 없을 수도** 있다.
 *    한쪽만 처리하면 서버 구현이 바뀌는 날 조용히 깨진다.
 */
test('SSE 프레임을 공백 유무·여러 줄 모두 파싱한다', () => {
  assert.deepEqual(mcp.parseBody('data: {"a":1}\n\n', 'text/event-stream'), { a: 1 });
  assert.deepEqual(mcp.parseBody('data:{"a":2}\n\n', 'text/event-stream'), { a: 2 });
  // 여러 data 줄은 **이어 붙인다**(JSON 이 길면 서버가 쪼갤 수 있다)
  assert.deepEqual(mcp.parseBody('event: message\ndata: {"a":\ndata: 3}\n\n', 'text/event-stream'), { a: 3 });
  // SSE 가 아니면 그냥 JSON
  assert.deepEqual(mcp.parseBody('{"a":4}', 'application/json'), { a: 4 });
});

test('data 프레임이 없으면 조용히 빈 값이 아니라 오류다', () => {
  assert.throws(() => mcp.parseBody('event: ping\n\n', 'text/event-stream'), /data 프레임/);
});

// ── 도구 선택 ────────────────────────────────────────────────

/**
 * 🔴 **읽기 전용만 부른다.** `computer*` 는 이름이 힌트에 걸려도 제외돼야 한다.
 *    이 워크스페이스는 "금지목록은 열거로 못 막는다" 를 두 번 배웠지만, 여기는 방향이 반대다 —
 *    **부를 것을 고르는** 자리라 허용 쪽이 좁고, 위험한 접두사를 추가로 막는 것이 겹겹이다.
 */
test('computer 계열은 힌트에 걸려도 고르지 않는다', () => {
  const tools = [
    { name: 'computer_web_search', description: '' }, // 힌트(websearch)에 걸리지만 computer 다
    { name: 'web_search', description: '' },
  ];
  assert.equal(mcp.pick(tools, mcp.SEARCH_HINTS).name, 'web_search');
  // computer 만 있으면 **아무것도 안 고른다**(그게 맞다)
  assert.equal(mcp.pick([tools[0]], mcp.SEARCH_HINTS), null);
});

/**
 * ⚠️ 접두사 제외를 **느슨하게 고친 그 자리**를 잠근다 — 네임스페이스가 붙어도
 *    마지막 구획이 위험하면 여전히 막혀야 한다. 오탐을 고치다 진짜 구멍을 내기 쉽다.
 */
test('네임스페이스가 붙어도 위험 도구는 막힌다', () => {
  for (const name of ['mycomputer.computerShell', 'mc:shell_exec', 'srv/file_write']) {
    assert.equal(mcp.pick([{ name, description: '' }], ['shell', 'file', 'computer']), null, name);
  }
});

test('이름 표기가 달라도 찾는다(WebSearch·web-search·websearch)', () => {
  for (const name of ['WebSearch', 'web-search', 'websearch', 'mycomputer.web_search']) {
    assert.equal(mcp.pick([{ name, description: '' }], mcp.SEARCH_HINTS)?.name, name, name);
  }
});

/**
 * ⚠️ 인자 이름을 **추측해 박지 않는다** — 오늘 랭킹 종류를 추측해 400 을 맞았다.
 *    스키마가 말하는 이름을 쓰고, 스키마가 없을 때만 `query` 로 떨어진다.
 */
test('인자 이름은 스키마에서 읽는다', () => {
  const t = (props, required) => ({ name: 'x', schema: { type: 'object', properties: props, required } });
  assert.deepEqual(mcp.buildArgs(t({ q: { type: 'string' } }), 'AAPL'), { q: 'AAPL' });
  assert.deepEqual(mcp.buildArgs(t({ keyword: { type: 'string' } }), 'AAPL'), { keyword: 'AAPL' });
  // 필수 문자열이 딱 하나면 그것이 검색어다
  assert.deepEqual(
    mcp.buildArgs(t({ searchTerm: { type: 'string' }, limit: { type: 'number' } }, ['searchTerm']), 'AAPL'),
    { searchTerm: 'AAPL' }
  );
  // 스키마가 없으면 마지막 수단
  assert.deepEqual(mcp.buildArgs({ name: 'x', schema: null }, 'AAPL'), { query: 'AAPL' });
});

/**
 * 🔴🔴 **검색어 칸만 채우면 호출이 실패한다.** 실물 `webSearch` 는 `limit` 도 필수다.
 *    첫 판의 내 코드가 정확히 여기서 틀렸고 **픽스처가 틀려서 안 잡혔다.**
 *    ⇒ 필수 필드를 **전수로 훑어** 빠짐없이 채우는지 본다.
 */
test('필수 필드를 전수로 채운다(query 만 채우고 끝내지 않는다)', () => {
  const webSearch = { name: 'webSearch', schema: TOOLS_WITH_SEARCH.tools[1].inputSchema };
  const args = mcp.buildArgs(webSearch, '삼성전자 주가');
  assert.equal(args.query, '삼성전자 주가');
  assert.equal(typeof args.limit, 'number', 'limit 이 필수인데 안 채웠다 — 호출이 실패한다');
  assert.ok(args.limit >= 1 && args.limit <= 10, `limit 이 스펙 범위(1-10) 밖이다: ${args.limit}`);

  // 필수 boolean·enum 도 채운다
  const t = {
    name: 'x',
    schema: {
      type: 'object',
      properties: { q: { type: 'string' }, deep: { type: 'boolean' }, mode: { type: 'string', enum: ['fast', 'slow'] } },
      required: ['q', 'deep', 'mode'],
    },
  };
  assert.deepEqual(mcp.buildArgs(t, 'AAPL'), { q: 'AAPL', deep: false, mode: 'fast' });

  // ⚠️ 선택 필드는 **건드리지 않는다**(필요 없는 값을 보내면 서버가 거부할 수 있다)
  const opt = { name: 'x', schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } };
  assert.deepEqual(mcp.buildArgs(opt, 'AAPL'), { query: 'AAPL' });
});

/** ★ 실물 이름(`webSearch`·`readWebPage`)이 힌트에 걸리는지 — 이름이 안 걸리면 기능이 통째로 안 돈다 */
test('실물 도구 이름을 찾는다', () => {
  const tools = TOOLS_WITH_SEARCH.tools.map((t) => ({ name: t.name, description: t.description }));
  assert.equal(mcp.pick(tools, mcp.SEARCH_HINTS)?.name, 'webSearch');
  assert.equal(mcp.pick(tools, mcp.FETCH_HINTS)?.name, 'readWebPage');
});

// ── 스위치 ───────────────────────────────────────────────────

/**
 * 🔴 기본 꺼짐을 잠근다. ⚠️ URL·토큰이 **있는** 상태에서 검사해야 의미가 있다
 *    (없어서 안 도는 것과 스위치가 막는 것은 다르다).
 */
test('ENABLED 가 꺼져 있으면 부르지 않는다', async () => {
  const mod = '../server/mcpClient';
  delete require.cache[require.resolve(mod)];
  process.env.MYCOMPUTER_MCP_ENABLED = 'false';
  const off = require(mod);
  const calls = install(() => sse({ jsonrpc: '2.0', result: {} }));

  const r = await off.searchMarketNews([{ symbol: '005930', name: '삼성전자' }]);

  assert.equal(r.ok, false);
  assert.equal(r.kind, 'disabled');
  assert.equal(calls.length, 0, '꺼져 있는데 네트워크를 때렸다');
  assert.equal(off.status().effective, 'off');
  assert.equal(off.status().reason, 'disabled');

  process.env.MYCOMPUTER_MCP_ENABLED = 'true';
  delete require.cache[require.resolve(mod)];
});

// ── 핸드셰이크 ───────────────────────────────────────────────

/**
 * ⚠️ `notifications/initialized` 를 빠뜨리면 서버가 도구 호출을 거부한다.
 *    빠뜨려도 **initialize 는 성공**해서 증상이 나중에 나온다.
 */
test('initialize → notifications/initialized → tools/list 순서로 간다', async () => {
  const calls = install((b) => handshake(b, () => sse({ jsonrpc: '2.0', id: b.id, result: TOOLS_WITH_SEARCH })));
  const tools = await mcp.listTools();

  assert.deepEqual(calls.map((c) => c.body.method), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.deepEqual(tools.map((t) => t.name), ['computerShell', 'webSearch', 'readWebPage']);
  // 세션 id 를 받아서 다음 호출에 실었는가
  assert.equal(calls[2].headers['Mcp-Session-Id'], 'sess-1');
  assert.equal(calls[0].headers['X-My-Computer-Auth'], 'TEST_MCP_TOKEN');
});

test('401 은 인증 문제로 분류한다(전송 실패와 섞지 않는다)', async () => {
  install(() => ({ ok: false, status: 401, headers: new Map(), text: async () => 'denied' }));
  await assert.rejects(() => mcp.listTools(), (e) => e.kind === 'auth');
});

// ── 도구 미노출 ──────────────────────────────────────────────

/**
 * 🔴 **"도구가 없다" 를 빈 결과로 만들지 않는다.** 이게 오늘 하루 종일 본 그 실패 모드다 —
 *    "검사하지 않은 것" 과 "통과한 것" 이 같아 보이면 안 된다.
 */
test('검색 도구가 노출돼 있지 않으면 이유를 돌려준다', async () => {
  install((b) => handshake(b, () => sse({ jsonrpc: '2.0', id: b.id, result: { tools: [{ name: 'computerShell' }] } })));
  const r = await mcp.searchMarketNews([{ symbol: '005930', name: '삼성전자' }]);

  assert.equal(r.ok, false);
  assert.equal(r.kind, 'no-tool');
  assert.match(r.error, /노출되어 있지 않/);
  // 무엇이 있었는지도 말해 준다 — 그게 없으면 다음 사람이 또 추측한다
  assert.match(r.error, /computerShell/);
});

/**
 * 🔴 **라이브에서만 보인 결함.** `webSearch` 응답이 JSON 인코딩된 문자열이라
 *    따옴표에 감싸여 오고 줄바꿈이 리터럴 `\n` 두 글자다. 스텁은 평문을 주니
 *    **테스트로는 영원히 안 보인다** — 컨테이너에서 실제로 태워 보고 알았다.
 *    ★ *"배포 후 태워보는 것과 테스트는 서로를 대체하지 않는다"* 의 이 프로젝트 판본.
 */
test('JSON 인코딩된 응답 문자열을 푼다(실패하면 원문 유지)', () => {
  assert.equal(mcp.unwrapJsonString('"🔎 검색 결과:\\n\\n1. 기사"'), '🔎 검색 결과:\n\n1. 기사');
  // 평문은 그대로
  assert.equal(mcp.unwrapJsonString('평범한 텍스트'), '평범한 텍스트');
  // 양끝이 따옴표라도 파싱 실패면 원문 유지 — 멀쩡한 본문을 망가뜨리지 않는다
  assert.equal(mcp.unwrapJsonString('"인용으로 시작해 인용으로 끝나는 한글 문장"이다"'), '"인용으로 시작해 인용으로 끝나는 한글 문장"이다"');
  // 문자열이 아닌 JSON 은 풀지 않는다
  assert.equal(mcp.unwrapJsonString('"123"'), '123');
});

/** 🔴 MCP 는 도구 실패를 **200 + isError** 로 준다. HTTP 만 보면 성공으로 읽는다 */
test('isError:true 는 성공이 아니다', async () => {
  install((b) =>
    handshake(b, (bb) =>
      bb.method === 'tools/list'
        ? sse({ jsonrpc: '2.0', id: bb.id, result: TOOLS_WITH_SEARCH })
        : sse({ jsonrpc: '2.0', id: bb.id, result: { isError: true, content: [{ type: 'text', text: '검색 실패' }] } })
    )
  );
  await assert.rejects(() => mcp.callTool('webSearch', { query: 'x' }), (e) => e.kind === 'tool-error');
});

// ── 🔴 자산이 밖으로 나가지 않는다 ───────────────────────────

/**
 * 🔴🔴 **이 테스트가 이 파일에서 가장 중요하다.**
 *
 * 검색어는 외부 검색 엔진으로 나간다 — 되돌릴 수 없다. 보유 **수량·평단·평가금액**이
 * 검색어에 실리면 내 포지션을 밖에 흘리는 셈이다. 규칙으로는 안 지켜지므로 자로 잠근다.
 *
 * ★ 오탐이 아니라 **누락**을 잡는 자다: 나중에 누가 프롬프트를 풍부하게 만든다며
 *   `${h.quantity}주 보유` 를 검색어에 넣으면 여기서 깨진다.
 */
test('검색어에 수량·평단·평가금액이 실리지 않는다', async () => {
  const sent = [];
  install((b) =>
    handshake(b, (bb) => {
      if (bb.method === 'tools/list') return sse({ jsonrpc: '2.0', id: bb.id, result: TOOLS_WITH_SEARCH });
      sent.push(JSON.stringify(bb.params.arguments));
      return sse({ jsonrpc: '2.0', id: bb.id, result: { content: [{ type: 'text', text: '뉴스 본문' }] } });
    })
  );

  // 실제 보유처럼 **민감한 숫자를 가진** 객체를 통째로 넘긴다
  const holdings = [
    { symbol: '005930', name: '삼성전자', quantity: 32, avgPrice: 243750, value: 8720000, accountNo: '1234567890' },
    { symbol: 'QLD', name: 'ProShares Ultra QQQ', quantity: 41, avgPrice: 82.4, value: 3760000 },
  ];
  // 🔴 **걸러서 넘기지 않는다.** 첫 판에서 여기서 걸러 넘겼더니 변이(검색어에 수량 삽입)를
  //    **못 잡았다** — 검사할 값이 애초에 객체에 없었기 때문이다(공허한 통과).
  const r = await mcp.searchMarketNews(holdings);

  assert.equal(r.ok, true);
  assert.equal(sent.length, 2);
  const blob = sent.join(' ');
  for (const secret of ['32', '243750', '8720000', '1234567890', '41', '82.4', '3760000']) {
    assert.ok(!blob.includes(secret), `검색어에 민감한 값이 실렸다: ${secret}\n실제: ${blob}`);
  }
  // 종목명·티커까지는 실린다(그래야 검색이 된다)
  assert.ok(blob.includes('삼성전자'));
});

/** 검색어 생성 함수 자체를 잠근다 — 보유 객체를 통째로 먹여도 두 칸만 읽어야 한다 */
test('buildQuery 는 이름·티커 외에는 읽지 않는다', () => {
  const q = mcp.buildQuery({
    symbol: '005930', name: '삼성전자',
    quantity: 32, avgPrice: 243750, value: 8720000, accountNo: '1234567890', profitRate: 11.79,
  });
  for (const secret of ['32', '243750', '8720000', '1234567890', '11.79']) {
    assert.ok(!q.includes(secret), `검색어에 ${secret} 이 실렸다: ${q}`);
  }
  assert.ok(q.includes('삼성전자'));
});

/** 한 종목이 실패해도 나머지는 간다 — 조각 실패를 전체 실패로 만들지 않는다 */
test('종목 하나가 실패해도 나머지 결과는 살아 있다', async () => {
  let n = 0;
  install((b) =>
    handshake(b, (bb) => {
      if (bb.method === 'tools/list') return sse({ jsonrpc: '2.0', id: bb.id, result: TOOLS_WITH_SEARCH });
      n += 1;
      return n === 1
        ? sse({ jsonrpc: '2.0', id: bb.id, result: { isError: true, content: [{ type: 'text', text: '타임아웃' }] } })
        : sse({ jsonrpc: '2.0', id: bb.id, result: { content: [{ type: 'text', text: '두 번째 뉴스' }] } });
    })
  );

  const r = await mcp.searchMarketNews([
    { symbol: 'A', name: '가' },
    { symbol: 'B', name: '나' },
  ]);

  assert.equal(r.ok, true);
  assert.equal(r.failedCount, 1, '실패 건수를 세어 노출해야 한다');
  assert.ok(r.results[0].error);
  assert.equal(r.results[1].text, '두 번째 뉴스');
});

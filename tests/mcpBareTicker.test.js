const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

/**
 * 🔴 **맨 티커 질의를 내보내지 않는다** (2026-10-01)
 *
 * 라이브 실측(my-computer 로그, 40시간 **6회**): `[web-search] 맨 티커 'QLD' 로 뉴스 검색`.
 * 'QLD' 는 뉴스 인덱스에서 **호주 퀸즐랜드 럭비·5K 마라톤**이 이긴다 — 그 결과가 그대로
 * 매매 판단 프롬프트에 실린다. **쓸모없는 결과로 프롬프트를 오염시키는 것보다 없는 게 낫다.**
 *
 * ❌ **접미어로는 못 고친다** — 09-24 에 실측으로 기각됐다(`QLD stock`→소 목장 매물,
 *    `RAM stock`→멕시코 마트 재고 할인). 모호성을 푸는 것은 **정식 종목명**뿐이고
 *    그건 호출자만 안다(`officialName`). ⇒ 못 구했으면 **건너뛰고 말한다.**
 *
 * ⚠️ **오탐 축이 같은 무게로 중요하다** — 이 가드가 정당한 검색을 죽이면 브리핑이 통째로
 *    비고, 그건 쓰레기가 섞이는 것보다 나쁠 수 있다. 그래서 판정 근거를 *"티커처럼 생겼다"*
 *    가 아니라 **"그 주제의 심볼과 정확히 같다"**(= 이름을 못 구해 떨어졌다는 **증거**)로 둔다.
 */

// 🔴 자격증명을 **넣고** 시작한다 — 안 넣으면 "꺼져 있어서" 통과하는 공허한 초록불이 된다
process.env.MYCOMPUTER_MCP_URL = 'http://127.0.0.1:1/my-computer/mcp';
process.env.MYCOMPUTER_MCP_TOKEN = 'TEST_MCP_TOKEN';
process.env.MYCOMPUTER_MCP_ENABLED = 'true';

const mcp = require('../server/mcpClient');
const realFetch = global.fetch;

function sse(obj) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'text/event-stream'], ['mcp-session-id', 'sess-1']]),
    text: async () => `event: message\ndata: ${JSON.stringify(obj)}\n\n`,
  };
}

const TOOLS = {
  tools: [{
    name: 'webSearch',
    description: '웹 검색',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query', 'limit'],
    },
  }],
};

/** 나간 검색어만 모은다 — 이 파일이 재는 것은 **"무엇을 내보냈는가"** 다 */
function installSearch() {
  const queries = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') {
      return sse({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'my-computer' }, protocolVersion: '2025-06-18' } });
    }
    if (body.method === 'notifications/initialized') return sse({ jsonrpc: '2.0', result: {} });
    if (body.method === 'tools/list') return sse({ jsonrpc: '2.0', id: body.id, result: TOOLS });
    queries.push(body.params?.arguments?.query);
    return sse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '뉴스 본문' }] } });
  };
  return queries;
}

beforeEach(() => { mcp._resetForTest(); });
afterEach(() => { global.fetch = realFetch; });

// ── ① 판정기 자체 (발동 축) ──────────────────────────────────

test('🔴 정식명·이름이 없어 티커로 떨어진 질의를 **맨 티커로 판정**한다', () => {
  const s = { symbol: 'QLD', name: '' };
  assert.equal(mcp.buildQuery(s), 'QLD', '전제 확인 — 이 상태가 실제로 티커를 낸다');
  assert.equal(mcp.isBareTickerQuery(s, 'QLD'), true);
});

test('🔴 이름이 티커와 같아도(미국 ETF 의 전형) 맨 티커다', () => {
  // 실측: 토스가 US ETF 이름을 티커 그대로 주는 경우가 있다 — `name` 분기로 빠져나갔었다
  const s = { symbol: 'QLD', name: 'QLD' };
  assert.equal(mcp.buildQuery(s), 'QLD');
  assert.equal(mcp.isBareTickerQuery(s, 'QLD'), true, '🔴 name 경유로 들어온 티커를 못 잡았다');
});

test('🔴 한국 6자리 코드도 맨 티커다', () => {
  assert.equal(mcp.isBareTickerQuery({ symbol: '005930', name: '005930' }, '005930'), true);
});

// ── ② 오탐 축 ────────────────────────────────────────────────

test('🔴 오탐 축: 정식명이 있으면 **건드리지 않는다**', () => {
  const s = { symbol: 'QLD', name: 'QLD', officialName: 'ProShares Ultra QQQ' };
  assert.equal(mcp.buildQuery(s), 'ProShares Ultra QQQ');
  assert.equal(mcp.isBareTickerQuery(s, mcp.buildQuery(s)), false);
});

test('🔴 오탐 축: 한글 종목명은 맨 티커가 아니다', () => {
  const s = { symbol: '005930', name: '삼성전자' };
  assert.equal(mcp.isBareTickerQuery(s, mcp.buildQuery(s)), false);
});

/**
 * 🔴 **심볼이 없으면 비교 기준이 없다 — 단정하지 않는다.**
 *    채팅의 자유 질의(`{name: 사용자문구, symbol: ''}`)까지 막으면
 *    *"NVDA 어때?"* 같은 **정당한 질문이 죽는다.**
 */
test('🔴 오탐 축: 심볼이 없는 자유 질의는 막지 않는다 (채팅 경로)', () => {
  assert.equal(mcp.isBareTickerQuery({ name: 'NVDA', symbol: '' }, 'NVDA'), false);
});

test('🔴 오탐 축: 시장 주제는 전용 문구라 대상이 아니다', () => {
  const s = { symbol: 'US', name: '미국 증시(S&P500·나스닥)', isMarket: true };
  assert.equal(mcp.isBareTickerQuery(s, mcp.buildQuery(s)), false);
});

test('⚠️ 오탐 축: 티커와 다른 한 낱말 이름은 통과한다', () => {
  assert.equal(mcp.isBareTickerQuery({ symbol: 'TSLA', name: 'Tesla' }, 'Tesla'), false);
});

// ── ③ 실제 호출 경로에서 건너뛴다 ────────────────────────────

test('🔴 맨 티커 주제는 **검색을 아예 안 나간다**', async () => {
  const queries = installSearch();
  const r = await mcp.searchMarketNews([
    { symbol: 'QLD', name: 'QLD' },
    { symbol: '005930', name: '삼성전자' },
  ]);
  assert.equal(r.ok, true);
  const blob = JSON.stringify(queries);
  assert.doesNotMatch(blob, /QLD/, '🔴 맨 티커가 그대로 나갔다 — 퀸즐랜드 럭비가 프롬프트에 실린다');
  assert.match(blob, /삼성전자/, '⚠️ 멀쩡한 종목까지 막으면 가드가 제품을 해친다');
  assert.equal(queries.length, 1, '🔴 나간 검색이 1건이 아니다');
});

/**
 * 🔴 **조용히 빼지 않는다** — 통째로 지우면 `asked` 건수가 거짓말을 하고,
 *    호출자는 *"검색했는데 결과가 없다"* 로 읽는다.
 */
test('🔴 건너뛴 주제가 결과 목록에 **표시로 남는다**', async () => {
  installSearch();
  const r = await mcp.searchMarketNews([{ symbol: 'QLD', name: 'QLD' }]);
  assert.equal(r.results.length, 1, '🔴 조용히 사라졌다');
  assert.equal(r.results[0].skipped, 'bare-ticker');
  assert.equal(r.skippedCount, 1);
});

/**
 * 🔴 **건너뜀은 실패도 적중도 아니다.** 셋을 섞으면 어느 축도 못 센다
 *    (`failedCount` 는 검색 장애를, 본문 유무는 "검색이 돌았다" 는 증거를 센다).
 */
test('🔴 건너뜀이 실패(failedCount)·적중(text)으로 새지 않는다', async () => {
  installSearch();
  const r = await mcp.searchMarketNews([{ symbol: 'QLD', name: 'QLD' }]);
  assert.equal(r.failedCount, 0, '🔴 건너뜀이 장애로 집계된다');
  assert.equal(r.results[0].text, undefined, '🔴 건너뛴 주제에 본문이 있는 것처럼 보인다');
  assert.equal(r.results[0].error, undefined);
});

test('⚠️ 정식명이 붙어 있으면 그대로 검색이 나간다 (회귀 방지)', async () => {
  const queries = installSearch();
  await mcp.searchMarketNews([{ symbol: 'QLD', name: 'QLD', officialName: 'ProShares Ultra QQQ' }]);
  assert.deepEqual(queries, ['ProShares Ultra QQQ']);
});

test('⚠️ 아무도 안 건너뛰면 skippedCount 는 0 이다', async () => {
  installSearch();
  const r = await mcp.searchMarketNews([{ symbol: '005930', name: '삼성전자' }]);
  assert.equal(r.skippedCount, 0);
});

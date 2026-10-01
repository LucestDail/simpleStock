const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

/**
 * 브리핑이 **기사 본문**까지 읽는다 — simpleStock ↔ my-computer 연계 (2026-10-01)
 *
 * ## 왜
 * 종전 브리핑은 검색 **목록**(제목·날짜·URL·220자 요약)만 받았다. 그래서 *"왜 움직였나"*
 * 를 물으면 제목을 바꿔 말하는 수준이었다. 본문을 읽는 `mcpClient.readArticle` 은
 * **이미 구현·실측돼 있었는데**(한국 경제지 12도메인 1.7k~12k자) **채팅 전용**이라
 * 브리핑 경로에 배선이 0 이었다 — *"만들어 놓고 안 쓴"* 자리.
 *
 * ## 🔴 이 자가 지키는 것은 "읽는다" 가 아니라 **"예산을 넘지 않는다"**
 * 회차당 URL 이 8~15개다. 전부 읽으면 프롬프트가 3~4배(+16k~24k 토큰), 최악 +120초다.
 * **출력 길이가 곧 시간인 저장소**에서 그건 브리핑을 죽인다(09-23 전례: 생각이 출력
 * 예산을 먹어 이틀 연속 실패). ⇒ 개수·자수·시간 **세 상한**을 전부 잠근다.
 *
 * ## ⚠️ 함께 지키는 것 — 못 읽은 것을 조용히 넘기지 않는다
 * 본문 확보 실패는 **그 종목 자리에 적는다**. 안 적으면 모델은 제목만 보고도
 * 본문을 본 것처럼 쓴다(그게 이 기능을 넣는 이유와 정면으로 어긋난다).
 */

process.env.SETTINGS_FILE = path.join(os.tmpdir(), `ss-set-article-${process.pid}.json`);
process.env.ANALYST_CHAT_FILE = path.join(os.tmpdir(), `ss-article-chat-${process.pid}.jsonl`);
process.env.ACTIVITY_FILE = path.join(os.tmpdir(), `ss-article-act-${process.pid}.jsonl`);
process.env.TELEGRAM_BOT_TOKEN = 'T';
process.env.TELEGRAM_CHAT_ID = '999';
process.env.TELEGRAM_SEND_ENABLED = 'true';

const realFetch = global.fetch;
let prompts = [];
let mcpResultToReturn = null;
let articleImpl = null;
let readCalls = [];

function fresh() {
  for (const k of Object.keys(require.cache)) {
    if (/analystService|aiService|telegramService|orderService|activityLog|mcpClient|tossClient|settingsService|logger|tickerTapeService/.test(k)) {
      delete require.cache[k];
    }
  }
  const aiPath = require.resolve('../server/aiService');
  require.cache[aiPath] = {
    id: aiPath, filename: aiPath, loaded: true,
    exports: {
      // 🔴 **프롬프트를 붙잡는다** — 이 자가 재는 것은 결과가 아니라 **모델에게 간 입력**이다
      /**
       * ⚠️ **라벨로 겨냥한다.** `analyze()` 는 모델을 두 번 부른다 —
       *    `trade_analyst`(판단) 와 `toss_writing_brief`(문장 정제). 개수로 단언했다가
       *    *"브리핑이 통째로 죽었다"* 는 **틀린 진단**을 낼 뻔했다(실제로는 정상 2회).
       */
      generateStructuredOutput: async (opts) => {
        if (opts?.logLabel === 'trade_analyst') prompts.push(String(opts?.userPrompt || ''));
        return { marketView: '시황', momentumRead: '', dataGaps: [], positions: [], proposals: [] };
      },
      getAiSettings: () => ({}),
    },
  };
  const tapePath = require.resolve('../server/tickerTapeService');
  const realTape = require(tapePath);
  require.cache[tapePath] = {
    id: tapePath, filename: tapePath, loaded: true,
    exports: { ...realTape, getTape: async () => ({ items: [], fixed: [], failed: [] }) },
  };
  const tossPath = require.resolve('../server/tossClient');
  const realToss = require(tossPath);
  require.cache[tossPath] = {
    id: tossPath, filename: tossPath, loaded: true,
    exports: {
      ...realToss,
      getCommissions: async () => [], getInvestorTrading: async () => [],
      getCandles: async () => ({ rows: [] }), getWarnings: async () => [],
      getOrderbook: async () => null, getPriceLimits: async () => null,
    },
  };
  const mcpPath = require.resolve('../server/mcpClient');
  require.cache[mcpPath] = {
    id: mcpPath, filename: mcpPath, loaded: true,
    exports: {
      searchMarketNews: async () => mcpResultToReturn,
      readArticle: async (url) => { readCalls.push(url); return articleImpl(url); },
    },
  };
  return require('../server/analystService');
}

beforeEach(() => {
  prompts = []; readCalls = [];
  articleImpl = async () => ({ ok: true, chars: 100, text: '본문입니다.' });
  global.fetch = async (url) => {
    if (!/api\.telegram\.org/.test(String(url || ''))) return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.ANALYST_ARTICLE_MAX;
  delete process.env.ANALYST_ARTICLE_CHARS;
});

const DASH_EMPTY = () => ({ portfolio: { items: [], summary: null }, momentum: [], warnings: {}, rankings: {} });

/** 검색 결과 N건 — 각각 URL 이 하나씩 들어 있는 실제 서식 */
const hits = (n) => ({
  ok: true, tool: 'webSearch', failedCount: 0, degraded: false,
  results: Array.from({ length: n }, (_, i) => ({
    symbol: `S${i}`, name: `종목${i}`, query: 'q',
    text: `🔎 '종목${i}' 검색 결과 (1건 · 출처 brave-news):\n\n1. [2026-10-01] 제목${i}\n   요약\n   https://example.com/a${i}\n`,
  })),
});

test('🔴 기사 본문이 프롬프트에 실린다 (헤드라인만 보던 것을 고쳤다)', async () => {
  mcpResultToReturn = hits(2);
  const analyst = fresh();
  await analyst.analyze(DASH_EMPTY());
  const p = prompts[0] || '';
  assert.ok(p.includes('## 기사 본문'), '본문 절이 없다 — 배선이 끊겼다');
  assert.ok(p.includes('본문입니다.'), '본문 내용이 안 실렸다');
  assert.deepEqual(readCalls, ['https://example.com/a0', 'https://example.com/a1']);
});

test('🔴 개수 상한을 넘지 않는다 (전부 읽으면 프롬프트가 3~4배가 된다)', async () => {
  process.env.ANALYST_ARTICLE_MAX = '2';
  mcpResultToReturn = hits(6);
  const analyst = fresh();
  await analyst.analyze(DASH_EMPTY());
  assert.equal(readCalls.length, 2, `${readCalls.length}건을 읽었다 — 상한이 안 먹는다`);
  assert.ok((prompts[0] || '').includes('본문을 안 읽었다'),
    '안 읽은 건이 있는데 그 사실이 프롬프트에 없다 — 모델이 전부 봤다고 믿는다');
});

test('🔴 못 읽은 기사는 그 자리에 "못 읽었다" 고 적는다 (조용히 넘기지 않는다)', async () => {
  mcpResultToReturn = hits(1);
  articleImpl = async () => ({ ok: false, error: 'HTTP 403' });
  const analyst = fresh();
  await analyst.analyze(DASH_EMPTY());
  const p = prompts[0] || '';
  assert.ok(/본문을 못 읽었다: HTTP 403/.test(p),
    '실패를 안 적으면 모델은 제목만 보고도 본문을 본 것처럼 쓴다');
  assert.ok(p.includes('제목·요약만으로 판단하라'), '무엇을 근거로 쓸지 안 알려줬다');
});

test('본문 읽기가 예외를 던져도 브리핑은 완주한다 (헤드라인만으로도 회차는 성립한다)', async () => {
  mcpResultToReturn = hits(1);
  articleImpl = async () => { throw new Error('터짐'); };
  const analyst = fresh();
  await analyst.analyze(DASH_EMPTY());
  assert.equal(prompts.length, 1, '판단 프롬프트가 안 만들어졌다 — 브리핑이 죽었다');
  assert.ok(/본문을 못 읽었다: 터짐/.test(prompts[0] || ''), '예외를 그 자리에 안 적었다');
});

test('자수 상한이 먹는다 (긴 본문이 프롬프트를 삼키지 않는다)', async () => {
  process.env.ANALYST_ARTICLE_CHARS = '500';
  mcpResultToReturn = hits(1);
  articleImpl = async () => ({ ok: true, text: 'ㄱ'.repeat(5000) });
  const analyst = fresh();
  await analyst.analyze(DASH_EMPTY());
  const body = (prompts[0] || '').match(/ㄱ+/)?.[0] || '';
  assert.equal(body.length, 500, `본문이 ${body.length}자 — 상한이 안 먹는다`);
});

test('URL 이 없는 검색 결과는 건너뛴다 (읽을 게 없으면 안 부른다)', async () => {
  mcpResultToReturn = {
    ok: true, tool: 'webSearch', failedCount: 0, degraded: false,
    results: [{ symbol: 'S', name: '종목', query: 'q', text: '검색 결과 없음' }],
  };
  const analyst = fresh();
  await analyst.analyze(DASH_EMPTY());
  assert.equal(readCalls.length, 0);
  assert.ok(!(prompts[0] || '').includes('## 기사 본문'), '읽은 게 없는데 빈 절이 생겼다');
});

test('끄면 한 번도 안 부른다 (상한 0 = 기능 정지)', async () => {
  process.env.ANALYST_ARTICLE_MAX = '0';
  mcpResultToReturn = hits(3);
  const analyst = fresh();
  await analyst.analyze(DASH_EMPTY());
  assert.equal(readCalls.length, 0, '껐는데 외부 호출이 나갔다');
  assert.ok(!(prompts[0] || '').includes('## 기사 본문'));
});

test('검색 자체가 없으면 본문 절도 없다 (오탐 축)', async () => {
  mcpResultToReturn = null;
  const analyst = fresh();
  await analyst.analyze(DASH_EMPTY(), { useWebSearch: false });
  assert.equal(readCalls.length, 0);
  assert.ok(!(prompts[0] || '').includes('## 기사 본문'));
});

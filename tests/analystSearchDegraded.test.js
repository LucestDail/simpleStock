const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

/**
 * 🔴 검색 품질 저하(`web.degraded`)가 사용자가 보는 곳(폰 본문)에도 코드로 적힌다
 * (2026-09-28, pm1 지시 — worker2 조사 후속).
 *
 * 종전에는 `degraded:true` 가 **LLM 프롬프트에만**(analystService.js 1137행 부근) 실렸다.
 * 모델이 그 귀띔을 자기 문장에 반영 안 하면 사용자는 저품질 출처였다는 걸 영영 모른다.
 * "프롬프트는 지시일 뿐이고 보장은 코드가 한다" 는 이 저장소 규율대로, 프롬프트 귀띔은
 * 그대로 두고 **코드가 독립으로** 폰 본문에 적는다.
 */

process.env.SETTINGS_FILE = path.join(os.tmpdir(), `ss-set-degraded-${process.pid}.json`);
process.env.ANALYST_CHAT_FILE = path.join(os.tmpdir(), `ss-degraded-chat-${process.pid}.jsonl`);
process.env.ACTIVITY_FILE = path.join(os.tmpdir(), `ss-degraded-act-${process.pid}.jsonl`);
process.env.TELEGRAM_BOT_TOKEN = 'T';
process.env.TELEGRAM_CHAT_ID = '999';
process.env.TELEGRAM_SEND_ENABLED = 'true';

const realFetch = global.fetch;
let sent = [];
let reportToReturn = null;
let mcpResultToReturn = null;

/** `tests/analystBriefPositionsGap.test.js` 와 같은 대역 패턴 */
function fresh() {
  for (const k of Object.keys(require.cache)) {
    if (/analystService|aiService|telegramService|orderService|activityLog|mcpClient|tossClient|settingsService|logger/.test(k)) {
      delete require.cache[k];
    }
  }
  const aiPath = require.resolve('../server/aiService');
  require.cache[aiPath] = {
    id: aiPath, filename: aiPath, loaded: true,
    exports: { generateStructuredOutput: async () => reportToReturn, getAiSettings: () => ({}) },
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
      getCommissions: async () => [],
      getInvestorTrading: async () => [],
      getCandles: async () => ({ rows: [] }),
      getWarnings: async () => [],
      getOrderbook: async () => null,
      getPriceLimits: async () => null,
    },
  };
  const mcpPath = require.resolve('../server/mcpClient');
  require.cache[mcpPath] = {
    id: mcpPath, filename: mcpPath, loaded: true,
    exports: { searchMarketNews: async () => mcpResultToReturn },
  };
  return require('../server/analystService');
}

beforeEach(() => {
  sent = [];
  global.fetch = async (url, init) => {
    const u = String(url || '');
    if (!/api\.telegram\.org/.test(u)) return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    sent.push(JSON.parse(init?.body || '{}'));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
});
afterEach(() => { global.fetch = realFetch; });

const DASH_EMPTY = () => ({ portfolio: { items: [], summary: null }, momentum: [], warnings: {}, rankings: {} });

test('🔴 발동: degraded:true → 폰 본문에 경고 줄이 실린다(소스 이름도 함께)', async () => {
  reportToReturn = { marketView: '시황', momentumRead: '', dataGaps: [], positions: [], proposals: [] };
  mcpResultToReturn = {
    ok: true, tool: 'brave_search', failedCount: 0, degraded: true,
    results: [{ symbol: 'QLD', name: 'QLD', query: 'q', text: '출처 searxng\n...', source: 'searxng' }],
  };
  const analyst = fresh();
  await analyst.analyze(DASH_EMPTY());
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(sent.length, 1, '분석 결과가 안 나갔다');
  assert.match(sent[0].text, /⚠️ 뉴스가 대체 검색 소스에서 왔습니다\(품질 낮음 — searxng\)/);
});

test('🔴 오탐 0(중요): degraded:false → 한 글자도 안 나간다', async () => {
  reportToReturn = { marketView: '시황', momentumRead: '', dataGaps: [], positions: [], proposals: [] };
  mcpResultToReturn = {
    ok: true, tool: 'brave_search', failedCount: 0, degraded: false,
    results: [{ symbol: 'QLD', name: 'QLD', query: 'q', text: '출처 brave\n...', source: 'brave' }],
  };
  const analyst = fresh();
  await analyst.analyze(DASH_EMPTY());
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(sent.length, 1, '분석 결과가 안 나갔다');
  assert.ok(!/대체 검색 소스/.test(sent[0].text), '정상인데 경고가 났다(오탐)');
});

test('오탐: degraded 자체가 없음(검색을 아예 안 한 회차) → 경고 없음', async () => {
  reportToReturn = { marketView: '시황', momentumRead: '', dataGaps: [], positions: [], proposals: [] };
  mcpResultToReturn = null; // useWebSearch:false 이면 web 이 null 이 된다
  const analyst = fresh();
  await analyst.analyze(DASH_EMPTY(), { useWebSearch: false });
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(sent.length, 1, '분석 결과가 안 나갔다');
  assert.ok(!/대체 검색 소스/.test(sent[0].text), 'degraded 가 없는데 경고가 났다');
});

test('🔴 충돌 없음: "못 본 것:" 줄과 degraded 경고가 둘 다 있으면 둘 다 나온다', async () => {
  reportToReturn = {
    marketView: '시황', momentumRead: '', dataGaps: ['환율 데이터 실패'], positions: [], proposals: [],
  };
  mcpResultToReturn = {
    ok: true, tool: 'brave_search', failedCount: 0, degraded: true,
    results: [{ symbol: 'QLD', name: 'QLD', query: 'q', text: '출처 gnews\n...', source: 'gnews' }],
  };
  const analyst = fresh();
  await analyst.analyze(DASH_EMPTY());
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(sent.length, 1, '분석 결과가 안 나갔다');
  assert.match(sent[0].text, /못 본 것: 환율 데이터 실패/, '기존 gaps 줄이 사라졌다');
  assert.match(sent[0].text, /대체 검색 소스에서 왔습니다\(품질 낮음 — gnews\)/, 'degraded 경고가 안 실렸다');
});

/**
 * 🔴 2026-09-28 pm1 후속 — worker2 의 ⓒ 변이 검증이 구멍을 찾았다: brave 필터
 * (`!/^brave/i.test(s)`)를 지워도 위 4건이 전부 통과했다. 원인은 `degraded:true` 케이스가
 * 전부 **단일 non-brave 소스만** 담아서 — "non-brave 가 있다" 는 지금도 잡히지만
 * **"brave 는 목록에서 빠져야 한다"** 는 필터의 존재 이유는 이 파일 어디서도 실증되지
 * 않았다. ⇒ **brave 와 non-brave 가 섞인** 입력으로 재고, "non-brave 가 있다" 뿐 아니라
 * **"brave 가 없다"** 를 정확히 단언한다 — 후자가 없으면 필터를 지워도 통과한다(장식).
 */
test('🔴 필터 검증: brave·non-brave 가 섞이면 목록에 non-brave 만 남고 brave 는 빠진다', async () => {
  reportToReturn = { marketView: '시황', momentumRead: '', dataGaps: [], positions: [], proposals: [] };
  mcpResultToReturn = {
    ok: true, tool: 'brave_search', failedCount: 0, degraded: true,
    results: [
      { symbol: 'QLD', name: 'QLD', query: 'q', text: '출처 brave\n...', source: 'brave' },
      { symbol: 'RAM', name: 'RAM', query: 'q', text: '출처 searxng\n...', source: 'searxng' },
    ],
  };
  const analyst = fresh();
  await analyst.analyze(DASH_EMPTY());
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(sent.length, 1, '분석 결과가 안 나갔다');
  const m = sent[0].text.match(/\(품질 낮음(?: — ([^)]*))?\)/);
  assert.ok(m, '대체소스 문구 자체가 없다');
  // 🔴 "non-brave 가 있다" 만 보면 필터를 지워도 통과한다 — "brave 가 없다" 까지 정확히 본다
  assert.equal(m[1], 'searxng', `alt 목록이 정확히 non-brave 소스만이어야 하는데 다르다(brave 섞임 의심): ${JSON.stringify(m[1])}`);
});

/**
 * 🔴 2026-09-28 pm1 후속 — worker2 가 스크래치(저장소 밖)로 확인한 안전 동작을
 * 영구 테스트로 옮긴다. `web.results || []` 방어가 실제로 있어서 안 터지는 것과,
 * 우연히 안 터지는 것은 테스트 없이는 구분이 안 된다.
 */
test('🔴 results 부재: degraded:true 인데 results 키가 없어도 안 터지고, 접미어 없이 경고만 나간다', async () => {
  reportToReturn = { marketView: '시황', momentumRead: '', dataGaps: [], positions: [], proposals: [] };
  mcpResultToReturn = { ok: true, tool: 'brave_search', failedCount: 0, degraded: true }; // 🔴 results 키 자체가 없다
  const analyst = fresh();

  // ① 예외가 안 난다 — 던지면 이 await 에서 테스트가 그대로 실패한다
  await analyst.analyze(DASH_EMPTY());
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(sent.length, 1, '분석 결과가 안 나갔다(①이 이미 깨졌을 수 있다)');
  // ② 경고 문구는 그래도 나간다
  assert.match(sent[0].text, /⚠️ 뉴스가 대체 검색 소스에서 왔습니다\(품질 낮음\)/, 'results 가 없다고 경고 자체가 사라졌다(②)');
  // ③ 괄호 접미어(" — 소스명")는 안 붙는다 — 없는 소스를 지어내지 않는다
  assert.ok(!/품질 낮음 — /.test(sent[0].text), 'results 가 없는데도 " — " 접미어가 붙었다(③)');
});

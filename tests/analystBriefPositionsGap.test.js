const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

/**
 * 🔴 2026-09-28 실사고 — 프리장(08:47)·장중(12:17) 브리핑 2회 연속 **보유 종목 판단이
 * 통째로 비었는데 정상 발송**됐다. 확정된 결함: `analystService.js` 의 `BRIEF_KINDS` 가
 * `'preopen'` 을 빠뜨려, 그 게이트가 만드는 `briefMarkets` → "대상 시장: … 판단하라"
 * 지시가 프리장·장중 브리핑에서 아예 안 실렸다(이미 `BRIEF_KINDS` 에 `'preopen'` 을
 * 추가해 고쳤다 — 그 사실을 여기서 확인한다).
 *
 * ⇒ 두 축을 잰다:
 * ① 회차 종류별로 "대상 시장 … 판단하라" 지시가 실제 프롬프트에 실리는가
 * ② 보유가 있는데 `positions` 가 (재시도 후에도) 비면 폰 본문에 그 사실이 실리는가
 */

process.env.SETTINGS_FILE = path.join(os.tmpdir(), `ss-set-briefpos-${process.pid}.json`);
process.env.ANALYST_CHAT_FILE = path.join(os.tmpdir(), `ss-briefpos-chat-${process.pid}.jsonl`);
process.env.ACTIVITY_FILE = path.join(os.tmpdir(), `ss-briefpos-act-${process.pid}.jsonl`);
process.env.TELEGRAM_BOT_TOKEN = 'T';
process.env.TELEGRAM_CHAT_ID = '999';
process.env.TELEGRAM_SEND_ENABLED = 'true';

const realFetch = global.fetch;
let sent = [];
let reportToReturn = null;
let llmCalls = [];
let warnCalls = [];

/** `tests/analystTelegram.test.js` 와 같은 대역 패턴 — LLM·테이프·토스·MCP·로거를 갈아끼운다 */
function fresh() {
  for (const k of Object.keys(require.cache)) {
    if (/analystService|aiService|telegramService|orderService|activityLog|mcpClient|tossClient|settingsService|logger/.test(k)) {
      delete require.cache[k];
    }
  }
  const aiPath = require.resolve('../server/aiService');
  require.cache[aiPath] = {
    id: aiPath, filename: aiPath, loaded: true,
    exports: {
      generateStructuredOutput: async (args) => { llmCalls.push(args); return reportToReturn; },
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
      getCommissions: async () => [],
      getInvestorTrading: async () => [],
      getCandles: async () => ({ rows: [] }),
      getWarnings: async () => [],
      getOrderbook: async () => null,
      getPriceLimits: async () => null,
    },
  };
  const mcpPath = require.resolve('../server/mcpClient');
  const realMcp = require(mcpPath);
  require.cache[mcpPath] = {
    id: mcpPath, filename: mcpPath, loaded: true,
    exports: { ...realMcp, searchMarketNews: async () => ({ ok: false, error: '꺼짐', kind: 'disabled', results: [] }) },
  };
  const loggerPath = require.resolve('../server/logger');
  const realLogger = require(loggerPath);
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { ...realLogger, logWarn: (event, ctx) => { warnCalls.push({ event, ctx }); } },
  };
  return require('../server/analystService');
}

beforeEach(() => {
  sent = [];
  llmCalls = [];
  warnCalls = [];
  global.fetch = async (url, init) => {
    const u = String(url || '');
    if (!/api\.telegram\.org/.test(u)) return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    sent.push(JSON.parse(init?.body || '{}'));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
});
afterEach(() => { global.fetch = realFetch; });

const heldKr = [{ symbol: '005930', market: 'KR', name: '삼성전자', dailyRate: 0, profitRate: 0, lastPrice: 70000 }];
const samplePositions = (items) => items.map((it) => (
  { symbol: it.symbol, stance: 'HOLD', confidence: 'MEDIUM', rationale: 'x', evidence: [], risk: 'y' }
));

// ── ① "대상 시장 … 판단하라" 지시 ────────────────────────────

test('🔴 preopen 회차 — 프롬프트에 "판단하라" 지시가 실린다(고치기 전엔 안 실렸다)', async () => {
  reportToReturn = { marketView: 'x', momentumRead: '', dataGaps: [], positions: samplePositions(heldKr), proposals: [] };
  const analyst = fresh();
  await analyst.analyze(
    { portfolio: { items: heldKr, summary: null }, momentum: [], warnings: {}, rankings: {} },
    { trigger: { reasons: [{ kind: 'preopen', key: 'kr', label: 'KRX' }] }, useWebSearch: false }
  );

  assert.ok(llmCalls.length >= 1, 'LLM 이 안 불렸다');
  assert.match(llmCalls[0].userPrompt, /대상 시장:.*판단하라/s, '프리장 브리핑에 "판단하라" 지시가 없다');
});

test('오탐 없음(회귀): open·mid·close 회차도 여전히 "판단하라" 지시가 실린다', async () => {
  for (const kind of ['open', 'mid', 'close']) {
    reportToReturn = { marketView: 'x', momentumRead: '', dataGaps: [], positions: samplePositions(heldKr), proposals: [] };
    const analyst = fresh();
    llmCalls = [];
    // eslint-disable-next-line no-await-in-loop
    await analyst.analyze(
      { portfolio: { items: heldKr, summary: null }, momentum: [], warnings: {}, rankings: {} },
      { trigger: { reasons: [{ kind, key: 'kr', label: 'KRX' }] }, useWebSearch: false }
    );
    assert.match(llmCalls[0].userPrompt, /대상 시장:.*판단하라/s, `${kind} 회차에서 "판단하라" 지시가 사라졌다(회귀)`);
  }
});

// ── ② 보유가 있는데 판단이 비면 조용히 넘어가지 않는다 ─────────────

test('🔴 보유 2종 + positions 빈 결과(재시도 후에도) → 폰 본문에 경고 + logWarn 1건', async () => {
  const held2 = [{ symbol: 'QLD', market: 'US' }, { symbol: 'RAM', market: 'US' }];
  reportToReturn = { marketView: '시황', momentumRead: '', dataGaps: [], positions: [], proposals: [] };
  const analyst = fresh();
  await analyst.analyze(
    { portfolio: { items: held2, summary: null }, momentum: [], warnings: {}, rankings: {} },
    { useWebSearch: false }
  );
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(sent.length, 1, '분석 결과가 안 나갔다');
  assert.match(sent[0].text, /⚠️ 보유 2종\(QLD·RAM\) 판단을 받지 못했습니다/);
  const missingWarns = warnCalls.filter((w) => w.event === 'analyst.positions_missing_in_brief');
  assert.equal(missingWarns.length, 1, 'logWarn 이 안 남았다');
  assert.deepEqual(missingWarns[0].ctx.symbols, ['QLD', 'RAM']);
});

test('오탐 0(중요): 보유 0종 + positions 빈 결과 → 경고 없음', async () => {
  reportToReturn = { marketView: '시황', momentumRead: '', dataGaps: [], positions: [], proposals: [] };
  const analyst = fresh();
  await analyst.analyze(
    { portfolio: { items: [], summary: null }, momentum: [], warnings: {}, rankings: {} },
    { useWebSearch: false }
  );
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(sent.length, 1, '분석 결과가 안 나갔다');
  assert.ok(!/판단을 받지 못했습니다/.test(sent[0].text), '보유가 없는데 경고가 났다(오탐)');
  assert.equal(warnCalls.filter((w) => w.event === 'analyst.positions_missing_in_brief').length, 0);
});

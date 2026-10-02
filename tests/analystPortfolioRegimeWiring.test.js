const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

/**
 * 🔴 **배선 테스트** — 순수 함수만 재면 *"로직은 맞는데 안 불린다"* 를 못 잡는다.
 *
 * `matchScenarios` 가 포트폴리오 조건을 **읽을 줄 아는 것**과, 브리핑이 그 조건을
 * **실제로 넘기는 것**은 다른 층이다. 실측으로 확인한 것:
 *   변이(브리핑에서 비중을 안 넘김) → `regimeMacroAxes` 테스트 **전부 통과**.
 *   = 순수 테스트만으로는 배선이 끊겨도 초록불이다.
 *
 * 그리고 이게 바로 2026-10-02 의 상태였다 — 레버리지 합계 **90.7%** 인데
 * 어떤 매뉴얼도 그걸 보지 않았다(시장 축만 봤기 때문이다).
 */

process.env.SETTINGS_FILE = path.join(os.tmpdir(), `ss-pw-set-${process.pid}.json`);
process.env.ANALYST_CHAT_FILE = path.join(os.tmpdir(), `ss-pw-chat-${process.pid}.jsonl`);
process.env.ACTIVITY_FILE = path.join(os.tmpdir(), `ss-pw-act-${process.pid}.jsonl`);
process.env.ORDERS_FILE = path.join(os.tmpdir(), `ss-pw-ord-${process.pid}.json`);

let prompt;

function fresh() {
  prompt = '';
  for (const k of Object.keys(require.cache)) {
    if (/analystService|aiService|telegramService|orderService|mcpClient|tossClient|settingsService|tickerTapeService|tossPortfolio|tossWriting|regimeService/.test(k)) delete require.cache[k];
  }
  const put = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  put('../server/aiService', {
    generateStructuredOutput: async (opts) => {
      if (opts?.logLabel === 'trade_analyst') prompt = String(opts.userPrompt || '');
      return { marketView: '시황', momentumRead: '', dataGaps: [], positions: [], proposals: [] };
    },
    getAiSettings: () => ({}),
  });
  put('../server/telegramService', { send: async () => ({ ok: true, sent: true }), isConfigured: () => true, status: () => ({ ok: true }) });
  put('../server/tossWriting', { refine: async (t) => t });
  put('../server/mcpClient', { searchMarketNews: async () => ({ ok: false, results: [] }), readArticle: async () => ({ ok: false }) });
  const tc = require.resolve('../server/tossClient'); const realToss = require(tc);
  put('../server/tossClient', {
    ...realToss,
    getCommissions: async () => [], getInvestorTrading: async () => [], getWarnings: async () => [],
    getOrderbook: async () => null, getPriceLimits: async () => null,
    // ⚠️ 국면 판정이 캔들을 쓴다 — 상승추세·평온이 나오도록 단조 증가를 준다
    getCandles: async () => ({ rows: Array.from({ length: 70 }, (_, i) => ({ c: 50 + i * 0.5 })) }),
    getIndexCandles: async () => ({ rows: Array.from({ length: 70 }, (_, i) => ({ c: 50 + i * 0.5 })) }),
    getIndexPrices: async () => [{ lastPrice: 90 }],
  });
  const tape = require.resolve('../server/tickerTapeService'); const realTape = require(tape);
  put('../server/tickerTapeService', { ...realTape, getTape: async () => ({ items: [], fixed: [], failed: [] }) });
  return require('../server/analystService');
}

const DASH = (items, cashUsd) => ({
  portfolio: { items, summary: { cash: { usd: { amount: cashUsd }, krw: { amount: 0 } } } },
  momentum: [], warnings: {}, rankings: {},
});

const realFetch = global.fetch;
beforeEach(() => { global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }); });
afterEach(() => { global.fetch = realFetch; });

test('🔴 레버리지 쏠림이 브리핑 프롬프트에 **매뉴얼로** 실린다 (배선)', async () => {
  const analyst = fresh();
  await analyst.analyze(DASH([
    { symbol: 'QLD', market: 'US', marketValue: 8690, leverageFactor: 2, quantity: 90, lastPrice: 96.5 },
    { symbol: 'RAM', market: 'US', marketValue: 5600, leverageFactor: 2, quantity: 400, lastPrice: 14 },
  ], 1375), { useWebSearch: false });
  assert.ok(prompt, '프롬프트를 못 붙잡았다 — 아래 단언이 전부 공허하다');
  assert.match(prompt, /레버리지 쏠림/, '🔴 레버리지 90% 인데 그 매뉴얼이 안 실렸다 — 비중이 국면 판정에 안 넘어갔다');
  assert.match(prompt, /내 포트폴리오/, '발동 근원이 "내 포트폴리오" 로 안 적혔다');
  assert.match(prompt, /레버리지 합계 9\d(\.\d)?%/, '레버리지 합계 숫자가 안 실렸다');
});

test('오탐 축: 레버리지가 낮으면 그 매뉴얼은 안 실린다', async () => {
  const analyst = fresh();
  await analyst.analyze(DASH([
    { symbol: 'SPY', market: 'US', marketValue: 1000, leverageFactor: 1, quantity: 1, lastPrice: 1000 },
  ], 9000), { useWebSearch: false });
  assert.ok(prompt, '프롬프트를 못 붙잡았다');
  assert.ok(!/레버리지 쏠림/.test(prompt), '레버리지가 없는데 쏠림 매뉴얼이 떴다');
});

test('🔴 현금 과다도 **내 포트폴리오** 국면으로 잡힌다', async () => {
  const analyst = fresh();
  await analyst.analyze(DASH([
    { symbol: 'SPY', market: 'US', marketValue: 1000, leverageFactor: 1, quantity: 1, lastPrice: 1000 },
  ], 9000), { useWebSearch: false });
  assert.match(prompt, /현금 과다/, '현금 90% 인데 기회비용 매뉴얼이 안 떴다');
});

/**
 * 🔴 **괴리를 코드가 빼서 준다** — 2026-10-02 09:04 라이브 실측
 *
 * 레버리지 합계 **90.7%** 인데 발동 매뉴얼은 *"레버리지 0~10%"* 를 말했다.
 * 괴리가 80%p 인데 **제안이 0건**(`model_proposed_none`)이었다 —
 * 현재 비중과 기준 배분을 **따로** 주고 뺄셈을 모델에게 맡긴 탓이다.
 * ⇒ 숫자를 **빼서** 준다. 행동으로 옮기기 쉬운 형태로.
 */
test('🔴 레버리지 괴리를 %p 와 금액으로 계산해 준다', async () => {
  const analyst = fresh();
  await analyst.analyze(DASH([
    { symbol: 'QLD', market: 'US', marketValue: 8690, leverageFactor: 2, quantity: 90, lastPrice: 96.5 },
    { symbol: 'RAM', market: 'US', marketValue: 5600, leverageFactor: 2, quantity: 400, lastPrice: 14 },
  ], 1375), { useWebSearch: false });
  assert.ok(prompt, '프롬프트를 못 붙잡았다 — 아래 단언이 공허하다');
  assert.match(prompt, /레버리지 괴리/, '🔴 괴리를 계산해 주지 않았다 — 모델이 뺄셈을 해야 한다');
  assert.match(prompt, /\d+(\.\d+)?%p 초과/, '초과분이 %p 로 안 적혔다');
  assert.match(prompt, /어치 축소가 필요하다/, '금액으로 환산해 주지 않았다');
  assert.match(prompt, /아무것도 제안하지 않는 것은 답이 아니다/, '0건으로 끝내도 된다고 읽을 여지를 남겼다');
});

test('오탐 축: 레버리지가 기준 안이면 괴리를 적지 않는다', async () => {
  const analyst = fresh();
  await analyst.analyze(DASH([
    { symbol: 'SPY', market: 'US', marketValue: 5000, leverageFactor: 1, quantity: 5, lastPrice: 1000 },
  ], 5000), { useWebSearch: false });
  assert.ok(!/레버리지 괴리/.test(prompt), '레버리지가 0인데 괴리를 적었다');
});

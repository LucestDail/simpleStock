const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

/**
 * 🔴 **현금을 넘는 제안을 거부하지 말고 깎는다** — 2026-10-02 라이브 실사고
 *
 * 08:00 KRX 프리장 회차 실물:
 * ```
 * analyst.proposal_blocked  SHY BUY  kind=insufficient
 *   "현금이 부족합니다 (필요 1622.00 USD > 가능 1375.34)."
 * analyst.no_proposal_reason  reason=all_rejected  proposed=1 created=0 rejected=1
 * ```
 * 모델 판단(**신용 경색·금리 상승 국면이니 단기국채로 피난**)은 **맞았는데**, 수량 하나
 * 때문에 제안이 통째로 날아갔고 사용자 화면에는 *"매매 제안 0건"* 만 남았다.
 *
 * ★ `checkAccountLimits` 는 **가능 수량(maxQuantity)을 이미 계산해서 돌려주고 있었다** —
 *   그걸 읽는 코드가 **0곳**이었다. *"수집해 놓고 안 쓰는"* 의 또 하나.
 *
 * ⚠️ 깎는 것은 **수량 부족일 때만**이다. 가격 밴드·종목 제한 같은 거부는 **판단 자체가
 *    틀린 것**이라 깎아서 통과시키면 안 된다 — 그건 가드를 무력화하는 것이다.
 */

process.env.SETTINGS_FILE = path.join(os.tmpdir(), `ss-clamp-set-${process.pid}.json`);
process.env.ANALYST_CHAT_FILE = path.join(os.tmpdir(), `ss-clamp-chat-${process.pid}.jsonl`);
process.env.ACTIVITY_FILE = path.join(os.tmpdir(), `ss-clamp-act-${process.pid}.jsonl`);
process.env.ORDERS_FILE = path.join(os.tmpdir(), `ss-clamp-ord-${process.pid}.json`);

let proposed; let limitResult; let logs;

function fresh(report) {
  proposed = []; logs = [];
  for (const k of Object.keys(require.cache)) {
    if (/analystService|aiService|telegramService|orderService|activityLog|mcpClient|tossClient|settingsService|tickerTapeService|tossPortfolio|tossWriting|logger/.test(k)) delete require.cache[k];
  }
  const put = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  const realLogger = (() => { const p = require.resolve('../server/logger'); delete require.cache[p]; const r = require(p); delete require.cache[p]; return r; })();
  put('../server/logger', { ...realLogger, logInfo: (ev, d) => logs.push({ ev, d }), logWarn: (ev, d) => logs.push({ ev, d }), logError: () => {} });
  put('../server/aiService', { generateStructuredOutput: async () => JSON.parse(JSON.stringify(report)), getAiSettings: () => ({}) });
  put('../server/telegramService', { send: async () => ({ ok: true, sent: true }), isConfigured: () => true, status: () => ({ ok: true }) });
  put('../server/tossWriting', { refine: async (t) => t });
  put('../server/orderService', {
    checkAccountLimits: async () => limitResult,
    propose: (p) => { proposed.push(p); return { ok: true, proposal: { id: 'p1', ...p } }; },
    CASH_FLOOR_PCT: 0,
  });
  put('../server/mcpClient', { searchMarketNews: async () => ({ ok: false, results: [] }), readArticle: async () => ({ ok: false }) });
  const tape = require.resolve('../server/tickerTapeService'); const realTape = require(tape);
  put('../server/tickerTapeService', { ...realTape, getTape: async () => ({ items: [], fixed: [], failed: [] }) });
  const tc = require.resolve('../server/tossClient'); const realToss = require(tc);
  put('../server/tossClient', { ...realToss, getCommissions: async () => [], getInvestorTrading: async () => [], getCandles: async () => ({ rows: [] }), getWarnings: async () => [], getOrderbook: async () => null, getPriceLimits: async () => null });
  return require('../server/analystService');
}

const REPORT = (qty) => ({
  marketView: '시황', momentumRead: '', dataGaps: [], positions: [],
  proposals: [{ symbol: 'SHY', side: 'BUY', quantity: qty, price: 81.1, reason: '금리 상승 국면 피난' }],
});
const DASH = { portfolio: { items: [], summary: { cash: { usd: { amount: 1375 }, krw: { amount: 0 } } } }, momentum: [], warnings: {}, rankings: {} };

const realFetch = global.fetch;
beforeEach(() => { global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }); });
afterEach(() => { global.fetch = realFetch; });

test('🔴 현금이 모자라면 **가능 수량으로 깎아서** 제안을 낸다 (08:00 실사고 재현)', async () => {
  limitResult = { ok: false, kind: 'insufficient', maxQuantity: 16, error: '현금이 부족합니다 (필요 1622.00 USD > 가능 1375.34).' };
  const analyst = fresh(REPORT(20));
  await analyst.analyze(DASH, { useWebSearch: false });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(proposed.length, 1, '제안이 통째로 날아갔다 — 판단은 맞았는데 수량 하나 때문이다');
  assert.equal(proposed[0].quantity, 16, '가능 수량으로 안 깎였다');
  const c = logs.find((l) => l.ev === 'analyst.proposal_clamped');
  assert.ok(c, '깎았다는 기록이 없다 — 조용히 바꾸면 안 된다');
  assert.equal(c.d.asked, 20);
  assert.equal(c.d.to, 16);
  assert.match(proposed[0].reason, /20→16주 축소/, '승인 화면에서 원래 의도를 알 수 없다');
});

test('🔴 수량 부족이 **아닌** 거부는 깎지 않는다 (가드 무력화 방지)', async () => {
  limitResult = { ok: false, kind: 'price-band', maxQuantity: 5, error: '지정가가 현재가 ±2.5% 밖입니다.' };
  const analyst = fresh(REPORT(20));
  await analyst.analyze(DASH, { useWebSearch: false });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(proposed.length, 0, '🔴 판단이 틀린 제안을 깎아서 통과시켰다 — 가드를 무력화한 것이다');
  assert.ok(logs.some((l) => l.ev === 'analyst.proposal_blocked'));
  assert.ok(!logs.some((l) => l.ev === 'analyst.proposal_clamped'));
});

test('가능 수량이 1주 미만이면 깎지 않고 거부한다 (0주 제안은 제안이 아니다)', async () => {
  limitResult = { ok: false, kind: 'insufficient', maxQuantity: 0, error: '현금이 부족합니다.' };
  const analyst = fresh(REPORT(20));
  await analyst.analyze(DASH, { useWebSearch: false });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(proposed.length, 0);
  assert.ok(!logs.some((l) => l.ev === 'analyst.proposal_clamped'));
});

test('오탐 축: 한도 안이면 그대로 간다 (깎지 않는다)', async () => {
  limitResult = { ok: true };
  const analyst = fresh(REPORT(10));
  await analyst.analyze(DASH, { useWebSearch: false });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].quantity, 10, '멀쩡한 수량을 건드렸다');
  assert.ok(!logs.some((l) => l.ev === 'analyst.proposal_clamped'));
  assert.ok(!/축소/.test(proposed[0].reason || ''), '안 깎았는데 축소했다고 적었다');
});

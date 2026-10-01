const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

/**
 * 🔴 **근거 보고서가 만들어지고 버려지고 있었다** — 2026-10-02 사용자 지적
 *
 * > *"지금 퀀트 모먼트 분석가로서 제대로 매도 매수 제안도 안나오고 매도 매수 제안 근거
 * >  보고서도 없고 뭐하는거야? 토큰비용이 너무 아까운데?"*
 *
 * 맞는 말이었다. 라이브 05:48 회차에서 모델은 O 한 종목에 대해 이만큼을 만들었다:
 * ```
 * entry 54.3 · stop 52.5 · target 57.52
 * evidence ['120일 고점대비 -18.59%', '52주 신저가 54.30 (검색)']
 * risk · scenarioUp · scenarioDown
 * trade { rr: 1.79, rrAfterFee: 1.63, riskPct: 3.31, sizedQuantity: 160 }
 * ```
 * 폰으로 간 것은 `marketView` + `momentumRead` **두 문장뿐**이었다.
 * ⇒ *"수집해 놓고 안 쓰는"* 의 가장 비싼 형태 — **토큰을 쓰고 버렸다.**
 *
 * ⚠️ 이 자가 재는 것은 "보고서가 생성됐나" 가 아니라 **"폰으로 갔나"** 다.
 *    생성은 이미 되고 있었다 — 끊긴 곳은 전달이다.
 */

process.env.SETTINGS_FILE = path.join(os.tmpdir(), `ss-rep-set-${process.pid}.json`);
process.env.ANALYST_CHAT_FILE = path.join(os.tmpdir(), `ss-rep-chat-${process.pid}.jsonl`);
process.env.ACTIVITY_FILE = path.join(os.tmpdir(), `ss-rep-act-${process.pid}.jsonl`);
process.env.ORDERS_FILE = path.join(os.tmpdir(), `ss-rep-ord-${process.pid}.json`);

const REPORT = {
  marketView: '시황 두 문장.',
  momentumRead: '모멘텀 두 문장.',
  dataGaps: [],
  proposals: [],
  positions: [{
    symbol: 'O', stance: 'HOLD', confidence: 'LOW',
    entry: 54.3, stop: 52.5, target: 57.52,
    rationale: '배당주로서 약세 흐름이지만 20일선 회복 전까지 보류한다.',
    evidence: ['120일 고점대비 -18.59%', '52주 신저가 54.30 (검색)'],
    risk: '20일선을 회복하지 못하면 추세적 하락이 이어질 수 있다.',
    scenarioUp: '20일선 57.52를 종가로 상회하면 반등 전환.',
    scenarioDown: '52주 저점 54.30을 하회하면 추가 하락.',
  }],
};

let sent;

function fresh() {
  sent = [];
  for (const k of Object.keys(require.cache)) {
    if (/analystService|aiService|telegramService|orderService|activityLog|mcpClient|tossClient|settingsService|tickerTapeService|tossPortfolio|tossWriting/.test(k)) {
      delete require.cache[k];
    }
  }
  const put = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  put('../server/aiService', {
    generateStructuredOutput: async () => JSON.parse(JSON.stringify(REPORT)),
    getAiSettings: () => ({}),
  });
  put('../server/telegramService', {
    send: async (text) => { sent.push(String(text)); return { ok: true, sent: true }; },
    isConfigured: () => true, status: () => ({ ok: true }),
  });
  /** ⚠️ 정제기는 **그대로 돌려준다** — 정제 결과를 재는 자가 아니다 */
  put('../server/tossWriting', { refine: async (t) => t });
  const tapePath = require.resolve('../server/tickerTapeService');
  const realTape = require(tapePath);
  put('../server/tickerTapeService', { ...realTape, getTape: async () => ({ items: [], fixed: [], failed: [] }) });
  const tossPath = require.resolve('../server/tossClient');
  const realToss = require(tossPath);
  put('../server/tossClient', {
    ...realToss,
    getCommissions: async () => [], getInvestorTrading: async () => [],
    getCandles: async () => ({ rows: [] }), getWarnings: async () => [],
    getOrderbook: async () => null, getPriceLimits: async () => null,
  });
  put('../server/mcpClient', { searchMarketNews: async () => ({ ok: false, kind: 'test', error: '목', results: [] }), readArticle: async () => ({ ok: false, error: '목' }) });
  return require('../server/analystService');
}

const DASH = () => ({
  portfolio: { items: [{ symbol: 'O', name: '리얼티 인컴', quantity: 1, avgPrice: 54.4, lastPrice: 53.66, currency: 'USD' }], summary: { cash: { usd: { amount: 1375 }, krw: { amount: 0 } } } },
  momentum: [], warnings: {}, rankings: {},
});

const realFetch = global.fetch;
beforeEach(() => { global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }); });
afterEach(() => { global.fetch = realFetch; });

const body = () => sent.join('\n');

test('🔴 종목별 entry/stop/target 이 폰으로 간다', async () => {
  const analyst = fresh();
  await analyst.analyze(DASH());
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(sent.length, '텔레그램으로 아무것도 안 갔다');
  const b = body();
  assert.match(b, /54\.30/, '진입가가 없다');
  assert.match(b, /52\.50/, '손절가가 없다 — "여기가 깨지면 틀린 것" 이 안 간다');
  assert.match(b, /57\.52/, '목표가가 없다');
});

test('🔴 근거·리스크·양방향 시나리오가 폰으로 간다', async () => {
  const analyst = fresh();
  await analyst.analyze(DASH());
  await new Promise((r) => setTimeout(r, 60));
  const b = body();
  assert.match(b, /120일 고점대비 -18\.59%/, 'evidence 가 버려졌다');
  assert.match(b, /52주 신저가 54\.30 \(검색\)/, '검색 근거가 버려졌다');
  assert.match(b, /20일선을 회복하지 못하면/, 'risk 가 버려졌다');
  assert.match(b, /↑/, 'scenarioUp 이 없다');
  assert.match(b, /↓/, 'scenarioDown 이 없다');
});

test('R:R 은 시스템이 계산한 값이 실린다 (모델이 아니라)', async () => {
  const analyst = fresh();
  await analyst.analyze(DASH());
  await new Promise((r) => setTimeout(r, 60));
  assert.match(body(), /R:R\s*\d/, '손익비가 안 갔다 — 계산해 놓고 안 쓰는 자리다');
});

/**
 * ⚠️ **오탐 축** — 판단이 0건이면 이 절을 아예 만들지 않는다. 빈 머리글만 가면
 *    사용자는 "뭔가 고장났나" 로 읽는다.
 */
test('오탐 축: 종목 판단이 0건이면 근거 절을 만들지 않는다', async () => {
  REPORT.positions = [];
  try {
    const analyst = fresh();
    await analyst.analyze({ ...DASH(), portfolio: { items: [], summary: { cash: { usd: { amount: 0 }, krw: { amount: 0 } } } } });
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(!body().includes('종목별 근거'), '판단이 없는데 빈 근거 절이 갔다');
  } finally {
    REPORT.positions = [{
      symbol: 'O', stance: 'HOLD', confidence: 'LOW', entry: 54.3, stop: 52.5, target: 57.52,
      rationale: '배당주로서 약세 흐름이지만 20일선 회복 전까지 보류한다.',
      evidence: ['120일 고점대비 -18.59%', '52주 신저가 54.30 (검색)'],
      risk: '20일선을 회복하지 못하면 추세적 하락이 이어질 수 있다.',
      scenarioUp: '20일선 57.52를 종가로 상회하면 반등 전환.',
      scenarioDown: '52주 저점 54.30을 하회하면 추가 하락.',
    }];
  }
});

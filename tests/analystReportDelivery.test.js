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
    if (/analystService|aiService|telegramService|activityLog|mcpClient|tossClient|settingsService|tickerTapeService|tossPortfolio|tossWriting/.test(k)) {
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

/**
 * 🔴 **2026-10-13 — 이 테스트들은 "낡은 세계" 를 지키고 있었다. 계약을 뒤집는다.**
 *
 * 원래(2026-10-02)는 참이었다: 모델이 SELL 이라 해놓고 수량·가격을 못 정해 `proposals` 를
 * 비워 두는 회차가 있었고, 그걸 폰에 적는 것이 맞았다.
 *
 * 그런데 **2026-10-12 에 주문 집행을 걷어내며 `proposals` 를 백테스트 전용 스키마로 옮겼다**
 * (`reportSchemaFor(…, { trades: true })` — 라이브 호출부는 그 인자를 안 준다).
 * ⇒ 라이브는 모델에게 제안을 **묻지 않는다.** 그러니
 *   *"모델이 수량·가격을 정하지 못했습니다 … 다시 분석을 돌려 주세요"* 는 **거짓**이고,
 *   몇 번을 다시 돌려도 결과는 같다.
 *
 * 🔴 **왜 이 테스트들이 못 잡았나** — `REPORT.proposals = [...]` 를 **목에 직접 주입**했다.
 *    라이브 스키마엔 그 칸이 아예 없으니 **일어날 수 없는 상황**을 만들어 놓고 통과시킨 것이다.
 *    ⇒ 이제 **라이브 계약 자체**를 단언한다: 스키마에 칸이 없고, 폰에 그 문구가 없다.
 */
test('🔴 라이브 스키마에는 `proposals` 칸이 없다 (이 계약이 아래 두 테스트의 근거다)', () => {
  const analyst = fresh();
  const live = analyst._reportSchemaFor(['QLD', 'RAM']);
  assert.ok(!('proposals' in (live.properties || {})), '라이브가 제안을 묻고 있다 — 아래 단언들의 전제가 깨졌다');
  assert.ok(!(live.required || []).includes('proposals'));
  // ★ 자의 판별력 — 백테스트 경로는 **열려 있어야** 한다(둘 다 닫히면 이 테스트는 공허하다)
  const bt = analyst._reportSchemaFor([], { trades: true });
  assert.ok('proposals' in (bt.properties || {}), '백테스트까지 닫혔다 — 시뮬레이션이 돌 수 없다');
});

test('🔴 SELL 판단이 있어도 폰에 "제안이 없다" 는 말을 하지 않는다 (라이브는 제안을 묻지 않는다)', async () => {
  REPORT.positions = [
    { symbol: 'QLD', stance: 'SELL', confidence: 'MEDIUM', rationale: '레버리지 축소', evidence: [], risk: '', scenarioUp: '', scenarioDown: '' },
    { symbol: 'RAM', stance: 'HOLD', confidence: 'LOW', rationale: '보유', evidence: [], risk: '', scenarioUp: '', scenarioDown: '' },
  ];
  REPORT.proposals = [];
  const analyst = fresh();
  await analyst.analyze(DASH(), { useWebSearch: false });
  await new Promise((r) => setTimeout(r, 60));
  const b = body();
  assert.ok(!/판단은 났는데 제안이 없습니다/.test(b), `🔴 거짓 문구가 되살아났다: ${b.slice(0, 300)}`);
  assert.ok(!/다시 분석을 돌려 주세요/.test(b), '🔴 몇 번을 돌려도 같은데 다시 돌리라고 했다');
  assert.ok(!/매매 제안 \d+건/.test(b), '🔴 "제안 N건" — 라이브에는 제안이라는 개념이 없다');
  // ⚠️ 판단 자체는 **그대로 가야 한다** — 문구를 지운다고 내용까지 사라지면 안 된다
  assert.match(b, /QLD/, '종목 판단이 통째로 사라졌다');
});

test('오탐 축: 전부 HOLD 면 아무 말도 안 한다', async () => {
  REPORT.positions = [{ symbol: 'QLD', stance: 'HOLD', confidence: 'LOW', rationale: 'x', evidence: [], risk: '', scenarioUp: '', scenarioDown: '' }];
  const analyst = fresh();
  await analyst.analyze(DASH(), { useWebSearch: false });
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(!/판단은 났는데/.test(body()), 'HOLD 뿐인데 경고가 났다');
});

/**
 * 🔴 **모델의 "희망 데이터 목록" 은 폰에 보내지 않는다** (2026-10-13 사용자 지시:
 *    *"못본것 저런거 관심없는데 왜 자꾸 뜨는거야."*)
 *
 * `report.dataGaps` 는 모델이 *"있었으면 좋았을 데이터"* 를 적는 칸이다. 라이브 실측:
 *   `변동성(연) 미제공 · 포트폴리오 VaR 미제공 · 기관·내부자 수급 미제공 · 재무제표 상세 미제공`
 * **매 회차 내용이 다르고, 사용자가 할 수 있는 일이 없고, 우리가 제공할 계획도 없다.**
 * 반면 **코드가 찾은 결손**(웹 검색 불가 등)은 원인이 우리 쪽이라 보낼 값이 있다.
 */
test('🔴 모델이 적은 dataGaps 는 폰에 안 간다 (희망 목록 ≠ 결손)', async () => {
  REPORT.positions = [{ symbol: 'QLD', stance: 'HOLD', confidence: 'LOW', rationale: 'x', evidence: [], risk: '', scenarioUp: '', scenarioDown: '' }];
  REPORT.dataGaps = ['포트폴리오 VaR 미제공', '기관·내부자 수급 미제공'];
  try {
    const analyst = fresh();
    await analyst.analyze(DASH(), { useWebSearch: false });
    await new Promise((r) => setTimeout(r, 60));
    const b = body();
    assert.ok(!/포트폴리오 VaR 미제공/.test(b), `🔴 모델 희망 목록이 폰에 갔다: ${b.slice(0, 300)}`);
    assert.ok(!/기관·내부자 수급 미제공/.test(b), '🔴 모델 희망 목록이 폰에 갔다');
    assert.ok(!/못 본 것:/.test(b), '🔴 옛 문구가 되살아났다');
  } finally { REPORT.dataGaps = []; }
});

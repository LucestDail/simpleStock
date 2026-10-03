/**
 * 🎬 시나리오 총합 테스트 (2026-10-03 재개편 검수 — 사용자 지시)
 *
 * 단위 자들은 각 가드를 **고립**해서 재지만, 실사고는 늘 **연결부**에서 났다
 * (로직은 맞는데 안 불린다 · 한 가드가 통과하면 다른 축이 뚫린다).
 * 여기서는 **analyze() 전구간**을 목 LLM·목 토스로 태워 시나리오별로 끝까지 간다.
 *
 * ⚠️ 목 LLM 은 **호출 차수별로 다른 응답**을 준다 — 재요청 경로는 그렇게만 태울 수 있다.
 * ⚠️ 각 시나리오는 모듈 캐시를 새로 깐다 — 상태가 새면 앞 시나리오가 뒤를 오염시킨다.
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const HELD = [
  { symbol: 'QLD', name: 'QLD', quantity: 70, avgPrice: 71.78, lastPrice: 97.5, currency: 'USD', market: 'US', marketValue: 6825 },
  { symbol: 'RAM', name: 'RAM', quantity: 300, avgPrice: 19.08, lastPrice: 14.5, currency: 'USD', market: 'US', marketValue: 4350 },
  { symbol: 'O', name: '리얼티 인컴', quantity: 2, avgPrice: 54.03, lastPrice: 53.7, currency: 'USD', market: 'US', marketValue: 107 },
];
const pos = (symbol, stance, extra = {}) => ({
  symbol, stance, confidence: 'MEDIUM',
  rationale: `${symbol} 판단`, evidence: [], risk: '위험',
  ...extra,
});
const BASE = { marketView: '시황.', momentumRead: '모멘텀.', dataGaps: [], proposals: [] };

/** 캔들: last 가 20일선 위가 되게 — 마지막 값만 크게 */
const risingCandles = () => ({ rows: Array.from({ length: 120 }, (_, i) => ({ c: 80 + i * 0.2, h: 81 + i * 0.2, l: 79 + i * 0.2 })) });

function fresh({ llmResponses, candles = risingCandles }) {
  for (const k of Object.keys(require.cache)) {
    if (/simpleStock\/(server|tests)\//.test(k)) delete require.cache[k];
  }
  const put = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  const llmCalls = [];
  put('../server/aiService', {
    generateStructuredOutput: async (opts) => {
      llmCalls.push(opts.logLabel || '?');
      const i = Math.min(llmCalls.length - 1, llmResponses.length - 1);
      const r = llmResponses[i];
      return typeof r === 'function' ? r(opts) : JSON.parse(JSON.stringify(r));
    },
    getAiSettings: () => ({}),
  });
  const sent = [];
  put('../server/telegramService', {
    send: async (t) => { sent.push(String(t)); return { ok: true, sent: true }; },
    isConfigured: () => true, status: () => ({ ok: true }),
  });
  put('../server/tossWriting', { refine: async (t) => t });
  const realTape = require(require.resolve('../server/tickerTapeService'));
  put('../server/tickerTapeService', { ...realTape, getTape: async () => ({ items: [], fixed: [], failed: [] }) });
  const realToss = require(require.resolve('../server/tossClient'));
  put('../server/tossClient', {
    ...realToss,
    getCommissions: async () => [], getInvestorTrading: async () => [],
    getCandles: async () => candles(), getWarnings: async () => [],
    getOrderbook: async () => null, getPriceLimits: async () => null,
    getIndexPrices: async () => ({}), getIndexCandles: async () => ({ rows: [] }),
    getIndexInvestorTrading: async () => [],
  });
  put('../server/mcpClient', {
    searchMarketNews: async () => ({ ok: false, kind: 'test', error: '목', results: [] }),
    readArticle: async () => ({ ok: false }), status: () => ({ effective: 'off' }),
  });
  put('../server/stockRating', { rate: async () => ({ total: null, isFund: true, typeWhy: '목' }) });
  const analyst = require('../server/analystService');
  return { analyst, sent, llmCalls };
}

const DASH = () => ({
  portfolio: {
    items: JSON.parse(JSON.stringify(HELD)),
    summary: { cash: { usd: { amount: 4755 }, krw: { amount: 0 } }, value: { krw: 15_000_000 } },
  },
  momentum: [], warnings: {}, rankings: {},
});

const realFetch = global.fetch;
beforeEach(() => { global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }); });
afterEach(() => { global.fetch = realFetch; });

const holdings3 = (over = {}) => ([
  pos('QLD', over.QLD || 'HOLD', { entry: 97.5, stop: 92.7, target: 103 }),
  pos('RAM', over.RAM || 'HOLD', { entry: 14.5, stop: 13.6, target: 15.4 }),
  pos('O', over.O || 'HOLD'),
]);

// ───────────────────────────────────────────────────────────────────

test('S1 정상 회차 — 보유 3종 전부 판단되고 폰으로 간다', async () => {
  const { analyst, sent } = fresh({ llmResponses: [{ ...BASE, holdings: holdings3() }] });
  const r = await analyst.analyze(DASH(), { dryRun: true });
  const syms = r.positions.map((p) => p.symbol).sort();
  assert.deepStrictEqual(syms, ['O', 'QLD', 'RAM']);
  assert.ok(r.positions.every((p) => !p._codeFilled), '모델이 직접 냈어야 한다');
  // dryRun 은 폰 발송 없음 — 그 축도 함께 못박는다
  assert.strictEqual(sent.length, 0, 'dryRun 인데 폰으로 갔다');
});

test('S2 보유 누락 — 재시도 후에도 없으면 코드가 채우고 그 사실이 보인다', async () => {
  const short = { ...BASE, holdings: holdings3().slice(0, 2) };     // O 누락
  const { analyst } = fresh({ llmResponses: [short, short] });      // 재시도도 똑같이 실패
  const r = await analyst.analyze(DASH(), { dryRun: true });
  const o = r.positions.find((p) => p.symbol === 'O');
  assert.ok(o, 'O 자리 자체가 없다');
  assert.strictEqual(o._codeFilled, true, '코드가 채웠다는 표식이 없으면 "판단받았다" 로 읽힌다');
  assert.match(o.rationale, /판단 자체가 없습니다/);
});

test('S3 가격 지어내기 — 재요청이 고치면 채택된다', async () => {
  const bad = { ...BASE, holdings: [
    pos('QLD', 'HOLD', { scenarioUp: '20일선(약 806) 회복 시 반등' }),  // 실제가의 8배
    pos('RAM', 'HOLD'), pos('O', 'HOLD'),
  ] };
  const good = { ...BASE, holdings: holdings3() };
  const { analyst, llmCalls } = fresh({ llmResponses: [bad, good] });
  const r = await analyst.analyze(DASH(), { dryRun: true });
  assert.ok(llmCalls.includes('trade_analyst_price_fix'), '재요청 경로가 안 탔다');
  const qld = r.positions.find((p) => p.symbol === 'QLD');
  assert.ok(!/806/.test(JSON.stringify(qld)), '지어낸 값이 살아남았다');
});

test('S4 가격 지어내기 — 재요청도 틀리면 코드가 사실로 교체한다', async () => {
  const bad = { ...BASE, holdings: [
    pos('QLD', 'HOLD', { scenarioUp: '목표 806 도달 시' }),
    pos('RAM', 'HOLD'), pos('O', 'HOLD'),
  ] };
  const { analyst } = fresh({ llmResponses: [bad, bad] });          // 두 번 다 틀림
  const r = await analyst.analyze(DASH(), { dryRun: true });
  const qld = r.positions.find((p) => p.symbol === 'QLD');
  assert.strictEqual(qld._priceFabricated, true, '교체 표식이 없다');
  assert.ok(!/806/.test(qld.scenarioUp || ''), '지어낸 값이 화면으로 간다');
});

test('S5 주제 이탈 — QLD 가 SOXX 이야기만 하면 잡히고, 재요청 채택은 심볼 보존을 요구한다', async () => {
  const drift = { ...BASE, holdings: [
    pos('QLD', 'HOLD', { rationale: 'SOXX가 20일선을 지키면 상승', evidence: [] }),
    pos('RAM', 'HOLD'), pos('O', 'HOLD'),
  ], positions: [pos('SOXX', 'HOLD')] };
  // 재요청이 보유를 갈아치우는 응답(후보만) — lost_symbols 로 거부돼야 한다
  const swapped = { ...BASE, positions: [pos('SOXX', 'HOLD'), pos('VONG', 'HOLD')] };
  const { analyst } = fresh({ llmResponses: [drift, swapped] });
  const r = await analyst.analyze(DASH(), { dryRun: true });
  const syms = new Set(r.positions.map((p) => p.symbol));
  for (const s of ['QLD', 'RAM', 'O']) assert.ok(syms.has(s), `${s} 가 재요청 채택으로 사라졌다`);
  const qld = r.positions.find((p) => p.symbol === 'QLD');
  assert.strictEqual(qld._subjectDrift, true, '이탈을 끝내 못 고쳤으면 그 사실이 표시돼야 한다');
});

test('S6 반쪽 레벨 — 진입만 비면 현재가로 메우고 표식이 남는다', async () => {
  const half = { ...BASE, holdings: [
    pos('QLD', 'HOLD', { stop: 92.7, target: 103 }),               // entry 없음
    pos('RAM', 'HOLD'), pos('O', 'HOLD'),
  ] };
  const { analyst } = fresh({ llmResponses: [half, half] });
  const r = await analyst.analyze(DASH(), { dryRun: true });
  const qld = r.positions.find((p) => p.symbol === 'QLD');
  assert.ok(Number(qld.entry) > 0, '진입이 안 메워졌다 — 손익비·수량이 통째로 안 나온다');
  assert.strictEqual(qld._entryFromPrice, true, '코드가 메운 표식이 없다');
});

test('S7 진입 괴리 — 다른 종목 가격대(+104%)면 손익비를 내지 않는다', async () => {
  const far = { ...BASE, holdings: [
    pos('RAM', 'HOLD', { entry: 29.59, stop: 28.2, target: 31.5 }), // RAM 현재가 14.5
    pos('QLD', 'HOLD'), pos('O', 'HOLD'),
  ] };
  const { analyst } = fresh({ llmResponses: [far, far] });
  const r = await analyst.analyze(DASH(), { dryRun: true });
  const ram = r.positions.find((p) => p.symbol === 'RAM');
  assert.strictEqual(ram.trade?.entryFar, true);
  assert.strictEqual(ram.trade?.rr ?? null, null, '틀린 진입으로 낸 손익비가 사용자를 설득한다');
});

test('S8 제안 전체 흐름 — 생성 → 거절이 감사에 남는다 (실행 경로는 안 태운다)', async () => {
  // ⚠️ orderService 는 실모듈 — 디스크(data/)를 쓰므로 생성→거절까지만 태우고 정리한다
  for (const k of Object.keys(require.cache)) if (/server\/orderService/.test(k)) delete require.cache[k];
  const orders = require('../server/orderService');
  const made = orders.propose({ symbol: 'QLD', side: 'SELL', quantity: 1, price: 97.5, reason: '[시나리오 테스트] 즉시 거절' });
  assert.ok(made.ok, `제안 생성 실패: ${made.error}`);
  const rej = orders.reject(made.proposal.id, 'scenario-test');
  assert.ok(rej.ok);
  assert.strictEqual(rej.proposal.status, 'REJECTED');
});

/**
 * 💰 수익 기반 적립 원장 (2026-10-06 — *"방어주/수익 기반으로 QLD 를 모아나간다"*)
 *
 * 네 계약을 **쌍으로** 잠근다 — 한쪽만 재면 반대쪽이 조용히 무너진다:
 * ① 예산 = 확정 수익만 (배당 + 실현손익 − 적립분). 손실은 깎고, **0 밑으로 안 간다**
 * ② 🔴 **추정은 예산에 안 들어간다** — 받지도 않은 돈으로 레버리지를 사면 원금이 샌다
 * ③ 용도는 목표 배분의 적립 버킷뿐. 목표 배분을 못 읽으면 **전부 거부**(fail-closed)
 * ④ 집중 상한 면제는 **예산이 있을 때만** — 예산 0 이면 종전 차단 그대로
 *
 * ⚠️ `TARGET_ALLOCATION_FILE` 을 매 테스트에서 명시한다 — 그 파일은 다른 축이 만들거나
 *    고치므로, 저장소 상태에 기대면 같은 테스트가 통과/실패를 왕복한다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * 목표 배분 표본 — 🔴 **실물과 같은 모양**이다(`buckets` 배열 · `key` 필드 · 합 100).
 *
 * 첫 판에서 이 픽스처를 최상위 버킷 키(`{core_aggressive:{...}}`)로 지어냈는데, 실물
 * `config/target-allocation.json` 은 `buckets` **배열**이었다. 내 추측과 같은 모양으로만
 * 재니 **19개가 전부 초록인데 라이브에서는 영원히 fail-closed** 였다(면제가 조용히 죽는
 * 방향이라 증상이 안 난다). ⇒ 아래 *"실물 파일"* 테스트가 그 축을 따로 잠근다.
 * ⚠️ 심볼은 `etf-catalog.json` 에 실재하는 것만 쓴다 — targetAllocation 이 없는 심볼을 버린다.
 */
const ALLOC = {
  toleranceBandPct: 3,
  toleranceSumPct: 0.5,
  buckets: [
    { key: 'defensive_income', name: '방어', targetPct: 25, symbols: ['O', 'SCHD'] },
    { key: 'base_slot', name: '기반', targetPct: 20, symbols: ['QQQM'], slot: { primary: 'QQQM', momentum: 'TQQQ', momentumMaxPctOfSlot: 50 } },
    { key: 'core_aggressive', name: '코어', targetPct: 30, symbols: ['QLD', 'TQQQ'] },
    { key: 'cash', name: '현금', targetPct: 25, symbols: [], cash: true },
  ],
};

function freshIncome({ alloc = ALLOC } = {}) {
  for (const k of Object.keys(require.cache)) {
    if (/incomeLedger|agentLedger|activityLog|targetAllocation/.test(k)) delete require.cache[k];
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-'));
  process.env.DATA_DIR = dir;
  process.env.ACTIVITY_FILE = path.join(dir, 'activity.jsonl');
  const allocPath = path.join(dir, 'target-allocation.json');
  if (alloc) fs.writeFileSync(allocPath, JSON.stringify(alloc));
  // alloc=null ⇒ 파일을 **만들지 않는다**(존재하지 않는 경로를 가리킨 채로 둔다)
  process.env.TARGET_ALLOCATION_FILE = allocPath;
  return { income: require('../server/incomeLedger'), ledger: require('../server/agentLedger'), dir };
}

/** 실현손익을 **실제 매매로** 만든다 — 숫자를 주입하면 agentLedger 와의 배선을 재지 못한다 */
function realize(ledger, { buy, sell, qty = 1 }) {
  ledger.setBudget(Math.max(buy * qty, 1), { by: 'test' });
  ledger.recordBuy({ symbol: 'ZZZ', quantity: qty, price: buy });
  ledger.recordSell({ symbol: 'ZZZ', quantity: qty, price: sell });
}

// ── ① 예산 공식 ──────────────────────────────────────────────

test('① 예산 — 수령 확정 배당만으로 적립 예산이 생긴다', () => {
  const { income } = freshIncome();
  assert.equal(income.accrualBudgetUsd(), 0, '아무것도 없는데 예산이 있었다');
  const r = income.addDividend({ usd: 100, note: 'SCHD 분기배당', by: 'test' });
  assert.equal(r.ok, true, r.error);
  assert.equal(income.accrualBudgetUsd(), 100);
  assert.equal(income.status().dividendUsd, 100);
});

test('① 예산 — 실현손실은 예산을 깎는다 (배당 100 · 실현 −50 → 50)', () => {
  const { income, ledger } = freshIncome();
  income.addDividend({ usd: 100, by: 'test' });
  realize(ledger, { buy: 100, sell: 50 });                 // 실현 −50
  assert.equal(ledger.status().realizedUsd, -50);
  assert.equal(income.accrualBudgetUsd(), 50, '실현손실이 적립 예산에 반영되지 않았다');
});

test('① 예산 — 손실이 배당보다 커도 **0 밑으로 안 간다**', () => {
  const { income, ledger } = freshIncome();
  income.addDividend({ usd: 100, by: 'test' });
  realize(ledger, { buy: 200, sell: 50 });                 // 실현 −150
  assert.equal(ledger.status().realizedUsd, -150);
  assert.equal(income.accrualBudgetUsd(), 0, '예산이 음수가 됐다');
  assert.equal(income.canAccrue('QLD', 1).ok, false, '예산 0 인데 적립이 통과했다');
});

/** ⚠️ 손실 축의 **쌍** — 깎기만 재고 보태기를 안 재면 "수익으로 모은다" 가 성립하는지 모른다 */
test('① 예산 — 실현이익은 적립 재원이 된다 (이 원장의 존재 이유)', () => {
  const { income, ledger } = freshIncome();
  realize(ledger, { buy: 100, sell: 140 });                // 실현 +40
  assert.equal(income.accrualBudgetUsd(), 40);
  income.addDividend({ usd: 10, by: 'test' });
  assert.equal(income.accrualBudgetUsd(), 50, '배당과 실현이익이 합산되지 않았다');
});

test('① 예산 — 배당 입력 검증: 0·음수·비숫자는 거부(기록도 안 남는다)', () => {
  const { income } = freshIncome();
  for (const bad of [0, -10, 'abc', null, undefined, 2_000_000]) {
    const r = income.addDividend({ usd: bad, by: 'test' });
    assert.equal(r.ok, false, `${bad} 가 배당으로 들어갔다`);
  }
  assert.equal(income.accrualBudgetUsd(), 0);
  assert.equal(income.status().dividends.length, 0);
});

// ── ② 🔴 추정 금지 (이 파일에서 가장 중요한 축) ──────────────

test('🔴 ② 예상 배당은 예산에 **들어가지 않는다** — 받지도 않은 돈으로 레버리지를 살 수 없다', () => {
  const { income } = freshIncome();
  const before = income.accrualBudgetUsd();
  const r = income.setEstimate(1000, { by: 'test' });
  assert.equal(r.ok, true, r.error);
  assert.equal(income.accrualBudgetUsd(), before, '예상 배당이 적립 예산을 키웠다');
  assert.equal(income.accrualBudgetUsd(), 0);
  // 표시는 된다 — 숨기는 게 아니라 **섞지 않는** 것이다
  assert.equal(income.status().estimatedUsd, 1000);
  assert.match(income.status().estimatedNote, /포함되지 않습니다/);
  // 확정분이 섞여 있어도 추정은 여전히 0 기여
  income.addDividend({ usd: 25, by: 'test' });
  income.setEstimate(9999, { by: 'test' });
  assert.equal(income.accrualBudgetUsd(), 25, '추정이 확정분에 더해졌다');
  assert.equal(income.canAccrue('QLD', 100).ok, false, '추정으로 적립이 통과했다');
});

test('② 예산 공식이 `estimatedUsd` 를 **구조적으로** 참조하지 않는다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'incomeLedger.js'), 'utf8');
  const body = src.slice(src.indexOf('function accrualBudgetUsd'));
  const fn = body.slice(0, body.indexOf('\n}') + 2);
  assert.ok(!/estimated/i.test(fn), `accrualBudgetUsd 가 추정값을 읽는다:\n${fn}`);
});

// ── ③ 용도 제한 · fail-closed ────────────────────────────────

test('③ 적립 대상 — core_aggressive·base_slot 만 허용', () => {
  const { income } = freshIncome();
  income.addDividend({ usd: 500, by: 'test' });
  assert.equal(income.canAccrue('QLD', 100).ok, true, income.canAccrue('QLD', 100).why);
  assert.equal(income.canAccrue('TQQQ', 100).ok, true);
  assert.equal(income.canAccrue('QQQM', 100).ok, true, 'base_slot 버킷이 빠졌다');
  assert.equal(income.canAccrue('qld', 100).ok, true, '소문자 심볼이 거부됐다');
  // 거부 축 둘 — ⓐ목표 안에 있지만 적립 버킷이 아닌 것 ⓑ목표 배분에 아예 없는 것
  const schd = income.canAccrue('SCHD', 100);
  assert.equal(schd.ok, false, '방어 버킷(defensive_income) 종목이 적립으로 통과했다');
  assert.match(schd.why, /적립 대상/);
  assert.equal(income.canAccrue('NVDA', 100).ok, false, '목표 배분 밖 종목이 통과했다');
  assert.equal(income.canAccrue('CASH', 100).ok, false);
});

test('🔴 ③ fail-closed — 목표 배분 파일이 없으면 **전부 거부**', () => {
  const { income } = freshIncome({ alloc: null });
  income.addDividend({ usd: 500, by: 'test' });
  assert.equal(income.accrualBudgetUsd(), 500, '예산 자체는 있어야 한다(면제만 막힌다)');
  for (const s of ['QLD', 'TQQQ', 'QQQM']) {
    const r = income.canAccrue(s, 100);
    assert.equal(r.ok, false, `${s} 가 목표 배분 없이 통과했다`);
    assert.match(r.why, /목표 배분/);
  }
  assert.equal(income.status().allocationAvailable, false);
  assert.deepEqual(income.status().accrualSymbols, []);
});

test('③ fail-closed — 파일이 깨졌거나 적립 버킷이 비어도 거부', () => {
  const { income, dir } = freshIncome({
    alloc: { buckets: [{ key: 'defensive_income', name: '방어', targetPct: 100, symbols: ['SCHD'] }] },
  });
  income.addDividend({ usd: 500, by: 'test' });
  assert.equal(income.canAccrue('QLD', 100).ok, false, '적립 버킷이 없는데 통과했다');
  fs.writeFileSync(path.join(dir, 'target-allocation.json'), '{ not json');
  assert.equal(income.canAccrue('QLD', 100).ok, false, '깨진 파일에서 통과했다');
  // 파일이 **생기면** 캐시 때문에 영영 닫혀 있지 않다(양방향)
  fs.writeFileSync(path.join(dir, 'target-allocation.json'), JSON.stringify(ALLOC));
  assert.equal(income.canAccrue('QLD', 100).ok, true, '파일이 생겼는데 캐시가 fail-closed 를 고정했다');
});

/**
 * 🔴🔴 **실물 파일** — 픽스처가 아니라 저장소의 진짜 `config/target-allocation.json` 으로 잰다.
 *
 * 이 테스트만이 잡을 수 있는 결함: 내가 파일 모양을 **추측해서**(최상위 버킷 키) 읽었을 때
 * 다른 19개는 전부 초록인데 라이브에서는 **영원히 fail-closed** 였다 — 면제가 조용히 죽는
 * 방향이라 증상이 안 난다("검사 안 한 것을 통과로 보여주지 않는다" 의 설정 파일판).
 *
 * ⚠️ 이 테스트는 **다른 축이 소유한 파일**에 의존한다. 깨지면 내 코드가 아니라 **버킷 키가
 *    바뀐 것**일 수 있다 — 그래도 깨지는 게 맞다(바뀌면 적립 면제가 조용히 죽기 때문이다).
 *    고칠 곳은 `incomeLedger.ACCRUAL_BUCKETS`.
 */
test('🔴 실물 파일 — 저장소의 target-allocation.json 으로 QLD 적립이 실제로 가능하다', () => {
  for (const k of Object.keys(require.cache)) {
    if (/incomeLedger|agentLedger|activityLog|targetAllocation/.test(k)) delete require.cache[k];
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-live-'));
  process.env.DATA_DIR = dir;
  process.env.ACTIVITY_FILE = path.join(dir, 'activity.jsonl');
  delete process.env.TARGET_ALLOCATION_FILE;          // ⇒ 실물 config/target-allocation.json
  const income = require('../server/incomeLedger');

  const st = income.status();
  assert.equal(st.allocationAvailable, true,
    `실물 목표 배분을 못 읽었다 — 적립 면제가 라이브에서 통째로 죽는다. buckets 키: ${JSON.stringify(income.ACCRUAL_BUCKETS)}`);
  assert.ok(st.accrualSymbols.includes('QLD'),
    `실물 파일의 적립 심볼에 QLD 가 없다(현재 ${JSON.stringify(st.accrualSymbols)}) — 사용자 전략의 종착점이 적립 대상이 아니다`);

  income.addDividend({ usd: 200, by: 'test' });
  assert.equal(income.canAccrue('QLD', 100).ok, true, income.canAccrue('QLD', 100).why);
  // 방어·현금 버킷은 실물에서도 적립 대상이 아니다
  assert.equal(income.canAccrue('O', 100).ok, false, '실물에서 방어주가 적립 대상이 됐다');
});

test('③ 예산 부족·통화 불일치·잘못된 금액은 거부 (귀속 문구 포함)', () => {
  const { income } = freshIncome();
  income.addDividend({ usd: 100, by: 'test' });
  const poor = income.canAccrue('QLD', 500);
  assert.equal(poor.ok, false);
  assert.match(poor.why, /적립 예산 부족/);
  assert.match(poor.why, /배당 100/, '왜 부족한지(재원 내역)를 안 알려주면 고칠 수 없다');
  const krw = income.canAccrue('QLD', 50, { currency: 'KRW' });
  assert.equal(krw.ok, false, 'KRW 금액이 USD 예산과 비교됐다');
  assert.match(krw.why, /USD/);
  assert.equal(income.canAccrue('QLD', 0).ok, false);
  assert.equal(income.canAccrue('QLD', NaN).ok, false);
  assert.equal(income.canAccrue('', 50).ok, false);
  assert.equal(income.canAccrue('QLD', 100).ok, true, '딱 맞는 금액은 통과해야 한다');
});

// ── 차감 · 영속 ──────────────────────────────────────────────

test('적립 기록이 예산을 **차감**한다 — 같은 예산으로 두 번 못 뚫는다', () => {
  const { income } = freshIncome();
  income.addDividend({ usd: 300, by: 'test' });
  const r = income.recordAccrual({ symbol: 'QLD', quantity: 2, price: 100 });
  assert.equal(r.ok, true, r.error);
  assert.equal(income.accrualBudgetUsd(), 100);
  assert.equal(income.canAccrue('QLD', 200).ok, false, '차감 전 예산으로 또 통과했다');
  assert.equal(income.canAccrue('QLD', 100).ok, true);
  assert.equal(income.status().accruedUsd, 200);
  assert.equal(income.status().accruals.at(-1).symbol, 'QLD');
  // 잘못된 입력은 차감도 기록도 하지 않는다
  assert.equal(income.recordAccrual({ symbol: 'QLD', quantity: 0, price: 100 }).ok, false);
  assert.equal(income.status().accruedUsd, 200);
});

test('재기동 생존 — 배당·적립·추정이 파일로 남는다', () => {
  const { income } = freshIncome();
  income.addDividend({ usd: 250, note: '유지', by: 'test' });
  income.setEstimate(77, { by: 'test' });
  income.recordAccrual({ symbol: 'QQQM', quantity: 1, price: 50 });
  for (const k of Object.keys(require.cache)) if (/incomeLedger/.test(k)) delete require.cache[k];
  const i2 = require('../server/incomeLedger');
  assert.equal(i2.accrualBudgetUsd(), 200, '재기동이 적립 원장을 지웠다');
  assert.equal(i2.status().dividendUsd, 250);
  assert.equal(i2.status().accruedUsd, 50);
  assert.equal(i2.status().estimatedUsd, 77);
});

// ── ④ 집중 상한 면제 쌍 (orderService 통합) ──────────────────

/**
 * 평가액 2000(현금 1000 + QLD 1000) · 한도 20% = 400 · QLD 는 이미 50%.
 * ⇒ 1주(100 USD) 추가도 종전엔 무조건 `concentration` 이었다. 그게 "모아나간다" 를 막던 벽이다.
 */
async function freshOrdersWithQld({ dividendUsd = 0, alloc = ALLOC } = {}) {
  for (const k of Object.keys(require.cache)) {
    if (/orderService|tossClient|tossPortfolio|incomeLedger|agentLedger|activityLog|targetAllocation/.test(k)) delete require.cache[k];
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inco-'));
  process.env.DATA_DIR = dir;
  process.env.ACTIVITY_FILE = path.join(dir, 'activity.jsonl');
  process.env.ORDERS_AUDIT_FILE = path.join(dir, 'orders-audit.jsonl');
  /**
   * 🔴 **제안 영속 파일을 반드시 갈라 준다** — orderService 의 `DATA_DIR` 은 하드코딩이고
   *    `STORE_FILE` 만 env 로 빠져 있다. 안 주면 `propose()` 가 **저장소의 라이브 승인 대기열**
   *    (`data/orders-proposals.json`)에 쓴다(그 파일 주석이 직접 경고하는 그 사고).
   *    1차 작업은 `checkAccountLimits` 만 불러서 안 드러났고, 집행 배선을 재는 순간 드러났다.
   */
  process.env.ORDERS_FILE = path.join(dir, 'orders-proposals.json');
  const allocPath = path.join(dir, 'target-allocation.json');
  if (alloc) fs.writeFileSync(allocPath, JSON.stringify(alloc));
  process.env.TARGET_ALLOCATION_FILE = allocPath;

  const tcp = require.resolve('../server/tossClient');
  require.cache[tcp] = {
    id: tcp, filename: tcp, loaded: true,
    exports: {
      ...require(tcp),
      getBuyingPower: async () => ({ currency: 'USD', cash: { raw: '1000', num: 1000 } }),
      getPrices: async () => new Map(),
      getPriceLimits: async () => ({}),
    },
  };
  const tpp = require.resolve('../server/tossPortfolio');
  require.cache[tpp] = {
    id: tpp, filename: tpp, loaded: true,
    exports: { getHoldings: async () => ({ summary: {}, items: [{ symbol: 'QLD', currency: 'USD', marketValue: 1000 }] }) },
  };
  const income = require('../server/incomeLedger');
  if (dividendUsd > 0) income.addDividend({ usd: dividendUsd, by: 'test' });
  return { orders: require('../server/orderService'), income };
}

/** 로그 캡처 — 면제가 **조용히** 일어나지 않는다는 것이 계약의 절반이다 */
function captureWarn(fn) {
  const lines = [];
  const real = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  return Promise.resolve(fn()).finally(() => { console.warn = real; }).then((v) => ({ v, lines }));
}

test('🔴 ④ 예산이 있으면 집중 상한을 넘는 QLD 매수가 통과한다 + 면제가 로그에 남는다', async () => {
  const { orders } = await freshOrdersWithQld({ dividendUsd: 150 });
  const { v: r, lines } = await captureWarn(() =>
    orders.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1, price: 100 }));
  assert.equal(r.ok, true, `적립 예산이 있는데 막혔다: ${r.error}`);
  const hit = lines.filter((l) => l.includes('orders.accrual_exempt'));
  assert.equal(hit.length, 1, `면제 로그가 ${hit.length}건 — 조용한 면제는 구멍이다`);
  const row = JSON.parse(hit[0]);
  assert.equal(row.level, 'warn', '실거래 범위가 넓어지는 사건이라 warn 이어야 한다');
  assert.equal(row.symbol, 'QLD');
  assert.equal(row.needUsd, 100);
  assert.equal(row.accrualBudgetUsd, 150, '예산 잔액이 없으면 나중에 귀속을 못 한다');
});

test('🔴 ④ 예산이 0 이면 종전대로 차단된다 (면제가 상한을 통째로 열지 않는다)', async () => {
  const { orders } = await freshOrdersWithQld({ dividendUsd: 0 });
  const { v: r, lines } = await captureWarn(() =>
    orders.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1, price: 100 }));
  assert.equal(r.ok, false, '예산 0 인데 적립 면제가 적용됐다');
  assert.equal(r.kind, 'concentration');
  assert.match(r.error, /적립 면제 불가/, '왜 면제가 안 됐는지가 응답에 없다');
  assert.equal(lines.filter((l) => l.includes('orders.accrual_exempt')).length, 0);
});

test('④ 예산이 있어도 적립 대상 밖 종목은 차단 (면제 범위가 종목으로 좁다)', async () => {
  const { orders } = await freshOrdersWithQld({ dividendUsd: 5000 });
  // SCHD 는 방어 버킷(목표 안에 있지만 적립 대상 아님) — 보유 0 이지만 한도 400 을 넘는 800 매수
  const r = await orders.checkAccountLimits({ symbol: 'SCHD', side: 'BUY', quantity: 8, price: 100 });
  assert.equal(r.ok, false, '적립 대상 밖 종목이 면제를 받았다');
  assert.equal(r.kind, 'concentration');
  assert.match(r.error, /적립 대상/);
});

test('④ 목표 배분이 없으면 예산이 있어도 차단 (fail-closed 가 통합 경로까지 간다)', async () => {
  const { orders } = await freshOrdersWithQld({ dividendUsd: 5000, alloc: null });
  const r = await orders.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1, price: 100 });
  assert.equal(r.ok, false, '목표 배분 없이 면제가 적용됐다');
  assert.equal(r.kind, 'concentration');
});

test('④ 면제는 **집중 상한만** — 현금 부족은 여전히 막는다', async () => {
  const { orders } = await freshOrdersWithQld({ dividendUsd: 100000 });
  const r = await orders.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 50, price: 100 }); // 5000 > 현금 1000
  assert.equal(r.ok, false, '적립 예산이 현금 게이트를 뚫었다');
  assert.equal(r.kind, 'insufficient');
});

test('④ 한도 안의 매수는 적립 판정을 **거치지 않는다** (면제 로그 0건)', async () => {
  const { orders } = await freshOrdersWithQld({ dividendUsd: 150 });
  const { v: r, lines } = await captureWarn(() =>
    orders.checkAccountLimits({ symbol: 'QQQM', side: 'BUY', quantity: 1, price: 100 })); // 0 + 100 ≤ 400
  assert.equal(r.ok, true, r.error);
  assert.equal(lines.filter((l) => l.includes('orders.accrual_exempt')).length, 0,
    '막히지도 않았는데 면제가 기록되면 로그가 거짓말한다');
});

// ── ⑤ 집행 시 차감 — 무한 반복 차단 (2026-10-06 2차) ─────────

/**
 * 🔴🔴 **이 절이 "원금 불가침" 의 나머지 절반이다.**
 *
 * 1차 작업에서 `recordAccrual` 을 만들어 놓고 **어느 집행 경로에도 배선하지 않았다** ⇒
 * `accruedUsd` 가 영원히 0 이고, 배당 $100 으로 QLD 를 **횟수 제한 없이** 살 수 있었다
 * (면제 판정이 매번 같은 예산을 보니까). 테스트는 전부 초록이었다 — 차감을 아무도 안 쟀다.
 *
 * 설계: 면제 **근거로 한도를 뚫은 주문만** 차감한다. 판정 시점에만 알 수 있는 사실이라
 * `checkAccountLimits` → 제안(`accrualExempt`) → `execute()` 로 들고 간다.
 * ❌ 기각: 집행 시점에 `canAccrue` 재질의 — 한도 안 매수까지 깎아 예산이 "매수 총량" 이 된다.
 */
function propExempt(symbol = 'QLD', { quantity = 1, price = 100 } = {}) {
  return { symbol, side: 'BUY', type: 'LIMIT', quantity, price, reason: 't', expiresInMs: 60000 };
}

/** 제안 → 승인 → 집행. ⚠️ 한도 검사는 호출자(라우트)가 하는 모양을 그대로 재현한다 */
async function proposeApproveExecute(orders, input, { accrual = null } = {}) {
  const r = orders.propose(input, { source: 'manual', notify: false, accrual });
  assert.equal(r.ok, true, `제안 실패: ${r.error}`);
  assert.equal(orders.approve(r.proposal.id).ok, true);
  const ex = await orders.execute(r.proposal.id);
  assert.equal(ex.ok, true, `집행 실패: ${ex.error}`);
  return r.proposal.id;
}

test('🔴🔴 ⑤ 무한 반복 차단 — 배당 $100 으로 면제 매수는 **한 번만** 된다', async () => {
  const { orders, income } = await freshOrdersWithQld({ dividendUsd: 100 });

  // 1회차: 면제가 적용돼 한도를 뚫는다
  const chk1 = await orders.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1, price: 100 });
  assert.equal(chk1.ok, true, chk1.error);
  assert.equal(chk1.accrualExempt, true, '면제 사실이 반환에 실리지 않았다 — 집행이 차감 근거를 못 받는다');
  assert.equal(chk1.accrualUsd, 100);
  await proposeApproveExecute(orders, propExempt(), { accrual: chk1 });

  // 🔴 집행이 예산을 깎았다
  assert.equal(income.accrualBudgetUsd(), 0, '집행 후에도 예산이 그대로 — 같은 돈으로 무한히 뚫을 수 있다');
  assert.equal(income.status().accruedUsd, 100);

  // 2회차: 같은 매수가 이제 막힌다
  const chk2 = await orders.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1, price: 100 });
  assert.equal(chk2.ok, false, '예산을 다 쓴 뒤에도 면제가 또 적용됐다(무한 반복)');
  assert.equal(chk2.kind, 'concentration');
  assert.match(chk2.error, /적립 예산 부족/);
  assert.equal(chk2.accrualExempt, undefined, '거부인데 면제 키가 실렸다');
});

test('⑤ 차감은 면제분만 — 재원이 더 있으면 남은 만큼은 계속 된다', async () => {
  const { orders, income } = await freshOrdersWithQld({ dividendUsd: 250 });
  const chk1 = await orders.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1, price: 100 });
  await proposeApproveExecute(orders, propExempt(), { accrual: chk1 });
  assert.equal(income.accrualBudgetUsd(), 150);
  const chk2 = await orders.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1, price: 100 });
  assert.equal(chk2.ok, true, `잔액 150 인데 100 매수가 막혔다: ${chk2.error}`);
  await proposeApproveExecute(orders, propExempt(), { accrual: chk2 });
  assert.equal(income.accrualBudgetUsd(), 50);
  // 50 남았는데 100 을 요구하면 막힌다
  assert.equal((await orders.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1, price: 100 })).ok, false);
});

/** ⚠️ 차감 **안 하는** 쪽을 쌍으로 잠근다 — 과차감은 "원금으로 산 것까지 깎는" 반대 결함이다 */
test('🔴 ⑤ 면제가 아닌 매수는 차감 0 — 한도 안 매수 · 적립 버킷 밖 심볼', async () => {
  const { orders, income } = await freshOrdersWithQld({ dividendUsd: 300 });

  // ⓐ 한도 안(QQQM 0 + 100 ≤ 400) — 면제가 필요 없었다
  const inCap = await orders.checkAccountLimits({ symbol: 'QQQM', side: 'BUY', quantity: 1, price: 100 });
  assert.equal(inCap.ok, true, inCap.error);
  assert.equal(inCap.accrualExempt, undefined, '한도 안인데 면제 플래그가 붙었다');
  await proposeApproveExecute(orders, propExempt('QQQM'), { accrual: inCap });
  assert.equal(income.accrualBudgetUsd(), 300, '원금으로 산 매수가 적립 예산을 깎았다');
  assert.equal(income.status().accruedUsd, 0);

  // ⓑ 적립 버킷 밖(SCHD) — 한도를 넘지만 면제 대상이 아니라 애초에 거부된다
  const outside = await orders.checkAccountLimits({ symbol: 'SCHD', side: 'BUY', quantity: 8, price: 100 });
  assert.equal(outside.ok, false);
  assert.equal(income.accrualBudgetUsd(), 300);

  // ⓒ 플래그 없이 집행된 제안은 차감하지 않는다(라우트가 accrual 을 안 넘긴 경우)
  await proposeApproveExecute(orders, propExempt('QLD'));
  assert.equal(income.accrualBudgetUsd(), 300, '플래그 없는 제안이 차감됐다');
});

/**
 * 🔴 영속 왕복 — 플래그가 저장→재조회 후에도 살아야 차감이 된다.
 * 지금은 `persist()` 가 제안을 통째로 직렬화해 자동으로 남지만, 나중에 누가 정규화를
 * 넣으면 **조용히 사라지고 차감만 안 되는** 상태가 된다(09-22 watch 필드와 같은 자리).
 */
test('🔴 ⑤ 제안 영속 왕복 — 면제 플래그가 재기동 후에도 남고 그때 차감된다', async () => {
  const { orders, income } = await freshOrdersWithQld({ dividendUsd: 100 });
  const chk = await orders.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1, price: 100 });
  const r = orders.propose(propExempt(), { source: 'manual', notify: false, accrual: chk });
  assert.equal(r.proposal.accrualExempt, true);
  assert.equal(r.proposal.accrualUsd, 100);

  // 파일에 실제로 들어갔는가 (직렬화 축)
  const onDisk = JSON.parse(fs.readFileSync(process.env.ORDERS_FILE, 'utf8'));
  const row = onDisk.proposals.find((x) => x.id === r.proposal.id);
  assert.equal(row.accrualExempt, true, '면제 플래그가 파일에 저장되지 않았다');
  assert.equal(row.accrualUsd, 100);

  // 새 모듈 인스턴스로 되읽기 (복원 축) — 승인·집행은 복원된 객체로 한다
  for (const k of Object.keys(require.cache)) if (/orderService/.test(k)) delete require.cache[k];
  const o2 = require('../server/orderService');
  const restored = o2.list().find((x) => x.id === r.proposal.id);
  assert.equal(restored.accrualExempt, true, '재기동이 면제 플래그를 잃었다 — 차감이 조용히 멈춘다');
  assert.equal(o2.approve(r.proposal.id).ok, true);
  assert.equal((await o2.execute(r.proposal.id)).ok, true);
  assert.equal(income.accrualBudgetUsd(), 0, '복원된 제안의 집행이 차감하지 않았다');
});

test('⑤ 집행 실패·미승인은 차감하지 않는다 (전송된 것만 센다)', async () => {
  const { orders, income } = await freshOrdersWithQld({ dividendUsd: 100 });
  const chk = await orders.checkAccountLimits({ symbol: 'QLD', side: 'BUY', quantity: 1, price: 100 });
  const r = orders.propose(propExempt(), { source: 'manual', notify: false, accrual: chk });
  // 승인 없이 집행 → 구조적으로 거부
  const ex = await orders.execute(r.proposal.id);
  assert.equal(ex.ok, false);
  assert.equal(income.accrualBudgetUsd(), 100, '집행되지 않았는데 차감됐다');
  // 거절된 제안도 마찬가지
  assert.equal(orders.reject(r.proposal.id, 'test').ok, true);
  assert.equal((await orders.execute(r.proposal.id)).ok, false);
  assert.equal(income.accrualBudgetUsd(), 100);
});

test('⑤ 자율 경로는 propose 안에서 플래그를 심는다 (호출자가 안 넘겨도 된다)', async () => {
  const { orders, income } = await freshOrdersWithQld({ dividendUsd: 100 });
  require('../server/agentControl').setAutonomy({ level: 1, by: 'test' });
  require('../server/agentLedger').setBudget(1000, { by: 'test' });
  const r = orders.propose({ ...propExempt(), reason: 'auto' }, { source: 'analyst', notify: false });
  assert.equal(r.ok, true, r.error);
  // 자율 집행은 비동기 — 상태가 DRY_RUN/EXECUTED 로 바뀔 때까지 기다린다
  const t0 = Date.now();
  let p;
  while (Date.now() - t0 < 2000) {
    p = orders.list().find((x) => x.id === r.proposal.id);
    if (p && ['DRY_RUN', 'EXECUTED', 'SENT'].includes(p.status)) break;
    await new Promise((res) => setTimeout(res, 25));
  }
  assert.ok(['DRY_RUN', 'EXECUTED', 'SENT'].includes(p.status), `자율 집행이 안 됐다: ${p.status}`);
  assert.equal(p.accrualExempt, true, '자율 경로가 면제 플래그를 심지 않았다');
  assert.equal(income.accrualBudgetUsd(), 0, '자율 집행이 적립 예산을 차감하지 않았다');
});

/**
 * 🔴 **호출부 전수 가드** (2026-10-06) — `propose()` 가 `accrual` 을 받는 이음새를 만들어도
 * 호출부가 안 넘기면 **차감이 조용히 안 된다**(같은 배당으로 무한히 집중 상한을 뚫는다).
 * 이음새는 테스트가 직접 호출로 재지만 **"라이브 호출부가 실제로 넘기는가" 는 원리상 못 본다.**
 * ⇒ 소스를 훑어 거꾸로 계정한다: 모든 `orderService.propose(` 호출은
 *   **accrual 전달** 또는 **이유 있는 면제**(자율 경로는 propose 안에서 스스로 심는다) 중 하나다.
 * ⚠️ 대상이 조용히 줄어드는 것도 막는다 — 3곳 미만이면 실패.
 */
test('배선 가드 — propose 호출부 전수가 accrual 을 넘긴다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const FILES = ['server.js', 'server/analystChat.js'];
  let scanned = 0;
  const missing = [];
  for (const rel of FILES) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    // 호출 시작부터 닫는 괄호까지 — 옵션 객체가 여러 줄에 걸친다
    const re = /orderService\.propose\(/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      scanned += 1;
      const chunk = src.slice(m.index, m.index + 1200);
      const end = chunk.indexOf('\n      );') >= 0 ? chunk.indexOf('\n      );') : chunk.indexOf(');');
      const body = chunk.slice(0, end > 0 ? end : 400);
      if (!/accrual\s*:/.test(body)) missing.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.ok(scanned >= 3, `propose 호출부가 ${scanned}곳 — 3곳 미만이면 자가 대상을 잃었다(경로가 바뀌었는지 확인)`);
  assert.deepEqual(missing, [], `accrual 을 안 넘기는 호출부: ${missing.join(', ')} — 적립 면제 매수가 차감되지 않는다`);
});

/**
 * 💰 적립 재원 프롬프트 절 + DCA 규율 (2026-10-06 ③).
 * 쌍으로 잠근다: 예산 0 이면 **생략**(0 을 보여 주면 모델이 매 회차 "적립 불가" 를 서술한다) ·
 * 예산이 있으면 금액·대상·면제·DCA 3규율이 실린다 · 🔴**예상 배당은 절대 안 실린다**.
 */
test('적립 재원 절 — 예산 0 이면 생략, 있으면 금액·면제·DCA', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  for (const k of Object.keys(require.cache)) if (/simpleStock\/server\//.test(k)) delete require.cache[k];
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ilp-'));
  const il = require('../server/incomeLedger');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf8');

  // 배선 존재 — 절 생성 블록이 analyze 프롬프트 경로에 있다
  assert.match(src, /## 적립 재원 \(수익 기반 — 원금이 아니다\)/, '적립 재원 절이 프롬프트에 없다');
  assert.match(src, /accrualBudgetUsd\) \|\| 0;[\s\S]{0,80}if \(budget > 0\)/, '예산 0 생략 조건이 없다 — 0 을 매 회차 서술한다');
  // DCA 3규율
  assert.match(src, /1회 1\/3 이하/, 'DCA ① 분할 규율 누락');
  assert.match(src, /금액을 줄이되 방향을 바꾸지 않는다/, 'DCA ② 국면 대응 규율 누락');
  assert.match(src, /재원을 넘는 제안은 집행 단계에서 거부/, 'DCA ③ 재원 상한 안내 누락');
  // 🔴 예상 배당이 절에 실리면 안 된다
  const sectionStart = src.indexOf('## 적립 재원');
  const sectionEnd = src.indexOf('analyst.income_section_failed');
  const body = src.slice(sectionStart, sectionEnd);
  assert.ok(!/estimatedUsd/.test(body), '예상 배당(추정)이 프롬프트 절에 실렸다 — 받지도 않은 돈을 재원으로 읽는다');
  // 실제 예산이 0 → status 가 0 임을 확인(절 생략 조건의 입력)
  assert.equal(il.status().accrualBudgetUsd, 0);
  await il.addDividend({ usd: 300, note: 'O 배당' });
  assert.equal(il.status().accrualBudgetUsd, 300);
});

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
    if (/incomeLedger|activityLog|targetAllocation/.test(k)) delete require.cache[k];
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-'));
  process.env.DATA_DIR = dir;
  process.env.ACTIVITY_FILE = path.join(dir, 'activity.jsonl');
  const allocPath = path.join(dir, 'target-allocation.json');
  if (alloc) fs.writeFileSync(allocPath, JSON.stringify(alloc));
  // alloc=null ⇒ 파일을 **만들지 않는다**(존재하지 않는 경로를 가리킨 채로 둔다)
  process.env.TARGET_ALLOCATION_FILE = allocPath;
  return { income: require('../server/incomeLedger'), dir };
}

/**
 * 🔴 **2026-10-12 — `realize()` 헬퍼를 지웠다.**
 *    실현손익은 `agentLedger`(AI 매매 원장)에서 왔는데 그 원장이 사라졌다.
 *    `incomeLedger.realizedUsd()` 는 이제 **항상 0** 이고, 거래 내역을 들여오면
 *    그 함수 하나만 고치면 된다(열어 둔 질문 ①).
 *    ⇒ 실현손익이 걸린 테스트 넷은 **지웠다** — 만들 수단이 없는 상태를 재는 자는
 *      공허하게 통과하거나 영구 실패한다.
 */

// ── ① 예산 공식 ──────────────────────────────────────────────
/**
 * ⚠️ 2026-10-12 — **실현손익이 걸린 테스트 셋을 지웠다**(손실 차감 · 0 하한 · 이익 합산).
 *    `realizedUsd()` 가 항상 0 이라 그 축을 만들 수단이 없다. 거래 내역을 들여오면
 *    **그때 이 셋을 되살린다** — 공식(`배당 + min(0, 실현)`)은 코드에 그대로 있다.
 */

test('① 예산 — 수령 확정 배당만으로 적립 예산이 생긴다', () => {
  const { income } = freshIncome();
  assert.equal(income.accrualBudgetUsd(), 0, '아무것도 없는데 예산이 있었다');
  const r = income.addDividend({ usd: 100, note: 'SCHD 분기배당', by: 'test' });
  assert.equal(r.ok, true, r.error);
  assert.equal(income.accrualBudgetUsd(), 100);
  assert.equal(income.status().dividendUsd, 100);
});



/** ⚠️ 손실 축의 **쌍** — 깎기만 재고 보태기를 안 재면 "수익으로 모은다" 가 성립하는지 모른다 */

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

/**
 * 🔴 **2026-10-12 — ④ 집중 상한 면제 · ⑤ 집행 시 차감 블록을 들어냈다.**
 *
 * 둘 다 `orderService` **통합 테스트**였다 — 적립 재원으로 집중 상한을 뚫고,
 * 집행 시 그만큼 차감하는 기계. 주문 집행이 사라져 **뚫을 상한도 차감할 집행도 없다.**
 *
 * ⚠️ 남은 ①②③·차감·영속은 **배당 원장 자체**라 그대로 둔다 —
 *    "받은 배당을 기록하고, 추정은 예산에 넣지 않는다" 는 여전히 참이다.
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

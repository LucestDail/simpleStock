/**
 * 💰 수익 기반 적립 원장 (2026-10-06 — 사용자 전략: *"방어주/수익 기반으로 QLD 를 모아나간다"*)
 *
 * ## 왜 이 원장이 따로 있나
 *
 * 종전 시스템은 **무엇으로 사는지를 구분하지 못했다** — 원금을 레버리지로 옮기는 것과
 * 배당·실현수익으로 적립하는 것이 코드에 같아 보였다. 전자는 위험 증가(막는 게 맞다),
 * 후자는 **원금 보존**(허용해야 한다). 그런데 집중 상한 20%(`orderService.SINGLE_POSITION_MAX_PCT`)
 * 가 QLD 추가 매수를 하드 차단해서, 현재 비중(31.8%)에서는 **"모아나간다" 가 원리상 불가능**했다.
 *
 * ⇒ "수익으로 산다" 는 축을 만들어 **그 예산 안에서만** 집중 상한을 면제한다.
 *    원금 불가침이 주석이 아니라 **코드로** 보장된다.
 *
 * ## 🔴 배당은 자동 조회가 **불가능하다** (2026-10-06 실측)
 *
 * `server/tossClient.js` 의 API 표면을 전수로 봤다 — `getPrices·getCandles·getRankings·
 * getWarnings·getOrderbook·getMarketCalendar·getExchangeRate·createOrder`. **배당·입출금
 * 내역 조회가 0건이다.** 추정으로 메우지 않는다. 출처를 세 갈래로 **분리**하고 확정분만 쓴다:
 *
 * | 출처 | 뜻 | 예산 포함 |
 * |---|---|---|
 * | `realizedUsd`  | `agentLedger.realizedUsd` (AI 매매 실현손익) | ✅ 확정 |
 * | `dividendUsd`  | 사용자가 입력한 **실제 배당 수령액**        | ✅ 확정 |
 * | `estimatedUsd` | 보유 × 배당률로 계산한 **예상**             | ❌ 참고 표시만 |
 *
 * 🔴 `estimatedUsd` 를 예산에 넣으면 **받지도 않은 돈으로 레버리지를 산다.** 절대 금지.
 *    `accrualBudgetUsd()` 는 이 값을 **읽지 않는다** — 테스트가 그 사실을 잠근다.
 * ⚠️ **현금 증가분에서 배당을 유도하는 방식도 금지한다** — 증권계좌의 현금은 배당·매도대금·
 *    입금·환전이 한 숫자로 섞여 들어온다. "어제보다 현금이 $12 늘었으니 배당" 은 **매도 대금을
 *    배당으로 오인**할 수 있고, 그 오인분이 곧바로 레버리지 매수 권한이 된다(원금 침식).
 *    못 세는 것은 **0 으로 둔다**(추정은 통과가 아니다).
 *
 * ## 예산 공식 — 음수가 되지 않는다
 *
 * ```
 * accrualBudgetUsd = max(0, dividendUsd + realizedUsd − accruedUsd)
 * ```
 * 🔴 **실현 손실은 예산을 깎는다**(`realizedUsd` 가 음수면 그대로 반영) — 번 돈으로만
 *    모으자는 것이 취지이므로, 잃은 뒤에 적립 권한이 남아 있으면 그건 원금으로 사는 것이다.
 *    단 **0 밑으로는 안 간다**(`agentLedger.effectiveBudgetUsd` 와 같은 철학).
 * ⚠️ 같은 실현손실이 `agentLedger` 의 유효 예산도 깎으므로 **두 축에서 각각 반영된다** —
 *    의도된 보수성이다(예산을 넉넉히 잠그는 방향의 중복이라 안전하다).
 *
 * ## 용도는 **좁다**
 *
 * - 허용: `config/target-allocation.json` 의 `core_aggressive`·`base_slot` 심볼 **매수**에 한해
 *   **집중 상한만** 면제.
 * - ⛔ 면제는 집중 상한 하나다. 불리가격 게이트·레버리지 신규 금지·HITL·일일 손실·
 *   `ADVERSE_PRICE_PCT`·현금 버퍼는 **그대로**. 자율 집행의 `agentLedger` 예산 게이트도 그대로
 *   (그건 AI 전용 자금이고 이건 적립 재원 — **다른 축**이다).
 * - ⚠️ 목표 배분 파일이 **없으면 면제 없음**(fail-closed). 그 파일은 읽기만 한다(만들지 않는다).
 */
const fs = require('node:fs');
const path = require('node:path');
const { logInfo, logWarn } = require('./logger');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'income-ledger.json');

/** 적립 매수가 허용되는 버킷 — 공격 코어와 베이스 슬롯만. 방어주·현금성은 적립 대상이 아니다 */
const ACCRUAL_BUCKETS = ['core_aggressive', 'base_slot'];

let state = load();

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (d && typeof d === 'object') {
      return { dividendUsd: 0, estimatedUsd: 0, accruedUsd: 0, dividends: [], accruals: [], ...d };
    }
  } catch { /* 첫 기동 */ }
  return { dividendUsd: 0, estimatedUsd: 0, accruedUsd: 0, dividends: [], accruals: [] };
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) { logWarn('income.persist_failed', { message: e.message }); }
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/**
 * AI 매매 실현손익(USD). ⚠️ `agentLedger` 를 **지연 require** 한다 — 두 원장이 서로를
 * 모듈 로드 시점에 참조하면 순환이 된다. 읽기 실패는 **0 으로** 본다(모름이 수익이 되면 안 된다).
 */
function realizedUsd() {
  try {
    const v = Number(require('./agentLedger').status().realizedUsd);
    return Number.isFinite(v) ? v : 0;
  } catch (e) {
    logWarn('income.realized_read_failed', { message: e.message });
    return 0;
  }
}

/**
 * 목표 배분 파일 경로 — **targetAllocation 이 정본이다**(경로를 복제하면 둘이 갈라진다).
 * 메시지·상태 표시 전용. 읽기는 `accrualSymbols()` 가 그 모듈을 통해서만 한다.
 */
function allocFile() {
  try { return require('./targetAllocation').TARGET_FILE; } catch { return '(targetAllocation 없음)'; }
}

/**
 * 적립 허용 심볼 집합. 못 읽으면 **`null`** 을 돌려 호출부가 전부 거부하게 한다
 * (fail-closed — "읽지 못했다" 가 "제한 없음" 이 되면 집중 상한이 통째로 열린다).
 *
 * 🔴 **목표 배분은 `targetAllocation.load()` 로만 읽는다 — JSON 을 두 번 파싱하지 않는다.**
 *    첫 판에서 내가 파일 모양을 **추측해** 최상위 버킷 키(`doc.core_aggressive`)로 읽었는데
 *    실물은 `buckets` **배열**(`{key, targetPct, symbols}`)이었다 ⇒ 내 테스트는 내 추측과
 *    같은 픽스처로 **전부 초록이었고 라이브에서는 영원히 fail-closed** 였다. 면제가 조용히
 *    죽는 방향이라 증상도 안 난다("픽스처가 결함을 만들었다" 의 재현).
 *    ⇒ **파서는 한 벌**이고, `tests/incomeLedger.test.js` 의 *"실물 파일"* 테스트가
 *      저장소의 진짜 `config/target-allocation.json` 으로 대조한다(픽스처만 믿지 않는다).
 * ⚠️ 캐시하지 않는다 — 그 파일은 다른 축이 만들거나 고치므로, 캐시하면 **생성됐는데도 영영
 *    fail-closed** 이거나 **지워졌는데도 면제가 살아 있는** 상태가 된다.
 * ⚠️ 현금 버킷은 제외한다(심볼이 없지만, 나중에 생겨도 적립 대상이 아니다).
 */
function accrualSymbols() {
  let target;
  try {
    target = require('./targetAllocation').load();
  } catch (e) {
    logWarn('income.alloc_unavailable', { message: e.message, effect: '적립 면제 없음(fail-closed)' });
    return null;
  }
  if (!target || !Array.isArray(target.buckets)) {
    // ⚠️ targetAllocation 이 이미 warn 을 남긴다(합 불일치·파일 없음) — 여기서는 **효과**만 적는다
    logWarn('income.alloc_invalid', { effect: '적립 면제 없음(fail-closed)' });
    return null;
  }
  const out = new Set();
  for (const b of target.buckets) {
    if (!ACCRUAL_BUCKETS.includes(b.key) || b.isCash) continue;
    for (const s of b.symbols || []) out.add(String(s).trim().toUpperCase());
  }
  if (!out.size) {
    logWarn('income.alloc_no_accrual_symbols', { buckets: ACCRUAL_BUCKETS, effect: '적립 면제 없음(fail-closed)' });
    return null;
  }
  return out;
}

/**
 * 🔴 적립 예산 — **확정 수익만**. `estimatedUsd` 는 여기에 들어오지 않는다.
 *    (이 함수가 `state.estimatedUsd` 를 참조하지 않는 것이 계약이고, 테스트가 그것을 잠근다)
 */
function accrualBudgetUsd() {
  const raw = (Number(state.dividendUsd) || 0) + realizedUsd() - (Number(state.accruedUsd) || 0);
  return Math.max(0, round2(raw));
}

function status() {
  const budget = accrualBudgetUsd();
  const realized = realizedUsd();
  const syms = accrualSymbols();
  return {
    // 확정 재원
    dividendUsd: round2(state.dividendUsd),
    realizedUsd: round2(realized),
    accruedUsd: round2(state.accruedUsd),
    accrualBudgetUsd: budget,
    // 🔴 참고용 — 예산에 **포함되지 않는다**. 화면·프롬프트가 이 구분을 지워서는 안 된다
    estimatedUsd: round2(state.estimatedUsd),
    estimatedNote: '예상 배당은 참고값이며 적립 예산에 포함되지 않습니다(수령 확정분만 집계).',
    // 면제 대상
    accrualSymbols: syms ? [...syms] : [],
    allocationAvailable: syms != null,
    allocationFile: allocFile(),
    dividends: state.dividends.slice(-30),
    accruals: state.accruals.slice(-30),
  };
}

/**
 * 실제 수령한 배당 입력 — **사람의 행위**다(자동 조회 불가. 상단 주석 참조).
 * 양수만 받는다. 정정이 필요하면 음수 대신 운영자가 파일을 고치게 한다 —
 * 음수 입력을 허용하면 "배당 받았다" 기록이 **예산 조작 수단**이 된다.
 */
function addDividend({ usd, note = '', at = null, by = 'web' } = {}) {
  const v = Number(usd);
  if (!Number.isFinite(v) || v <= 0 || v > 1_000_000) {
    return { ok: false, error: 'usd 는 0 보다 크고 1,000,000 이하인 숫자여야 합니다(실제 수령액).' };
  }
  const amount = round2(v);
  const row = {
    at: at ? new Date(at).toISOString() : new Date().toISOString(),
    usd: amount,
    note: String(note || '').slice(0, 200),
    by,
  };
  state.dividendUsd = round2((Number(state.dividendUsd) || 0) + amount);
  state.dividends.push(row);
  persist();
  // 적립 재원(=실거래 권한)이 늘어나는 사건 — info 가 아니라 warn
  logWarn('income.dividend_added', { usd: amount, total: state.dividendUsd, by, note: row.note });
  try {
    require('./activityLog').record('approval', `배당 수령 입력 ${amount} USD (${by})${row.note ? ` — ${row.note}` : ''}`, {});
  } catch { /* 기록 실패가 입력 결과를 바꾸지 않는다 */ }
  return { ok: true, ...status() };
}

/**
 * 예상 배당 설정 — **참고값**. 🔴 `accrualBudgetUsd()` 는 이 값을 읽지 않는다.
 * 0 을 넣으면 지운다(사람이 "모르겠다" 로 되돌릴 수 있어야 한다).
 */
function setEstimate(usd, { by = 'web' } = {}) {
  const v = usd == null ? 0 : Number(usd);
  if (!Number.isFinite(v) || v < 0 || v > 1_000_000) {
    return { ok: false, error: 'usd 는 0~1,000,000 사이 숫자여야 합니다(예상 배당, 참고값).' };
  }
  state.estimatedUsd = round2(v);
  persist();
  // 예산에 영향이 없으므로 info — warn 으로 올리면 "돈이 움직였다" 로 읽힌다
  logInfo('income.estimate_set', { usd: state.estimatedUsd, by, effect: '참고값 — 적립 예산 불변' });
  return { ok: true, ...status() };
}

/**
 * 적립 매수 가능 판정. **셋이 전부 참일 때만** ok:
 *  ① 통화가 USD (이 원장은 USD 재원이다 — KRW 금액을 USD 예산과 비교하면 환율만큼 틀린다)
 *  ② 심볼이 목표 배분의 적립 버킷에 있다 (파일 없으면 전부 거부 = fail-closed)
 *  ③ 적립 예산이 필요액을 덮는다
 * 🔴 조용히 거부하지 않는다 — `why` 에 **어느 조건에서 걸렸는지**를 담는다(귀속 없는 거부는
 *    다음 사람이 "예산이 없나 심볼이 틀렸나" 를 추측하게 만든다).
 */
function canAccrue(symbol, needUsd, { currency = 'USD' } = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  const need = Number(needUsd);
  const budgetUsd = accrualBudgetUsd();
  const cur = String(currency || 'USD').toUpperCase();
  if (cur !== 'USD') {
    return { ok: false, why: `적립 예산은 USD 재원입니다 (요청 통화 ${cur}).`, budgetUsd };
  }
  if (!sym) return { ok: false, why: '심볼이 없습니다.', budgetUsd };
  if (!Number.isFinite(need) || need <= 0) {
    return { ok: false, why: '필요 금액을 계산할 수 없습니다 — 적립 면제를 적용하지 않습니다.', budgetUsd };
  }
  const syms = accrualSymbols();
  if (syms == null) {
    return { ok: false, why: `목표 배분(${path.basename(allocFile())})을 읽지 못해 적립 면제를 적용하지 않습니다.`, budgetUsd };
  }
  if (!syms.has(sym)) {
    return { ok: false, why: `${sym} 은 적립 대상(${ACCRUAL_BUCKETS.join('·')})이 아닙니다.`, budgetUsd, accrualSymbols: [...syms] };
  }
  if (need > budgetUsd) {
    return {
      ok: false,
      why: `적립 예산 부족 (필요 ${need.toFixed(2)} > 예산 ${budgetUsd.toFixed(2)} USD — 배당 ${round2(state.dividendUsd).toFixed(2)} + 실현 ${round2(realizedUsd()).toFixed(2)} − 적립 ${round2(state.accruedUsd).toFixed(2)}).`,
      budgetUsd,
    };
  }
  return { ok: true, budgetUsd, symbol: sym };
}

/**
 * 적립 집행 기록 — 예산에서 **차감**하고 이력을 남긴다.
 * ⚠️ 기록 시점은 호출자가 정한다(주문 전송 성공 시점이 맞다 — `agentLedger` 와 같은 보수적 기준).
 * 🔴 차감하지 않으면 같은 예산으로 **무한히** 집중 상한을 뚫을 수 있다.
 */
function recordAccrual({ symbol, quantity, price, proposalId = null, dryRun = false } = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  const qty = Number(quantity);
  const px = Number(price);
  if (!sym || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(px) || px <= 0) {
    logWarn('income.accrual_rejected', { symbol: sym, quantity, price, why: 'invalid_input' });
    return { ok: false, error: '심볼·수량·가격이 모두 유효해야 합니다.' };
  }
  const usd = round2(qty * px);
  state.accruedUsd = round2((Number(state.accruedUsd) || 0) + usd);
  state.accruals.push({ at: new Date().toISOString(), symbol: sym, quantity: qty, price: px, usd, proposalId, dryRun });
  persist();
  logInfo('income.accrual', { symbol: sym, quantity: qty, price: px, usd, remainingUsd: accrualBudgetUsd(), dryRun });
  return { ok: true, usd, remainingUsd: accrualBudgetUsd() };
}

module.exports = {
  status,
  addDividend,
  setEstimate,
  accrualBudgetUsd,
  canAccrue,
  recordAccrual,
  ACCRUAL_BUCKETS,
  _FILE: FILE,
  _allocFile: allocFile,
};

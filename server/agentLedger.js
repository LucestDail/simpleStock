/**
 * 📒 AI 운용 원장 (2026-10-05 — 사용자: "비율적으로 일부를 일임하는 구조가 되어 있나?")
 *
 * 자율 집행(1단+)의 돈 범위를 **계좌 전체에서 "맡긴 예산"으로** 좁히는 장치.
 * 사용자 우려 그대로: *"그냥 줘버리면 가지고 있는 종목도 주무를 것 같고, 비율 산정이 애매"*.
 *
 * ## 세 가지 계약
 * ① 자동 **매수**는 예산 잔액(유효 예산 − 보유 원가) 안에서만. 🔴 **예산 미설정(null) = 자동 매수 0**
 *    — 명시적으로 줘야 움직인다(기본값이 "전 재산" 인 구조를 만들지 않는다).
 *    🔴 유효 예산 = 예산 + min(0, 실현손익) — **잃은 돈은 다음 매수 때 돌아오지 않고**,
 *    번 돈은 자동으로 합쳐지지 않는다(범위 확대는 사람이 예산을 다시 정해서).
 * ② 자동 **매도**는 이 원장에 기록된(=AI 가 산) 수량까지만 — **기존 보유는 영원히 HITL**.
 * ③ 모든 기록이 파일로 영속 + 실현손익 분리 — "맡긴 돈이 뭘 했나" 가 숫자로 남는다.
 *
 * ⚠️ 한계(정직): 기록 시점은 **주문 전송 성공**이다 — 미체결·부분체결 보정은 reconcile 의
 *    영역이고 이 원장은 보수적으로 "전송=투입" 으로 센다(예산을 넉넉히 잠그는 방향의 오차).
 */
const fs = require('node:fs');
const path = require('node:path');
const { logInfo, logWarn } = require('./logger');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'agent-ledger.json');

/** 1회 주문 상한(예산 대비 %) — DCA 규율의 "1/3 이하" 와 같은 값. 100 이면 끈다 */
const MAX_ORDER_PCT = Math.max(1, Math.min(100, Number(process.env.AGENT_MAX_ORDER_PCT ?? 34)));

let state = load();

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (d && typeof d === 'object') return { budgetUsd: null, positions: {}, realizedUsd: 0, history: [], ...d };
  } catch { /* 첫 기동 */ }
  return { budgetUsd: null, positions: {}, realizedUsd: 0, history: [] };
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) { logWarn('ledger.persist_failed', { message: e.message }); }
}

/** 보유 원가 합(USD) — 예산에서 이미 잠긴 몫 */
function openCostUsd() {
  return Object.values(state.positions).reduce((a, p) => a + (Number(p.costUsd) || 0), 0);
}

/**
 * 🔴 유효 예산 — **실현 손실은 차감**된다 (2026-10-05 사용자: *"손해가 나타나면 다음
 * 매수/매도 시에 다시 500 으로 돌아가지는 않는지"* — 종전 코드는 정확히 돌아갔다:
 * 매도가 원가를 전액 풀어 주고 손익은 realizedUsd 에만 적혀, 500 투입 → 400 손절 →
 * 잔액이 다시 500. 순간 노출은 ≤예산이지만 **누적 손실엔 상한이 없었다**).
 * ⚠️ 실현 **이익은 더하지 않는다** — 운용 범위가 사람 모르게 커지면 안 된다.
 *    늘리는 건 예산 재설정(사람의 행위)으로만.
 */
function effectiveBudgetUsd() {
  if (state.budgetUsd == null) return null;
  return Math.max(0, state.budgetUsd + Math.min(0, Number(state.realizedUsd) || 0));
}

function status() {
  const eff = effectiveBudgetUsd();
  return {
    budgetUsd: state.budgetUsd,
    effectiveBudgetUsd: eff == null ? null : Math.round(eff * 100) / 100,
    maxOrderPct: MAX_ORDER_PCT,
    maxOrderUsd: eff == null ? null : Math.round(Math.min(Math.max(0, eff - openCostUsd()), eff * (MAX_ORDER_PCT / 100)) * 100) / 100,
    openCostUsd: Math.round(openCostUsd() * 100) / 100,
    availableUsd: eff == null ? 0 : Math.max(0, Math.round((eff - openCostUsd()) * 100) / 100),
    realizedUsd: Math.round(state.realizedUsd * 100) / 100,
    positions: Object.fromEntries(Object.entries(state.positions)
      .filter(([, p]) => p.qty > 0)
      .map(([s, p]) => [s, { qty: p.qty, costUsd: Math.round(p.costUsd * 100) / 100, avgUsd: Math.round((p.costUsd / p.qty) * 100) / 100 }])),
    trades: state.history.slice(-30),
  };
}

/** 예산 설정 — null 로 지우면 자동 매수가 전부 멈춘다(끄는 스위치를 겸한다) */
function setBudget(usd, { by = 'web' } = {}) {
  const v = usd == null ? null : Number(usd);
  if (v != null && (!Number.isFinite(v) || v < 0 || v > 1_000_000)) {
    return { ok: false, error: 'budgetUsd 는 0~1,000,000(USD) 또는 null 이어야 합니다.' };
  }
  const was = state.budgetUsd;
  state.budgetUsd = v;
  persist();
  logWarn('ledger.budget_changed', { from: was, to: v, by }); // 실거래 범위가 바뀌는 사건 — warn
  try { require('./activityLog').record('approval', `AI 운용 예산 ${was ?? '미설정'} → ${v ?? '미설정'} USD (${by})`, {}); } catch { /* 기록 실패 무시 */ }
  return { ok: true, ...status() };
}

/** 자동 매수 가능액 판정 — ⚠️ null(미설정)은 0 이다. "모름" 이 "무제한" 이 되면 안 된다 */
function canBuy(needUsd) {
  const eff = effectiveBudgetUsd();
  if (eff == null) return { ok: false, why: 'AI 예산 미설정 — 운용 규칙에서 예산을 정해야 자동 매수가 됩니다.' };
  const avail = eff - openCostUsd();
  if (needUsd > avail) {
    const lost = Math.min(0, Number(state.realizedUsd) || 0);
    return { ok: false, why: `AI 예산 잔액 부족 (필요 ${needUsd.toFixed(2)} > 잔액 ${avail.toFixed(2)} USD${lost < 0 ? ` · 실현 손실 ${lost.toFixed(2)} 반영` : ''})` };
  }
  /**
   * 🔴 **1회 주문 상한** (2026-10-06 — 사용자 질문이 구멍을 찾았다:
   *    *"AI 예산 2000불이면 2000불만 가지고 지지고 볶는다는건가? 아니면 한번의 주문에
   *    2000$씩 태운다는건가?"*).
   *
   *    종전 답은 **"둘 다"** 였다 — 총액은 예산 안으로 묶였지만 **1회 주문 상한이
   *    코드에 0건**이라 한 회차에 전액을 태울 수 있었다. DCA 규율("1회 1/3 이하")은
   *    **프롬프트 권고**였을 뿐이고, 프롬프트는 지켜지지 않을 수 있다
   *    (이 워크스페이스 규율: 프롬프트로 못 막는 것은 코드로 막는다).
   *
   * ⚠️ **잔액이 상한보다 작으면 잔액까지 허용**한다 — 안 그러면 마지막 잔돈을
   *    영구히 못 쓰고(예산 $100 · 상한 $34 인데 잔액 $40 이 남는 상황) 예산이 조용히 묶인다.
   * ⚠️ 기본 34% = DCA 규율의 "1/3 이하" 와 같은 값이다(프롬프트와 코드가 갈라지지 않게).
   *    `AGENT_MAX_ORDER_PCT=100` 으로 끌 수 있다 — 끄는 것도 사람의 선택이다.
   */
  const cap = eff * (MAX_ORDER_PCT / 100);
  const limit = Math.min(avail, cap);
  if (needUsd > limit) {
    return { ok: false, why: `1회 주문 상한 초과 (필요 ${needUsd.toFixed(2)} > 1회 한도 ${limit.toFixed(2)} USD = 예산의 ${MAX_ORDER_PCT}%) — 분할해서 들어가라.` };
  }
  return { ok: true };
}

/** AI 가 판 수 있는 수량 — 원장에 기록된(=AI 가 산) 것만 */
function sellableQty(symbol) {
  return Number(state.positions[String(symbol).toUpperCase()]?.qty) || 0;
}

function recordBuy({ symbol, quantity, price, proposalId = null, dryRun = false }) {
  const sym = String(symbol).toUpperCase();
  const p = state.positions[sym] || { qty: 0, costUsd: 0 };
  p.qty += quantity;
  p.costUsd += quantity * price;
  state.positions[sym] = p;
  state.history.push({ at: new Date().toISOString(), side: 'BUY', symbol: sym, quantity, price, proposalId, dryRun });
  persist();
  logInfo('ledger.buy', { symbol: sym, quantity, price, dryRun });
}

function recordSell({ symbol, quantity, price, proposalId = null, dryRun = false }) {
  const sym = String(symbol).toUpperCase();
  const p = state.positions[sym];
  if (!p || p.qty <= 0) { logWarn('ledger.sell_without_position', { symbol: sym }); return; }
  const qty = Math.min(quantity, p.qty);
  const avg = p.costUsd / p.qty;
  p.qty -= qty;
  p.costUsd -= avg * qty;
  state.realizedUsd += (price - avg) * qty;
  if (p.qty <= 0) delete state.positions[sym];
  state.history.push({ at: new Date().toISOString(), side: 'SELL', symbol: sym, quantity: qty, price, proposalId, dryRun });
  persist();
  logInfo('ledger.sell', { symbol: sym, quantity: qty, price, realized: Math.round((price - avg) * qty * 100) / 100, dryRun });
}

module.exports = { status, setBudget, canBuy, sellableQty, recordBuy, recordSell, effectiveBudgetUsd, _FILE: FILE };

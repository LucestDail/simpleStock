/**
 * 📒 AI 운용 원장 (2026-10-05 — 사용자: "비율적으로 일부를 일임하는 구조가 되어 있나?")
 *
 * 자율 집행(1단+)의 돈 범위를 **계좌 전체에서 "맡긴 예산"으로** 좁히는 장치.
 * 사용자 우려 그대로: *"그냥 줘버리면 가지고 있는 종목도 주무를 것 같고, 비율 산정이 애매"*.
 *
 * ## 세 가지 계약
 * ① 자동 **매수**는 예산 잔액(budget − 보유 원가) 안에서만. 🔴 **예산 미설정(null) = 자동 매수 0**
 *    — 명시적으로 줘야 움직인다(기본값이 "전 재산" 인 구조를 만들지 않는다).
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

function status() {
  return {
    budgetUsd: state.budgetUsd,
    openCostUsd: Math.round(openCostUsd() * 100) / 100,
    availableUsd: state.budgetUsd == null ? 0 : Math.max(0, Math.round((state.budgetUsd - openCostUsd()) * 100) / 100),
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
  if (state.budgetUsd == null) return { ok: false, why: 'AI 예산 미설정 — 운용 규칙에서 예산을 정해야 자동 매수가 됩니다.' };
  const avail = state.budgetUsd - openCostUsd();
  if (needUsd > avail) return { ok: false, why: `AI 예산 잔액 부족 (필요 ${needUsd.toFixed(2)} > 잔액 ${avail.toFixed(2)} USD)` };
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

module.exports = { status, setBudget, canBuy, sellableQty, recordBuy, recordSell, _FILE: FILE };

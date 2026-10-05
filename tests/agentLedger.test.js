/**
 * 📒 AI 운용 원장 (2026-10-05 — "비율 일임"). 세 계약을 쌍으로 잠근다:
 * ① 예산 미설정 = 자동 매수 0 (기본이 전 재산이면 안 된다)
 * ② 자동 매도는 AI 가 산 수량까지만 — 기존 보유는 HITL
 * ③ 회계: 매수=원가 잠김 · 매도=원가 회수+실현손익 · 재기동 생존(파일)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function freshLedger() {
  for (const k of Object.keys(require.cache)) if (/agentLedger/.test(k)) delete require.cache[k];
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-'));
  return require('../server/agentLedger');
}

test('③ 회계 — 매수 잠김·매도 회수·실현손익·재기동 생존', () => {
  const l = freshLedger();
  l.setBudget(1000, { by: 'test' });
  assert.equal(l.canBuy(500).ok, true);
  l.recordBuy({ symbol: 'QQQ', quantity: 5, price: 100 });       // 500 잠김
  assert.equal(l.status().availableUsd, 500);
  assert.equal(l.canBuy(600).ok, false, '잔액 넘는 매수가 통과했다');
  l.recordSell({ symbol: 'QQQ', quantity: 2, price: 110 });      // 원가 200 회수 + 실현 +20
  const st = l.status();
  assert.equal(st.availableUsd, 700);
  assert.equal(st.realizedUsd, 20);
  assert.equal(l.sellableQty('QQQ'), 3);
  // 재기동 생존 — 같은 파일을 새 모듈 인스턴스로
  for (const k of Object.keys(require.cache)) if (/agentLedger/.test(k)) delete require.cache[k];
  const l2 = require('../server/agentLedger');
  assert.equal(l2.status().availableUsd, 700, '재기동이 원장을 지웠다');
});

test('① 예산 미설정 — canBuy 는 무조건 거부(null ≠ 무제한)', () => {
  const l = freshLedger();
  assert.equal(l.canBuy(1).ok, false);
  assert.match(l.canBuy(1).why, /예산 미설정/);
});

async function freshOrders({ level, budget }) {
  for (const k of Object.keys(require.cache)) if (/simpleStock\/server\//.test(k)) delete require.cache[k];
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lgo-'));
  const o = require('../server/orderService');
  o.checkAccountLimits = async () => ({ ok: true });
  require('../server/agentControl').setAutonomy({ level, by: 'test' });
  if (budget != null) require('../server/agentLedger').setBudget(budget, { by: 'test' });
  return o;
}
async function waitStatus(o, id, want, ms = 1500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const p = o.list().find((x) => x.id === id);
    if (p && want.includes(p.status)) return p;
    await new Promise((r) => setTimeout(r, 25));
  }
  return o.list().find((x) => x.id === id);
}
const BUY = { symbol: 'QQQ', side: 'BUY', type: 'LIMIT', quantity: 2, price: 100, reason: 't', expiresInMs: 60000 };

test('①-훅 수준1 + 예산 미설정 — 매수는 HITL 대기(auto_skipped ledger_budget)', async () => {
  const o = await freshOrders({ level: 1, budget: null });
  try {
    const r = o.propose(BUY, { source: 'analyst', notify: false });
    const p = await waitStatus(o, r.proposal.id, ['DRY_RUN'], 400);
    assert.equal(p.status, 'PENDING', `예산 없이 자동이 나갔다: ${p.status}`);
    assert.match(fs.readFileSync(o.AUDIT_FILE, 'utf8'), /AI 예산 미설정/);
  } finally { delete o.checkAccountLimits; }
});

test('①-훅 예산 안 매수 — 자동 집행 + 원장 기록', async () => {
  const o = await freshOrders({ level: 1, budget: 1000 });
  try {
    const r = o.propose(BUY, { source: 'analyst', notify: false });
    const p = await waitStatus(o, r.proposal.id, ['DRY_RUN', 'EXECUTED']);
    assert.ok(['DRY_RUN', 'EXECUTED'].includes(p.status), p.status);
    const led = require('../server/agentLedger').status();
    assert.equal(led.openCostUsd, 200, '원장에 투입이 안 잡혔다');
  } finally { delete o.checkAccountLimits; }
});

test('② 기존 보유 매도는 자동 금지 — 원장에 없는 수량(ledger_not_owned)', async () => {
  const o = await freshOrders({ level: 1, budget: 1000 });
  try {
    const r = o.propose({ ...BUY, side: 'SELL', quantity: 5 }, { source: 'analyst', notify: false });
    const p = await waitStatus(o, r.proposal.id, ['DRY_RUN'], 400);
    assert.equal(p.status, 'PENDING', `기존 보유 매도가 자동으로 나갔다: ${p.status}`);
    assert.match(fs.readFileSync(o.AUDIT_FILE, 'utf8'), /기존 보유 매도는 HITL/);
  } finally { delete o.checkAccountLimits; }
});

test('② AI 가 산 것은 자동 매도 가능 — 원장 회수까지', async () => {
  const o = await freshOrders({ level: 1, budget: 1000 });
  const ledger = require('../server/agentLedger');
  ledger.recordBuy({ symbol: 'QQQ', quantity: 5, price: 100 });
  try {
    const r = o.propose({ ...BUY, side: 'SELL', quantity: 3, price: 110 }, { source: 'analyst', notify: false });
    const p = await waitStatus(o, r.proposal.id, ['DRY_RUN', 'EXECUTED']);
    assert.ok(['DRY_RUN', 'EXECUTED'].includes(p.status), p.status);
    assert.equal(ledger.sellableQty('QQQ'), 2);
    assert.equal(ledger.status().realizedUsd, 30);
  } finally { delete o.checkAccountLimits; }
});

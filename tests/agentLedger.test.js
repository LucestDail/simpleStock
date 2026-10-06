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

/**
 * ⚠️ `maxOrderPct` 기본 **100(1회 상한 끔)** — 2026-10-06.
 *    1회 주문 상한이 신설되자 **총액 축을 재던 기존 테스트 2개가 깨졌다**(budget 1000 에
 *    canBuy(500) 이 34% 상한에 걸림). 로직 회귀가 아니라 **관심사가 둘로 갈린 것**이다:
 *    총액(예산 − 보유원가)과 1회 상한은 다른 축이고, 각자 자기 테스트가 있어야 한다.
 *    ⇒ 총액 축 테스트는 1회 상한을 끄고 재고, 1회 상한은 전용 테스트가 전담한다
 *      (집중 상한 20→35→40 에서 쓴 것과 같은 수법 — 한도를 또 조정해도 안 깨진다).
 */
function freshLedger({ maxOrderPct = 100 } = {}) {
  for (const k of Object.keys(require.cache)) if (/agentLedger/.test(k)) delete require.cache[k];
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-'));
  process.env.AGENT_MAX_ORDER_PCT = String(maxOrderPct);
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

/**
 * 🔴 손실 이월 쌍 (2026-10-05 사용자: "손해가 나면 다시 500 으로 돌아가지는 않는지" — 돌아갔다).
 * 손실=차감 / 이익=미합산 을 **쌍으로** 잠근다 — 한쪽만 보면 반대쪽이 조용히 무너진다.
 */
test('③-손실 이월 — 손절 후 잔액이 예산으로 복원되지 않는다', () => {
  const l = freshLedger();
  l.setBudget(500, { by: 'test' });
  l.recordBuy({ symbol: 'QLD', quantity: 5, price: 100 });        // 500 전액 투입
  l.recordSell({ symbol: 'QLD', quantity: 5, price: 80 });        // 실현 −100
  const st = l.status();
  assert.equal(st.realizedUsd, -100);
  assert.equal(st.effectiveBudgetUsd, 400, '손실이 유효 예산에 반영되지 않았다');
  assert.equal(st.availableUsd, 400, '손절 후 잔액이 500 으로 돌아갔다');
  assert.equal(l.canBuy(450).ok, false, '잃은 돈으로 또 샀다');
  assert.match(l.canBuy(450).why, /실현 손실/);
  assert.equal(l.canBuy(400).ok, true);
});

test('③-이익 미합산 — 번 돈이 예산을 자동으로 키우지 않는다', () => {
  const l = freshLedger();
  l.setBudget(500, { by: 'test' });
  l.recordBuy({ symbol: 'QLD', quantity: 5, price: 100 });
  l.recordSell({ symbol: 'QLD', quantity: 5, price: 120 });       // 실현 +100
  const st = l.status();
  assert.equal(st.realizedUsd, 100);
  assert.equal(st.effectiveBudgetUsd, 500, '이익이 운용 범위를 몰래 키웠다');
  assert.equal(st.availableUsd, 500);
  assert.equal(l.canBuy(501).ok, false, '예산 밖 매수가 통과했다');
});

test('③-손실 과대 — 예산보다 큰 누적 손실이면 유효 예산 0 (음수 금지)', () => {
  const l = freshLedger();
  l.setBudget(100, { by: 'test' });
  l.recordBuy({ symbol: 'X', quantity: 1, price: 100 });
  l.recordSell({ symbol: 'X', quantity: 1, price: 0 });           // 실현 −100
  l.recordBuy({ symbol: 'Y', quantity: 1, price: 0 });            // 잔액 0 상태 대비
  assert.equal(l.status().effectiveBudgetUsd, 0);
  assert.equal(l.canBuy(1).ok, false);
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

/**
 * 📒 프롬프트 배선 (2026-10-06 — "예산을 투입하면 그거로 불리라는데"). 예산이 집행 게이트에만
 * 있고 판단(프롬프트)에 없어서 첫 밤 BUY 0 이었다. 절 생성(순수)과 배선(호출 존재)을 잠근다.
 * ⚠️ 호출 존재는 이름 grep 이라 약하다(10-01 함정) — 최종 판정은 배포 후 다음 회차의
 *    analyst-last-prompt.txt 에 'AI 운용 예산' 절이 실리는 **라이브 실증**이다.
 */
test('프롬프트 — 예산 미설정이면 절 없음, 설정이면 임무·수치·게이트 안내', () => {
  const a = require('../server/analystService');
  assert.equal(a.ledgerSection({ budgetUsd: null }), null);
  assert.equal(a.ledgerSection(null), null);
  const sec = a.ledgerSection({ budgetUsd: 500, availableUsd: 500, openCostUsd: 0, realizedUsd: 0, positions: {} }, 1).join('\n');
  assert.match(sec, /AI 운용 예산/);
  assert.match(sec, /예산 \$500 · 가용 \$500/);
  assert.match(sec, /BUY 를 제안하라 — 자율 1단\+ 라 그 제안은 자동 집행된다/);
  assert.match(sec, /집중 상한/, '게이트 안내가 빠지면 모델이 자동 거부를 결함으로 서술한다');
  const sec0 = a.ledgerSection({ budgetUsd: 500, availableUsd: 500, openCostUsd: 0, realizedUsd: 0, positions: {} }, 0).join('\n');
  assert.doesNotMatch(sec0, /자동 집행된다 —|1단\+ 라/, '0단에서 자동 집행을 약속하면 거짓말');
});

test('프롬프트 — 손실 이월·AI 보유가 수치로 실린다', () => {
  const a = require('../server/analystService');
  const sec = a.ledgerSection({
    budgetUsd: 500, effectiveBudgetUsd: 400, availableUsd: 280, openCostUsd: 120,
    realizedUsd: -100, positions: { SOXX: { qty: 2, costUsd: 120, avgUsd: 60 } },
  }, 1).join('\n');
  assert.match(sec, /유효 예산은 \$400/);
  assert.match(sec, /SOXX 2주 @60/);
  assert.match(sec, /실현손익 -\$100/);
});

test('프롬프트 — analyze 경로가 ledgerSection 을 실제로 부른다(선언 외 호출 ≥1)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf8');
  const calls = (src.match(/ledgerSection\(/g) || []).length;
  assert.ok(calls >= 2, `선언 포함 ${calls}회 — 호출부가 사라졌다(배선 제거)`);
});

/**
 * 🔴 **1회 주문 상한** (2026-10-06 — 사용자 질문이 구멍을 찾았다: "2000불만 가지고
 * 지지고 볶는다는건가? 아니면 한번의 주문에 2000$씩 태운다는건가?" → 종전 답은 **둘 다**).
 * 총액은 묶였는데 1회 상한이 코드에 0건이라 한 회차에 전액을 태울 수 있었다.
 * DCA "1회 1/3 이하" 는 프롬프트 권고였을 뿐 — **프롬프트로 못 막는 것은 코드로 막는다.**
 */
test('1회 주문 상한 — 예산의 34% 초과는 거부, 그 안은 통과', () => {
  const l = freshLedger({ maxOrderPct: 34 });   // 기본값과 같은 값 — 전용 축
  l.setBudget(2000, { by: 'test' });
  const st = l.status();
  assert.equal(st.maxOrderPct, 34);
  assert.equal(st.maxOrderUsd, 680, '1회 한도가 예산의 34% 가 아니다');
  assert.equal(l.canBuy(680).ok, true);
  assert.equal(l.canBuy(2000).ok, false, '한 회차에 전액이 통과했다 — 분할 규율이 코드로 안 막힌다');
  assert.match(l.canBuy(2000).why, /1회 주문 상한/);
  // 총액 축은 그대로 — 두 축이 독립임을 확인(한쪽을 고쳐 다른 쪽이 무너지지 않았다)
  l.recordBuy({ symbol: 'QLD', quantity: 6, price: 100 });   // 600 투입
  assert.equal(l.status().availableUsd, 1400);
  assert.equal(l.canBuy(680).ok, true, '잔액이 충분한데 거부됐다');
});

test('1회 상한 — 잔액이 상한보다 작으면 잔액까지 허용(잔돈이 묶이지 않는다)', () => {
  const l = freshLedger({ maxOrderPct: 34 });
  l.setBudget(100, { by: 'test' });          // 1회 상한 $34
  l.recordBuy({ symbol: 'QLD', quantity: 1, price: 60 });   // 잔액 40
  const st = l.status();
  assert.equal(st.availableUsd, 40);
  assert.equal(st.maxOrderUsd, 34, '상한이 잔액보다 작을 때의 표시가 틀렸다');
  assert.equal(l.canBuy(40).ok, false, '상한을 넘겼는데 통과');
  assert.equal(l.canBuy(34).ok, true);
  // 잔액이 상한 아래로 내려가면 그 잔액까지 쓸 수 있다
  l.recordBuy({ symbol: 'QLD', quantity: 1, price: 30 });   // 잔액 10
  assert.equal(l.canBuy(10).ok, true, '마지막 잔돈을 못 쓴다 — 예산이 조용히 묶인다');
});

test('1회 상한 — env 100 이면 끌 수 있다(끄는 것도 사람의 선택)', () => {
  const l = freshLedger({ maxOrderPct: 100 });
  l.setBudget(2000, { by: 'test' });
  assert.equal(l.canBuy(2000).ok, true, 'env 로 끌 수 없다');
});

/** 🔴 **코드 기본값이 34 인가** — freshLedger 가 env 를 핀하므로 소스로 따로 확인한다 */
test('1회 상한 — 코드 기본값 34 (env 없이도 걸린다)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'agentLedger.js'), 'utf8');
  assert.match(src, /AGENT_MAX_ORDER_PCT \?\? 34/, '기본값이 34 가 아니다 — env 를 안 주면 상한이 사라진다');
});

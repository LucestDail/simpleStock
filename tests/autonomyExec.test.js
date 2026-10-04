/**
 * 🤖 자율 집행 (2026-10-04) — "자율 수준도 선택이 안 되는데" 를 실동작으로.
 *
 * 축 셋을 **쌍으로** 잠근다(발동만 재면 오탐 축이 조용히 무너진다 — 09-30 교훈):
 *  ① 수준 0 = 어떤 제안도 자동 집행되지 않는다 (기본의 안전)
 *  ② 수준 1 + 에이전트 발 + 한도 통과 = 자동 승인+실행 (기능이 실재한다)
 *  ③ 수준 1 이라도: 수동 제안은 자동 금지 · 한도 실패는 HITL 대기로 남는다 (안 막는 쪽 설계)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function fresh({ level, limitsOk }) {
  for (const k of Object.keys(require.cache)) {
    if (/simpleStock\/server\//.test(k)) delete require.cache[k];
  }
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-'));
  const put = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  // 토스는 안 닿는다 — 한도 검사를 스텁(진짜 checkAccountLimits 는 orderAccountCheck 테스트가 잰다)
  const o = require('../server/orderService');
  const origChk = o.checkAccountLimits;
  const ctl = require('../server/agentControl');
  ctl.setAutonomy({ level, by: 'test' });
  return { o, ctl, origChk };
}

/** propose 의 비동기 자율 훅이 끝날 때까지 — 상태 전이를 폴링(고정 sleep 은 느리거나 깨진다) */
async function waitStatus(o, id, want, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const p = o.list().find((x) => x.id === id);
    if (p && want.includes(p.status)) return p;
    await new Promise((r) => setTimeout(r, 25));
  }
  return o.list().find((x) => x.id === id);
}

const INPUT = { symbol: 'QQQ', side: 'BUY', type: 'LIMIT', quantity: 1, price: 100, reason: 't', expiresInMs: 60000 };

test('① 수준 0 — 에이전트 제안도 자동 집행되지 않는다(HITL 대기)', async () => {
  const { o } = fresh({ level: 0 });
  const r = o.propose(INPUT, { source: 'analyst', notify: false });
  assert.equal(r.ok, true);
  const p = await waitStatus(o, r.proposal.id, ['DRY_RUN', 'APPROVED'], 400);
  assert.equal(p.status, 'PENDING', `수준 0 인데 ${p.status} — 기본값에서 자동이 샜다`);
});

test('② 수준 1 + analyst + 한도 통과 — 자동 승인·실행(테스트 환경은 dry-run 으로 떨어진다)', async () => {
  const { o } = fresh({ level: 1 });
  o.checkAccountLimits = async () => ({ ok: true });
  try {
    const r = o.propose(INPUT, { source: 'analyst', notify: false });
    const p = await waitStatus(o, r.proposal.id, ['DRY_RUN', 'EXECUTED']);
    assert.ok(['DRY_RUN', 'EXECUTED'].includes(p.status), `자동 집행이 안 됐다: ${p.status}`);
    // 감사에 auto_executed 가 남는다 — 자동은 조용하면 안 된다
    const audit = fs.readFileSync(o.AUDIT_FILE, 'utf8');
    assert.match(audit, /auto_executed/);
  } finally { delete o.checkAccountLimits; }
});

test('③-1 수준 1 이라도 수동 제안은 자동 금지 — "입력하자마자 나가는" 사고 방지', async () => {
  const { o } = fresh({ level: 1 });
  o.checkAccountLimits = async () => ({ ok: true });
  try {
    const r = o.propose(INPUT, { source: 'manual', notify: false });
    const p = await waitStatus(o, r.proposal.id, ['DRY_RUN'], 400);
    assert.equal(p.status, 'PENDING', `수동 제안이 자동 집행됐다: ${p.status}`);
  } finally { delete o.checkAccountLimits; }
});

test('③-2 수준 1 + 한도 실패 — 거절이 아니라 HITL 대기로 남고 auto_skipped 가 남는다', async () => {
  const { o } = fresh({ level: 1 });
  o.checkAccountLimits = async () => ({ ok: false, kind: 'concentration', error: '한도 초과' });
  try {
    const r = o.propose(INPUT, { source: 'analyst', notify: false });
    const p = await waitStatus(o, r.proposal.id, ['DRY_RUN'], 400);
    assert.equal(p.status, 'PENDING', '한도 실패가 제안을 지우거나 집행했다');
    const audit = fs.readFileSync(o.AUDIT_FILE, 'utf8');
    assert.match(audit, /auto_skipped/);
  } finally { delete o.checkAccountLimits; }
});

/**
 * 🛑 비상정지 (2026-10-03 와이어프레임 D-4)
 *
 * 자율 트레이딩의 **첫 번째 안전장치** — 자율 수준을 올리기 전에 내리는 길부터.
 * 와이어프레임: *"정지 중에는 어떤 자동 주문도 나가지 않습니다."*
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agentctl-'));
for (const k of Object.keys(require.cache)) if (/agentControl|orderService/.test(k)) delete require.cache[k];
const ctl = require('../server/agentControl');

test('🛑 정지하면 제안 게이트가 닫히고 **이유가 돌아온다**', () => {
  const r = ctl.pause({ scope: 'halt_new', reason: '테스트 정지' });
  assert.ok(r.ok);
  const g = ctl.gateProposal();
  assert.strictEqual(g.allowed, false);
  assert.match(g.why, /정지 중/, '이유 없는 차단은 "왜 안 나가지" 를 영영 못 가린다');
  assert.match(g.why, /테스트 정지/);
});

test('🔴 정지가 **재기동을 넘어 살아남는다** — 파일에서 복원', () => {
  for (const k of Object.keys(require.cache)) if (/agentControl/.test(k)) delete require.cache[k];
  const ctl2 = require('../server/agentControl');
  assert.strictEqual(ctl2.effective().paused, true, '재기동이 정지를 풀면 안전장치가 아니다');
  assert.strictEqual(ctl2.gateProposal().allowed, false);
});

test('🛑 orderService.propose 가 정지 중 제안을 **만들지 않는다** (길목 배선)', () => {
  const orders = require('../server/orderService');
  const r = orders.propose({ symbol: 'QLD', side: 'SELL', quantity: 1, price: 97, reason: '정지 중 시도' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kind, 'agent_paused', '정지 차단과 다른 거부가 구분돼야 화면이 바르게 말한다');
});

test('재개는 즉시 — 그리고 게이트가 다시 열린다', () => {
  const r = require('../server/agentControl').resume();
  assert.ok(r.ok);
  assert.strictEqual(require('../server/agentControl').gateProposal().allowed, true);
});

test('⚠️ 잘못된 scope 는 거부 — 조용히 기본값으로 바꾸지 않는다', () => {
  const r = ctl.pause({ scope: 'halt_everything' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /scope/);
});

test('⚠️ 자동 재개는 **정지 시점에 사람이 고른 것**만 — 시각이 지나면 풀린다', () => {
  const c = require('../server/agentControl');
  c.pause({ scope: 'halt_new', resumeNextDay: true });
  const st = c.effective();
  assert.ok(st.resumeAt, '예약 재개 시각이 안 박혔다');
  assert.ok(Date.parse(st.resumeAt) > Date.now());
  c.resume();
});

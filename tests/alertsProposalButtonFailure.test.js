const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

/**
 * 🔴 승인 버튼 발송 실패를 사용자가 안다 (2026-09-28, pm1 지시 — pm2 가 오늘 잡은
 * "가렸다고 로그에 찍혔는데 실제론 원본이 나갔다"(시끄러운데 틀린 로그)와 같은 가족)
 *
 * 배경: 브리핑 본문이 "🟡 매매 제안 N건 — 승인 버튼이 곧 옵니다" 라고 **약속**하는데,
 * 그 버튼은 `orderService.onProposed → alertService.onProposal → bot.sendProposal` 라는
 * **다른 경로**로 나중에 나간다. 그 발송이 실패하면(예외든 `sent:false` 든) 종전에는
 * `logError` 만 남고 사용자는 "곧 온다" 는 말을 믿고 기다리다 10분 TTL 로 조용히
 * 제안이 만료됐다 — `orderService.js` 의 "거절했는데 버튼이 남아 있었다"(있다고 안
 * 했는데 있다)의 **거울상**(있다고 했는데 없다).
 *
 * ⚠️ 위험 방향은 안전하다(기회를 놓치는 것이지 잘못된 주문이 나가는 게 아니다) — 그래도
 * HITL 제품에서 **사용자가 자기 상태를 잘못 아는 것**은 고쳐야 한다는 게 이 작업의 이유다.
 */

process.env.TELEGRAM_BOT_TOKEN = 'T';
process.env.TELEGRAM_CHAT_ID = '999';
process.env.TELEGRAM_SEND_ENABLED = 'true';
process.env.ALERTS_ENABLED = 'true'; // onProposal 의 `if (!ENABLED)` 게이트를 통과해야 한다
/**
 * 🔴 **상태 파일을 격리한다** (2026-10-01 — 전체 실행에서만 간헐 실패하던 원인).
 *
 * `node --test` 는 파일을 **병렬 프로세스**로 돌린다. 이 파일만 `ALERTS_STATE_FILE` 을
 * 안 깔아서 **저장소의 진짜 `data/alerts-state.json`** 을 읽고 썼고, 같은 순간 다른
 * alerts 테스트가 그 파일을 갈아엎으면 JSON 파싱이 깨져 `logError` 가 난다 ⇒
 * `assert.equal(errorCalls.length, 0)` 이 **1 !== 0** 으로 터진다.
 *
 * ⚠️ 증상이 "가끔 빨간불" 이라 **플래키로 넘기기 쉬웠다** — 단독 실행은 5/5 통과한다.
 *    그런데 원인은 타이밍이 아니라 **격리 누락**이고, 형제 테스트 4개는 전부 하고 있었다
 *    (**형제 중 하나만 빠진** 그 모양).
 * ★ 플래키를 방치하면 **빨간불을 읽지 않는 습관**이 생긴다 — 그게 진짜 비용이다.
 */
process.env.ALERTS_STATE_FILE = path.join(os.tmpdir(), `ss-alerts-btn-${process.pid}.json`);

let errorCalls = [];

/** ⚠️ `logError` 는 alertService.js 에서 **destructure** 된다 — require 전에 꽂아야 잡힌다 */
function captureLogger() {
  errorCalls = [];
  const logger = require('../server/logger');
  logger.logError = (event, err, ctx) => { errorCalls.push({ event, message: err?.message, ctx }); };
}

function fresh() {
  for (const k of Object.keys(require.cache)) {
    if (/alertService|telegramBot|telegramService|activityLog|orderService|logger/.test(k)) delete require.cache[k];
  }
  captureLogger();
  return require('../server/alertService');
}

const P = { id: 'p-test', symbol: 'QLD', side: 'BUY', quantity: 1, price: 100 };

beforeEach(() => { errorCalls = []; });

test('오탐 0: 버튼 발송 성공 → 후속 알림 없음(평상시 폰을 안 더럽힌다)', async () => {
  const a = fresh();
  require('../server/telegramBot').sendProposal = async () => ({ ok: true, sent: true, messageId: 42 });
  const followUps = [];
  require('../server/telegramService').send = async (text, opts) => { followUps.push({ text, opts }); return { ok: true, sent: true }; };
  let activityMeta = null;
  require('../server/activityLog').record = (kind, title, meta) => { activityMeta = meta; };

  const r = await a.onProposal(P);

  assert.equal(r.sent, true);
  assert.equal(followUps.length, 0, '버튼이 성공했는데 후속 알림을 보냈다(오탐)');
  assert.equal(activityMeta.telegram, true);
  assert.equal(errorCalls.length, 0);
});

test('🔴 발동: 버튼 발송이 예외 → 후속 평문 알림 1건 + logError', async () => {
  const a = fresh();
  require('../server/telegramBot').sendProposal = async () => { throw new Error('network down'); };
  const followUps = [];
  require('../server/telegramService').send = async (text, opts) => { followUps.push({ text, opts }); return { ok: true, sent: true }; };
  let activityMeta = null;
  require('../server/activityLog').record = (kind, title, meta) => { activityMeta = meta; };

  const r = await a.onProposal(P);

  assert.equal(r.sent, false);
  assert.equal(followUps.length, 1, '예외인데 후속 알림이 안 갔다');
  assert.match(followUps[0].text, /QLD 제안의 승인 버튼을 보내지 못했습니다/);
  assert.ok(errorCalls.some((c) => c.event === 'alerts.proposal_failed'), 'logError(alerts.proposal_failed) 가 안 남았다');
  assert.equal(activityMeta.telegram, false, 'telegram 값이 버튼 성공 여부를 안 말한다');
});

test('🔴 발동: 버튼 발송이 sent:false(예외 아님, 조용한 실패) → 같은 후속 처리(예외만 잡으면 놓치는 축)', async () => {
  const a = fresh();
  require('../server/telegramBot').sendProposal = async () => ({ ok: false, sent: false, error: 'HTTP 500' });
  const followUps = [];
  require('../server/telegramService').send = async (text, opts) => { followUps.push({ text, opts }); return { ok: true, sent: true }; };
  let activityMeta = null;
  require('../server/activityLog').record = (kind, title, meta) => { activityMeta = meta; };

  const r = await a.onProposal(P);

  assert.equal(r.sent, false);
  assert.equal(followUps.length, 1, 'sent:false(예외 아님)인데 후속 알림이 안 갔다');
  assert.match(followUps[0].text, /QLD 제안의 승인 버튼을 보내지 못했습니다/);
  assert.equal(activityMeta.telegram, false);
});

test('🔴 후속 알림마저 실패 → 더 시도하지 않고 logError, "보냈다" 로 기록하지 않는다', async () => {
  const a = fresh();
  require('../server/telegramBot').sendProposal = async () => ({ ok: false, sent: false, error: 'HTTP 500' });
  let followUpCalls = 0;
  require('../server/telegramService').send = async () => { followUpCalls += 1; return { ok: false, sent: false, error: 'telegram down' }; };
  let activityMeta = null;
  require('../server/activityLog').record = (kind, title, meta) => { activityMeta = meta; };

  const r = await a.onProposal(P);

  assert.equal(r.sent, false);
  assert.equal(followUpCalls, 1, '후속을 재시도하거나(2회 이상) 아예 안 불렀다(0회)');
  assert.ok(
    errorCalls.some((c) => c.event === 'alerts.proposal_followup_failed'),
    'logError(alerts.proposal_followup_failed) 가 안 남았다'
  );
  assert.equal(activityMeta.telegram, false, '버튼도 후속도 실패했는데 "보냈다" 로 기록됐다');
});

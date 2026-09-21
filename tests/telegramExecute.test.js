const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

/**
 * 🔴 **폰 승인 → 실행** (2026-09-22 사용자 지시: *"폰 승인도 실행까지 연결해"*)
 *
 * ## 이 파일이 재는 것은 **오터치가 곧 체결이 되지 않는가** 다
 *
 * 폰 버튼은 알림을 넘기다 눌리기 쉽고 이 경로는 **되돌릴 수 없다**.
 * ⇒ 승인(`ok`)과 전송(`go`)을 **한 탭 떼어 놓았다**. 화면 쪽 확인 창과 **같은 규율**이다.
 *
 * ⚠️ 종전 문구가 *"주문을 보냅니다"* 였는데 **아무것도 안 보냈다** —
 *    승인을 실행에 연결하는 곳이 없었다. *"말과 사실이 다른 것"* 의 또 한 건.
 */

process.env.TELEGRAM_BOT_TOKEN = 'T';
process.env.TELEGRAM_CHAT_ID = '999';
process.env.ACTIVITY_FILE = path.join(os.tmpdir(), `ss-tg-act-${process.pid}.jsonl`);

let calls = [];
let orderStub = {};

function fresh(stub = {}) {
  for (const k of Object.keys(require.cache)) {
    if (/telegramBot|orderService|activityLog|telegramService/.test(k)) delete require.cache[k];
  }
  const op = require.resolve('../server/orderService');
  const real = require(op);
  orderStub = {
    ...real,
    status: () => ({ effective: stub.live === false ? 'dry-run' : 'live' }),
    approve: (id) => ({ ok: true, proposal: { id, symbol: 'RAM', side: 'SELL', quantity: 1, price: 20 } }),
    reject: (id) => ({ ok: true, proposal: { id, symbol: 'RAM' } }),
    execute: async (id) => { calls.push(id); return stub.execute ? stub.execute(id) : { ok: true, orderId: 'ord-1', proposal: { id, symbol: 'RAM', side: 'SELL', quantity: 1, price: 20 } }; },
  };
  require.cache[op] = { id: op, filename: op, loaded: true, exports: orderStub };
  return require('../server/telegramBot');
}

const sent = [];
beforeEach(() => {
  calls = []; sent.length = 0;
  global.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init?.body || '{}') });
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
});

const cb = (data) => ({ id: 'c1', data, message: { chat: { id: '999' }, message_id: 7 } });
const texts = () => sent.map((x) => x.body?.text || '').join('\n');
const keyboards = () => sent.flatMap((x) => (x.body?.reply_markup?.inline_keyboard || []).flat());

test('🔴 승인만으로는 **주문이 안 나간다** (한 탭 더 필요하다)', async () => {
  const bot = fresh();
  const r = await bot.handleCallback(cb('ok:p1'));
  assert.equal(r.ok, true);
  assert.equal(calls.length, 0, '🔴 승인 한 번에 주문이 나갔다 — 오터치가 곧 체결이다');
  assert.equal(r.awaitingSend, true);
  assert.match(texts(), /아직 안 보냈습니다/);
});

test('🔴 승인 뒤 **전송 버튼**이 달린다 (실거래면 그렇게 적힌다)', async () => {
  const bot = fresh();
  await bot.handleCallback(cb('ok:p1'));
  const btns = keyboards();
  const go = btns.find((b) => String(b.callback_data).startsWith('go:'));
  assert.ok(go, '🔴 전송 버튼이 없다 — 폰에서 실행을 못 한다');
  assert.match(go.text, /실주문/, '🔴 버튼이 실거래임을 말하지 않는다');
  assert.ok(btns.some((b) => String(b.callback_data).startsWith('no:')), '취소 버튼이 없다');
});

test('🔴 전송을 누르면 **실제로 실행된다**', async () => {
  const bot = fresh();
  await bot.handleCallback(cb('ok:p1'));
  const r = await bot.handleCallback(cb('go:p1'));
  assert.deepEqual(calls, ['p1'], '🔴 전송을 눌렀는데 실행이 안 됐다');
  assert.equal(r.ok, true);
  assert.equal(r.orderId, 'ord-1');
  assert.match(texts(), /주문을 보냈습니다/);
  assert.match(texts(), /접수/, '🔴 "체결" 로 읽히면 안 된다 — 접수일 뿐이다');
});

/** 🔴 "모름" 은 실패가 아니다 — 다시 누르면 두 번 산다 */
test('🔴 응답을 못 받으면 **다시 누르지 말라**고 말한다', async () => {
  const bot = fresh({ execute: async () => ({ ok: false, unknown: true, error: '응답 없음' }) });
  const r = await bot.handleCallback(cb('go:p1'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown');
  assert.match(texts(), /다시 누르지 마세요/);
  assert.ok(!/실패/.test(texts()) || /응답을 못 받/.test(texts()), '🔴 "실패" 로만 읽히면 다시 누른다');
});

test('전송이 실패하면 그대로 말한다', async () => {
  const bot = fresh({ execute: async () => ({ ok: false, error: '현금이 부족합니다' }) });
  const r = await bot.handleCallback(cb('go:p1'));
  assert.equal(r.ok, false);
  assert.match(texts(), /전송 실패/);
  assert.match(texts(), /현금이 부족/);
});

/** ⚠️ 실거래가 꺼져 있으면 **그렇게 적는다** — 버튼 이름도 사실을 말해야 한다 */
test('⚠️ 모의 모드에서는 버튼과 결과가 "모의" 라고 말한다', async () => {
  const bot = fresh({ live: false, execute: async (id) => ({ ok: true, dryRun: true, proposal: { id, symbol: 'RAM', side: 'SELL', quantity: 1, price: 20 } }) });
  await bot.handleCallback(cb('ok:p1'));
  const go = keyboards().find((b) => String(b.callback_data).startsWith('go:'));
  assert.match(go.text, /모의/, '🔴 꺼져 있는데 "실주문" 이라 적었다');
  await bot.handleCallback(cb('go:p1'));
  assert.match(texts(), /실제 주문은 나가지 않았습니다/);
});

/** 🔴 남의 채팅에서 누른 버튼은 **실행되지 않는다** */
test('🔴 다른 채팅의 전송 버튼은 거부한다', async () => {
  const bot = fresh();
  const r = await bot.handleCallback({ id: 'c', data: 'go:p1', message: { chat: { id: '111' }, message_id: 1 } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'foreign_chat');
  assert.equal(calls.length, 0, '🔴 남이 내 주문을 보냈다');
});

test('취소는 실행하지 않는다', async () => {
  const bot = fresh();
  await bot.handleCallback(cb('no:p1'));
  assert.equal(calls.length, 0);
  assert.match(texts(), /취소됨/);
});

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// 🔴 테스트 파일은 병렬로 돈다 — 설정을 공유하면 서로의 값을 덮어쓴다
process.env.SETTINGS_FILE = require('node:path').join(require('node:os').tmpdir(), `ss-set-condwatch-${process.pid}.json`);
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { APP_TIMEZONE } = require('../server/time');

/**
 * 예약(조건부) 주문 감시 — 발동/만료 전이 알림 (2026-09-27, pm1 위임)
 *
 * `listConditionalOrders({status:'OPEN'})` 로 받은 열린 목록을 직전 틱과 비교해
 * **사라진 것만** 사유를 갈라 알린다. `getConditionalOrder` 의 실제 응답 필드명은
 * 확인된 적이 없으므로, 모르는 상태값을 절대 '발동' 으로 단정하지 않는지가
 * 이 자의 핵심이다.
 */

process.env.ALERTS_STATE_FILE = path.join(os.tmpdir(), `ssalerts-condwatch-${process.pid}.json`);
process.env.ACTIVITY_FILE = path.join(os.tmpdir(), `ssact-condwatch-${process.pid}.jsonl`);
process.env.TELEGRAM_BOT_TOKEN = 'TEST_TOKEN';
process.env.TELEGRAM_CHAT_ID = '999';
process.env.TELEGRAM_SEND_ENABLED = 'true';

const realFetch = global.fetch;
let sent = [];

/** ⚠️ 스텁은 alertService 를 require 하기 *전*에 꽂는다 (alerts.test.js 와 같은 함정) */
function freshAlerts(env = {}, before = null) {
  for (const k of Object.keys(require.cache)) {
    if (/alertService|telegramBot|telegramService|tickerTapeService|tossPortfolio|tossClient|activityLog|settingsService/.test(k)) {
      delete require.cache[k];
    }
  }
  Object.assign(process.env, env);
  if (before) before();
  return require('../server/alertService');
}

/** 보유는 비워 다른 규칙(목표가·급변)이 소음을 안 만들게 하고, 조건부 주문만 스텁 */
function stubConditional({ open = [], detail = null } = {}) {
  return () => {
    require('../server/tossPortfolio').getHoldings = async () => ({ items: [], summary: null });
    require('../server/settingsService').getDashboardSettings = () => ({ targets: {} });
    const toss = require('../server/tossClient');
    toss.listConditionalOrders = async () => ({ items: open });
    toss.getConditionalOrder = async (id) => {
      if (detail instanceof Error) throw detail;
      if (typeof detail === 'function') return detail(id);
      return detail ?? {};
    };
  };
}

function setOpenList(list) {
  require('../server/tossClient').listConditionalOrders = async () => ({ items: list });
}

function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE }).format(new Date());
}

beforeEach(() => {
  sent = [];
  if (fs.existsSync(process.env.ALERTS_STATE_FILE)) fs.rmSync(process.env.ALERTS_STATE_FILE);
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('finance.yahoo.com')) {
      // 변동 없음 — 지수 알림이 소음을 만들지 않게
      return { ok: true, json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 100, chartPreviousClose: 100 } }] } }) };
    }
    sent.push({ url: u, body: JSON.parse(init?.body || '{}') });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
});
afterEach(() => {
  global.fetch = realFetch;
  for (const f of [process.env.ALERTS_STATE_FILE, process.env.ACTIVITY_FILE]) {
    if (f && fs.existsSync(f)) fs.rmSync(f);
  }
  delete process.env.ALERTS_ENABLED;
  delete process.env.ALERTS_QUIET_FROM;
  delete process.env.ALERTS_QUIET_TO;
});

const QUIET_OFF = { ALERTS_ENABLED: 'true', ALERTS_QUIET_FROM: '3', ALERTS_QUIET_TO: '3' };
const ROW = (id, symbol, trigger, expireDate) => ({
  conditionalOrderId: id, symbol, first: { orderSide: 'SELL', triggerPrice: String(trigger), orderPrice: String(trigger + 0.5) }, expireDate,
});
const texts = () => sent.map((s) => s.body.text || '');

test('첫 실행(직전 상태 없음)은 기준선만 잡고 알림이 없다', async () => {
  const a = freshAlerts(QUIET_OFF, stubConditional({ open: [ROW('co-1', 'QLD', 100, '2099-01-01')] }));
  const r = await a.tick();
  assert.ok(r.ran);
  assert.ok(!texts().some((t) => /QLD/.test(t)), '재기동 때 있던 예약을 끝났다고 오인했다');
  const st = JSON.parse(fs.readFileSync(process.env.ALERTS_STATE_FILE, 'utf8'));
  assert.ok(st.conditionalOpen && st.conditionalOpen['co-1'], '기준선이 저장되지 않았다');
  assert.equal(st.conditionalOpen['co-1'].symbol, 'QLD');
  assert.equal(st.conditionalOpen['co-1'].expireDate, '2099-01-01');
});

test('전이 감지 — 직전 2건 → 지금 1건이면 사라진 1건만 처리한다', async () => {
  const openList = [ROW('co-1', 'QLD', 100, '2099-01-01'), ROW('co-2', 'RAM', 50, '2099-01-01')];
  const a = freshAlerts(QUIET_OFF, stubConditional({
    open: openList,
    detail: async (id) => ({ conditionalOrderId: id, status: 'TRIGGERED' }),
  }));
  await a.tick(); // 기준선

  setOpenList([openList[0]]); // co-2(RAM) 만 사라짐
  sent = [];
  await a.tick();
  const t = texts();
  assert.ok(t.some((x) => /RAM/.test(x) && /발동/.test(x)), '사라진 예약(RAM)을 알리지 않았다');
  assert.ok(!t.some((x) => /QLD/.test(x)), '안 사라진 예약(QLD)까지 건드렸다');
});

test('같은 상태 반복 틱은 알림이 없다 (엣지 규율)', async () => {
  const list = [ROW('co-1', 'QLD', 100, '2099-01-01')];
  const a = freshAlerts(QUIET_OFF, stubConditional({ open: list }));
  await a.tick(); // 기준선
  sent = [];
  await a.tick(); // 목록이 그대로
  assert.ok(!texts().some((t) => /QLD/.test(t)), '변화가 없는데 알렸다');
});

test('🔴 상세 조회 실패는 "발동" 이라 말하지 않고 사유 확인 불가로 알린다', async () => {
  const list = [ROW('co-1', 'QLD', 100, '2099-01-01')];
  const a = freshAlerts(QUIET_OFF, stubConditional({ open: list, detail: new Error('토스 응답 없음') }));
  await a.tick();
  setOpenList([]);
  sent = [];
  await a.tick();
  const t = texts().join('\n');
  assert.match(t, /QLD.*사유를 확인하지 못했습니다/);
  assert.ok(!/발동/.test(t), '조회도 못 했는데 발동이라 말했다 — 돈이 움직인 것처럼 읽힌다');
});

test('만료/취소 상태는 만료로 알린다', async () => {
  const list = [ROW('co-1', 'QLD', 100, '2099-01-01')];
  const a = freshAlerts(QUIET_OFF, stubConditional({ open: list, detail: async () => ({ status: 'EXPIRED' }) }));
  await a.tick();
  setOpenList([]);
  sent = [];
  await a.tick();
  const t = texts().join('\n');
  assert.match(t, /⏳ 예약 만료 — QLD/);
  assert.ok(!/발동/.test(t));
});

test('🔴 알 수 없는 상태값은 발동으로 단정하지 않는다 (모르면 모른다고 한다)', async () => {
  const list = [ROW('co-1', 'QLD', 100, '2099-01-01')];
  const a = freshAlerts(QUIET_OFF, stubConditional({ open: list, detail: async () => ({ status: 'WEIRD_UNKNOWN_VALUE' }) }));
  await a.tick();
  setOpenList([]);
  sent = [];
  await a.tick();
  const t = texts().join('\n');
  assert.match(t, /사유를 확인하지 못했습니다/);
  assert.ok(!/발동/.test(t));
});

test('첫 실행(재기동 흉내)에서는 이미 있던 예약을 "끝났다" 로 알리지 않는다', async () => {
  // st.conditionalOpen 이 아예 없는 상태에서 시작 — 이게 "재기동" 시나리오다
  const a = freshAlerts(QUIET_OFF, stubConditional({ open: [ROW('co-1', 'QLD', 100, '2099-01-01')] }));
  const r = await a.tick();
  assert.equal(r.found, 0, '재기동 첫 틱에서 알림이 나갔다');
});

test('오늘 만료되는 예약은 하루 한 번만 경고한다', async () => {
  const today = todayStr();
  const list = [ROW('co-1', 'QLD', 100, today)];
  const a = freshAlerts(QUIET_OFF, stubConditional({ open: list }));
  await a.tick();
  assert.ok(texts().some((t) => /만료되는 예약/.test(t) && /QLD/.test(t)), '오늘 만료 경고가 없다');

  sent = [];
  await a.tick(); // 같은 날 두 번째 틱
  assert.ok(!texts().some((t) => /QLD/.test(t)), '하루 한 번 규칙을 어기고 또 보냈다');
});

test('🔴 조건부 감시가 실패해도 다른 규칙(세션 등)은 계속 돈다', async () => {
  const a = freshAlerts(QUIET_OFF, () => {
    require('../server/tossPortfolio').getHoldings = async () => ({ items: [], summary: null });
    require('../server/settingsService').getDashboardSettings = () => ({ targets: {} });
    require('../server/tossClient').listConditionalOrders = async () => { throw new Error('조건부 목록 조회 실패'); };
  });
  const r = await a.tick();
  assert.ok(r.ran, '조건부 감시 실패로 틱 전체가 죽었다');
  assert.ok(r.failed.includes('conditional'), '실패가 기록되지 않았다');
});

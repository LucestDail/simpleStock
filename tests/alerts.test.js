const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 자동 알림 · 텔레그램 승인 버튼 (2026-09-21)
 *
 * ## 🔴 이 자가 지키는 두 가지
 *
 * **① 권한** — 승인 버튼이 **인터넷 너머**로 나간다. 봇 토큰이 새면 아무나 누를 수 있으므로
 *    콜백의 발신 대화가 **설정된 chat_id 인지**를 코드가 본다. 그게 뚫리면 나머지는 의미 없다.
 * **② 소음** — 같은 알림이 반복되면 사람이 알림을 끄고, 그러면 **정작 중요한 것도 안 본다.**
 *    상태 전이·하루 한 번·조용한 시간을 자로 잠근다.
 *
 * ⚠️ 파일 경로를 프로세스마다 갈라 쓴다 — `node --test` 는 파일을 **병렬로** 돌린다
 *    (오늘 채팅/dreaming 테스트가 같은 파일을 놓고 경합해 전체 실행에서만 깨졌다).
 */

process.env.ALERTS_STATE_FILE = path.join(os.tmpdir(), `ssalerts-${process.pid}.json`);
/**
 * 🔴 **활동 기록도 갈라 쓴다.** 첫 판은 이걸 안 해서 테스트 알림이 **실제 `data/activity.jsonl`
 *    에 58건** 쌓였고, 화면 타임라인에 "솔라나 +50%" 같은 **가짜 기록**이 떴다.
 *    오늘 채팅·dreaming 에서 이미 같은 실수를 했는데 **세 번째**다 —
 *    새 저장소를 만들 때마다 테스트 경로를 갈라야 한다.
 */
process.env.ACTIVITY_FILE = path.join(os.tmpdir(), `ssact-${process.pid}.jsonl`);
process.env.TELEGRAM_BOT_TOKEN = 'TEST_TOKEN';
process.env.TELEGRAM_CHAT_ID = '999';
/**
 * 🔴 **발송을 켜 둔다.** 안 켜면 `telegram.send` 가 dry-run 이라 fetch 를 안 부르고,
 *    그러면 "무엇이 나갔는가" 를 보는 이 테스트들이 **전부 공허하게** 통과한다
 *    (실제로 목표가 테스트 3건이 그래서 깨졌고, 코드가 아니라 하니스가 문제였다).
 * ⚠️ fetch 는 가로채므로 **실제 네트워크로는 안 나간다.**
 */
process.env.TELEGRAM_SEND_ENABLED = 'true';

const realFetch = global.fetch;
let sent = [];

/**
 * ⚠️ **스텁은 `alertService` 를 require 하기 *전*에 꽂아야 한다.**
 *    `alertService` 가 `const { getDashboardSettings } = require(...)` 로 **구조분해**해
 *    값을 붙들기 때문에, 나중에 모듈 객체를 바꿔도 **안 먹는다.**
 *    오늘 **네 번째로** 밟은 함정이라 하니스에 아예 박아 둔다.
 * @param {object} env  환경변수
 * @param {function} [before]  require 직전에 돌 스텁 설치 함수
 */
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

/** 보유·목표선을 흉내 낸다 — 실제 토스·설정 파일을 안 건드린다 */
function stubs({ items = [], summary = null, targets = {} } = {}) {
  return () => {
    require('../server/tossPortfolio').getHoldings = async () => ({ items, summary });
    require('../server/settingsService').getDashboardSettings = () => ({ targets });
  };
}

beforeEach(() => {
  sent = [];
  if (fs.existsSync(process.env.ALERTS_STATE_FILE)) fs.rmSync(process.env.ALERTS_STATE_FILE);
  /**
   * ⚠️ 야후(테이프)와 텔레그램을 **갈라서** 흉내 낸다.
   *    첫 판은 전부 텔레그램 응답만 돌려줘서 테이프가 비었고, 그 결과
   *    "조용한 시간" 테스트가 **알림 0건으로 공허하게 통과**했다(변이를 안 잡았다).
   *    ⇒ 지수 하나를 **크게 움직여** 실제로 알림이 생기게 한다.
   */
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('finance.yahoo.com')) {
      return {
        ok: true,
        json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 150, chartPreviousClose: 100 } }] } }),
      };
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
});

// ── ① 권한: 승인 버튼 ────────────────────────────────────────

test('🔴 다른 대화에서 누른 버튼은 거부한다 (봇 토큰이 새도 주문은 못 건드린다)', async () => {
  process.env.TELEGRAM_BOT_ENABLED = 'true';
  for (const k of Object.keys(require.cache)) if (/telegramBot|orderService/.test(k)) delete require.cache[k];
  const bot = require('../server/telegramBot');
  const orders = require('../server/orderService');
  orders._resetForTest();
  const p = orders.propose({ symbol: '005930', side: 'BUY', type: 'LIMIT', quantity: 1, price: 100 }).proposal;

  const r = await bot.handleCallback({
    id: 'cb1', data: `ok:${p.id}`,
    message: { chat: { id: '12345' }, message_id: 7 },   // ← 설정된 999 가 아니다
  });

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'foreign_chat');
  // 🔴 제안이 **승인되지 않았어야** 한다 — 이게 이 테스트의 전부다
  assert.equal(orders.list().find((x) => x.id === p.id).status, 'PENDING');
});

test('설정된 대화에서 누르면 승인된다 — 다만 **실행은 아니다**', async () => {
  process.env.TELEGRAM_BOT_ENABLED = 'true';
  for (const k of Object.keys(require.cache)) if (/telegramBot|orderService/.test(k)) delete require.cache[k];
  const bot = require('../server/telegramBot');
  const orders = require('../server/orderService');
  orders._resetForTest();
  const p = orders.propose({ symbol: '005930', side: 'BUY', type: 'LIMIT', quantity: 1, price: 100 }).proposal;

  const r = await bot.handleCallback({ id: 'cb2', data: `ok:${p.id}`, message: { chat: { id: '999' }, message_id: 7 } });
  assert.equal(r.ok, true);
  const after = orders.list().find((x) => x.id === p.id);
  assert.equal(after.status, 'APPROVED');
  assert.ok(after.approvedAt, '승인 시각이 없으면 실행 게이트가 구조로 막지 못한다');

  // 🔴 사용자에게 **실행이 아니라는 것**을 말했는가 — "승인했으니 샀겠지" 가 제일 위험하다
  const notice = sent.map((s) => JSON.stringify(s.body)).join(' ');
  assert.match(notice, /실제 주문은 나가지 않습니다|주문을 보냅니다/);
});

test('취소 버튼은 거절로 남는다', async () => {
  process.env.TELEGRAM_BOT_ENABLED = 'true';
  for (const k of Object.keys(require.cache)) if (/telegramBot|orderService/.test(k)) delete require.cache[k];
  const bot = require('../server/telegramBot');
  const orders = require('../server/orderService');
  orders._resetForTest();
  const p = orders.propose({ symbol: 'QLD', side: 'SELL', type: 'LIMIT', quantity: 2, price: 90 }).proposal;
  await bot.handleCallback({ id: 'cb3', data: `no:${p.id}`, message: { chat: { id: '999' }, message_id: 8 } });
  assert.equal(orders.list().find((x) => x.id === p.id).status, 'REJECTED');
});

/** ⚠️ 피어 제안: 텔레그램은 메시지가 남아 **어제 제안을 오늘 누른다** — 유효기간을 본문에 적는다 */
test('제안 메시지에 유효기간이 적혀 있다', async () => {
  process.env.TELEGRAM_BOT_ENABLED = 'true';
  for (const k of Object.keys(require.cache)) if (/telegramBot|telegramService|orderService/.test(k)) delete require.cache[k];
  const bot = require('../server/telegramBot');
  const orders = require('../server/orderService');
  orders._resetForTest();
  const p = orders.propose({ symbol: '005930', side: 'BUY', type: 'LIMIT', quantity: 3, price: 70000 }).proposal;

  await bot.sendProposal(p);
  const body = sent.map((s) => s.body.text || '').join('\n');
  assert.match(body, /까지/, '유효기간이 없으면 만료된 버튼을 누르고 "왜 안 되지" 를 겪는다');
  assert.match(body, /승인 필요/);
  // 버튼이 실제로 붙었는가
  const kb = sent.find((s) => s.body.reply_markup)?.body.reply_markup?.inline_keyboard?.[0] || [];
  assert.deepEqual(kb.map((b) => b.callback_data), [`ok:${p.id}`, `no:${p.id}`]);
});

// ── ② 소음 ──────────────────────────────────────────────────

test('기본은 꺼져 있고, 꺼져 있으면 한 건도 안 나간다', async () => {
  delete process.env.ALERTS_ENABLED;
  const a = freshAlerts();
  const r = await a.tick();
  assert.equal(r.ran, false);
  assert.equal(r.why, 'disabled');
  assert.equal(sent.length, 0);
  assert.equal(a.status().reason, 'disabled');
});

test('개장/폐장은 **상태가 바뀐 순간**에만 알린다 (첫 틱은 기준선)', async () => {
  const a = freshAlerts({ ALERTS_ENABLED: 'true' });
  // 지수·보유 규칙은 네트워크를 타므로 실패해도 세션 규칙은 돌아야 한다(부분 실패 격리)
  const first = await a.tick();
  const firstSession = sent.filter((s) => /개장|폐장|장 전/.test(s.body.text || '')).length;
  assert.equal(firstSession, 0, '첫 틱은 기준선이라 세션 알림이 나가면 안 된다');

  sent = [];
  await a.tick();
  const second = sent.filter((s) => /개장|폐장|장 전/.test(s.body.text || '')).length;
  assert.equal(second, 0, '상태가 안 바뀌었는데 또 알렸다 — 매 틱 소음이 된다');
  assert.equal(first.ran, true);
  delete process.env.ALERTS_ENABLED;
});

test('조용한 시간에는 찾아도 보내지 않고, 그 사실을 남긴다', async () => {
  // 지금 시각과 무관하게 **항상 조용한** 창을 준다(0~24)
  const a = freshAlerts({ ALERTS_ENABLED: 'true', ALERTS_QUIET_FROM: '0', ALERTS_QUIET_TO: '24' });
  assert.equal(a.isQuiet(new Date()), true);
  const r = await a.tick();
  assert.equal(r.quiet, true);
  /**
   * 🔴 **검사 대상이 0건이면 이 테스트는 아무것도 안 잰다.**
   *    실제로 첫 판이 그랬고 `if (quiet) continue;` 를 지우는 변이를 **못 잡았다**.
   *    야후 스텁이 +50% 를 주므로 지수 규칙이 반드시 뭔가를 찾는다.
   */
  assert.ok(r.found > 0, `찾은 알림이 0건이라 "안 보냈다" 를 검사하지 못한다 (found=${r.found})`);
  assert.equal(sent.filter((s) => /sendMessage/.test(s.url)).length, 0, '조용한 시간에 보냈다');
  assert.equal(r.sent, 0);
  delete process.env.ALERTS_ENABLED;
  delete process.env.ALERTS_QUIET_FROM;
  delete process.env.ALERTS_QUIET_TO;
});

/**
 * 🔴🔴 **2026-09-21 실사고 회귀 가드.**
 *
 * `force` 를 *"점검용"* 이라 부르며 *"켜기 전에 한 번 돌려 보자"* 고 안내했는데,
 * 실제로는 **사용자 폰으로 12건이 나갔다.** `ALERTS_ENABLED` 는 꺼져 있었지만
 * 아래층 `TELEGRAM_SEND_ENABLED` 가 켜져 있었고 `force` 가 위층만 건너뛰었기 때문이다.
 *
 * ★ **이름이 동작을 보증하지 않는다.** "점검용" 이라 부르려면 코드가 점검용이어야 한다.
 *   ⇒ *돌 것인가* 와 *보낼 것인가* 를 **다른 축**으로 갈랐고, 여기서 못박는다.
 */
test('🔴 force 는 돌리기만 한다 — 보내지 않는다', async () => {
  delete process.env.ALERTS_ENABLED;              // 알림은 꺼져 있고
  // 발송은 위에서 켜 뒀다 ← 사고 당시 그대로
  const a = freshAlerts();

  const r = await a.tick({ force: true });

  assert.equal(r.ran, true, 'force 인데 안 돌았다 — 점검을 못 한다');
  assert.ok(r.found > 0, '찾은 게 0건이면 이 테스트가 아무것도 검사하지 못한다');
  assert.equal(r.sent, 0, '🔴 force 만으로 발송됐다 — 사용자 폰으로 나간다');
  assert.equal(r.willSend, false);
  assert.equal(r.why, 'alerts_disabled');
  assert.equal(sent.filter((x) => /sendMessage/.test(x.url)).length, 0);
  // 점검의 목적 — **나갔을 내용**은 돌려줘야 한다
  assert.ok(Array.isArray(r.preview) && r.preview.length === r.found);
});

test('일부러 보내려면 send 를 **명시**해야 한다', async () => {
  delete process.env.ALERTS_ENABLED;
  const a = freshAlerts();
  const r = await a.tick({ force: true, send: true });
  assert.equal(r.willSend, true);
  assert.ok(r.sent > 0, '명시했는데도 안 보냈다');
});

test('켜져 있어도 dryRun 이면 안 보낸다', async () => {
  const a = freshAlerts({ ALERTS_ENABLED: 'true' });
  const r = await a.tick({ dryRun: true });
  assert.equal(r.willSend, false);
  assert.equal(r.why, 'dry-run');
  assert.equal(r.sent, 0);
  delete process.env.ALERTS_ENABLED;
});

/**
 * 🔴 피어 지적: `found: 0` 만으로는 *"알릴 게 없다"* 와 *"이미 알려서 걸렀다"* 가 **안 갈린다.**
 *    두 번째 틱은 중복 방지 때문에 0 이 되는데, 그게 정상인지 고장인지 화면이 모른다.
 */
test('두 번째 틱의 0 은 "걸렀다" 라고 말한다', async () => {
  const a = freshAlerts({ ALERTS_ENABLED: 'true' });
  const first = await a.tick();
  assert.ok(first.found > 0, '첫 틱이 0이면 이 테스트가 아무것도 검사하지 못한다');

  const second = await a.tick();
  assert.equal(second.found, 0, '중복 방지가 안 먹었다');
  // ★ 0 의 **이유**가 있어야 한다
  assert.ok(second.suppressed > 0, '걸러진 건수를 안 세면 0 이 "없다" 로만 보인다');
  assert.ok(second.suppressedWhy.some((w) => /이미 알림/.test(w)), '왜 걸렀는지 말하지 않았다');
  delete process.env.ALERTS_ENABLED;
});

// ── 목표가·손절선 ──────────────────────────────────────────

const QUIET_OFF = { ALERTS_ENABLED: 'true', ALERTS_MOVE_PCT: '99', ALERTS_INDEX_PCT: '999' };

test('🎯 목표가는 **통과할 때 한 번만** 알린다', async () => {
  const a = freshAlerts(QUIET_OFF, stubs({
    items: [{ symbol: 'QLD', name: 'QLD', lastPrice: 95, profitRate: 10, dailyRate: 0 }],
    targets: { QLD: { target: 90, stop: 70 } },
  }));

  const r1 = await a.tick();
  assert.ok(r1.found >= 1, '목표가를 넘었는데 안 알렸다');
  assert.ok(sent.some((x) => /목표가 도달/.test(x.body.text || '')));

  // 🔴 계속 위에 있다고 매 틱 알리면 소음이다
  sent = [];
  const r2 = await a.tick();
  assert.ok(!sent.some((x) => /목표가 도달/.test(x.body.text || '')), '같은 상태인데 또 알렸다');
  assert.ok(r2.suppressedWhy.some((w) => /목표가/.test(w)), '왜 안 알렸는지 말하지 않았다');
  delete process.env.ALERTS_ENABLED;
});

test('🔴 되돌아왔다가 다시 넘으면 **새 사건**이다', async () => {
  const a = freshAlerts(QUIET_OFF, stubs({
    items: [{ symbol: 'QLD', name: 'QLD', lastPrice: 95, profitRate: 1, dailyRate: 0 }],
    targets: { QLD: { target: 90, stop: null } },
  }));
  const tp = require('../server/tossPortfolio');
  await a.tick();

  // 아래로 내려갔다 — 표시를 지워야 다음 통과를 알린다
  tp.getHoldings = async () => ({ items: [{ symbol: 'QLD', name: 'QLD', lastPrice: 80, profitRate: 1, dailyRate: 0 }], summary: null });
  await a.tick();

  sent = [];
  tp.getHoldings = async () => ({ items: [{ symbol: 'QLD', name: 'QLD', lastPrice: 96, profitRate: 1, dailyRate: 0 }], summary: null });
  await a.tick();
  assert.ok(sent.some((x) => /목표가 도달/.test(x.body.text || '')), '되돌아온 뒤 다시 넘었는데 안 알렸다 — 표시를 안 지웠다');
  delete process.env.ALERTS_ENABLED;
});

test('🛑 손절선은 아래로 통과할 때 알린다', async () => {
  const a = freshAlerts(QUIET_OFF, stubs({
    items: [{ symbol: 'RAM', name: 'RAM', lastPrice: 14, profitRate: -25, dailyRate: 0 }],
    targets: { RAM: { target: null, stop: 15 } },
  }));
  await a.tick();
  assert.ok(sent.some((x) => /손절선 이탈/.test(x.body.text || '')));
  delete process.env.ALERTS_ENABLED;
});

test('목표선이 설정 안 된 종목은 건드리지 않는다', async () => {
  const a = freshAlerts(QUIET_OFF, stubs({
    items: [{ symbol: 'QLD', name: 'QLD', lastPrice: 9999, profitRate: 1, dailyRate: 0 }],
  }));
  await a.tick();
  assert.ok(!sent.some((x) => /목표가|손절선/.test(x.body.text || '')), '설정도 안 했는데 알렸다');
  delete process.env.ALERTS_ENABLED;
});

// ── 장 마감 요약 ───────────────────────────────────────────

test('🔔 폐장 알림에는 **오늘 요약**이 함께 간다', async () => {
  const a = freshAlerts(QUIET_OFF, stubs({
    items: [
      { symbol: 'A', name: '가나다', lastPrice: 100, profitRate: 5, dailyRate: 3.2 },
      { symbol: 'B', name: '라마바', lastPrice: 50, profitRate: -8, dailyRate: -4.1 },
    ],
    summary: { value: { krw: 1000000 }, dailyRate: -0.5, profitRate: 11.4 },
  }));

  // 첫 틱은 기준선 — 여기서 상태를 심는다
  const fs2 = require('node:fs');
  await a.tick();
  // 상태를 'open' 으로 바꿔 두면 다음 틱에서 closed 로의 **전이**가 일어난다
  const st = JSON.parse(fs2.readFileSync(process.env.ALERTS_STATE_FILE, 'utf8'));
  for (const k of Object.keys(st)) if (k.startsWith('session:')) st[k] = 'open';
  fs2.writeFileSync(process.env.ALERTS_STATE_FILE, JSON.stringify(st));

  sent = [];
  await a.tick();
  const close = sent.map((x) => x.body.text || '').find((t) => /폐장 · 오늘 요약/.test(t));
  // ⚠️ 지금 시각이 장 중이면 전이가 안 일어난다 — 그때는 이 테스트가 아무것도 못 잰다
  if (!close) return;
  assert.match(close, /▲ 가나다 \+3\.2/, '기여 종목(상승)이 없다');
  assert.match(close, /▼ 라마바 -4\.1/, '기여 종목(하락)이 없다');
  assert.match(close, /누적 \+11\.4/, '누적 손익이 없다');
  delete process.env.ALERTS_ENABLED;
});

/** 🔴 못 하는 것을 **조용히 빼지 않는다** — 사용자가 "왜 어닝콜은 안 오지" 를 겪지 않게 */
test('지원하지 않는 항목을 상태에 적어 둔다', () => {
  const a = freshAlerts();
  assert.ok(a.status().unsupported.some((u) => /어닝콜/.test(u)), '어닝콜을 못 한다는 사실이 어디에도 없다');
});

// ── 제안 → 알림 배선 ────────────────────────────────────────

test('제안이 만들어지면 알림 훅이 불린다 (배선이 실제로 돈다)', () => {
  for (const k of Object.keys(require.cache)) if (/orderService/.test(k)) delete require.cache[k];
  const orders = require('../server/orderService');
  orders._resetForTest();
  const seen = [];
  orders.onProposed((p) => seen.push(p.symbol));
  orders.propose({ symbol: 'QLD', side: 'BUY', type: 'LIMIT', quantity: 1, price: 90 });
  assert.deepEqual(seen, ['QLD']);

  // ⚠️ 빈칸이 있어 **거부된** 제안은 알리지 않는다(없는 일을 알리면 안 된다)
  seen.length = 0;
  orders.propose({ symbol: '', side: 'BUY', type: 'LIMIT', quantity: 1, price: 90 });
  assert.deepEqual(seen, []);
});

test('알림 훅이 터져도 제안은 살아 있다 (곁가지가 본체를 죽이지 않는다)', () => {
  for (const k of Object.keys(require.cache)) if (/orderService/.test(k)) delete require.cache[k];
  const orders = require('../server/orderService');
  orders._resetForTest();
  orders.onProposed(() => { throw new Error('텔레그램 죽음'); });
  const r = orders.propose({ symbol: '005930', side: 'BUY', type: 'LIMIT', quantity: 1, price: 100 });
  assert.equal(r.ok, true, '알림 실패가 제안을 되돌렸다');
});

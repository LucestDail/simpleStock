const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 🩺 정기 브리핑 누락 감시 — `alertService.ruleBriefWatch` (2026-09-27, worker3)
 *
 * 별도 파일로 둔다 — `tests/alerts.test.js` 를 다른 세션(worker2)이 동시에 편집 중이라
 * 파일을 나눠 충돌 표면을 줄인다(pm1 지시).
 *
 * ⚠️ `tick()` 은 시각을 인자로 안 받고 내부에서 `new Date()` 를 쓴다. 그래서 세션 시각을
 *    고정 날짜(예: "2026-09-28 09:00 KST")로 박으면 **테스트를 실행하는 실제 시각**에 따라
 *    "기대 시각 +25분" 여부가 매번 달라진다(기존 `alerts.test.js` 의 폐장 테스트가 이 문제를
 *    `if (!close) return` 로 덮고 지나간 그 자리다). 여기서는 캘린더의 `regular{start,end}`
 *    를 **테스트 실행 시각(Date.now()) 기준 상대 오프셋**으로 만들어 결정적으로 만든다.
 *
 * ⚠️ `marketCalendar` 는 하루 단위로 **모듈 전역**에 캘린더를 캐시한다(`calCache`). 지우지
 *    않으면 앞선 테스트가 채운(다른 오프셋의) 캐시를 다음 테스트가 그대로 물려받는다.
 *    ⇒ `freshAlerts` 가 매번 `marketCalendar`·`tossClient`·`analystService` 캐시까지 지운다.
 */

process.env.ALERTS_STATE_FILE = path.join(os.tmpdir(), `ss-briefwatch-alerts-${process.pid}.json`);
process.env.ACTIVITY_FILE = path.join(os.tmpdir(), `ss-briefwatch-act-${process.pid}.jsonl`);
process.env.ANALYST_LAST_FILE = path.join(os.tmpdir(), `ss-briefwatch-analyst-last-${process.pid}.json`);
process.env.TELEGRAM_BOT_TOKEN = 'TEST_TOKEN';
process.env.TELEGRAM_CHAT_ID = '999';
process.env.TELEGRAM_SEND_ENABLED = 'true';
const QUIET_OFF = { ALERTS_QUIET_FROM: '0', ALERTS_QUIET_TO: '0' };

const realFetch = global.fetch;
let sent = [];

/** KR 은 `today.integrated.regularMarket`, US 는 `today.regularMarket`(한 겹 얕다) — marketCalendar.js 규약 */
function fakeCalendarDay(market, regular) {
  const body = regular
    ? { regularMarket: { startTime: new Date(regular.start).toISOString(), endTime: new Date(regular.end).toISOString() } }
    : {}; // 휴장 흉내 — startTime/endTime 이 없으면 span() 이 null 을 준다
  return market === 'KR' ? { date: 'test', integrated: body } : { date: 'test', ...body };
}

/**
 * @param {{start:number,end:number}|null} kr KR 오늘 정규장(epoch ms) 또는 null(휴장)
 * @param {{start:number,end:number}|null} us US 오늘 정규장(epoch ms) 또는 null(휴장)
 */
function stubCalendar(kr, us) {
  require('../server/tossClient').getMarketCalendar = async (market) => ({
    today: fakeCalendarDay(market, market === 'KR' ? kr : us),
    previousBusinessDay: null,
    nextBusinessDay: null,
  });
}

function freshAlerts(env = {}, before = null) {
  for (const k of Object.keys(require.cache)) {
    if (/alertService|telegramBot|telegramService|tickerTapeService|tossPortfolio|tossClient|activityLog|settingsService|marketCalendar|analystService/.test(k)) {
      delete require.cache[k];
    }
  }
  Object.assign(process.env, env);
  if (before) before();
  return require('../server/alertService');
}

/** 보유·설정·예약주문 목록을 흉전 — 이 스위트의 관심사가 아닌 규칙들을 조용히 만든다 */
function quietOtherRules() {
  require('../server/tossPortfolio').getHoldings = async () => ({ items: [], summary: null });
  require('../server/settingsService').getDashboardSettings = () => ({ targets: {} });
  require('../server/tossClient').listConditionalOrders = async () => ({ items: [] });
}

/** 첫 실행이 아닌 **정상 가동 중** 상태를 흉내 낸다(브리핑 감시의 첫 틱 특례를 피해간다) */
function seedSteadyState() {
  fs.writeFileSync(process.env.ALERTS_STATE_FILE, JSON.stringify({ briefWatchSeeded: true }));
}

beforeEach(() => {
  sent = [];
  if (fs.existsSync(process.env.ALERTS_STATE_FILE)) fs.rmSync(process.env.ALERTS_STATE_FILE);
  if (fs.existsSync(process.env.ANALYST_LAST_FILE)) fs.rmSync(process.env.ANALYST_LAST_FILE);
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('finance.yahoo.com')) {
      // 지수 테이프는 이 스위트의 관심사가 아니다 — 0% 변화로 조용히 둔다
      return { ok: true, json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 100, chartPreviousClose: 100 } }] } }) };
    }
    sent.push({ url: u, body: JSON.parse(init?.body || '{}') });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
});

afterEach(() => {
  global.fetch = realFetch;
  for (const f of [process.env.ALERTS_STATE_FILE, process.env.ACTIVITY_FILE, process.env.ANALYST_LAST_FILE]) {
    if (f && fs.existsSync(f)) fs.rmSync(f);
  }
  delete process.env.ALERTS_ENABLED;
});

const missingTexts = () => sent.map((x) => x.body.text || '').filter((t) => /브리핑이 예정 시각.*돌지 않았습니다/.test(t));

// ── 발동 ─────────────────────────────────────────────────────

test('🔴 발동: 기대 시각(개장) +25분, 기록 없음 → 경고 1건', async () => {
  const refNow = Date.now();
  const start = refNow - 25 * 60_000; // KRX 개장 25분 전 = 유예(20분) 지남
  const end = refNow + 60 * 60_000; // 마감은 아직 한참 남음(중간·마감 회차는 안 걸린다)

  const a = freshAlerts(QUIET_OFF, () => {
    stubCalendar({ start, end }, null); // US 는 휴장 처리 — KR 개장 하나만 남긴다
    quietOtherRules();
  });
  seedSteadyState();

  const r = await a.tick({ force: true, send: true });

  const texts = missingTexts();
  assert.equal(texts.length, 1, `경고가 1건이 아니다: ${JSON.stringify(sent.map((x) => x.body.text))}`);
  assert.match(texts[0], /KRX/);
  assert.match(texts[0], /개장/);
  assert.match(texts[0], /트리거 누락 가능/);
  assert.equal(r.failed.includes('brief_watch'), false, `brief_watch 규칙 자체가 실패했다: ${JSON.stringify(r.failed)}`);
});

// ── 오탐 0 ───────────────────────────────────────────────────

test('오탐: 기대 시각 이후 분석 기록이 있으면 경고하지 않는다', async () => {
  const refNow = Date.now();
  const start = refNow - 25 * 60_000;
  const end = refNow + 60 * 60_000;

  const a = freshAlerts(QUIET_OFF, () => {
    stubCalendar({ start, end }, null);
    quietOtherRules();
  });
  seedSteadyState();

  // 개장(start) 이후·지금(now) 이전에 분석이 실제로 끝나 저장됐다 — readLast() 가 이걸 본다
  const analystService = require('../server/analystService');
  analystService.saveLast({ at: new Date(start + 5 * 60_000).toISOString(), positions: [], created: [] });

  const r = await a.tick({ force: true, send: true });

  assert.equal(missingTexts().length, 0, '기록이 있는데도 경고했다');
  assert.ok(r.suppressedWhy.some((s) => /브리핑 확인됨/.test(s)), '확인됐다는 사실을 어디에도 안 남겼다');
});

test('오탐: 기대 시각이 아직 +10분(유예 20분 안) — 경고하지 않는다', async () => {
  const refNow = Date.now();
  const start = refNow - 10 * 60_000; // 유예 20분 안
  const end = refNow + 60 * 60_000;

  const a = freshAlerts(QUIET_OFF, () => {
    stubCalendar({ start, end }, null);
    quietOtherRules();
  });
  seedSteadyState();

  const r = await a.tick({ force: true, send: true });

  assert.equal(missingTexts().length, 0, '아직 유예 시간 안인데 경고했다');
  assert.equal(r.failed.includes('brief_watch'), false);
});

test('오탐: 휴장(캘린더가 정규장을 안 줌) — 기대 회차 자체가 없다', async () => {
  const refNow = Date.now();
  // 두 시장 다 정규장 없음(주말·공휴일과 같은 모양) — 있었다면 한참 지났을 시각이어도 회차가 없다
  const a = freshAlerts(QUIET_OFF, () => {
    stubCalendar(null, null);
    quietOtherRules();
  });
  seedSteadyState();
  void refNow;

  const r = await a.tick({ force: true, send: true });

  assert.equal(missingTexts().length, 0, '휴장인데 경고했다');
  assert.equal(r.failed.includes('brief_watch'), false);
});

test('오탐: 같은 회차 — 두 번째 틱에서 중복 경고하지 않는다', async () => {
  const refNow = Date.now();
  const start = refNow - 25 * 60_000;
  const end = refNow + 60 * 60_000;

  const a = freshAlerts(QUIET_OFF, () => {
    stubCalendar({ start, end }, null);
    quietOtherRules();
  });
  seedSteadyState();

  await a.tick({ force: true, send: true });
  assert.equal(missingTexts().length, 1, '첫 틱에서 경고가 안 갔다(전제 조건 실패)');

  sent = [];
  await a.tick({ force: true, send: true });
  assert.equal(missingTexts().length, 0, '같은 회차를 두 번째 틱에서 또 경고했다');
});

// ── 첫 실행(상태 없음) ────────────────────────────────────────

test('🔴 첫 실행(상태 없음)엔 과거 회차를 소급 경고하지 않는다 — 재기동 시 하루치가 쏟아지면 안 된다', async () => {
  const refNow = Date.now();
  // 개장·중간·마감 셋 다 이미 지났고(유예도 지남) 기록도 없다 — 소급 판정하면 3건이 한꺼번에 나가야 할 상황
  const start = refNow - 6 * 60 * 60_000;
  const end = refNow - 60 * 60_000;

  const a = freshAlerts(QUIET_OFF, () => {
    stubCalendar({ start, end }, null);
    quietOtherRules();
  });
  // ⚠️ seedSteadyState() 를 **호출하지 않는다** — 이게 이 테스트의 핵심(state 파일 자체가 없다)

  const r1 = await a.tick({ force: true, send: true });
  assert.equal(missingTexts().length, 0, '첫 틱에서 과거 회차를 소급 경고했다');

  sent = [];
  const r2 = await a.tick({ force: true, send: true });
  assert.equal(missingTexts().length, 0, '재기동 직후 두 번째 틱에서도 여전히 조용해야 한다');
  assert.equal(r1.failed.includes('brief_watch'), false);
  assert.equal(r2.failed.includes('brief_watch'), false);
});

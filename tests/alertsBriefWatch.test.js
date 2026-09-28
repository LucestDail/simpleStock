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
const realLogWarn = require('../server/logger').logWarn;
let sent = [];
let warnCalls = [];

/** `logger.logWarn` 을 가로챈다 — `freshAlerts` 보다 먼저 불러야 alertService 의 destructure 가 이걸 잡는다 */
function captureLogWarn() {
  warnCalls = [];
  require('../server/logger').logWarn = (event, ctx) => { warnCalls.push({ event, ctx }); };
}

/** KR 은 `today.integrated.regularMarket`, US 는 `today.regularMarket`(한 겹 얕다) — marketCalendar.js 규약 */
function fakeCalendarDay(market, regular, pre) {
  const body = {};
  if (regular) body.regularMarket = { startTime: new Date(regular.start).toISOString(), endTime: new Date(regular.end).toISOString() };
  // 🔴 프리장(preMarket) — 2026-09-28. 안 주면(undefined) 종전처럼 키 자체가 없다 → span() 이 null.
  if (pre) body.preMarket = { startTime: new Date(pre.start).toISOString(), endTime: new Date(pre.end).toISOString() };
  return market === 'KR' ? { date: 'test', integrated: body } : { date: 'test', ...body };
}

/**
 * @param {{start:number,end:number}|null} kr KR 오늘 정규장(epoch ms) 또는 null(휴장)
 * @param {{start:number,end:number}|null} us US 오늘 정규장(epoch ms) 또는 null(휴장)
 * @param {{start:number,end:number}|null} [krPre] KR 오늘 프리장(epoch ms) — 생략하면 없음(US 는 애초에 안 준다)
 */
function stubCalendar(kr, us, krPre) {
  require('../server/tossClient').getMarketCalendar = async (market) => ({
    today: fakeCalendarDay(market, market === 'KR' ? kr : us, market === 'KR' ? krPre : null),
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
  require('../server/logger').logWarn = realLogWarn;
  for (const f of [process.env.ALERTS_STATE_FILE, process.env.ACTIVITY_FILE, process.env.ANALYST_LAST_FILE]) {
    if (f && fs.existsSync(f)) fs.rmSync(f);
  }
  delete process.env.ALERTS_ENABLED;
});

const missingTexts = () => sent.map((x) => x.body.text || '').filter((t) => /브리핑이 예정 시각.*돌지 않았습니다/.test(t));
const calendarUnknownTexts = () => sent.map((x) => x.body.text || '').filter((t) => /거래일 확인 불가/.test(t));

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
  assert.equal(calendarUnknownTexts().length, 0, '정상 거래일인데 "거래일 확인 불가" 경고가 났다(회귀)');
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
  // 🔴 09-24·25 KR 침묵 조사 후속 — 이 시나리오(source:'calendar'+regular:null)는
  //    "캘린더를 읽었고 확인된 휴장" 이다. 여기서 계정불가 경고가 나오면 연휴 내내 매 틱 운다.
  assert.equal(calendarUnknownTexts().length, 0, '확인된 휴장인데 "거래일 확인 불가" 경고가 났다(오탐)');
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

// ── 🔴 프리장(preopen) 회차 (2026-09-28) ──────────────────────
//
// 09-28 아침 KR 프리장 브리핑이 실제로 안 떴는데(캘린더 캐시 UTC 키 — 이미 고쳐 배포됨)
// 이 감시는 프리장을 기대 회차로 세지 않아 원리상 아무 말도 못 했다. 침묵이 정상으로
// 읽혀 더 나빴다. 아래 첫 테스트가 **고치기 전에는 실패**했다(회차 자체가 없어서 조용
// — 발동/이유 확인 기록은 보고 참조).

test('🔴 발동: 프리장 시각 +25분, 기록 없음 → 프리장 개장 경고 1건', async () => {
  const refNow = Date.now();
  const preStart = refNow - 25 * 60_000; // 프리장 개장 25분 전 = 유예(20분) 지남
  const preEnd = refNow + 5 * 60_000;
  const regStart = refNow + 30 * 60_000; // 정규장은 아직(개장 회차가 안 걸려야 프리장만 격리된다)
  const regEnd = refNow + 6 * 60 * 60_000;

  const a = freshAlerts(QUIET_OFF, () => {
    stubCalendar({ start: regStart, end: regEnd }, null, { start: preStart, end: preEnd });
    quietOtherRules();
  });
  seedSteadyState();

  const r = await a.tick({ force: true, send: true });

  const texts = missingTexts();
  assert.equal(texts.length, 1, `프리장 경고가 1건이 아니다: ${JSON.stringify(sent.map((x) => x.body.text))}`);
  assert.match(texts[0], /KRX/);
  assert.match(texts[0], /프리장 개장/);
  assert.equal(r.failed.includes('brief_watch'), false);
});

test('오탐: 프리장 시각 이후에 분석 기록이 있으면 경고하지 않는다', async () => {
  const refNow = Date.now();
  const preStart = refNow - 25 * 60_000;
  const preEnd = refNow + 5 * 60_000;
  const regStart = refNow + 30 * 60_000;
  const regEnd = refNow + 6 * 60 * 60_000;

  const a = freshAlerts(QUIET_OFF, () => {
    stubCalendar({ start: regStart, end: regEnd }, null, { start: preStart, end: preEnd });
    quietOtherRules();
  });
  seedSteadyState();

  const analystService = require('../server/analystService');
  analystService.saveLast({ at: new Date(preStart + 5 * 60_000).toISOString(), positions: [], created: [] });

  const r = await a.tick({ force: true, send: true });

  assert.equal(missingTexts().length, 0, '프리장 기록이 있는데도 경고했다');
  assert.ok(r.suppressedWhy.some((s) => /프리장 개장 브리핑 확인됨/.test(s)));
});

test('오탐: preSpan 이 없으면(US·휴장일) 프리장 회차 자체를 안 만든다', async () => {
  const refNow = Date.now();
  /**
   * ⚠️ 마감 뒤(`now >= regular.end`) 창을 쓰면 `marketCalendar.sessionFromCalendar` 가
   *    상태를 `closed` 로 접으며 **`regular` 자체를 null 로 되돌린다**(정규장이 있었다는
   *    사실과 "오늘은 안 연다" 를 구분하려는 설계 — 08:00 프리장 창과는 무관). 그 창을
   *    썼다가 실제로는 회차 자체가 0건이 되어 이 테스트가 틀린 이유로 실패했었다(직접 확인함).
   *    ⇒ 기존 "발동" 테스트와 **같은 창**(state=open 유지)을 그대로 재사용한다.
   */
  const start = refNow - 25 * 60_000;
  const end = refNow + 60 * 60_000;

  const a = freshAlerts(QUIET_OFF, () => {
    stubCalendar({ start, end }, null); // krPre 생략 — preMarket 키 자체가 없다
    quietOtherRules();
  });
  seedSteadyState();

  const r = await a.tick({ force: true, send: true });

  const texts = missingTexts();
  assert.equal(texts.length, 1, '개장 회차 수가 달라졌다');
  assert.match(texts[0], /개장/);
  assert.ok(!texts.some((t) => /프리장/.test(t)), 'preSpan 이 없는데 프리장 경고가 나왔다');
  assert.equal(r.failed.includes('brief_watch'), false);
});

test('오탐: 같은 프리장 회차 — 두 번째 틱에서 중복 경고하지 않는다', async () => {
  const refNow = Date.now();
  const preStart = refNow - 25 * 60_000;
  const preEnd = refNow + 5 * 60_000;
  const regStart = refNow + 30 * 60_000;
  const regEnd = refNow + 6 * 60 * 60_000;

  const a = freshAlerts(QUIET_OFF, () => {
    stubCalendar({ start: regStart, end: regEnd }, null, { start: preStart, end: preEnd });
    quietOtherRules();
  });
  seedSteadyState();

  await a.tick({ force: true, send: true });
  assert.equal(missingTexts().length, 1, '첫 틱에서 프리장 경고가 안 갔다(전제 조건 실패)');

  sent = [];
  await a.tick({ force: true, send: true });
  assert.equal(missingTexts().length, 0, '같은 프리장 회차를 두 번째 틱에서 또 경고했다');
});

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

// ── 🔴 "확인된 휴장" vs "캘린더를 못 읽어서 모른다" (2026-09-28, 09-24·25 KR 침묵 조사 후속) ──
//
// `briefOccasions` 는 `s.regular` 유무만 보고 회차를 만드는데, source:'calendar'+regular:null
// (확인된 휴장)과 source:'fallback'+regular:null(캘린더 실패)은 증상이 똑같이 "조용함" 이라
// 구분이 안 됐다. 09-24·25 는 실제로 전자(추석)였지만, 후자가 나도 똑같이 조용했을 것이다.

/** `marketCalendar.resolveSessionLive` 자체를 대역으로 — toss 계층을 안 거치고 source 를 직접 준다 */
function stubResolveSessionLive(bySrcMarket) {
  const marketCalendar = require('../server/marketCalendar');
  marketCalendar.resolveSessionLive = async (now, market) => {
    const r = bySrcMarket[market] || { state: 'closed', source: 'calendar', regular: null };
    return { state: r.state, source: r.source, regular: r.regular ?? null };
  };
}

test('🔴 발동: 캘린더 실패(source:\'fallback\') → "거래일 확인 불가" 경고 1건', async () => {
  const a = freshAlerts(QUIET_OFF, () => {
    quietOtherRules();
    // KR 은 캘린더가 아예 실패(레이트리밋 등 — source:'fallback'), US 는 확인된 휴장(오탐 대조군)
    require('../server/tossClient').getMarketCalendar = async (market) => {
      if (market === 'KR') throw new Error('rate limited');
      return { today: fakeCalendarDay('US', null), previousBusinessDay: null, nextBusinessDay: null };
    };
  });
  seedSteadyState();

  const r = await a.tick({ force: true, send: true });

  const texts = calendarUnknownTexts();
  assert.equal(texts.length, 1, `경고가 1건이 아니다: ${JSON.stringify(sent.map((x) => x.body.text))}`);
  assert.match(texts[0], /KRX/, 'US(확인된 휴장, 오탐 대조군)에는 경고가 없어야 하는데 이게 KR 이 아니다');
  assert.equal(r.failed.includes('brief_watch'), false);
});

test('오탐: 모르는 source 값도 fail-loud 로 경고한다(열거로 막지 않는다 — 미래의 제3의 값 대비)', async () => {
  const a = freshAlerts(QUIET_OFF, () => {
    quietOtherRules();
    stubResolveSessionLive({
      KR: { state: 'closed', source: '__unexpected_source__', regular: null },
      US: { state: 'closed', source: 'calendar', regular: null },
    });
  });
  seedSteadyState();

  const r = await a.tick({ force: true, send: true });

  const texts = calendarUnknownTexts();
  assert.equal(texts.length, 1, `모르는 source 값인데 경고가 안 났다(열거식 방어의 구멍): ${JSON.stringify(sent.map((x) => x.body.text))}`);
  assert.match(texts[0], /KRX/);
  assert.equal(r.failed.includes('brief_watch'), false);
});

test('오탐: 같은 날 두 번째 틱 — "거래일 확인 불가" 재경고 없음', async () => {
  const a = freshAlerts(QUIET_OFF, () => {
    quietOtherRules();
    require('../server/tossClient').getMarketCalendar = async (market) => {
      if (market === 'KR') throw new Error('rate limited');
      return { today: fakeCalendarDay('US', null), previousBusinessDay: null, nextBusinessDay: null };
    };
  });
  seedSteadyState();

  await a.tick({ force: true, send: true });
  assert.equal(calendarUnknownTexts().length, 1, '첫 틱에서 경고가 안 갔다(전제 조건 실패)');

  sent = [];
  await a.tick({ force: true, send: true });
  assert.equal(calendarUnknownTexts().length, 0, '같은 날 두 번째 틱에서 또 경고했다');
});

/**
 * 🔴 합본 스위트를 돌려 보고서야 찾은 것 — `tests/alertsConditionalWatch.test.js` 는
 * 캘린더를 안 꾸며 두고 도는데(토스 자격증명 미설정 → `why:'unconfigured'`), 그 상태에서
 * 이 감시가 매 틱 "거래일 확인 불가" 를 울려 그 테스트의 무관한 단언(알림 0건)을 깼다.
 * `unconfigured` 는 "캘린더만 실패" 가 아니라 **이 배포 전체가 자격증명 없이 설정된 것**
 * (개발·테스트 환경이 전형)이라 별도로 제외한다.
 */
function stubUnconfiguredCalendar() {
  require('../server/tossClient').getMarketCalendar = async () => {
    const e = new Error('TOSS_CLIENT_ID/TOSS_CLIENT_SECRET 가 설정되지 않았습니다');
    e.kind = 'unconfigured';
    throw e;
  };
}
const skipLogs = () => warnCalls.filter((w) => w.event === 'alerts.calendar_unknown_skipped');

test('오탐: 토스 자격증명 자체가 없으면(why:\'unconfigured\') 폰 알림은 안 내되 — 로그는 남긴다', async () => {
  captureLogWarn();
  const a = freshAlerts(QUIET_OFF, () => {
    quietOtherRules();
    stubUnconfiguredCalendar();
  });
  seedSteadyState();

  const r = await a.tick({ force: true, send: true });

  assert.equal(calendarUnknownTexts().length, 0, '자격증명 미설정인데 "거래일 확인 불가" 폰 알림이 났다');
  assert.equal(r.failed.includes('brief_watch'), false);
  // 🔴 "면제가 새 침묵이 되면 안 된다" — kr·us 둘 다 unconfigured 라 둘 다 로그가 남아야 한다
  assert.equal(skipLogs().length, 2, `면제 로그가 2건이 아니다(시장별 1건씩): ${JSON.stringify(warnCalls)}`);
  assert.ok(skipLogs().some((w) => w.ctx.market === 'kr' && w.ctx.why === 'unconfigured'));
  assert.ok(skipLogs().some((w) => w.ctx.market === 'us' && w.ctx.why === 'unconfigured'));
});

test('오탐: 같은 날 두 번째 틱 — 자격증명 미설정 로그도 추가로 안 남는다', async () => {
  captureLogWarn();
  const a = freshAlerts(QUIET_OFF, () => {
    quietOtherRules();
    stubUnconfiguredCalendar();
  });
  seedSteadyState();

  await a.tick({ force: true, send: true });
  const first = skipLogs().length;
  assert.equal(first, 2, `첫 틱에서 로그가 안 남았다(전제 조건 실패): ${JSON.stringify(warnCalls)}`);

  await a.tick({ force: true, send: true });
  assert.equal(skipLogs().length, first, '같은 날 두 번째 틱에서 면제 로그가 더 남았다');
});

/**
 * 🔴 두 마크(`calendarUnknownMark`/`calendarUnconfiguredMark`)를 **키로 가른 이유**를
 * 실제로 지탱하는 테스트 (2026-09-28, pm1 지시 — "구분은 존재가 아니라 실제로 지탱하는가
 * 로 검사한다. 이유 없는 구분은 곧 구멍").
 *
 * 재는 시나리오: **같은 시장·같은 날, 사유가 바뀐다** — ①먼저 `why:'unconfigured'`(로그만,
 * 폰 알림 없음. 마크 A) → ②그 뒤(같은 날) 자격증명은 채워졌는데 캘린더 읽기 자체가 실패
 * (`source:'fallback'`, `why:'error'` — 마크 B). 두 마크가 **같은 문자열이면** ①이 찍은
 * 표시를 ②가 "오늘 이미 알렸다" 로 잘못 읽어 **폰 경고가 조용히 먹힌다.**
 *
 * ⚠️ **틱 사이 상태 유지를 이렇게 보장했다**: 새 대역(state 객체)을 안 만들고, **같은
 * `a`(같은 `ALERTS_STATE_FILE`)에 `tick()` 을 두 번** 부른다(기존 "같은 날 두 번째 틱"
 * 테스트들과 동일 패턴). ①이 끝난 직후 **상태 파일을 직접 읽어** 마크 A 가 실제로
 * 디스크에 남았는지 확인한 뒤에야 ②를 태운다 — 이 확인이 없으면 "①이 진짜 있었는지"
 * 를 가정에 맡기는 셈이라 이 테스트 자체가 무의미해질 수 있었다.
 */
test('🔴 발동: 같은 시장·같은 날 사유가 바뀐다(unconfigured → 진짜 fallback) — 먼저 찍힌 마크가 나중 경고를 먹지 않는다', async () => {
  captureLogWarn();
  const a = freshAlerts(QUIET_OFF, () => {
    quietOtherRules();
    stubUnconfiguredCalendar(); // ① 자격증명 자체가 없다
  });
  seedSteadyState();

  await a.tick({ force: true, send: true });
  assert.equal(calendarUnknownTexts().length, 0, '①(unconfigured)에서 폰 알림이 났다(전제 조건 실패)');
  assert.equal(skipLogs().length, 2, '①에서 면제 로그가 안 남았다(전제 조건 실패)');

  // 🔴 마크 A 가 실제로 디스크에 남았는지 직접 확인 — 새 대역이 아니라 같은 파일을 그대로 읽는다
  const persisted = JSON.parse(fs.readFileSync(process.env.ALERTS_STATE_FILE, 'utf8'));
  const markAKeys = Object.keys(persisted.briefWatch || {}).filter((k) => k.startsWith('kr:calendar_unconfigured_skip:'));
  assert.equal(markAKeys.length, 1, `①의 KR 마크가 상태 파일에 안 남았다 — 이 테스트의 전제가 깨졌다: ${JSON.stringify(persisted.briefWatch)}`);

  // ② 같은 날, 이번엔 자격증명은 있는데 캘린더 읽기 자체가 실패(예: 429) — source:'fallback', why:'error'
  sent = [];
  require('../server/tossClient').getMarketCalendar = async (market) => {
    if (market === 'KR') throw new Error('rate limited'); // .kind 없음 → why:'error'(unconfigured 아님)
    return { today: fakeCalendarDay('US', null), previousBusinessDay: null, nextBusinessDay: null }; // US 는 확인된 휴장(대조군, 오탐 없어야 함)
  };
  await a.tick({ force: true, send: true });

  const texts = calendarUnknownTexts();
  assert.equal(
    texts.length, 1,
    `②(진짜 fallback)에서 폰 경고가 안 나갔다 — ①의 unconfigured 마크에 먹혔을 수 있다: ${JSON.stringify(sent.map((x) => x.body.text))}`
  );
  assert.match(texts[0], /KRX/);
});

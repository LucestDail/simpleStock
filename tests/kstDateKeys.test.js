const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * 🔴 "날짜 키" 는 KST 기준이어야 한다 — UTC 로 접으면 KST 00:00~09:00 구간(우리가
 * 프리장 브리핑을 켠 그 시간대)에서 하루가 밀린다 (2026-09-28 라이브 실측 —
 * `lastPreopenDay: {"kr":"2026-09-27"}` 가 오늘 08:00 이벤트를 어제로 찍었다).
 *
 * `server/marketCalendar.js` 의 캘린더 하루치 캐시는 먼저 고쳤다(별도 커밋 `3a464b2`).
 * 이 파일은 전수 스캔으로 찾은 **나머지 3곳**을 잰다(pm1 지시 번호를 그대로 따른다):
 *   ① alertService.collectMomentumRows — 캔들 캐시 하루 키
 *   ② analystTrigger.decide            — 세션 dedup 키(+ 옛 UTC 형식 저장값 전환 안전성)
 *   ③ tossClient.pickLiveCommissions   — 수수료 유효기간 비교 기본 날짜
 *
 * ⚠️ `kstDay` 는 `server/time.js` 로 옮겨 **한 함수**로 공유한다(alertService.js·
 *    analystTrigger.js·tossClient.js 가 전부 거기서 import) — 세 곳에서 따로 만들면
 *    다음에 또 그중 하나만 빠질 수 있다.
 */

const KST = 'Asia/Seoul';
/** KST 기준 ISO 문자열 → epoch ms (KST = UTC+9, 서머타임 없음) */
const kstMs = (iso) => new Date(`${iso}+09:00`).getTime();

function freshRequire(names, before) {
  for (const k of Object.keys(require.cache)) {
    if (names.some((n) => k.includes(n))) delete require.cache[k];
  }
  if (before) before();
}

// ── ① alertService.collectMomentumRows — 캔들 캐시 하루 키 ──────────────

test('🔴 ① 캔들 캐시: KST 08:30 과 KST 10:00 은 같은 캐시 키 — 캔들을 한 번만 받는다', async () => {
  freshRequire(['alertService', 'tossClient']);
  const { collectMomentumRows } = require('../server/alertService');
  const toss = require('../server/tossClient');
  let calls = 0;
  toss.getCandles = async () => {
    calls += 1;
    return { rows: [{ t: '2026-09-10', c: 100 }, { t: '2026-09-11', c: 101 }, { t: '2026-09-12', c: 102 }] };
  };
  toss.getPrices = async () => new Map();

  const st = {};
  const universe = { TEST1: { role: 'watch' } };
  const t0830 = kstMs('2026-09-28T08:30:00'); // UTC 로는 09-27 23:30 — 전날
  const t1000 = kstMs('2026-09-28T10:00:00');

  await collectMomentumRows(st, universe, [], t0830);
  await collectMomentumRows(st, universe, [], t1000);

  assert.equal(calls, 1, 'KST 로 같은 날인데 캔들을 두 번 받았다(UTC 캐시 키 버그)');
});

test('① 캔들 캐시: KST 날짜가 바뀌면(23:59→00:01) 다시 받는다', async () => {
  freshRequire(['alertService', 'tossClient']);
  const { collectMomentumRows } = require('../server/alertService');
  const toss = require('../server/tossClient');
  let calls = 0;
  toss.getCandles = async () => {
    calls += 1;
    return { rows: [{ t: '2026-09-10', c: 100 }, { t: '2026-09-11', c: 101 }] };
  };
  toss.getPrices = async () => new Map();

  const st = {};
  const universe = { TEST2: { role: 'watch' } };
  const before = kstMs('2026-09-28T23:59:00');
  const after = kstMs('2026-09-29T00:01:00');

  await collectMomentumRows(st, universe, [], before);
  await collectMomentumRows(st, universe, [], after);

  assert.equal(calls, 2, 'KST 로 날짜가 바뀌었는데 캔들 캐시를 그대로 재사용했다');
});

// ── ② analystTrigger.decide — 세션 dedup 키(+ 옛 UTC 형식 전환 안전성) ────

test('🔴 ② 마감 dedup: KST 날짜로 찍힌다(정규장 마감이 KST 로 다음날 새벽인 미국장 포함)', () => {
  freshRequire(['analystTrigger']);
  const { decide } = require('../server/analystTrigger');
  // 미국장 마감 05:00 KST(다음날 새벽) — UTC 로는 **같은 날 20:00** 이라 KST/UTC 가 갈린다
  const regEnd = kstMs('2026-09-29T05:00:00');
  const closeAtUtc = new Date(regEnd).toISOString().slice(0, 10); // '2026-09-28'
  const sessions = [{ key: 'us', label: '미국장', state: 'closed', regular: { start: regEnd - 6.5 * 3600_000, end: regEnd } }];

  const r = decide({ now: regEnd + 1000, sessions, symbols: [], state: {} });

  assert.equal(r.reasons.some((x) => x.kind === 'close'), true, '마감 사유가 안 났다(전제 조건 실패)');
  const { kstDay } = require('../server/time');
  assert.equal(r.state.lastCloseDay.us, kstDay(regEnd), 'dedup 키가 KST 날짜가 아니다');
  assert.notEqual(r.state.lastCloseDay.us, closeAtUtc, 'dedup 키가 여전히 UTC 날짜다(KST 와 우연히 같으면 이 단언이 무의미 — 이 테스트는 KST≠UTC 인 시각을 골랐다)');
});

test('🔴 ② 전환 안전성: 프리장이 옛 UTC 형식(예: "2026-09-27")으로 이미 기록돼 있으면 오늘 창에서도 중복 발화하지 않는다', () => {
  freshRequire(['analystTrigger']);
  const { decide } = require('../server/analystTrigger');
  // 실측 그대로: 오늘(KST 09-28) 08:30 프리장 창, regular 09:00 시작 — 아직 정규장 전
  const preStart = kstMs('2026-09-28T08:00:00');
  const regStart = kstMs('2026-09-28T09:00:00');
  const now = kstMs('2026-09-28T08:30:00');
  const sessions = [{ key: 'kr', label: 'KRX', state: 'pre', preSpan: { start: preStart, end: regStart }, regular: { start: regStart, end: kstMs('2026-09-28T15:30:00') } }];
  // 라이브에서 실제로 관측된 옛(UTC) 형식 저장값 — 오늘 이 이벤트를 이미 보낸 뒤 남은 흔적이다
  const legacyStoredValue = new Date(preStart).toISOString().slice(0, 10); // '2026-09-27'

  const r = decide({ now, sessions, symbols: [], state: { lastPreopenDay: { kr: legacyStoredValue } } });

  assert.equal(r.reasons.some((x) => x.kind === 'preopen'), false, '옛 형식 저장값을 못 알아봐 같은 회차를 또 발화했다(중복 알림)');
});

test('② 전환 안전성 대조군: 완전히 새 상태(저장값 없음)면 오늘 프리장이 정상 발화한다', () => {
  freshRequire(['analystTrigger']);
  const { decide } = require('../server/analystTrigger');
  const preStart = kstMs('2026-09-28T08:00:00');
  const regStart = kstMs('2026-09-28T09:00:00');
  const now = kstMs('2026-09-28T08:30:00');
  const sessions = [{ key: 'kr', label: 'KRX', state: 'pre', preSpan: { start: preStart, end: regStart }, regular: { start: regStart, end: kstMs('2026-09-28T15:30:00') } }];

  const r = decide({ now, sessions, symbols: [], state: {} });

  assert.equal(r.reasons.some((x) => x.kind === 'preopen'), true, '저장값이 아예 없는데도 프리장이 안 났다(대조군 자체가 깨졌다)');
});

// ── ③ tossClient.pickLiveCommissions — 수수료 유효기간 비교 기본 날짜 ──────

/**
 * `pickLiveCommissions(rows, today, nowMs)` 의 `today` **기본값**(무인자 호출)이 실제로
 * KST 를 쓰는지는 `Date.now()`/`new Date()` 를 제어해야만 결정적으로 잴 수 있다(이 프로젝트에
 * 는 시각 모킹 라이브러리가 없고 Node 18 의 `node:test` 도 `mock.timers` 로 `Date` 를 못
 * 흉내낸다). ⇒ `global.Date` 를 **이 테스트 블록 안에서만** 실제 `Date` 를 상속한 대역으로
 * 잠깐 바꿔치기한다(`Date.parse`/`Date.UTC` 등 정적 메서드는 `extends` 로 자동 위임되고
 * `now()` 만 고정값을 준다) — `try/finally` 로 반드시 원복한다.
 */
function freezeGlobalDate(ms) {
  const RealDate = global.Date;
  class FrozenDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [ms])); }
    static now() { return ms; }
  }
  global.Date = FrozenDate;
  return () => { global.Date = RealDate; };
}

test('🔴 ③ 수수료: KST 08:00(=UTC 로는 전날)에도 today 기본값이 오늘 시작 행을 고른다', () => {
  const { pickLiveCommissions } = require('../server/tossClient');
  const t0800 = kstMs('2026-09-28T08:00:00'); // UTC 로는 2026-09-27T23:00:00Z — 전날
  const unfreeze = freezeGlobalDate(t0800);
  try {
    const rows = [{ marketCountry: 'KR', commissionRate: 0.00015, startDate: '2026-09-28', endDate: null }];
    const picked = pickLiveCommissions(rows); // today·nowMs 를 안 넘긴다 — 실제 기본값 배선을 잰다
    assert.equal(picked.length, 1, 'KST 08:00 인데 오늘(2026-09-28) 시작 행이 빠졌다(today 기본값이 아직 UTC 다)');
  } finally {
    unfreeze();
  }
});

// ── ④ alertService.collectMomentumRows — liveDay 폴백(우리 시계 추측) 제거 ──

/**
 * 2026-09-28 pm1 지적: `liveDay` 가 `live?.at` 이 없을 때 **우리 시계(UTC)로 날짜를
 * 추측**해 마지막 봉이 진행 중인지 가렸다. `bars[].t` 는 거래소가 준 날짜(US 종목이면
 * 미국 거래일)라 우리 시간대 추측은 KST 로 바꿔도 여전히 틀릴 수 있다 — 그래서 "더 나은
 * 추측"이 아니라 **추측 자체를 없앤다**: `live.at` 이 없으면 `logWarn` 을 남기고, "hist 는
 * 확정 봉만" 이라는 불변식을 지키려고 **마지막 봉을 보수적으로 버린다**(안 버리면 아직
 * 움직이는 값이 확정 종가로 굳어 등락률이 거짓이 될 수 있다 — 그게 더 나쁘다는 판단).
 * ⚠️ **보유 종목은 `live` 를 구조적으로 항상 못 받는다**(`held?.dailyRate != null` 분기에서
 * `live` 가 무조건 `null`) — 드문 예외가 아니라 **보유 종목 전부가 매 틱 이 경로를 탄다**.
 */
function captureLogWarn() {
  const logger = require('../server/logger');
  const calls = [];
  logger.logWarn = (event, ctx) => { calls.push({ event, ctx }); };
  return calls;
}

test('🔴 ④ live.at 있음 · 마지막 봉이 진행 중(날짜 일치) — 종전처럼 버린다(회귀 없음)', async () => {
  freshRequire(['alertService', 'tossClient', 'logger']);
  const warnCalls = captureLogWarn();
  const { collectMomentumRows } = require('../server/alertService');
  const toss = require('../server/tossClient');
  toss.getCandles = async () => ({
    rows: [{ t: '2026-09-25', c: 100 }, { t: '2026-09-26', c: 101 }, { t: '2026-09-28', c: 102 }],
  });
  toss.getPrices = async () => new Map([['TEST4A', { price: 103, at: '2026-09-28T09:05:00.000Z' }]]);

  const rows = await collectMomentumRows({}, { TEST4A: { role: 'watch' } }, [], kstMs('2026-09-28T18:00:00'));

  assert.equal(rows[0].history.length, 1, '진행 중 봉을 못 걸렀다(회귀) — 확정 봉 2개의 변화 1개여야 한다');
  assert.equal(warnCalls.length, 0, 'live.at 이 있는데도 경고를 남겼다');
});

test('④ live.at 있음 · 마지막 봉이 이미 확정(날짜 불일치) — 버리지 않는다(회귀 없음)', async () => {
  freshRequire(['alertService', 'tossClient', 'logger']);
  const warnCalls = captureLogWarn();
  const { collectMomentumRows } = require('../server/alertService');
  const toss = require('../server/tossClient');
  toss.getCandles = async () => ({
    rows: [{ t: '2026-09-25', c: 100 }, { t: '2026-09-26', c: 101 }, { t: '2026-09-27', c: 102 }],
  });
  toss.getPrices = async () => new Map([['TEST4B', { price: 103, at: '2026-09-28T09:05:00.000Z' }]]);

  const rows = await collectMomentumRows({}, { TEST4B: { role: 'watch' } }, [], kstMs('2026-09-28T18:00:00'));

  assert.equal(rows[0].history.length, 2, '이미 확정된 봉을 불필요하게 버렸다(회귀) — 확정 봉 3개의 변화 2개여야 한다');
  assert.equal(warnCalls.length, 0);
});

test('🔴 ④ live.at 없음 — 우리 시계로 추측하지 않고 warn 을 남기고 마지막 봉을 보수적으로 버린다', async () => {
  freshRequire(['alertService', 'tossClient', 'logger']);
  const warnCalls = captureLogWarn();
  const { collectMomentumRows } = require('../server/alertService');
  const toss = require('../server/tossClient');
  toss.getCandles = async () => ({
    rows: [{ t: '2026-09-25', c: 100 }, { t: '2026-09-26', c: 101 }, { t: '2026-09-27', c: 102 }],
  });
  toss.getPrices = async () => new Map(); // 이 심볼은 응답에 없다 — live 는 undefined

  const rows = await collectMomentumRows({}, { TEST4C: { role: 'watch' } }, [], kstMs('2026-09-28T18:00:00'));

  assert.equal(rows[0].history.length, 1, '판정 불가인데도 마지막 봉을 확정 봉으로 단정했다');
  assert.equal(warnCalls.length, 1, 'live.at 이 없는데 경고가 안 남았다');
  assert.equal(warnCalls[0].event, 'analyst.trigger_live_at_missing');
  assert.equal(warnCalls[0].ctx.symbol, 'TEST4C');
});

/**
 * 🔴 2026-09-28 pm1 반영: 보유 종목은 **매 틱(5분) 마다** 이 경로를 타므로(위 주석 참조,
 * 보유 2종이면 하루 576건) `live.at` 없음 warn 을 보유에도 내면 **오탐이 정말 이상한
 * 경우(감시 심볼인데 시세가 안 온 것)를 묻어 버린다.** ⇒ `if (!held) logWarn(...)` 로
 * 좁혔다 — **경고는 감시 종목에만, 트림은 보유·감시 둘 다.**
 *
 * ⚠️ 이 단언을 **각자 따로** 재면(보유 warn=0 하나, 감시 warn=1 하나) "둘 다 warn 이거나
 * 둘 다 안 나도" 각 단언이 우연히 통과할 수 있는 자였다(예: 트림 로직 자체가 통째로 죽어도
 * 보유 쪽 "warn=0" 은 여전히 참). ⇒ **보유·감시를 같은 호출에 함께 넣어** 경고 건수를
 * "정확히 1건, 그것도 감시 심볼에" 로 못박는다 — 두 축이 실제로 갈리는지가 핵심이다.
 */
test('🔴 ④ live.at 없음이 보유/감시를 가른다 — 트림은 둘 다, warn 은 감시에만(같은 호출에서 구분)', async () => {
  freshRequire(['alertService', 'tossClient', 'logger']);
  const warnCalls = captureLogWarn();
  const { collectMomentumRows } = require('../server/alertService');
  const toss = require('../server/tossClient');
  toss.getCandles = async () => ({
    rows: [{ t: '2026-09-25', c: 100 }, { t: '2026-09-26', c: 101 }, { t: '2026-09-27', c: 102 }],
  });
  let gotPricesFor = null;
  // 보유(TEST4D)는 `held?.dailyRate != null` 분기에서 live 를 아예 안 받고, 감시(TEST4E)는
  // getPrices 응답에 없다 — 둘 다 "live.at 없음" 이라는 같은 조건인데 결과가 갈려야 한다.
  toss.getPrices = async (symbols) => { gotPricesFor = symbols; return new Map(); };

  const items = [{ symbol: 'TEST4D', dailyRate: 1.23 }];
  const universe = { TEST4D: { role: 'held' }, TEST4E: { role: 'watch' } };
  const rows = await collectMomentumRows({}, universe, items, kstMs('2026-09-28T18:00:00'));

  assert.deepEqual(gotPricesFor, ['TEST4E'], '보유 종목까지 시세 조회 대상에 들어갔다(불필요한 호출)');

  const heldRow = rows.find((r) => r.symbol === 'TEST4D');
  const watchRow = rows.find((r) => r.symbol === 'TEST4E');
  // ① 트림은 보유·감시 **둘 다** 일어난다 — 확정 봉 3개에서 1개를 버려 변화 1개
  assert.equal(heldRow.history.length, 1, '보유 종목의 마지막 봉이 트림되지 않았다');
  assert.equal(watchRow.history.length, 1, '감시 종목의 마지막 봉이 트림되지 않았다');
  // ② 보유 등락률은 dailyRate 를 그대로 쓴다(회귀)
  assert.equal(heldRow.dailyChangePct, 1.23, '보유 등락률은 dailyRate 를 그대로 써야 한다(회귀)');
  // ③ 🔴 경고는 정확히 1건 — 감시 심볼에만. 보유에도 났거나(오탐 재발) 둘 다 안 났으면
  //    (트림 확인 자체가 빠졌다면) 여기서 걸린다
  assert.equal(warnCalls.length, 1, `경고 건수가 1이 아니다(보유/감시 구분 실패): ${JSON.stringify(warnCalls)}`);
  assert.equal(warnCalls[0].ctx.symbol, 'TEST4E', '엉뚱한 심볼에 경고가 났다');
  assert.equal(warnCalls[0].ctx.role, 'watch', '경고에 감시가 아닌 역할이 찍혔다');
});

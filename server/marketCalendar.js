/**
 * 장 운영 달력 (2026-09-21 신설)
 *
 * ## 무엇이 틀려 있었나 (실측)
 *
 * `getMarketSessionSnapshot` 은 **시각(hour)만** 봤다. 요일도 휴장일도 안 본다.
 * ⇒ **토요일 오전 10시가 `open`** 으로 표시된다. 공휴일도 마찬가지다.
 *
 * ## 왜 요일을 시장 현지 기준으로 봐야 하나 — 여기서 틀리기 쉽다
 *
 * 미국장 창은 앱 기준시(KST)로 22시~익일 5시다. 그래서 **KST 토요일 새벽 3시**는
 * 뉴욕에서는 **금요일 오후 2시** — **정상 개장 중**이다.
 * KST 요일로 주말을 자르면 **금요일 미국장을 통째로 닫아 버린다.**
 * ⇒ 요일은 **그 시장의 현지 시간대**로 구한다.
 *
 * ## 휴장일
 *
 * ~~지금은 주말만 판정한다. … 자격증명이 필요해 아직 붙이지 못했다.~~
 * ✅ **2026-09-22: 토스 캘린더를 붙였다.** 자격증명은 09-21 부터 있었는데
 *    **이 주석이 낡으면서 아무도 안 붙였다** — 문서가 거짓이 되면 그 자리가 영영 남는다.
 *
 * ## 🔴 하드코딩이 **실제와 어긋나 있었다** (라이브 실측)
 * ```
 *        하드코딩            실제(토스 캘린더)
 * KRX    09~16시            09:00 ~ **15:30**      ⇒ 마감을 30분 늦게 잡았다
 * 미국장  22~06시            22:30 ~ **05:00**      ⇒ 개장 30분 이르고 마감 1시간 늦었다
 * ```
 * ⚠️ 어젯밤 만든 **장마감 분석 트리거가 이 추정 위에 서 있었다.**
 *
 * ## ⚠️ 두 시장의 **응답 모양이 다르다** — 한쪽만 보고 짜면 조용히 깨진다
 * ```
 * US  today.{dayMarket, preMarket, regularMarket, afterMarket}
 * KR  today.integrated.{preMarket, regularMarket, afterMarket}   ← 한 겹 더 깊고 dayMarket 이 없다
 * ```
 * ⚠️ 휴장일은 세션이 **`null`** 이다(키가 없는 게 아니다).
 * ⚠️ `MARKET_INFO` 한도가 **3/s** 로 좁다 ⇒ **하루 한 번만** 받아 캐시한다.
 */

/**
 * 캘린더 응답에서 **정규장 구간**을 꺼낸다. 순수 함수 — 네트워크 없이 검증한다.
 *
 * @returns {{date:string, regular:{start:number,end:number}|null, pre:object|null, after:object|null}|null}
 * ⚠️ 휴장이면 `regular: null` 이다 — **"모른다" 가 아니라 "그날은 안 연다"** 로 구분해야 한다.
 */
function normalizeCalendarDay(day) {
  if (!day || typeof day !== 'object') return null;
  // 🔴 KR 은 `integrated` 안에, US 는 최상위에 세션이 있다
  const src = day.integrated && typeof day.integrated === 'object' ? day.integrated : day;
  const span = (x) => {
    if (!x || !x.startTime || !x.endTime) return null;
    const start = Date.parse(x.startTime);
    const end = Date.parse(x.endTime);
    return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
  };
  return {
    date: day.date || null,
    regular: span(src.regularMarket),
    pre: span(src.preMarket),
    after: span(src.afterMarket),
  };
}

/**
 * 지금이 어떤 세션인가 — **정규장 기준**으로 `open`/`pre`/`closed` 를 낸다.
 *
 * ⚠️ 프리·애프터는 `open` 으로 치지 **않는다**. 장마감 트리거가 애프터마켓까지 열린 것으로 보면
 *    마감 요약이 3시간 늦게 나간다.
 *
 * 🔴 **`pre` 를 캘린더에서 유도한다** (2026-09-22). 종전에는 시계 폴백에만 있던 어휘라,
 *    이쪽으로 정본을 합치면 *"장 전"* 알림이 **조용히 사라질** 뻔했다.
 *    ★ 사라진 알림은 아무도 못 본다 — 그래서 없애지 않고 **더 정확하게** 만든다.
 *    정의 = *"오늘 정규장이 있는데 아직 시작 전"*. 마감 뒤에는 `pre` 가 아니라 `closed` 다.
 *    ⚠️ 시계 폴백은 이걸 표현 못 했다 — 자정을 넘는 창(미국장)에서 마감 직후를
 *      `hour < 시작시각` 으로 판정해 **"장 전"** 이라 답했다(실측: 마감 21분 뒤 화면이 `pre`).
 */
function sessionFromCalendar(nowMs, days) {
  const today = normalizeCalendarDay(days?.today);
  const list = [days?.previousBusinessDay, days?.today, days?.nextBusinessDay]
    .map(normalizeCalendarDay).filter(Boolean);
  if (!list.length) return null;
  for (const d of list) {
    if (d.regular && nowMs >= d.regular.start && nowMs < d.regular.end) {
      return { state: 'open', source: 'calendar', regular: d.regular, date: d.date };
    }
  }
  /**
   * 오늘 정규장이 **아직 시작 전**이면 `pre`. 휴장일(regular=null)은 해당 없음 —
   * **"안 여는 날" 을 "곧 연다" 로 말하지 않는다.**
   */
  if (today?.regular && nowMs < today.regular.start) {
    return { state: 'pre', source: 'calendar', regular: today.regular, date: today.date };
  }
  /**
   * 어느 구간에도 안 들면 **닫혀 있다.** 다만 *"캘린더를 못 읽어서 모른다"* 와는 다르다 —
   * 여기 왔다는 건 캘린더를 읽었고 그중 어디에도 안 든다는 뜻이다.
   */
  return { state: 'closed', source: 'calendar', regular: null, date: list.find((d) => d.date)?.date || null };
}

/**
 * 캘린더 하루치 캐시. ⚠️ `MARKET_INFO` 한도가 **3/s** 라 매 틱 부르면 안 된다.
 * ⚠️ 실패를 **캐시하지 않는다** — 한 번 실패했다고 하루 종일 폴백에 머물면 안 된다.
 */
const calCache = new Map(); // market → { day, days, at }

async function loadCalendar(market, { toss = require('./tossClient'), now = Date.now() } = {}) {
  const m = String(market || '').toUpperCase();
  const today = new Date(now).toISOString().slice(0, 10);
  const hit = calCache.get(m);
  if (hit && hit.day === today) return hit.days;
  const days = await toss.getMarketCalendar(m);
  calCache.set(m, { day: today, days, at: now });
  return days;
}

/**
 * 실제 캘린더로 세션을 판정한다. **못 읽으면 폴백**하되 **어느 쪽을 썼는지 밝힌다.**
 *
 * 🔴 조용히 폴백하면 *"캘린더를 붙였다"* 고 믿는 채로 옛 추정이 계속 돈다 —
 *    오늘 내내 본 *"검사하지 않은 것과 통과한 것을 구분 못 하는 자"* 다.
 */
async function resolveSessionLive(now, market, fallbackStart, fallbackEnd, appTimeZone, deps = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  try {
    const days = await loadCalendar(market, { ...deps, now: nowMs });
    const r = sessionFromCalendar(nowMs, days);
    if (r) return r;
    // 캘린더는 읽었는데 모양이 예상과 다르다 — 그것도 밝힌다
    return { ...resolveSession(new Date(nowMs), market, fallbackStart, fallbackEnd, appTimeZone), source: 'fallback', why: 'shape' };
  } catch (e) {
    return {
      ...resolveSession(new Date(nowMs), market, fallbackStart, fallbackEnd, appTimeZone),
      source: 'fallback',
      why: e?.kind || 'error',
      error: e?.message,
    };
  }
}

const MARKET_TZ = {
  KR: 'Asia/Seoul',
  US: 'America/New_York',
};

/** 해당 시간대에서의 요일(0=일 … 6=토) */
function weekdayIn(now, timeZone) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(now);
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
  // ⚠️ 못 읽으면 "평일" 로 떨어뜨린다 — 모르는 상태에서 **장을 닫아 버리는 쪽**이 더 나쁘다
  //    (없는 휴장을 만들면 사용자는 시세가 멈춘 줄 안다). 대신 아래에서 unknown 을 표시한다.
  return idx;
}

/** 해당 시간대에서의 시(0~23) */
function hourIn(now, timeZone) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hour12: false })
    .formatToParts(now)
    .find((p) => p.type === 'hour');
  return Number(part?.value || 0);
}

function isWeekend(now, market) {
  const tz = MARKET_TZ[market];
  if (!tz) return { weekend: false, known: false };
  const d = weekdayIn(now, tz);
  if (d < 0) return { weekend: false, known: false };
  return { weekend: d === 0 || d === 6, known: true };
}

/**
 * 시각만으로 본 상태. 창이 자정을 넘으면(미국장 KST 22~5) 감싸는 계산을 한다.
 * ⚠️ 이 함수는 **원래 로직 그대로**다 — 요일 판정을 덧씌우기만 하고 기존 동작을 바꾸지 않는다.
 */
function sessionStateByHour(hour, windowStartHour, windowEndHour) {
  if (windowStartHour < windowEndHour) {
    if (hour < windowStartHour) return 'pre';
    if (hour >= windowEndHour) return 'closed';
    return 'open';
  }
  if (hour >= windowStartHour || hour < windowEndHour) return 'open';
  return hour < windowStartHour ? 'pre' : 'closed';
}

/**
 * @param {'KR'|'US'} market
 * @returns {{state:'open'|'pre'|'closed', reason:string, holidayAware:boolean}}
 */
function resolveSession(now, market, windowStartHour, windowEndHour, appTimeZone) {
  const byHour = sessionStateByHour(hourIn(now, appTimeZone), windowStartHour, windowEndHour);
  const { weekend, known } = isWeekend(now, market);

  if (weekend) {
    return { state: 'closed', reason: 'weekend', holidayAware: false };
  }
  return {
    state: byHour,
    // ⚠️ 요일을 못 읽었으면 그 사실을 그대로 내보낸다. 조용히 평일로 치지 않는다.
    reason: known ? 'schedule' : 'weekday-unknown',
    holidayAware: false,
  };
}

module.exports = {
  MARKET_TZ,
  weekdayIn,
  hourIn,
  isWeekend,
  sessionStateByHour,
  resolveSession,
  normalizeCalendarDay,
  sessionFromCalendar,
  resolveSessionLive,
  loadCalendar,
};

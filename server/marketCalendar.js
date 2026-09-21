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
 * 지금은 **주말만** 판정한다. 공휴일 목록은 신뢰할 소스가 있어야 하고
 * (토스 `/api/v1/market-calendar/KR|US`), 그건 자격증명이 필요해 아직 붙이지 못했다.
 * 🔴 그래서 이 모듈은 **"공휴일은 아직 모른다"** 를 `holidayAware:false` 로 **밝힌다** —
 *    모르는 것을 아는 척하면 화면이 조용히 틀린다(검사 못 함 ≠ 통과).
 */

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
};

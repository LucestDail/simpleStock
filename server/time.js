const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Seoul';

function getDateInTimezone(date = new Date(), timeZone = APP_TIMEZONE) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function getDateTimeInTimezone(date = new Date(), timeZone = APP_TIMEZONE) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone,
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(date);
}

/**
 * 🔴 "하루 단위 캐시·중복방지 키" 는 **여기 한 곳**에서만 만든다 (2026-09-28, `alertService.js`
 * 에 있던 걸 옮겼다 — pm1 지시: "판정은 한 함수여야 다음 곳에서 안 갈린다").
 *
 * `new Date().toISOString().slice(0,10)`(UTC 날짜)로 캐시·dedup 키를 접으면 KST
 * 00:00~09:00 구간(우리가 프리장 브리핑을 켠 그 시간대)에서 **UTC 로는 아직 전날**이라
 * 하루가 밀린다(2026-09-28 라이브 실측: `lastPreopenDay:{"kr":"2026-09-27"}`).
 * ⇒ 날짜만 필요한 캐시 키는 전부 `kstDay(now)` 를 쓴다.
 *
 * ⚠️ 같은 일을 하는 `getDateInTimezone` 이 위에 이미 있었다 — 이름이 둘이면 한쪽만 고쳐져
 * 갈라진다. 그래서 여기서 **그것을 부른다**(구현 복제 금지). 20,000 표본으로 sv-SE↔en-CA
 * 결과가 완전히 같은 것을 확인하고 합쳤다.
 */
function kstDay(now = new Date()) {
  return getDateInTimezone(now instanceof Date ? now : new Date(now), APP_TIMEZONE);
}

module.exports = {
  APP_TIMEZONE,
  getDateInTimezone,
  getDateTimeInTimezone,
  kstDay,
};

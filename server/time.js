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

module.exports = {
  APP_TIMEZONE,
  getDateInTimezone,
  getDateTimeInTimezone,
};

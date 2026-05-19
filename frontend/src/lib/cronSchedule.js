function getTimeParts(date, timezone = 'Asia/Seoul') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    minute: Number(map.minute),
    hour: Number(map.hour),
    dayOfMonth: Number(map.day),
    month: Number(map.month),
    dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(map.weekday),
  };
}

function matchCronField(field, value, min, max) {
  if (!field || field === '*') return true;
  return field.split(',').some((token) => {
    const [rangePart, stepPart] = token.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isFinite(step) || step <= 0) return false;

    let start = min;
    let end = max;
    if (rangePart && rangePart !== '*') {
      if (rangePart.includes('-')) {
        const [rawStart, rawEnd] = rangePart.split('-').map(Number);
        start = rawStart;
        end = rawEnd;
      } else {
        start = Number(rangePart);
        end = Number(rangePart);
      }
    }
    if (![start, end].every(Number.isFinite)) return false;
    if (value < start || value > end) return false;
    return (value - start) % step === 0;
  });
}

export function matchesCronExpression(expression, date, timezone = 'Asia/Seoul') {
  const parts = String(expression || '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minuteField, hourField, domField, monthField, dowField] = parts;
  const zoned = getTimeParts(date, timezone);
  const minuteMatch = matchCronField(minuteField, zoned.minute, 0, 59);
  const hourMatch = matchCronField(hourField, zoned.hour, 0, 23);
  const monthMatch = matchCronField(monthField, zoned.month, 1, 12);
  const domMatch = matchCronField(domField, zoned.dayOfMonth, 1, 31);
  const normalizedDow = zoned.dayOfWeek === 0 ? 0 : zoned.dayOfWeek;
  const dowMatch =
    matchCronField(dowField, normalizedDow, 0, 7) ||
    (normalizedDow === 0 && matchCronField(dowField, 7, 0, 7));
  const domWildcard = domField === '*';
  const dowWildcard = dowField === '*';
  const dayMatch = domWildcard && dowWildcard ? true : domWildcard ? dowMatch : dowWildcard ? domMatch : domMatch || dowMatch;
  return minuteMatch && hourMatch && monthMatch && dayMatch;
}

export function getNextRunDate(expression, timezone = 'Asia/Seoul') {
  const now = new Date();
  const cursor = new Date(now);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 370; i += 1) {
    if (matchesCronExpression(expression, cursor, timezone)) {
      return new Date(cursor);
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

export function formatRunLabel(date, timezone = 'Asia/Seoul') {
  if (!date) return '일정 계산 중';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: timezone,
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

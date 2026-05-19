const US_TIMEZONE = 'America/New_York';

export function formatMarketClock(date = new Date()) {
  const kstFormatter = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const usFormatter = new Intl.DateTimeFormat('ko-KR', {
    timeZone: US_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const kstParts = Object.fromEntries(kstFormatter.formatToParts(date).map((p) => [p.type, p.value]));
  const usParts = Object.fromEntries(usFormatter.formatToParts(date).map((p) => [p.type, p.value]));

  return {
    kst: {
      date: `${kstParts.year}년 ${kstParts.month}월 ${kstParts.day}일 (${kstParts.weekday})`,
      time: `${kstParts.hour}:${kstParts.minute}:${kstParts.second}`,
    },
    us: {
      date: `${usParts.month}/${usParts.day}/${usParts.year} (${usParts.weekday})`,
      time: `${usParts.hour}:${usParts.minute}:${usParts.second}`,
      zoneLabel: '미국 동부',
    },
  };
}

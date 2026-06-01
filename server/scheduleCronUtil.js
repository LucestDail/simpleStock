const cron = require('node-cron');

const DOW_ALIASES = {
  일: 0,
  월: 1,
  화: 2,
  수: 3,
  목: 4,
  금: 5,
  토: 6,
  일요일: 0,
  월요일: 1,
  화요일: 2,
  수요일: 3,
  목요일: 4,
  금요일: 5,
  토요일: 6,
};

function isValidCronExpression(expression) {
  const value = String(expression || '').trim();
  return Boolean(value && cron.validate(value));
}

function parseHourMinute(text) {
  const raw = String(text || '');
  let hour = null;
  let minute = 0;

  const colon = raw.match(/(?:^|[^\d])(\d{1,2})\s*:\s*(\d{2})(?:[^\d]|$)/);
  if (colon) {
    hour = Number(colon[1]);
    minute = Number(colon[2]);
  }

  const korean = raw.match(/(오전|오후|am|pm)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/i);
  if (korean) {
    let parsedHour = Number(korean[2]);
    const parsedMinute = korean[3] ? Number(korean[3]) : minute;
    const meridiem = String(korean[1] || '').toLowerCase();
    if (meridiem.includes('오후') || meridiem === 'pm') {
      if (parsedHour < 12) parsedHour += 12;
    } else if (meridiem.includes('오전') || meridiem === 'am') {
      if (parsedHour === 12) parsedHour = 0;
    }
    hour = parsedHour;
    minute = parsedMinute;
  }

  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function inferDayOfWeekField(text) {
  const raw = String(text || '');
  if (/평일|주중|월[\s~\-–—]금|월~금|weekday/i.test(raw)) return '1-5';
  if (/주말|weekend/i.test(raw)) return '0,6';
  if (/매일|매일마다|every\s*day/i.test(raw)) return '*';

  for (const [label, value] of Object.entries(DOW_ALIASES)) {
    if (raw.includes(label)) return String(value);
  }
  return '*';
}

function inferCronFromScheduleText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const explicit = raw.match(/\b(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\b/);
  if (explicit && isValidCronExpression(explicit[1])) {
    return explicit[1];
  }

  const time = parseHourMinute(raw);
  if (!time) return null;

  const dayOfWeek = inferDayOfWeekField(raw);
  const expression = `${time.minute} ${time.hour} * * ${dayOfWeek}`;
  return isValidCronExpression(expression) ? expression : null;
}

function collectScheduleText(action, userMessage) {
  const payload = action?.scheduleTask || {};
  return [
    userMessage,
    payload.title,
    payload.description,
    payload.nextRunLabel,
    payload.prompt,
  ]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n');
}

function inferTaskTypeFromText(text) {
  const raw = String(text || '');
  if (/지표|indicator/i.test(raw)) return 'indicatorCheck';
  if (/시황|market\s*review/i.test(raw)) return 'marketReview';
  if (/브리핑|brief|매니저/i.test(raw)) return 'managerBrief';
  return null;
}

function backfillScheduleTaskCrons(actions, userMessage, threadId, logInfo = () => {}) {
  if (!Array.isArray(actions) || actions.length === 0) return actions;

  let patched = 0;
  const next = actions.map((action) => {
    if (action?.type !== 'scheduleTask') return action;
    const payload = { ...(action.scheduleTask || {}) };
    const sourceText = collectScheduleText(action, userMessage);

    if (!isValidCronExpression(payload.cronExpression)) {
      const inferred = inferCronFromScheduleText(sourceText);
      if (inferred) {
        payload.cronExpression = inferred;
        patched += 1;
      }
    }

    if (!payload.taskType || payload.taskType === 'custom') {
      const inferredType = inferTaskTypeFromText(sourceText);
      if (inferredType) {
        payload.taskType = inferredType;
      }
    }

    if (!payload.timezone) {
      payload.timezone = 'Asia/Seoul';
    }

    return { ...action, scheduleTask: payload };
  });

  if (patched > 0) {
    logInfo('chat.actions.schedule_cron_backfilled', {
      threadId,
      patched,
    });
  }

  return next;
}

module.exports = {
  backfillScheduleTaskCrons,
  inferCronFromScheduleText,
  isValidCronExpression,
};

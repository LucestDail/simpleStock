const { APP_TIMEZONE } = require('./time');

const MARKET_EVENT_TYPES = Object.freeze({
  QUOTE_UPDATED: 'market.quote.updated',
  SESSION_UPDATED: 'market.session.updated',
  FX_RATE_UPDATED: 'fx.rate.updated',
});

const HOLDING_MARKET_FIELDS = Object.freeze([
  'ticker',
  'market',
  'currency',
  'lastQuote',
  'lastQuoteAt',
  'quoteSource',
]);

function getMarketProviderConfig() {
  return {
    timezone: APP_TIMEZONE,
    providers: {
      kr: null,
      us: null,
      fx: null,
    },
    refreshIntervalsMs: {
      session: 60_000,
      quote: 30_000,
      fx: 60_000,
    },
  };
}

function getTimezoneHour(now = new Date(), timeZone = APP_TIMEZONE) {
  const hourPart = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  })
    .formatToParts(now)
    .find((part) => part.type === 'hour');
  return Number(hourPart?.value || 0);
}

function getSessionState(hour, windowStartHour, windowEndHour) {
  if (windowStartHour < windowEndHour) {
    if (hour < windowStartHour) return 'pre';
    if (hour >= windowEndHour) return 'closed';
    return 'open';
  }

  if (hour >= windowStartHour || hour < windowEndHour) {
    return 'open';
  }

  return hour < windowStartHour ? 'pre' : 'closed';
}

function getMarketSessionSnapshot(now = new Date()) {
  const hour = getTimezoneHour(now, APP_TIMEZONE);

  return {
    timezone: APP_TIMEZONE,
    asOf: now.toISOString(),
    sessions: {
      kr: {
        market: 'KRX',
        state: getSessionState(hour, 9, 16),
      },
      us: {
        market: 'US',
        state: getSessionState(hour, 22, 5),
      },
    },
  };
}

function buildMarketExtensionHooks() {
  return {
    eventTypes: MARKET_EVENT_TYPES,
    holdingFields: HOLDING_MARKET_FIELDS,
    config: getMarketProviderConfig(),
  };
}

module.exports = {
  MARKET_EVENT_TYPES,
  HOLDING_MARKET_FIELDS,
  getMarketProviderConfig,
  getMarketSessionSnapshot,
  buildMarketExtensionHooks,
};

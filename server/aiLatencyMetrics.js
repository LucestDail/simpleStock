const MAX_RECENT = 50;

const state = {
  recent: [],
  totals: { count: 0, success: 0, errors: 0, sumMs: 0 },
  byLabel: {},
};

function recordAiLatency({
  logLabel = 'unknown',
  durationMs = 0,
  success = true,
  transport = '',
  model = '',
  streaming = false,
} = {}) {
  const entry = {
    logLabel,
    durationMs: Math.round(Number(durationMs) || 0),
    success: Boolean(success),
    transport: String(transport || ''),
    model: String(model || ''),
    streaming: Boolean(streaming),
    at: new Date().toISOString(),
  };

  state.recent.unshift(entry);
  if (state.recent.length > MAX_RECENT) {
    state.recent.length = MAX_RECENT;
  }

  state.totals.count += 1;
  state.totals.sumMs += entry.durationMs;
  if (success) state.totals.success += 1;
  else state.totals.errors += 1;

  if (!state.byLabel[logLabel]) {
    state.byLabel[logLabel] = { count: 0, success: 0, errors: 0, sumMs: 0, lastMs: 0 };
  }
  const bucket = state.byLabel[logLabel];
  bucket.count += 1;
  bucket.sumMs += entry.durationMs;
  bucket.lastMs = entry.durationMs;
  if (success) bucket.success += 1;
  else bucket.errors += 1;

  return entry;
}

function getAiLatencySnapshot() {
  const recent = state.recent.slice(0, 12);
  const avgMs = state.totals.count ? Math.round(state.totals.sumMs / state.totals.count) : 0;
  const labels = Object.fromEntries(
    Object.entries(state.byLabel).map(([label, bucket]) => [
      label,
      {
        count: bucket.count,
        success: bucket.success,
        errors: bucket.errors,
        avgMs: bucket.count ? Math.round(bucket.sumMs / bucket.count) : 0,
        lastMs: bucket.lastMs,
      },
    ])
  );

  return {
    totals: { ...state.totals, avgMs },
    recent,
    byLabel: labels,
  };
}

module.exports = {
  recordAiLatency,
  getAiLatencySnapshot,
};

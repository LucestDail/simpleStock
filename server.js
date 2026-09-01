require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const cron = require('node-cron');
const { APP_TIMEZONE, getDateInTimezone, getDateTimeInTimezone } = require('./server/time');
const { AI_DAILY_CRON, isAiConfigured } = require('./server/aiService');
const { syncScheduledTasks } = require('./server/taskService');
const { ensureManagerBriefSchedule } = require('./server/managerBriefSchedule');
const { logInfo, logError } = require('./server/logger');
const { runManagerReview, getSystemStatus, getLatestManagerReport } = require('./server/managerService');
const { ORCHESTRATION_NOTES, buildServerStatusPayload } = require('./server/payloadService');
const { subscribe, unsubscribe, sendToClient, broadcast, getSubscriberCount } = require('./server/realtimeService');
const {
  refreshMarketData,
  scheduleMarketRefresh,
  startMarketDataPolling,
  getMarketSnapshot,
} = require('./server/marketDataService');
const { updateSettings, AI_PRESETS, MARKET_PROVIDER_OPTIONS } = require('./server/settingsService');
const {
  getWatchlistState,
  createGroup,
  renameGroup,
  deleteGroup,
  reorderGroups,
  addTicker,
  removeTicker,
} = require('./server/watchlistService');

const PORT = Number(process.env.PORT) || 50000;
const APP_ACCESS_TOKEN = String(process.env.APP_ACCESS_TOKEN || '').trim();
const LOG_REQUEST_BODY = String(process.env.LOG_REQUEST_BODY || 'false').trim().toLowerCase() === 'true';
const app = express();

app.use(express.json({ limit: '2mb' }));

function extractAccessToken(req) {
  const authHeader = String(req.headers.authorization || '');
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return String(req.headers['x-access-token'] || req.query.token || '').trim();
}

function requireAccessToken(req, res, next) {
  if (!APP_ACCESS_TOKEN) return next();
  const token = extractAccessToken(req);
  if (token && token === APP_ACCESS_TOKEN) return next();
  return res.status(401).json({ error: '인증이 필요합니다. APP_ACCESS_TOKEN을 확인하세요.' });
}

function summarizeBody(req) {
  if (!LOG_REQUEST_BODY || !req.body || typeof req.body !== 'object') return undefined;
  return { keys: Object.keys(req.body || {}) };
}

app.use((req, res, next) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  req.requestId = requestId;

  logInfo('http.request.start', {
    requestId,
    method: req.method,
    path: req.path,
    query: req.query || {},
    bodySummary: summarizeBody(req),
  });

  res.on('finish', () => {
    logInfo('http.request.finish', {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  next();
});

app.use('/api', requireAccessToken);

// ── 시세 ─────────────────────────────────────────────────────────
app.get('/api/market/status', (req, res) => {
  res.json(getMarketSnapshot());
});

app.post('/api/market/refresh', async (req, res) => {
  try {
    const payload = await refreshMarketData({ reason: 'manual', force: true });
    res.json(payload);
  } catch (error) {
    logError('market.refresh.manual_failed', error, { requestId: req.requestId });
    res.status(500).json({ error: error.message || '시세 갱신 실패' });
  }
});

// ── 실시간 스트림(SSE) ────────────────────────────────────────────
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(': connected\n\n');

  const clientId = subscribe(res);
  logInfo('realtime.connected', { requestId: req.requestId, clientId, subscribers: getSubscriberCount() });

  sendToClient(clientId, 'hello', { clientId, connectedAt: new Date().toISOString() });
  sendToClient(clientId, 'server.status', buildServerStatusPayload());
  sendToClient(clientId, 'watchlist.updated', { watchlist: getWatchlistState() });

  req.on('close', () => {
    const removed = unsubscribe(clientId);
    logInfo('realtime.disconnected', { requestId: req.requestId, clientId, removed, subscribers: getSubscriberCount() });
  });
});

// ── 관심종목(watchlist) — 테마 그룹 ───────────────────────────────
app.get('/api/watchlist', (req, res) => {
  res.json(getWatchlistState());
});

app.post('/api/watchlist/groups', async (req, res) => {
  try {
    const state = await createGroup(req.body?.name);
    res.status(201).json(state);
  } catch (error) {
    res.status(400).json({ error: error.message || '그룹 생성 실패' });
  }
});

app.post('/api/watchlist/groups/reorder', async (req, res) => {
  try {
    const state = await reorderGroups(req.body?.orderedIds || []);
    res.json(state);
  } catch (error) {
    res.status(400).json({ error: error.message || '그룹 순서 변경 실패' });
  }
});

app.put('/api/watchlist/groups/:id', async (req, res) => {
  try {
    const state = await renameGroup(req.params.id, req.body?.name);
    res.json(state);
  } catch (error) {
    const status = /찾을 수 없습니다/.test(error.message || '') ? 404 : 400;
    res.status(status).json({ error: error.message || '그룹 수정 실패' });
  }
});

app.delete('/api/watchlist/groups/:id', async (req, res) => {
  try {
    const state = await deleteGroup(req.params.id);
    res.json(state);
  } catch (error) {
    const status = /찾을 수 없습니다/.test(error.message || '') ? 404 : 500;
    res.status(status).json({ error: error.message || '그룹 삭제 실패' });
  }
});

app.post('/api/watchlist/groups/:id/tickers', async (req, res) => {
  try {
    const result = await addTicker(req.params.id, req.body || {});
    res.status(201).json(result);
  } catch (error) {
    const msg = error.message || '';
    const status = /그룹을 찾을 수 없습니다/.test(msg)
      ? 404
      : /찾을 수 없습니다|필요합니다/.test(msg)
        ? 400
        : 500;
    res.status(status).json({ error: msg || '종목 추가 실패' });
  }
});

app.delete('/api/watchlist/groups/:id/tickers/:symbol', async (req, res) => {
  try {
    const state = await removeTicker(req.params.id, req.params.symbol);
    res.json(state);
  } catch (error) {
    const status = /찾을 수 없습니다/.test(error.message || '') ? 404 : 500;
    res.status(status).json({ error: error.message || '종목 삭제 실패' });
  }
});

// ── 범용 시장 브리핑 ──────────────────────────────────────────────
async function handleBriefingRun(req, res) {
  try {
    const report = await runManagerReview('manual');
    res.json({ report, watchlist: getWatchlistState() });
  } catch (error) {
    logError('briefing.run.failed', error, { requestId: req.requestId, trigger: 'manual' });
    const status = /비활성화/.test(error.message || '')
      ? 503
      : /관심종목이 없어/.test(error.message || '')
        ? 400
        : 500;
    res.status(status).json({ error: error.message || '시장 브리핑 생성 실패' });
  }
}
app.post('/api/briefing/run', handleBriefingRun);
app.post('/api/manager/run', handleBriefingRun); // 하위호환 별칭
app.post('/api/ai/run', handleBriefingRun); // 하위호환 별칭

app.get('/api/briefing/latest', (req, res) => {
  res.json({ report: getLatestManagerReport() });
});

// ── 시스템 상태·설정 ──────────────────────────────────────────────
app.get('/api/system/status', (req, res) => {
  res.json({
    ...getSystemStatus(),
    market: getMarketSnapshot(),
    dataFiles: buildServerStatusPayload().system.dataFiles,
    orchestrationNotes: ORCHESTRATION_NOTES,
    latestManagerReport: getLatestManagerReport(),
    aiPresets: AI_PRESETS,
    marketProviderOptions: MARKET_PROVIDER_OPTIONS,
  });
});

app.put('/api/system/settings', async (req, res) => {
  try {
    const saved = await updateSettings(req.body || {});
    res.json({ settings: saved, system: getSystemStatus() });
  } catch (error) {
    res.status(400).json({ error: error.message || '설정 저장 실패' });
  }
});

// ── 정적 프론트 ───────────────────────────────────────────────────
const dist = path.join(__dirname, 'dist');
app.use(express.static(dist, { index: false }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const indexPath = path.join(dist, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return res.status(503).send('프론트엔드 빌드가 없습니다. npm run build 실행 후 다시 시도하세요.');
  }
  let html = fs.readFileSync(indexPath, 'utf8');
  if (APP_ACCESS_TOKEN) {
    const bootstrap = `<script>window.__SIMPLESTOCK_ACCESS_TOKEN__=${JSON.stringify(APP_ACCESS_TOKEN)};</script>`;
    html = html.includes('</head>') ? html.replace('</head>', `${bootstrap}</head>`) : `${bootstrap}${html}`;
  }
  res.type('html').send(html);
});

async function startAiSchedule() {
  const usePresetBriefSchedule =
    String(process.env.MANAGER_BRIEF_PRESET_SCHEDULE ?? 'true').trim().toLowerCase() !== 'false';

  if (usePresetBriefSchedule) {
    await ensureManagerBriefSchedule();
  }

  syncScheduledTasks();
  startMarketDataPolling();
  scheduleMarketRefresh('startup', { force: true, delayMs: 800 });

  if (!isAiConfigured()) {
    logInfo('schedule.disabled', { reason: 'missing_gemini_api_key', timezone: APP_TIMEZONE });
    return;
  }

  const legacyCronEnabled = !usePresetBriefSchedule && AI_DAILY_CRON && cron.validate(AI_DAILY_CRON);
  if (!legacyCronEnabled) {
    if (usePresetBriefSchedule) {
      logInfo('schedule.preset_market_brief', { timezone: APP_TIMEZONE, slots: '22,23,06,09,10,18 weekdays' });
    }
    return;
  }

  cron.schedule(
    AI_DAILY_CRON,
    async () => {
      try {
        await runManagerReview('schedule');
        logInfo('schedule.market_brief.success', {
          targetDate: getDateInTimezone(new Date(), APP_TIMEZONE),
          timezone: APP_TIMEZONE,
        });
      } catch (error) {
        logError('schedule.market_brief.failed', error, { timezone: APP_TIMEZONE, cronExpression: AI_DAILY_CRON });
      }
    },
    { timezone: APP_TIMEZONE }
  );

  logInfo('schedule.registered', { timezone: APP_TIMEZONE, cronExpression: AI_DAILY_CRON });
}

app.listen(PORT, '0.0.0.0', () => {
  const ip =
    Object.values(os.networkInterfaces())
      .flat()
      .find((item) => item && item.family === 'IPv4' && !item.internal)?.address || '127.0.0.1';
  logInfo('server.started', {
    url: `http://${ip}:${PORT}`,
    timezone: APP_TIMEZONE,
    localTime: getDateTimeInTimezone(new Date(), APP_TIMEZONE),
  });
  void startAiSchedule();
});

process.on('unhandledRejection', (error) => {
  logError('process.unhandled_rejection', error);
});

process.on('uncaughtException', (error) => {
  logError('process.uncaught_exception', error);
});

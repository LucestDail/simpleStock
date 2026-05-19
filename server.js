require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const cron = require('node-cron');
const { CATEGORIES, mutateStore } = require('./server/dataStore');
const { buildSnapshot } = require('./server/snapshotService');
const { APP_TIMEZONE, getDateInTimezone, getDateTimeInTimezone } = require('./server/time');
const { AI_DAILY_CRON, getAiSettings, isAiConfigured } = require('./server/aiService');
const { syncScheduledTasks } = require('./server/taskService');
const { ensureManagerBriefSchedule } = require('./server/managerBriefSchedule');
const { logInfo, logError } = require('./server/logger');
const {
  createThread,
  getThread,
  deleteThread,
  sendMessage,
  sendMessageStream,
  refreshThreadMemory,
} = require('./server/chatService');
const { getProfileState, updateUserProfile } = require('./server/profileService');
const { getLatestManagerReport, runManagerReview, getSystemStatus } = require('./server/managerService');
const {
  ORCHESTRATION_NOTES,
  buildPortfolioPayload,
  buildProfilePayload,
  buildChatThreadsPayload,
  buildServerStatusPayload,
} = require('./server/payloadService');
const { subscribe, unsubscribe, sendToClient, broadcast, getSubscriberCount } = require('./server/realtimeService');
const {
  refreshMarketData,
  scheduleMarketRefresh,
  startMarketDataPolling,
  getMarketSnapshot,
} = require('./server/marketDataService');
const { updateSettings, AI_PRESETS, MARKET_PROVIDER_OPTIONS } = require('./server/settingsService');
const {
  getMemoryState,
  deleteLongTermMemory,
  setLongTermMemoryPinned,
  updateThreadSummary,
  createLongTermMemory,
} = require('./server/memoryService');
const {
  buildImportPreview,
  applyImportWithUndo,
  undoLastImport,
} = require('./server/importPreviewService');

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
  if (req.path.includes('/messages')) {
    return {
      contentLength: String(req.body.content || '').length,
    };
  }
  if (req.path === '/api/portfolio') {
    return {
      holdingsCount: Array.isArray(req.body.holdings) ? req.body.holdings.length : null,
    };
  }
  if (req.path === '/api/profile') {
    return {
      profileKeys: Object.keys(req.body || {}),
    };
  }
  return {
    keys: Object.keys(req.body || {}),
  };
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

function sanitizeHoldings(holdings) {
  const seen = new Set();
  return holdings.map((holding) => {
    let id = holding.id ? String(holding.id) : crypto.randomUUID();
    if (seen.has(id)) id = crypto.randomUUID();
    seen.add(id);
    const details = holding.details && typeof holding.details === 'object'
      ? {
          account: String(holding.details.account || '').slice(0, 120),
          currency: String(holding.details.currency || '').slice(0, 16),
          ticker: String(holding.details.ticker || '').slice(0, 40),
          market: String(holding.details.market || '').slice(0, 24),
          quantity: Number.isFinite(Number(holding.details.quantity)) ? Number(holding.details.quantity) : null,
          averagePrice: Number.isFinite(Number(holding.details.averagePrice)) ? Number(holding.details.averagePrice) : null,
          currentPrice: Number.isFinite(Number(holding.details.currentPrice)) ? Number(holding.details.currentPrice) : null,
          lastQuote: Number.isFinite(Number(holding.details.lastQuote)) ? Number(holding.details.lastQuote) : null,
          previousClose: Number.isFinite(Number(holding.details.previousClose)) ? Number(holding.details.previousClose) : null,
          priceChange: Number.isFinite(Number(holding.details.priceChange)) ? Number(holding.details.priceChange) : null,
          priceChangePct: Number.isFinite(Number(holding.details.priceChangePct)) ? Number(holding.details.priceChangePct) : null,
          marketState: String(holding.details.marketState || '').slice(0, 24),
          lastQuoteAt: holding.details.lastQuoteAt ? String(holding.details.lastQuoteAt).slice(0, 40) : null,
          quoteSource: String(holding.details.quoteSource || '').slice(0, 80),
          nativeAmount: Number.isFinite(Number(holding.details.nativeAmount)) ? Number(holding.details.nativeAmount) : null,
          fxRate: Number.isFinite(Number(holding.details.fxRate)) ? Number(holding.details.fxRate) : null,
          summary: String(holding.details.summary || '').slice(0, 240),
          orders: Array.isArray(holding.details.orders)
            ? holding.details.orders.map((item) => String(item || '').slice(0, 160)).filter(Boolean).slice(0, 6)
            : [],
        }
      : null;
    return {
      id,
      name: String(holding.name || '이름 없음').slice(0, 200),
      category: CATEGORIES.includes(holding.category) ? holding.category : 'deposit',
      amount: Math.max(0, Math.round(Number(holding.amount) || 0)),
      details,
    };
  });
}

app.get('/api/portfolio', (req, res) => {
  res.json(buildPortfolioPayload());
});

app.post('/api/market/refresh', async (req, res) => {
  try {
    const payload = await refreshMarketData({
      reason: 'manual',
      force: true,
    });
    res.json(payload);
  } catch (error) {
    logError('market.refresh.manual_failed', error, {
      requestId: req.requestId,
    });
    res.status(500).json({ error: error.message || '시세 갱신 실패' });
  }
});

app.get('/api/market/status', (req, res) => {
  res.json(getMarketSnapshot());
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
  res.write(': connected\n\n');

  const clientId = subscribe(res);
  logInfo('realtime.connected', {
    requestId: req.requestId,
    clientId,
    subscribers: getSubscriberCount(),
  });

  sendToClient(clientId, 'hello', {
    clientId,
    connectedAt: new Date().toISOString(),
  });
  sendToClient(clientId, 'server.status', buildServerStatusPayload());

  req.on('close', () => {
    const removed = unsubscribe(clientId);
    logInfo('realtime.disconnected', {
      requestId: req.requestId,
      clientId,
      removed,
      subscribers: getSubscriberCount(),
    });
  });
});

app.put('/api/portfolio', async (req, res) => {
  if (!req.body || !Array.isArray(req.body.holdings)) {
    return res.status(400).json({ error: 'holdings 배열이 필요합니다.' });
  }

  try {
    await mutateStore((store) => {
      store.portfolio.holdings = sanitizeHoldings(req.body.holdings);
    });
    const payload = buildPortfolioPayload();
    broadcast('portfolio.updated', payload);
    scheduleMarketRefresh('portfolio:manual_save', { force: true, delayMs: 300 });
    res.json(payload);
  } catch (error) {
    logError('portfolio.save.failed', error, { requestId: req.requestId });
    res.status(500).json({ error: error.message || '자산 저장 실패' });
  }
});

app.post('/api/snapshots', async (req, res) => {
  const date = req.body?.date || getDateInTimezone(new Date(), APP_TIMEZONE);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: '날짜는 YYYY-MM-DD 형식이어야 합니다.' });
  }

  try {
    await mutateStore((store) => {
      const snapshot = buildSnapshot(store.portfolio.holdings, date);
      store.portfolio.snapshots = store.portfolio.snapshots.filter((item) => item.date !== date);
      store.portfolio.snapshots.push(snapshot);
      store.portfolio.snapshots.sort((a, b) => a.date.localeCompare(b.date));
    });
    const payload = buildPortfolioPayload();
    broadcast('snapshots.updated', payload);
    res.json(payload);
  } catch (error) {
    logError('snapshot.save.failed', error, { requestId: req.requestId, date });
    res.status(500).json({ error: error.message || '스냅샷 저장 실패' });
  }
});

app.delete('/api/snapshots/:date', async (req, res) => {
  const { date } = req.params;
  try {
    const removed = await mutateStore((store) => {
      const before = store.portfolio.snapshots.length;
      store.portfolio.snapshots = store.portfolio.snapshots.filter((item) => item.date !== date);
      return before !== store.portfolio.snapshots.length;
    });

    if (!removed) {
      return res.status(404).json({ error: '스냅샷을 찾을 수 없습니다.' });
    }
    const payload = buildPortfolioPayload();
    broadcast('snapshots.updated', payload);
    res.json(payload);
  } catch (error) {
    logError('snapshot.delete.failed', error, { requestId: req.requestId, date });
    res.status(500).json({ error: error.message || '스냅샷 삭제 실패' });
  }
});

app.get('/api/profile', (req, res) => {
  res.json(getProfileState());
});

app.put('/api/profile', async (req, res) => {
  try {
    const profile = await updateUserProfile(req.body || {});
    broadcast('profile.user.updated', buildProfilePayload());
    res.json(profile);
  } catch (error) {
    logError('profile.update.failed', error, { requestId: req.requestId });
    res.status(500).json({ error: error.message || '프로필 저장 실패' });
  }
});

app.get('/api/chat/threads', (req, res) => {
  res.json(buildChatThreadsPayload());
});

app.post('/api/chat/threads', async (req, res) => {
  try {
    const thread = await createThread(req.body?.title || '새 대화');
    res.status(201).json({ thread });
  } catch (error) {
    logError('chat.thread.create.failed', error, { requestId: req.requestId });
    res.status(500).json({ error: error.message || '스레드 생성 실패' });
  }
});

app.get('/api/chat/threads/:threadId', (req, res) => {
  const result = getThread(req.params.threadId);
  if (!result) {
    return res.status(404).json({ error: '스레드를 찾을 수 없습니다.' });
  }
  res.json(result);
});

app.post('/api/chat/threads/:threadId/messages', async (req, res) => {
  try {
    const result = await sendMessage(req.params.threadId, req.body?.content || '');
    res.json(result);
  } catch (error) {
    logError('chat.message.failed', error, {
      requestId: req.requestId,
      threadId: req.params.threadId,
      contentPreview: String(req.body?.content || '').slice(0, 120),
    });
    const status = /비활성화/.test(error.message || '')
      ? 503
      : /찾을 수 없습니다|입력/.test(error.message || '')
        ? 400
        : 500;
    res.status(status).json({ error: error.message || '메시지 전송 실패' });
  }
});

app.post('/api/chat/threads/:threadId/messages/stream', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const writeEvent = (event) => {
    res.write(`${JSON.stringify(event)}\n`);
    if (typeof res.flush === 'function') {
      res.flush();
    }
  };

  try {
    await sendMessageStream(req.params.threadId, req.body?.content || '', writeEvent);
    res.end();
  } catch (error) {
    logError('chat.message.stream.failed', error, {
      requestId: req.requestId,
      threadId: req.params.threadId,
      contentPreview: String(req.body?.content || '').slice(0, 120),
    });
    writeEvent({
      type: 'error',
      error: error.message || '메시지 스트리밍 전송 실패',
    });
    res.end();
  }
});

app.delete('/api/chat/threads/:threadId', async (req, res) => {
  try {
    const removed = await deleteThread(req.params.threadId);
    if (!removed) {
      return res.status(404).json({ error: '스레드를 찾을 수 없습니다.' });
    }
    res.json({ ok: true });
  } catch (error) {
    logError('chat.thread.delete.failed', error, {
      requestId: req.requestId,
      threadId: req.params.threadId,
    });
    res.status(500).json({ error: error.message || '스레드 삭제 실패' });
  }
});

app.post('/api/chat/threads/:threadId/summarize', async (req, res) => {
  try {
    const summary = await refreshThreadMemory(req.params.threadId);
    res.json({ summary });
  } catch (error) {
    logError('chat.thread.summarize.failed', error, {
      requestId: req.requestId,
      threadId: req.params.threadId,
    });
    res.status(500).json({ error: error.message || '대화 요약 실패' });
  }
});

app.post('/api/manager/run', async (req, res) => {
  try {
    const report = await runManagerReview('manual');
    res.json({
      report,
      ...buildPortfolioPayload(),
    });
  } catch (error) {
    logError('manager.run.failed', error, { requestId: req.requestId, trigger: 'manual' });
    const status =
      /비활성화/.test(error.message || '') ? 503 : /등록된 자산/.test(error.message || '') ? 400 : 500;
    res.status(status).json({ error: error.message || '매니저 브리핑 생성 실패' });
  }
});

app.post('/api/ai/run', async (req, res) => {
  try {
    const report = await runManagerReview('manual');
    res.json({
      report,
      ...buildPortfolioPayload(),
    });
  } catch (error) {
    logError('ai.run.failed', error, { requestId: req.requestId, trigger: 'manual' });
    const status =
      /비활성화/.test(error.message || '') ? 503 : /등록된 자산/.test(error.message || '') ? 400 : 500;
    res.status(status).json({ error: error.message || 'AI 브리핑 생성 실패' });
  }
});

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

app.get('/api/memory', (req, res) => {
  res.json(getMemoryState());
});

app.post('/api/memory/long-term', async (req, res) => {
  try {
    const memory = await createLongTermMemory(req.body || {});
    res.status(201).json({ memory, ...getMemoryState() });
  } catch (error) {
    res.status(400).json({ error: error.message || '기억 저장 실패' });
  }
});

app.delete('/api/memory/long-term/:memoryId', async (req, res) => {
  try {
    const removed = await deleteLongTermMemory(req.params.memoryId);
    if (!removed) return res.status(404).json({ error: '기억을 찾을 수 없습니다.' });
    res.json(getMemoryState());
  } catch (error) {
    res.status(500).json({ error: error.message || '기억 삭제 실패' });
  }
});

app.patch('/api/memory/long-term/:memoryId', async (req, res) => {
  try {
    const updated = await setLongTermMemoryPinned(req.params.memoryId, req.body?.pinned !== false);
    if (!updated) return res.status(404).json({ error: '기억을 찾을 수 없습니다.' });
    res.json(getMemoryState());
  } catch (error) {
    res.status(500).json({ error: error.message || '기억 갱신 실패' });
  }
});

app.put('/api/memory/thread-summaries/:summaryId', async (req, res) => {
  try {
    const updated = await updateThreadSummary(req.params.summaryId, req.body || {});
    if (!updated) return res.status(404).json({ error: '스레드 요약을 찾을 수 없습니다.' });
    res.json({ summary: updated, ...getMemoryState() });
  } catch (error) {
    res.status(500).json({ error: error.message || '스레드 요약 저장 실패' });
  }
});

app.put('/api/system/settings', async (req, res) => {
  try {
    const saved = await updateSettings(req.body || {});
    res.json({
      settings: saved,
      system: getSystemStatus(),
    });
  } catch (error) {
    res.status(400).json({ error: error.message || '설정 저장 실패' });
  }
});

app.post('/api/import/preview', (req, res) => {
  try {
    res.json(buildImportPreview(req.body?.content || ''));
  } catch (error) {
    res.status(400).json({ error: error.message || 'import 미리보기 실패' });
  }
});

app.post('/api/import/apply', async (req, res) => {
  try {
    const result = await applyImportWithUndo(req.body?.content || '');
    const payload = buildPortfolioPayload();
    broadcast('portfolio.updated', payload);
    if (result.workspacePatch) {
      broadcast('workspace.patch', { workspacePatch: result.workspacePatch });
    }
    scheduleMarketRefresh('import:apply', { force: true, delayMs: 300 });
    res.json({
      ...result,
      ...payload,
    });
  } catch (error) {
    res.status(400).json({ error: error.message || 'import 적용 실패' });
  }
});

app.post('/api/import/undo', async (req, res) => {
  try {
    const result = await undoLastImport();
    const payload = buildPortfolioPayload();
    broadcast('portfolio.updated', payload);
    res.json({ ...result, ...payload });
  } catch (error) {
    res.status(400).json({ error: error.message || 'import 되돌리기 실패' });
  }
});

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
    html = html.includes('</head>')
      ? html.replace('</head>', `${bootstrap}</head>`)
      : `${bootstrap}${html}`;
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

  if (!isAiConfigured()) {
    logInfo('schedule.disabled', {
      reason: 'missing_gemini_api_key',
      timezone: APP_TIMEZONE,
    });
    return;
  }

  const legacyCronEnabled =
    !usePresetBriefSchedule &&
    AI_DAILY_CRON &&
    cron.validate(AI_DAILY_CRON);

  if (!legacyCronEnabled) {
    if (usePresetBriefSchedule) {
      logInfo('schedule.preset_manager_brief', {
        timezone: APP_TIMEZONE,
        slots: '22,23,06,09,10,18 weekdays',
      });
    }
    return;
  }

  cron.schedule(
    AI_DAILY_CRON,
    async () => {
      try {
        await runManagerReview('schedule');
        logInfo('schedule.manager_brief.success', {
          targetDate: getDateInTimezone(new Date(), APP_TIMEZONE),
          timezone: APP_TIMEZONE,
        });
      } catch (error) {
        logError('schedule.manager_brief.failed', error, {
          timezone: APP_TIMEZONE,
          cronExpression: AI_DAILY_CRON,
        });
      }
    },
    { timezone: APP_TIMEZONE }
  );

  logInfo('schedule.registered', {
    timezone: APP_TIMEZONE,
    cronExpression: AI_DAILY_CRON,
  });
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

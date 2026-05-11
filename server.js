require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const cron = require('node-cron');
const {
  CATEGORIES,
  FILES,
  loadStore,
  mutateStore,
} = require('./server/dataStore');
const { getCategoryShares } = require('./server/contextBuilder');
const { APP_TIMEZONE, getDateInTimezone, getDateTimeInTimezone } = require('./server/time');
const { AI_DAILY_CRON, getAiSettings, isAiConfigured } = require('./server/aiService');
const { syncScheduledTasks } = require('./server/taskService');
const { logInfo, logError } = require('./server/logger');
const {
  listThreads,
  createThread,
  getThread,
  deleteThread,
  sendMessage,
  refreshThreadMemory,
} = require('./server/chatService');
const { getProfileState, updateUserProfile } = require('./server/profileService');
const { getLatestManagerReport, runManagerReview, getSystemStatus } = require('./server/managerService');

const PORT = Number(process.env.PORT) || 3000;
const app = express();

const ORCHESTRATION_NOTES = [
  'Supervisor는 매 턴마다 사용자 질문, 장기 기억, 사용자 프로필, 자산 데이터를 읽고 동적으로 persona/system prompt와 specialist task를 생성합니다.',
  'Specialist는 portfolio, memory, manager, research 역할 중 필요한 조합으로 동적으로 생성되며, research는 Gemini googleSearch 툴만 사용합니다.',
  '자산 입력, 설정 변경, 반복 브리핑/시황/indicator 예약 요청은 conversation action으로 해석되면 실제 JSON 데이터와 예약 작업에 반영됩니다.',
  '대화 후에는 thread summary, long-term memory, inferred profile이 JSON 파일로 갱신됩니다.',
].join('\n');

app.use(express.json({ limit: '2mb' }));

function summarizeBody(req) {
  if (!req.body || typeof req.body !== 'object') return undefined;
  if (req.path.includes('/messages')) {
    return {
      contentPreview: String(req.body.content || '').slice(0, 120),
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
          quantity: Number.isFinite(Number(holding.details.quantity)) ? Number(holding.details.quantity) : null,
          averagePrice: Number.isFinite(Number(holding.details.averagePrice)) ? Number(holding.details.averagePrice) : null,
          currentPrice: Number.isFinite(Number(holding.details.currentPrice)) ? Number(holding.details.currentPrice) : null,
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

function buildSnapshot(holdings, date) {
  const total = holdings.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const shares = getCategoryShares(holdings);
  const byCategory = Object.fromEntries(shares.map((item) => [item.category, item.amount]));
  return {
    date,
    total,
    byCategory,
  };
}

function buildPortfolioPayload(store = loadStore()) {
  return {
    holdings: store.portfolio.holdings,
    snapshots: store.portfolio.snapshots,
    manager: {
      latestReport: store.memory.managerReports[0] || null,
      history: store.memory.managerReports.slice(0, 10),
    },
    system: {
      ...getSystemStatus(),
      dataFiles: FILES,
      orchestrationNotes: ORCHESTRATION_NOTES,
    },
  };
}

app.get('/api/portfolio', (req, res) => {
  res.json(buildPortfolioPayload());
});

app.put('/api/portfolio', async (req, res) => {
  if (!req.body || !Array.isArray(req.body.holdings)) {
    return res.status(400).json({ error: 'holdings 배열이 필요합니다.' });
  }

  try {
    await mutateStore((store) => {
      store.portfolio.holdings = sanitizeHoldings(req.body.holdings);
    });
    res.json(buildPortfolioPayload());
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
    res.json(buildPortfolioPayload());
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
    res.json(buildPortfolioPayload());
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
    res.json(profile);
  } catch (error) {
    logError('profile.update.failed', error, { requestId: req.requestId });
    res.status(500).json({ error: error.message || '프로필 저장 실패' });
  }
});

app.get('/api/chat/threads', (req, res) => {
  res.json({
    threads: listThreads(),
    system: getSystemStatus(),
  });
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
    dataFiles: FILES,
    orchestrationNotes: ORCHESTRATION_NOTES,
    ai: getAiSettings(),
    latestManagerReport: getLatestManagerReport(),
  });
});

const dist = path.join(__dirname, 'dist');
app.use(express.static(dist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const index = path.join(dist, 'index.html');
  if (!fs.existsSync(index)) {
    return res.status(503).send('프론트엔드 빌드가 없습니다. npm run build 실행 후 다시 시도하세요.');
  }
  return res.sendFile(index);
});

function startAiSchedule() {
  syncScheduledTasks();

  if (!isAiConfigured()) {
    logInfo('schedule.disabled', {
      reason: 'missing_gemini_api_key',
      timezone: APP_TIMEZONE,
    });
    return;
  }

  if (!cron.validate(AI_DAILY_CRON)) {
    logInfo('schedule.invalid_cron', {
      cronExpression: AI_DAILY_CRON,
    });
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
  startAiSchedule();
});

process.on('unhandledRejection', (error) => {
  logError('process.unhandled_rejection', error);
});

process.on('uncaughtException', (error) => {
  logError('process.uncaught_exception', error);
});

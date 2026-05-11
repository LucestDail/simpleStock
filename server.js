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
  '대화 후에는 thread summary, long-term memory, inferred profile이 JSON 파일로 갱신됩니다.',
].join('\n');

app.use(express.json({ limit: '2mb' }));

function sanitizeHoldings(holdings) {
  const seen = new Set();
  return holdings.map((holding) => {
    let id = holding.id ? String(holding.id) : crypto.randomUUID();
    if (seen.has(id)) id = crypto.randomUUID();
    seen.add(id);
    return {
      id,
      name: String(holding.name || '이름 없음').slice(0, 200),
      category: CATEGORIES.includes(holding.category) ? holding.category : 'deposit',
      amount: Math.max(0, Math.round(Number(holding.amount) || 0)),
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
    res.status(500).json({ error: error.message || '스레드 삭제 실패' });
  }
});

app.post('/api/chat/threads/:threadId/summarize', async (req, res) => {
  try {
    const summary = await refreshThreadMemory(req.params.threadId);
    res.json({ summary });
  } catch (error) {
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
  if (!isAiConfigured()) {
    console.log('[AI] GEMINI_API_KEY 없음 - 스케줄 비활성화');
    return;
  }

  if (!cron.validate(AI_DAILY_CRON)) {
    console.log(`[AI] 잘못된 cron 표현식: ${AI_DAILY_CRON}`);
    return;
  }

  cron.schedule(
    AI_DAILY_CRON,
    async () => {
      try {
        await runManagerReview('schedule');
        console.log(`[AI] 일일 매니저 브리핑 생성 완료 (${getDateInTimezone(new Date(), APP_TIMEZONE)})`);
      } catch (error) {
        console.error('[AI] 일일 매니저 브리핑 생성 실패:', error.message);
      }
    },
    { timezone: APP_TIMEZONE }
  );

  console.log(`[AI] node-cron 등록 완료 (${APP_TIMEZONE} / ${AI_DAILY_CRON})`);
}

app.listen(PORT, '0.0.0.0', () => {
  const ip =
    Object.values(os.networkInterfaces())
      .flat()
      .find((item) => item && item.family === 'IPv4' && !item.internal)?.address || '127.0.0.1';
  console.log(`SimpleStock running at http://${ip}:${PORT}`);
  console.log(`[Time] ${APP_TIMEZONE} / ${getDateTimeInTimezone(new Date(), APP_TIMEZONE)}`);
  startAiSchedule();
});

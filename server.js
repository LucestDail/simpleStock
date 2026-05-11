require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const cron = require('node-cron');

const PORT = Number(process.env.PORT) || 3000;
const DATA_PATH = path.join(__dirname, 'data', 'portfolio.json');
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Seoul';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const GEMINI_THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || 'medium';
const AI_DAILY_CRON = process.env.AI_DAILY_CRON || '5 21 * * *';

const CATEGORIES = ['deposit', 'installment', 'stock', 'fund', 'pension'];
const MAX_AI_HISTORY = 30;
let googleGenAiCtorPromise = null;

const AI_REPORT_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: '오늘 자산 상황 한 줄 요약',
    },
    dailyObjective: {
      type: 'string',
      description: '오늘 우선순위 한 문장',
    },
    actionItems: {
      type: 'array',
      items: { type: 'string' },
      description: '오늘 실행할 점검/관리 항목 3~5개',
    },
    riskChecks: {
      type: 'array',
      items: { type: 'string' },
      description: '확인할 리스크/주의 포인트 2~5개',
    },
    allocationNotes: {
      type: 'array',
      items: { type: 'string' },
      description: '현재 비중에 대한 해석과 코멘트',
    },
  },
  required: ['summary', 'dailyObjective', 'actionItems', 'riskChecks', 'allocationNotes'],
};

const QUANT_MANAGER_SYSTEM_PROMPT = [
  'You are SimpleStock Quant Manager, a Korean personal asset management analyst for a single user.',
  'Your job is to review the provided holdings and daily net-worth snapshots and produce a practical daily management brief.',
  'Rules:',
  '1. Respond in Korean.',
  '2. Use only the provided portfolio and snapshot data. Do not invent prices, returns, market news, or macro events.',
  '3. You are not a licensed financial advisor. Give operational portfolio hygiene guidance, not guaranteed return claims.',
  '4. Be concrete, calm, and concise. Focus on monitoring, diversification hygiene, liquidity, concentration, and missing-data checks.',
  '5. If data is insufficient, say so clearly and turn that into an action item.',
  '6. Treat deposit/installment as cash-like, stock/fund as investment risk assets, pension as long-horizon retirement assets.',
  '7. Assume the user wants a daily checklist and a lightweight quant-style manager summary.',
].join('\n');

function getDefaultAiState() {
  return {
    latestReport: null,
    history: [],
    lastRunAt: null,
    lastError: null,
    lastRunSource: null,
  };
}

function normalizeData(data) {
  const normalized = data && typeof data === 'object' ? data : {};
  if (!Array.isArray(normalized.holdings)) normalized.holdings = [];
  if (!Array.isArray(normalized.snapshots)) normalized.snapshots = [];
  if (!normalized.ai || typeof normalized.ai !== 'object') normalized.ai = getDefaultAiState();
  if (!Array.isArray(normalized.ai.history)) normalized.ai.history = [];
  if (!Object.prototype.hasOwnProperty.call(normalized.ai, 'latestReport')) {
    normalized.ai.latestReport = null;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized.ai, 'lastRunAt')) {
    normalized.ai.lastRunAt = null;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized.ai, 'lastError')) {
    normalized.ai.lastError = null;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized.ai, 'lastRunSource')) {
    normalized.ai.lastRunSource = null;
  }
  return normalized;
}

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    return normalizeData(JSON.parse(raw));
  } catch {
    return normalizeData({});
  }
}

function saveData(data) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(normalizeData(data), null, 2), 'utf8');
}

function summarizeHoldings(holdings) {
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  let total = 0;
  for (const h of holdings) {
    const c = CATEGORIES.includes(h.category) ? h.category : 'deposit';
    const amount = Math.max(0, Math.round(Number(h.amount) || 0));
    byCategory[c] += amount;
    total += amount;
  }
  return { total, byCategory };
}

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

function isAiConfigured() {
  return Boolean(GEMINI_API_KEY);
}

async function getGoogleGenAI() {
  if (!googleGenAiCtorPromise) {
    googleGenAiCtorPromise = import('@google/genai').then((module) => module.GoogleGenAI);
  }
  return googleGenAiCtorPromise;
}

function upsertSnapshot(data, date) {
  const { total, byCategory } = summarizeHoldings(data.holdings);
  const snap = { date, total, byCategory };
  data.snapshots = data.snapshots.filter((s) => s.date !== date);
  data.snapshots.push(snap);
  data.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  return snap;
}

function getCategoryShares(holdings) {
  const { total, byCategory } = summarizeHoldings(holdings);
  if (!total) {
    return CATEGORIES.map((category) => ({ category, amount: 0, pct: 0 }));
  }
  return CATEGORIES.map((category) => ({
    category,
    amount: byCategory[category],
    pct: Math.round((byCategory[category] / total) * 1000) / 10,
  }));
}

function getSortedSnapshotsDesc(snapshots) {
  return [...snapshots].sort((a, b) => b.date.localeCompare(a.date));
}

function getDayOverDay(snapshots) {
  const sorted = getSortedSnapshotsDesc(snapshots);
  if (sorted.length < 2) return null;
  const latest = sorted[0];
  const previous = sorted[1];
  const delta = latest.total - previous.total;
  return {
    latestDate: latest.date,
    previousDate: previous.date,
    delta,
    pct: previous.total > 0 ? Math.round((delta / previous.total) * 1000) / 10 : null,
  };
}

function buildRuntimeState() {
  return {
    timezone: APP_TIMEZONE,
    serverTimeIso: new Date().toISOString(),
    serverTimeLocal: getDateTimeInTimezone(new Date(), APP_TIMEZONE),
    todayLocalDate: getDateInTimezone(new Date(), APP_TIMEZONE),
    aiConfigured: isAiConfigured(),
    aiCronExpression: AI_DAILY_CRON,
    aiCronValid: cron.validate(AI_DAILY_CRON),
    aiCronMode: 'node-cron',
    geminiModel: GEMINI_MODEL,
    geminiThinkingLevel: GEMINI_THINKING_LEVEL,
    quantManagerSystemPrompt: QUANT_MANAGER_SYSTEM_PROMPT,
  };
}

function withRuntimeState(data) {
  return {
    ...normalizeData(JSON.parse(JSON.stringify(data))),
    system: buildRuntimeState(),
  };
}

function recordAiError(data, error, trigger) {
  data.ai.lastRunAt = new Date().toISOString();
  data.ai.lastRunSource = trigger;
  data.ai.lastError = {
    at: new Date().toISOString(),
    trigger,
    message: error.message || 'AI 분석 생성 실패',
  };
}

function buildAiPrompt(data, targetDate) {
  const shares = getCategoryShares(data.holdings);
  const sortedSnapshots = getSortedSnapshotsDesc(data.snapshots);
  const latestSnapshot = sortedSnapshots[0] || null;
  const dayOverDay = getDayOverDay(data.snapshots);

  return [
    QUANT_MANAGER_SYSTEM_PROMPT,
    '',
    `Current local date: ${targetDate}`,
    `Timezone: ${APP_TIMEZONE}`,
    '',
    'Holdings:',
    JSON.stringify(data.holdings, null, 2),
    '',
    'Category shares:',
    JSON.stringify(shares, null, 2),
    '',
    'Latest snapshot:',
    JSON.stringify(latestSnapshot, null, 2),
    '',
    'Day-over-day summary:',
    JSON.stringify(dayOverDay, null, 2),
    '',
    'Snapshot history:',
    JSON.stringify(sortedSnapshots.slice(0, 14), null, 2),
    '',
    'Return a JSON object matching the provided schema.',
  ].join('\n');
}

async function generateGeminiReport(data, targetDate) {
  if (!isAiConfigured()) {
    const error = new Error('GEMINI_API_KEY가 설정되지 않아 AI 기능이 비활성화되어 있습니다.');
    error.statusCode = 503;
    throw error;
  }

  const GoogleGenAI = await getGoogleGenAI();
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: buildAiPrompt(data, targetDate),
    config: {
      thinkingConfig: {
        thinkingLevel: GEMINI_THINKING_LEVEL,
      },
      responseFormat: {
        text: {
          mimeType: 'application/json',
          schema: AI_REPORT_SCHEMA,
        },
      },
    },
  });

  if (!response.text) {
    throw new Error('Gemini 응답이 비어 있습니다.');
  }

  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error('Gemini 응답 JSON 파싱에 실패했습니다.');
  }

  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    targetDate,
    model: GEMINI_MODEL,
    thinkingLevel: GEMINI_THINKING_LEVEL,
    summary: parsed.summary,
    dailyObjective: parsed.dailyObjective,
    actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
    riskChecks: Array.isArray(parsed.riskChecks) ? parsed.riskChecks : [],
    allocationNotes: Array.isArray(parsed.allocationNotes) ? parsed.allocationNotes : [],
  };
}

async function runAiReview(trigger = 'manual') {
  const data = loadData();

  if (!isAiConfigured()) {
    const error = new Error('GEMINI_API_KEY가 설정되지 않아 AI 기능이 비활성화되어 있습니다.');
    error.statusCode = 503;
    recordAiError(data, error, trigger);
    saveData(data);
    throw error;
  }

  if (!data.holdings.length) {
    const error = new Error('등록된 자산이 없어 AI 분석을 생성할 수 없습니다.');
    error.statusCode = 400;
    recordAiError(data, error, trigger);
    saveData(data);
    throw error;
  }

  const targetDate = getDateInTimezone(new Date(), APP_TIMEZONE);
  upsertSnapshot(data, targetDate);

  try {
    const report = await generateGeminiReport(data, targetDate);
    data.ai.latestReport = {
      ...report,
      trigger,
      systemPromptVersion: 'quant-manager-v1',
    };
    data.ai.history = [data.ai.latestReport, ...data.ai.history].slice(0, MAX_AI_HISTORY);
    data.ai.lastRunAt = data.ai.latestReport.createdAt;
    data.ai.lastRunSource = trigger;
    data.ai.lastError = null;
    saveData(data);
    return withRuntimeState(data);
  } catch (error) {
    recordAiError(data, error, trigger);
    saveData(data);
    throw error;
  }
}

function startAiSchedule() {
  if (!isAiConfigured()) {
    console.log('[AI] GEMINI_API_KEY 없음 - AI 스케줄 비활성화');
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
        await runAiReview('schedule');
        console.log(`[AI] 일일 브리핑 생성 완료 (${getDateInTimezone(new Date(), APP_TIMEZONE)})`);
      } catch (error) {
        console.error('[AI] 일일 브리핑 생성 실패:', error.message);
      }
    },
    { timezone: APP_TIMEZONE }
  );

  console.log(`[AI] node-cron 등록 완료 (${APP_TIMEZONE} / ${AI_DAILY_CRON})`);
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/api/portfolio', (req, res) => {
  res.json(withRuntimeState(loadData()));
});

app.put('/api/portfolio', (req, res) => {
  const body = req.body;
  if (!body || !Array.isArray(body.holdings)) {
    return res.status(400).json({ error: 'holdings 배열이 필요합니다.' });
  }

  const data = loadData();
  const seen = new Set();
  data.holdings = body.holdings.map((h) => {
    let id = h.id && String(h.id);
    if (!id || seen.has(id)) id = crypto.randomUUID();
    seen.add(id);
    return {
      id,
      name: String(h.name || '이름 없음').slice(0, 200),
      category: CATEGORIES.includes(h.category) ? h.category : 'deposit',
      amount: Math.max(0, Math.round(Number(h.amount) || 0)),
    };
  });
  saveData(data);
  res.json(withRuntimeState(data));
});

app.post('/api/snapshots', (req, res) => {
  const data = loadData();
  const date = (req.body && req.body.date) || getDateInTimezone(new Date(), APP_TIMEZONE);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: '날짜는 YYYY-MM-DD 형식이어야 합니다.' });
  }
  upsertSnapshot(data, date);
  saveData(data);
  res.json(withRuntimeState(data));
});

app.delete('/api/snapshots/:date', (req, res) => {
  const { date } = req.params;
  const data = loadData();
  const before = data.snapshots.length;
  data.snapshots = data.snapshots.filter((s) => s.date !== date);
  if (data.snapshots.length === before) {
    return res.status(404).json({ error: '스냅샷을 찾을 수 없습니다.' });
  }
  saveData(data);
  res.json(withRuntimeState(data));
});

app.post('/api/ai/run', async (req, res) => {
  try {
    const result = await runAiReview('manual');
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || 'AI 실행 실패' });
  }
});

app.get('/api/system/status', (req, res) => {
  res.json(buildRuntimeState());
});

const dist = path.join(__dirname, 'dist');
app.use(express.static(dist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const index = path.join(dist, 'index.html');
  if (fs.existsSync(index)) {
    res.sendFile(index);
  } else {
    res.status(503).send('프론트엔드 빌드가 없습니다. npm run build 실행 후 다시 시도하세요.');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  const ip =
    Object.values(os.networkInterfaces())
      .flat()
      .find((item) => item && item.family === 'IPv4' && !item.internal)?.address || '127.0.0.1';
  console.log(`SimpleStock running at http://${ip}:${PORT}`);
  console.log(`[Time] ${APP_TIMEZONE} / ${getDateTimeInTimezone(new Date(), APP_TIMEZONE)}`);
  startAiSchedule();
});

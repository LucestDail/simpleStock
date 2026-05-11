const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_PATH = path.join(__dirname, 'data', 'portfolio.json');

const CATEGORIES = ['deposit', 'installment', 'stock', 'fund', 'pension'];

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.holdings)) data.holdings = [];
    if (!Array.isArray(data.snapshots)) data.snapshots = [];
    return data;
  } catch {
    return { holdings: [], snapshots: [] };
  }
}

function saveData(data) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function summarizeHoldings(holdings) {
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  let total = 0;
  for (const h of holdings) {
    const c = CATEGORIES.includes(h.category) ? h.category : 'deposit';
    byCategory[c] += h.amount;
    total += h.amount;
  }
  return { total, byCategory };
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/api/portfolio', (req, res) => {
  res.json(loadData());
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
  res.json(data);
});

app.post('/api/snapshots', (req, res) => {
  const data = loadData();
  const date =
    (req.body && req.body.date) || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: '날짜는 YYYY-MM-DD 형식이어야 합니다.' });
  }
  const { total, byCategory } = summarizeHoldings(data.holdings);
  const snap = { date, total, byCategory };
  data.snapshots = data.snapshots.filter((s) => s.date !== date);
  data.snapshots.push(snap);
  data.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  saveData(data);
  res.json(snap);
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
  res.json({ ok: true });
});

const dist = path.join(__dirname, 'dist');
app.use(express.static(dist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const index = path.join(dist, 'index.html');
  if (fs.existsSync(index)) res.sendFile(index);
  else res.status(503).send('프론트엔드 빌드가 없습니다. npm run build 실행 후 다시 시도하세요.');
});

app.listen(PORT, '0.0.0.0', () => {
  const ip =
    Object.values(require('os').networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address || '127.0.0.1';
  console.log(`SimpleStock running at http://${ip}:${PORT}`);
});

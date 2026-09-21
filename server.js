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
const { updateSettings, AI_PRESETS, MARKET_PROVIDER_OPTIONS, getDashboardSettings } = require('./server/settingsService');
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
const SESSION = require('./server/session');
const tossPortfolio = require('./server/tossPortfolio');
const tossClient = require('./server/tossClient');
const dashboardService = require('./server/dashboardService');
const orderService = require('./server/orderService');
const telegram = require('./server/telegramService');
const analyst = require('./server/analystService');
const mcp = require('./server/mcpClient');
const analystChat = require('./server/analystChat');
const analystDream = require('./server/analystDream');

// 🔴 2026-09-21: 종전에는 토큰이 없으면 `requireAccessToken` 이 그냥 next() 했다(fail-open).
//    설정 실수 한 번이 곧 전면 개방이었다. 이제 **없으면 무작위로 만들어 잠근다** —
//    운영자는 기동 로그에서 값을 보고, 아무도 모르는 채 열려 있는 상태는 만들지 않는다.
//    (선례: Probius 가 비밀번호 미설정 시 무작위 생성 후 기동 로그에 출력)
const APP_ACCESS_TOKEN = (() => {
  const configured = String(process.env.APP_ACCESS_TOKEN || '').trim();
  if (configured) return configured;
  const generated = crypto.randomBytes(24).toString('hex');
  // eslint-disable-next-line no-console
  console.warn(
    '[auth] APP_ACCESS_TOKEN 미설정 — 무작위 토큰으로 잠급니다(재기동하면 바뀝니다).\n'
      + `[auth] 이번 기동 토큰: ${generated}\n`
      + '[auth] 고정하려면 /etc/simplestock.env 등에 APP_ACCESS_TOKEN 을 설정하세요.'
  );
  return generated;
})();
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
  // ⓪ LAN 에서 온 요청은 면제한다 (2026-09-21 사용자 결정).
  //    nginx 가 이미 lanonly 로 외부를 403 으로 막았으므로 앱까지 두 번 묻는 건 마찰이다.
  //    🔴 위조 방지는 SESSION.isTrustedLanRequest 안에 있다(헤더를 함부로 믿지 않는다).
  if (SESSION.isTrustedLanRequest(req)) return next();
  // ① 브라우저 = httpOnly 세션 쿠키 (토큰이 JS 에 노출되지 않는다)
  if (SESSION.isValidSession(SESSION.readCookie(req))) return next();
  // ② 서버-대-서버(HARU 등) = 헤더 토큰. 이 경로는 남긴다.
  const token = extractAccessToken(req);
  if (token && SESSION.safeEqual(token, APP_ACCESS_TOKEN)) return next();
  return res.status(401).json({ error: '인증이 필요합니다.' });
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

// ── 내 자산 (토스 실계좌) ─────────────────────────────────────
// 🔴 저장하지 않는다 — 매번 증권사에서 읽는다. 사본을 만들면 백업으로 퍼지고,
//    그게 09-01 에 portfolio.json 을 걷어낸 이유다.
app.get('/api/portfolio', async (req, res) => {
  if (!tossPortfolio.isEnabled()) {
    return res.status(503).json({
      error: '토스 연동이 설정되지 않았습니다(TOSS_CLIENT_ID/SECRET).',
      configured: false,
    });
  }
  try {
    // 환산은 서버에서 끝낸다 — 소비자가 화면 하나가 아니다(텔레그램·API 직접조회)
    const mkt = getMarketSnapshot();
    const rate = Number(mkt?.fx?.USDKRW?.rate) || 0;
    const data = await tossPortfolio.getHoldings({
      fx: rate ? { rate, asOf: mkt?.lastRefreshAt || null, source: mkt?.providers?.fx || mkt?.provider || null } : null,
    });
    return res.json({
      ...data,
      momentum: tossPortfolio.pickMomentum(data.items, Number(req.query.momentum) || 3),
    });
  } catch (error) {
    // 실패 이유를 그대로 보여 준다 — 특히 ip-denied 는 화면에서 바로 알아야 고친다
    logError('portfolio.failed', error, { requestId: req.requestId, kind: error.kind });
    return res.status(error.kind === 'unconfigured' ? 503 : 502).json({
      error: error.message || '보유 현황을 불러오지 못했습니다.',
      kind: error.kind || 'unknown',
    });
  }
});

// ── 매매 애널리스트 (시황 → 판단 → 제안) ──────────────────────
app.post('/api/analyst/run', async (req, res) => {
  if (!tossPortfolio.isEnabled()) {
    return res.status(503).json({ error: '토스 연동이 설정되지 않았습니다.', configured: false });
  }
  try {
    const mkt = getMarketSnapshot();
    const rate = Number(mkt?.fx?.USDKRW?.rate) || 0;
    const settings = getDashboardSettings();
    const watch = getWatchlistState();
    const dash = await dashboardService.build({
      watchSymbols: (watch?.groups || []).flatMap((g) => (g.tickers || []).map((t) => t.symbol)),
      fx: rate ? { rate, asOf: mkt?.lastRefreshAt || null, source: mkt?.providers?.fx || null } : null,
      momentumPct: settings.momentumPct,
      rankingTypes: settings.rankingTypes,
      rankingCountries: settings.rankingCountries,
    });
    // 웹 검색은 **버튼을 눌렀을 때만**. 5분 타이머에 붙이면 자동으로 계속 검색하게 된다
    const useWebSearch = req.body?.useWebSearch !== false;
    const report = await analyst.analyze(dash, {
      userInstruction: settings.briefingPrompt,
      useWebSearch,
    });
    return res.json({ ...report, dashFailed: dash.failedCount, parts: dash.parts });
  } catch (error) {
    logError('analyst.failed', error, { requestId: req.requestId, kind: error.kind });
    return res.status(502).json({ error: error.message || '분석에 실패했습니다.', kind: error.kind || 'unknown' });
  }
});

/**
 * 애널리스트 채팅 — **SSE 스트리밍**.
 *
 * 🔴 사용자 지시: *"스트리밍 형태로 출력되어야 함. REST 형태로 안 나오게 주의"*
 *    ⇒ 여기서 `res.json` 을 쓰면 요구사항 위반이다. 조각이 생기는 즉시 `res.write` 한다.
 *
 * ⚠️ **SSE 는 `data:` 한 줄에 개행을 못 담는다.** 줄바꿈이 든 텍스트를 그대로 쓰면
 *    프레임이 깨져 클라이언트가 조용히 일부만 받는다 ⇒ **JSON 으로 감싸** 한 줄로 만든다
 *    (피어가 오늘 `data:` 공백 문제로 한 번 걸렸다. 같은 층의 함정이다).
 * ⚠️ nginx 가 버퍼링하면 **스트리밍이 REST 처럼 보인다** ⇒ `X-Accel-Buffering: no`.
 */
app.post('/api/analyst/chat', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const emit = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // ⚠️ 압축 미들웨어가 붙으면 flush 가 필요하다. 없으면 no-op
    if (typeof res.flush === 'function') res.flush();
  };

  /**
   * 끊긴 연결에 계속 쓰지 않는다(브라우저 탭을 닫으면 바로 일어난다).
   *
   * 🔴 **`req.on('close')` 를 쓰면 안 된다.** `express.json()` 이 본문을 이미 다 읽어서
   *    핸들러가 도는 시점에 요청 스트림은 **끝나 있고**, `close` 가 **즉시** 발화한다.
   *    첫 판이 그랬고 `event: start` 뒤로 **모든 이벤트가 막혔다** — 화면은 영원히
   *    "생각 중…" 이었을 것이다. 서비스 테스트는 전부 초록이었다(라우트 밖의 일이라서).
   *    ⇒ 연결이 살아 있는지는 **응답 쪽**(`res`)으로 판정한다.
   */
  let aborted = false;
  res.on('close', () => { aborted = true; });
  const safeEmit = (e, d) => { if (!aborted && !res.writableEnded) emit(e, d); };

  try {
    const mkt = getMarketSnapshot();
    const rate = Number(mkt?.fx?.USDKRW?.rate) || 0;
    safeEmit('start', { at: new Date().toISOString() });
    const summary = await analystChat.chat({
      message: req.body?.message,
      contextNote: String(req.body?.contextNote || '').slice(0, 800),
      fx: rate ? { rate, asOf: mkt?.lastRefreshAt || null, source: mkt?.providers?.fx || null } : null,
      emit: safeEmit,
    });
    safeEmit('done', summary);
  } catch (error) {
    logError('chat.failed', error, { requestId: req.requestId, kind: error.kind });
    // 🔴 이미 헤더를 보냈으므로 상태코드로 알릴 수 없다 — **이벤트로** 알린다
    safeEmit('error', { message: error.message || '대화에 실패했습니다.', kind: error.kind || 'unknown' });
  } finally {
    res.end();
  }
});

/**
 * dreaming — 유휴 시 이력을 되짚어 장기기억을 남긴다.
 * ⚠️ `force` 는 **수동 실행**이다(기본 꺼짐을 우회). 화면 버튼·점검용.
 */
app.get('/api/analyst/dream', (req, res) => res.json(analystDream.status()));
app.post('/api/analyst/dream', async (req, res) => {
  try {
    const r = await analystDream.dream({ force: req.body?.force === true });
    // 🔴 `ran:false` 도 200 이다 — "안 돌았다" 는 오류가 아니라 **정상적인 결과**다.
    //    다만 why 를 반드시 실어서 화면이 이유를 말할 수 있게 한다
    return res.json(r);
  } catch (e) {
    logError('dream.route_failed', e, { requestId: req.requestId });
    return res.status(500).json({ error: e.message || 'dreaming 실패' });
  }
});

/** 대화 이력(화면 복원용). 스트리밍이 아니라 이건 REST 가 맞다 */
app.get('/api/analyst/chat/history', (req, res) => {
  const rows = analystChat.readHistory({ limit: Number(req.query.limit) || 60 });
  res.json({ items: rows.filter((r) => r.role === 'user' || r.role === 'assistant') });
});

/**
 * 선택한 종목의 뉴스. 🔴 **검색어는 `mcpClient.buildQuery` 가 만든다** —
 * 여기서 문자열을 조립하면 수량·금액이 섞여 들어갈 길이 하나 더 생긴다(가드를 우회하는 셈).
 */
app.get('/api/news', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  const name = String(req.query.name || '').trim();
  if (!symbol && !name) return res.status(400).json({ error: 'symbol 또는 name 이 필요합니다.' });
  const r = await mcp.searchMarketNews([{ symbol, name }], { maxSubjects: 1 });
  if (!r.ok) {
    // ⚠️ "뉴스가 없다" 와 "못 받았다" 를 화면이 구분할 수 있게 kind 를 그대로 준다
    return res.status(200).json({ ok: false, error: r.error, kind: r.kind, items: [] });
  }
  const hit = r.results[0] || {};
  if (hit.error) return res.status(200).json({ ok: false, error: hit.error, kind: hit.kind, items: [] });
  return res.json({ ok: true, tool: r.tool, query: hit.query, items: parseNews(hit.text || '') });
});

/**
 * `webSearch` 는 **서식 문자열**을 돌려준다(구조화 JSON 이 아니다).
 * ```
 * 1. 제목 - 매체
 *    Wed, 11 Mar 2026 07:00:00 GMT
 *    https://...
 * ```
 * ⚠️ 규칙을 우리가 정하는 것이므로 **못 맞추면 버리지 말고 원문을 남긴다**
 *    (형식이 바뀌면 조용히 빈 목록이 되는 게 최악이다).
 */
function parseNews(text) {
  const items = [];
  const blocks = String(text).split(/\n(?=\s*\d+\.\s)/);
  for (const b of blocks) {
    const m = /^\s*(\d+)\.\s*(.+?)\s*$/m.exec(b);
    if (!m) continue;
    const url = (/https?:\/\/\S+/.exec(b) || [null])[0];
    const when = (/^\s*((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),[^\n]+)$/m.exec(b) || [null, null])[1];
    items.push({ rank: Number(m[1]), title: m[2], url, when });
  }
  return items;
}

/**
 * MCP 연계 상태·도구 목록.
 * ⚠️ **화면이 "무엇이 붙어 있는지" 를 볼 수 있어야 한다** — 안 그러면 검색이 안 도는 것과
 *    도구가 없는 것과 토큰이 틀린 것이 전부 "결과 없음" 으로 똑같이 보인다.
 */
app.get('/api/mcp/status', async (req, res) => {
  const base = mcp.status();
  if (!base.configured || !base.enabled) return res.json({ ...base, tools: null });
  try {
    const tools = await mcp.listTools({ refresh: req.query.refresh === 'true' });
    return res.json({ ...mcp.status(), tools: tools.map((t) => t.name) });
  } catch (e) {
    return res.json({ ...base, tools: null, error: e.message, kind: e.kind || 'unknown' });
  }
});

// ── 텔레그램 (밖에서 받는 창구) ────────────────────────────────
app.get('/api/telegram/status', (req, res) => res.json(telegram.status()));

/** 지금 자산 현황을 한 통 보낸다. 🔴 기본은 dry-run 이라 실제로 안 나간다 */
app.post('/api/telegram/portfolio', async (req, res) => {
  try {
    const mkt = getMarketSnapshot();
    const rate = Number(mkt?.fx?.USDKRW?.rate) || 0;
    const p = await tossPortfolio.getHoldings({
      fx: rate ? { rate, asOf: mkt?.lastRefreshAt || null, source: mkt?.providers?.fx || null } : null,
    });
    const r = await telegram.send(telegram.formatPortfolio(p), { reason: 'portfolio' });
    return res.status(r.ok ? 200 : 502).json(r);
  } catch (e) {
    logError('telegram.portfolio_failed', e, { requestId: req.requestId });
    return res.status(502).json({ ok: false, error: e.message, kind: e.kind || 'unknown' });
  }
});

// ── 주문 제안 (제안 → 승인 → 실행). 🔴 실행은 현재 no-op ────────
app.get('/api/orders/proposals', (req, res) => {
  res.json({ status: orderService.status(), proposals: orderService.list() });
});

app.post('/api/orders/proposals', (req, res) => {
  const r = orderService.propose(req.body || {}, { source: String(req.body?.source || 'manual') });
  // 빠진 값을 400 으로 돌려준다 — **승인 화면에서 채우게 두지 않는다**
  return res.status(r.ok ? 201 : 400).json(r);
});

app.post('/api/orders/proposals/:id/approve', (req, res) => {
  const r = orderService.approve(req.params.id);
  return res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/orders/proposals/:id/reject', (req, res) => {
  const r = orderService.reject(req.params.id, req.body?.reason);
  return res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/orders/proposals/:id/execute', async (req, res) => {
  const r = await orderService.execute(req.params.id);
  return res.status(r.ok ? 200 : 400).json(r);
});

// ── 대시보드 (한 화면에 필요한 것을 한 번에) ──────────────────
app.get('/api/dashboard', async (req, res) => {
  if (!tossPortfolio.isEnabled()) {
    return res.status(503).json({ error: '토스 연동이 설정되지 않았습니다.', configured: false });
  }
  try {
    const mkt = getMarketSnapshot();
    const rate = Number(mkt?.fx?.USDKRW?.rate) || 0;
    const watch = getWatchlistState();
    const watchSymbols = (watch?.groups || []).flatMap((g) => (g.tickers || []).map((t) => t.symbol));
    const data = await dashboardService.build({
      watchSymbols,
      fx: rate ? { rate, asOf: mkt?.lastRefreshAt || null, source: mkt?.providers?.fx || null } : null,
      momentumPct: Number(req.query.momentum) || getDashboardSettings().momentumPct,
      rankingTypes: getDashboardSettings().rankingTypes,
      rankingCountries: getDashboardSettings().rankingCountries,
    });
    // ⚠️ 조각이 하나라도 실패하면 **200 이지만 그 사실을 몸통에 담아** 보낸다.
    //    실패를 502 로 바꾸면 나머지 멀쩡한 조각까지 화면에서 사라진다.
    return res.json({ ...data, market: mkt, watchlist: watch, settings: getDashboardSettings() });
  } catch (error) {
    logError('dashboard.failed', error, { requestId: req.requestId, kind: error.kind });
    return res.status(502).json({ error: error.message || '대시보드를 만들지 못했습니다.', kind: error.kind || 'unknown' });
  }
});

// 개별 조회 — 화면에서 종목을 고를 때만 부른다(한도를 아낀다)
app.get('/api/toss/candles', async (req, res) => {
  try {
    res.json(await tossClient.getCandles(String(req.query.symbol || ''), {
      interval: req.query.interval === '1m' ? '1m' : '1d',
      count: Number(req.query.count) || 120,
    }));
  } catch (e) {
    res.status(502).json({ error: e.message, kind: e.kind || 'unknown' });
  }
});

app.get('/api/toss/orderbook', async (req, res) => {
  try {
    res.json(await tossClient.getOrderbook(String(req.query.symbol || '')));
  } catch (e) {
    res.status(502).json({ error: e.message, kind: e.kind || 'unknown' });
  }
});

app.get('/api/toss/investor-trading', async (req, res) => {
  try {
    res.json({ records: await tossClient.getInvestorTrading(String(req.query.symbol || '')) });
  } catch (e) {
    res.status(502).json({ error: e.message, kind: e.kind || 'unknown' });
  }
});

// ── 인증 ─────────────────────────────────────────────────────────
// 토큰을 **한 번만** 제출하고 이후에는 httpOnly 쿠키로 다닌다.
// ⚠️ /api 밖에 둔다 — 로그인하려면 인증을 통과해야 하는 순환을 만들지 않기 위해서다.
const LOGIN_WINDOW_MS = 5 * 60_000;
const LOGIN_MAX_FAILS = 5;
const loginFails = new Map(); // ip → { count, until }

function loginBlocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return false;
  if (rec.until <= Date.now()) {
    loginFails.delete(ip);
    return false;
  }
  return rec.count >= LOGIN_MAX_FAILS;
}

function noteLoginFail(ip) {
  const now = Date.now();
  const rec = loginFails.get(ip);
  if (!rec || rec.until <= now) loginFails.set(ip, { count: 1, until: now + LOGIN_WINDOW_MS });
  else rec.count += 1;
}

app.post('/auth/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (loginBlocked(ip)) {
    // ⚠️ 계정 잠금이 아니라 **그 출처만** 잠시 막는다(선례: Probius).
    logInfo('auth.login.blocked', { requestId: req.requestId });
    return res.status(429).json({ error: '시도가 너무 많습니다. 잠시 후 다시 시도하세요.' });
  }
  const token = String(req.body?.token || '').trim();
  if (!token || !SESSION.safeEqual(token, APP_ACCESS_TOKEN)) {
    noteLoginFail(ip);
    logInfo('auth.login.failed', { requestId: req.requestId });
    return res.status(401).json({ error: '토큰이 올바르지 않습니다.' });
  }
  loginFails.delete(ip);
  const id = SESSION.createSession();
  res.setHeader('Set-Cookie', SESSION.buildSetCookie(id, { secure: req.secure }));
  logInfo('auth.login.ok', { requestId: req.requestId });
  return res.json({ ok: true, expiresInMs: SESSION.SESSION_TTL_MS });
});

app.post('/auth/logout', (req, res) => {
  SESSION.destroySession(SESSION.readCookie(req));
  res.setHeader('Set-Cookie', SESSION.buildClearCookie());
  return res.json({ ok: true });
});

// 🔴 무인증으로 열려 있다. **인증 여부(불리언)만** 답하고 토큰·설정·규모를 담지 않는다
//    (무인증 /health 가 토큰을 흘린 2026-09-21 사고와 같은 자리다).
app.get('/auth/status', (req, res) => {
  const lan = SESSION.isTrustedLanRequest(req);
  res.json({
    authenticated: lan || SESSION.isValidSession(SESSION.readCookie(req)),
    // 왜 통과했는지 화면이 알 수 있게 — 'lan' 이면 로그인 UI 를 아예 안 그린다
    via: lan ? 'lan' : 'session',
  });
});

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
    // 화면 설정 패널이 읽는 곳. **기본값이 적용된 실효값**과 무엇이 기본값인지를 함께 준다.
    dashboardSettings: getDashboardSettings(),
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

// ── 헬스 ──────────────────────────────────────────────────────────
// 🔴 이 라우트는 **정적 프론트보다 먼저** 있어야 한다. (2026-09-21)
//
// 게이트웨이(nginx)가 `location = /simpleStock/health` 를 **gwauth 없이 무인증으로**
// 노출한다(허브 상태점검이 401 팝업을 띄우지 않게 하려고 만든 자리).
// 그런데 이 라우트가 없으면 요청이 아래 catch-all 로 떨어져 `index.html` 이 나가고,
// 그 HTML 에는 **접근 토큰이 주입됐었다**(`window.__SIMPLESTOCK_ACCESS_TOKEN__`).
// ⚠️ 2026-09-21 오후에 그 주입을 없앴다(세션 쿠키로 대체). 이 주석은 사고 경위 기록이다 —
//    현재형으로 읽으면 안 된다.
//
// 2026-09-21 실측: 인터넷에서 `GET /simpleStock/health` 로 **토큰 31자를 그대로 받았다.**
// (본체 `/simpleStock/` 는 401 로 막혀 있었으므로 이 경로 하나가 구멍이었다.)
//
// 그리고 같은 이유로 **헬스가 헬스가 아니었다** — 아무 경로나 200+HTML 이라
// 정적 파일만 서빙되면 통과했고, DB·API 가 죽어도 허브는 "정상" 으로 보였다.
//
// ⚠️ 무인증 = 공개다. **규모 정보(종목 수·사용자 수·호스트 목록)를 담지 말 것.**
// ⚠️ 이 헬스는 **프로세스가 응답한다는 것만** 말한다. 의존물(시세 업스트림·데이터
//    디렉토리)은 **보지 않는다** — 담으려면 별도 작업이고, 그때까지 이 응답을
//    "전부 정상" 으로 읽으면 안 된다.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'simplestock', checks: 'process-only' });
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
  // 🔴 2026-09-21: 여기서 `window.__SIMPLESTOCK_ACCESS_TOKEN__` 로 토큰을 주입했었다.
  //    페이지를 받을 수 있는 누구나 토큰을 갖는 구조였고, 무인증 /health 가 이 catch-all 로
  //    떨어지면서 **실제로 외부에 샜다**. 이제 아무것도 주입하지 않는다 —
  //    프론트는 /auth/login 으로 한 번 제출하고 httpOnly 쿠키를 받는다.
  res.type('html').send(fs.readFileSync(indexPath, 'utf8'));
});

async function startAiSchedule() {
  const usePresetBriefSchedule =
    String(process.env.MANAGER_BRIEF_PRESET_SCHEDULE ?? 'true').trim().toLowerCase() !== 'false';

  if (usePresetBriefSchedule) {
    await ensureManagerBriefSchedule();
  }

  // ⚠️ 조용한 우회를 만들지 않는다 — LAN 면제가 켜져 있으면 그 사실을 기동 때 말한다
  logInfo('orders.mode', orderService.status());
  // 조용히 켜져 있지도, 조용히 꺼져 있지도 않게 — 어느 쪽이 막는지 이유까지 남긴다
  logInfo('telegram.mode', telegram.status());
  // 어느 쪽이 막고 있는지(미설정/꺼짐)까지 기동 로그에 남긴다
  logInfo('mcp.mode', mcp.status());
  // 무인 반복은 켜졌는지·왜 안 도는지를 기동 때 말한다
  logInfo('dream.mode', analystDream.status());
  logInfo('llm.fetch_probe', require('./server/geminiClient').describeFetchProbe());
  logInfo('auth.lan_trust', {
    enabled: SESSION.TRUST_LAN,
    note: SESSION.TRUST_LAN
      ? '사설 대역 요청은 앱 로그인을 면제합니다(nginx lanonly 전제). 끄려면 SIMPLESTOCK_TRUST_LAN=false'
      : '모든 요청이 앱 로그인을 요구합니다',
  });
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

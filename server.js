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
const { logInfo, logWarn, logError } = require('./server/logger');
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
const { resolveTickerByName } = require('./server/tickerLookupService');
const { THEME_PRESETS } = require('./server/themePresets');
const stockRating = require('./server/stockRating');

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
const tape = require('./server/tickerTapeService');
const telegramBot = require('./server/telegramBot');
const alerts = require('./server/alertService');
const activity = require('./server/activityLog');

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
    /**
     * 🔴 **점검용 실행** — `{"dryRun": true}` 면 텔레그램도 안 가고 제안도 안 만든다.
     *    pm2: *"검증이 곧 발송이라 이 경로를 앞으로 검증할 수 없다."*
     *    **검증할 수 없는 경로는 결국 검증 안 된 채로 배포된다** ⇒ 부작용 없는 문을 낸다.
     *    ⚠️ 기본은 `false` 다 — 사용자 지시 *"애널리스트가 판단하면 바로 쏴"* 를 바꾸지 않는다.
     */
    const dryRun = req.body?.dryRun === true;
    const report = await analyst.analyze(dash, {
      userInstruction: settings.briefingPrompt,
      useWebSearch,
      // ⚠️ 계좌는 원화, 종목은 달러일 수 있다 — 수량 계산에 환율이 필요하다
      fx: rate ? { rate } : null,
      dryRun,
    });
    return res.json({ ...report, dryRun, dashFailed: dash.failedCount, parts: dash.parts });
  } catch (error) {
    logError('analyst.failed', error, { requestId: req.requestId, kind: error.kind });
    return res.status(502).json({ error: error.message || '분석에 실패했습니다.', kind: error.kind || 'unknown' });
  }
});

/**
 * 종목 계층 평가 — 10항목 100점.
 * ⚠️ LLM 을 쓰므로 느리다(10~20초). 화면은 로딩을 보여줘야 한다.
 */
app.get('/api/rate/:symbol', async (req, res) => {
  try {
    const raw2 = String(req.params.symbol || '').trim().toUpperCase();
    // 한국 6자리 코드는 야후 형식으로
    const sym = /^\d{6}$/.test(raw2) ? `${raw2}.KS` : raw2;
    return res.json(await stockRating.rate(sym));
  } catch (e) {
    logError('rating.failed', e, { requestId: req.requestId, kind: e.kind });
    return res.status(e.kind === 'not-found' ? 404 : 502).json({ error: e.message, kind: e.kind || 'unknown' });
  }
});

/**
 * 대표 테마 프리셋을 넣는다 (2026-09-21 사용자 지시: *"8가지 넣어서 10가지 테마로"*).
 *
 * 🔴 **멱등이다** — 이미 같은 이름의 테마가 있으면 **건너뛴다**. 두 번 눌러도 안 늘어난다.
 * ⚠️ 종목 추가가 실패해도(상장폐지·티커 변경) **그 종목만 건너뛰고** 몇 개를 못 넣었는지
 *    돌려준다. 조용히 빠지면 "원래 4개짜리 테마" 로 보인다.
 */
app.post('/api/watchlist/presets', async (req, res) => {
  const added = [];
  const skipped = [];
  const failedTickers = [];
  const quoteless = [];
  try {
    for (const preset of THEME_PRESETS) {
      const state = getWatchlistState();
      if ((state.groups || []).some((g) => g.name === preset.name)) {
        skipped.push(preset.name);
        continue;
      }
      const g = await createGroup(preset.name);
      const gid = g?.id || g?.group?.id || (getWatchlistState().groups || []).find((x) => x.name === preset.name)?.id;
      if (!gid) { failedTickers.push(`${preset.name}: 그룹 생성 실패`); continue; }
      for (const t of preset.tickers) {
        try {
          await addTicker(gid, { symbol: t.symbol, name: t.name, market: t.market });
        } catch (e) {
          failedTickers.push(`${preset.name}/${t.symbol}: ${e.message}`);
        }
      }
      /**
       * 🔴 **"추가됐다" 와 "시세가 붙었다" 는 다르다** (2026-09-21 실측).
       *    `BRK-B` 는 추가는 됐는데 토스가 티커를 몰라 `quote: null` 이었고,
       *    `failedTickers: 0` 이라 **전부 성공한 것처럼** 보였다.
       *    ★ *"대상이 0건인가" 가 아니라 "재려던 것이 대상에 들었나"* — 여기서 또 걸렸다.
       * ⚠️ 시세는 비동기로 채워지므로 **지금 null 이라고 죽은 티커는 아니다** ⇒ 실패가 아니라
       *    `quoteless` 로 따로 보고한다(사람이 보고 판단할 수 있게).
       */
      const after = (getWatchlistState().groups || []).find((x) => x.id === gid);
      for (const t of after?.tickers || []) {
        if (!t.quote) quoteless.push(`${preset.name}/${t.symbol}`);
      }
      added.push(preset.name);
    }
    logInfo('watchlist.presets', {
      added: added.length, skipped: skipped.length, failed: failedTickers.length, quoteless: quoteless.length,
    });
    return res.json({ ok: true, added, skipped, failedTickers, quoteless });
  } catch (e) {
    logError('watchlist.presets_failed', e, { requestId: req.requestId });
    return res.status(500).json({ error: e.message, added, skipped, failedTickers, quoteless });
  }
});

/**
 * 종목 검색 — **이름으로도** 찾는다 (2026-09-21 사용자: *"삼성전자 검색하면 안뜨는데"*).
 *
 * ⚠️ 종전 랭킹 검색은 **입력값을 그대로 종목 코드로** 썼다. 그래서 `005930` 은 되고
 *    `삼성전자` 는 안 됐다 — 한글을 티커로 보내니 당연히 없다.
 * ⇒ ①토스 `/stocks` 로 **코드로** 먼저 확인 ②안 되면 `resolveTickerByName` 으로 이름 해석.
 *   🔴 순서가 중요하다 — 코드처럼 생긴 입력을 이름 검색에 보내면 엉뚱한 종목이 나온다.
 */
app.get('/api/lookup', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: '검색어가 필요합니다.' });

  // ① 코드로 보고 조회 — 맞으면 이름까지 돌려준다
  try {
    const info = await tossClient.getStockInfo([q.toUpperCase()]);
    const hit = info.get(q.toUpperCase());
    if (hit?.name) {
      return res.json({ ok: true, by: 'symbol', symbol: q.toUpperCase(), name: hit.name, market: hit.market });
    }
  } catch (e) {
    // 코드 조회 실패는 **이름 검색을 막지 않는다**(둘은 독립된 경로다)
    logInfo('lookup.symbol_miss', { q, message: e.message });
  }

  // ② 이름으로 해석
  try {
    const c = await resolveTickerByName(q);
    if (c?.symbol) return res.json({ ok: true, by: 'name', symbol: c.symbol, name: c.name || q, market: c.market || null });
  } catch (e) {
    logWarn('lookup.name_failed', { q, message: e.message });
  }
  // 🔴 "못 찾았다" 를 200+빈값으로 주지 않는다 — 화면이 "없다" 와 "실패" 를 구분해야 한다
  return res.status(404).json({ ok: false, error: `'${q}' 를 찾지 못했습니다.` });
});

/**
 * 헤더 시세 테이프 — 환율·지수·원자재·코인.
 * ⚠️ 토스가 아니라 Yahoo 다(토스는 종목만 준다). 무인증이라 캐시로 아껴 쓴다.
 */
app.get('/api/tape', async (req, res) => {
  try {
    const t = await tape.getTape({ force: req.query.force === 'true' });
    // 🔴 몇 개를 못 받았는지 함께 준다 — 화면이 "없다" 와 "못 받았다" 를 구분해야 한다
    // 고정 칸(원/달러)과 흐르는 칸을 **갈라서** 준다 — 화면이 둘을 다르게 놓는다
    return res.json({ items: t.items, fixed: t.fixed || [], failed: t.failed, cached: Boolean(t.cached), stale: Boolean(t.stale) });
  } catch (e) {
    logError('tape.failed', e, { requestId: req.requestId });
    return res.status(502).json({ error: e.message || '시세 테이프를 불러오지 못했습니다.', items: [] });
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

/**
 * 매매 분석을 텔레그램으로 보낸다(사용자 지시: *"매매 분석 및 시황 분석 / 텔레그램 발송"*).
 * ⚠️ 분석을 **다시 돌리지 않는다** — 화면이 들고 있는 리포트를 그대로 보낸다.
 *    다시 돌리면 화면과 폰의 내용이 달라져 "어느 쪽이 맞나" 가 된다.
 * 🔴 기본이 dry-run 이다(`TELEGRAM_SEND_ENABLED`). 안 갔으면 **안 갔다고** 돌려준다.
 */
app.post('/api/analyst/telegram', async (req, res) => {
  const r = req.body?.report;
  if (!r || typeof r !== 'object') return res.status(400).json({ error: '보낼 리포트가 없습니다.' });
  const lines = ['📋 매매 분석'];
  if (r.marketView) lines.push('', r.marketView);
  if (r.momentumRead) lines.push('', `[모멘텀] ${r.momentumRead}`);
  for (const p of r.positions || []) {
    lines.push('', `· ${p.symbol} ${p.stance}/${p.confidence} — ${p.rationale}`);
  }
  for (const c of r.created || []) {
    lines.push('', `🟡 제안 ${c.side} ${c.symbol} ${c.quantity}주 @ ${c.price} (승인 대기)`);
  }
  if (r.dataGaps?.length) lines.push('', `못 본 것: ${r.dataGaps.join(' · ')}`);

  const out = await telegram.send(lines.join('\n'), { reason: 'analyst' });
  return res.json(out);
});

/**
 * 🔴 대화 초기화 — **서버 이력까지** 지운다.
 * ⚠️ 화면만 비우면 다음 접속에 되살아나고, 더 나쁘게는 **recall 이 계속 그걸 물어 온다.**
 *    지우는 것이 맞는 자리다(대화는 감사 기록이 아니다).
 */
app.delete('/api/analyst/chat/history', (req, res) => {
  const r = analystChat.clearHistory();
  return res.json(r);
});

/**
 * 활동 타임라인 — 분석·알림·제안·승인을 **한 시간축**으로.
 * ⚠️ 종전에는 세 곳에 흩어져 있어(화면 메모리 · 로그 파일 · 감사 JSONL) 사람이 못 봤다.
 */
app.get('/api/activity', (req, res) => {
  const kinds = String(req.query.kinds || '').trim();
  res.json({
    items: activity.list({
      limit: Math.min(300, Number(req.query.limit) || 80),
      kinds: kinds ? kinds.split(',') : null,
    }),
  });
});
app.delete('/api/activity', (req, res) => res.json(activity.clear()));

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
app.get('/api/telegram/status', (req, res) =>
  // 🔴 피어 요청: 폴링이 죽으면 **앱은 멀쩡한데 버튼만 안 먹는다** — 워치독이 볼 수 있게 낸다
  res.json({
    ...telegram.status(),
    /**
     * 🔴 피어 요청: **폴링이 죽으면 조용하다** — 앱은 멀쩡하고 버튼만 안 먹는다.
     *    워치독이 한 칸만 보면 되게 **평평하게도** 낸다(`bot.running` 과 같은 값이다).
     */
    botPolling: telegramBot.status().running,
    bot: telegramBot.status(),
    alerts: alerts.status(),
  }));

/** 알림 한 바퀴를 손으로 돌린다(점검용). `force` 면 꺼져 있어도 돈다 */
app.post('/api/alerts/tick', async (req, res) => {
  try {
    /**
     * 🔴 `force` 는 **돌리기만** 한다 — 보내지 않는다(2026-09-21 사고 후 분리).
     *    실제로 보내 보려면 `{"force":true,"send":true}` 로 **명시**해야 한다.
     */
    return res.json(await alerts.tick({
      force: req.body?.force === true,
      dryRun: req.body?.dryRun === true,
      send: req.body?.send === true,
    }));
  } catch (e) {
    logError('alerts.route_failed', e, { requestId: req.requestId });
    return res.status(500).json({ error: e.message });
  }
});

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
  /**
   * 🔴 `{"notify": false}` 면 **폰의 승인 버튼을 안 보낸다**(점검용).
   *    pm2 가 이 경로로 영속화를 검증하다 사용자 폰에 버튼을 보냈다 — 본인은 안 보내는 줄 알았다.
   *    발송이 **리스너**에서 일어나 함수 본문만 봐서는 안 보이기 때문이다.
   *    ⚠️ 기본은 **보낸다** — 사용자 지시를 바꾸지 않는다.
   */
  const notify = req.body?.notify !== false;
  const r = orderService.propose(req.body || {}, { source: String(req.body?.source || 'manual'), notify });
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
/**
 * 🔴 **`index.html` 을 캐시하면 배포해도 사용자가 못 본다** (2026-09-21 실결함).
 *
 * 사용자: *"화면 개선 내가 준거 진행한거야? 화면이 그대로인데?"*
 * 확인해 보니 라이브 번들에는 새 코드가 **다 들어 있었다**(마커 6종 js·css 각 1건).
 * 바뀌지 않은 것은 **브라우저가 들고 있는 `index.html`** 이었다 — 거기에 옛 asset 해시가
 * 적혀 있으니 새 파일을 아예 요청하지 않는다.
 * ⚠️ 종전에는 `Cache-Control` 이 **없었다**. 없으면 "캐시하지 마라" 가 아니라
 *    **브라우저가 알아서 정한다**(휴리스틱 캐싱). 그게 이 증상의 원인이다.
 *
 * ⇒ 갈라서 다룬다:
 *   · `assets/*` — 파일명에 **내용 해시**가 있다. 내용이 바뀌면 이름이 바뀌므로 **영구 캐시**가 안전하다
 *   · `index.html` — 그 해시를 가리키는 **지도**다. 절대 캐시하면 안 된다
 *
 * ★ 이건 "배포했는데 사용자는 못 본다" 는 부류라 **배포 검증으로도 안 잡힌다** —
 *   서버 번들에는 마커가 있으니 전부 초록으로 보인다. 사용자가 말해 줘야 안다.
 */
app.use(
  express.static(dist, {
    index: false,
    setHeaders(res, filePath) {
      if (/[\\/]assets[\\/]/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);
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
  // 🔴 지도는 캐시하지 않는다 — 여기서 캐시되면 새 번들을 영영 안 받는다
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
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
  logInfo('telegram.bot', telegramBot.status());
  logInfo('alerts.mode', alerts.status());
  // 🔴 제안 → 텔레그램(승인 버튼). 알림이 꺼져 있으면 onProposal 이 스스로 건너뛴다
  orderService.onProposed((p) => alerts.onProposal(p));
  // 🔴 끝난 제안은 **폰의 버튼도 지운다** — 안 지우면 사용자가 아직 결정할 게 있다고 믿는다
  orderService.onSettled((p, why) => alerts.onProposalSettled(p, why));
  telegramBot.start();
  alerts.start();

  /**
   * 🔴 매매 분석 **자동 실행** (2026-09-21 사용자: *"분석 실행해야 시작하는거야?"*).
   * ⚠️ **기본 꺼짐**이다 — LLM 을 주기적으로 부르면 비용이 선형으로 는다.
   *    `ANALYST_AUTO_CRON` 에 cron 을 주면 그때만 돈다(예: 장 시작·마감).
   * ★ 결과는 화면이 아니라 **활동 기록**에 남는다 — 그래서 새로고침해도 시간순으로 보인다.
   */
  const autoCron = String(process.env.ANALYST_AUTO_CRON || '').trim();
  if (autoCron && cron.validate(autoCron)) {
    cron.schedule(autoCron, async () => {
      try {
        const mkt = getMarketSnapshot();
        const rate = Number(mkt?.fx?.USDKRW?.rate) || 0;
        const st = getDashboardSettings();
        const watch = getWatchlistState();
        const dash = await dashboardService.build({
          watchSymbols: (watch?.groups || []).flatMap((g) => (g.tickers || []).map((t) => t.symbol)),
          fx: rate ? { rate, asOf: mkt?.lastRefreshAt || null, source: mkt?.providers?.fx || null } : null,
          momentumPct: st.momentumPct,
          rankingTypes: st.rankingTypes,
          rankingCountries: st.rankingCountries,
        });
        const r = await analyst.analyze(dash, { userInstruction: st.briefingPrompt, fx: rate ? { rate } : null });
        logInfo('analyst.auto', { positions: r.positions?.length || 0, created: r.created?.length || 0 });
      } catch (e) {
        // 자동 실행이 실패해도 앱은 돈다. 다만 **조용하지 않다**
        logError('analyst.auto_failed', e, {});
      }
    }, { timezone: APP_TIMEZONE });
    logInfo('analyst.auto_scheduled', { cron: autoCron });
  } else {
    // 🔴 "안 켜져 있다" 를 기동 로그에 남긴다 — 사용자가 자동인 줄 알고 기다리지 않게
    logInfo('analyst.auto_off', { reason: autoCron ? 'invalid_cron' : 'unset', cron: autoCron || null });
  }
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

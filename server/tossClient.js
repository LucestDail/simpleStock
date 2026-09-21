const { logInfo, logWarn, logError } = require('./logger');

/**
 * 토스증권 Open API 클라이언트 (2026-09-21 신설)
 *
 * ## 설계 근거는 전부 **실측**이다 (추측 아님)
 *
 * 스펙(`toss_security.json`)에는 Rate Limit **그룹 이름 17개만** 있고 숫자가 없다.
 * 그래서 붙이기 전에 `.25` 에서 한 번 찔러 봤고, **응답 헤더가 숫자를 준다**:
 *
 * ```
 * /oauth2/token        x-ratelimit-limit=5   reset=1
 * /api/v1/prices       x-ratelimit-limit=15  reset=1     ← 200종목을 1콜로
 * /market-calendar/KR  x-ratelimit-limit=3   reset=1
 * /exchange-rate       x-ratelimit-limit=3   reset=1
 * 연속 10회 → 6번째에 429.  ⚠️ **retry-after 가 null** 이라 물러서기를 우리가 정해야 한다
 * 토큰 expires_in=86399s(24h) · 가격은 **문자열**("272500") · 응답은 {result:…}
 * ```
 *
 * 🔴 **KR 시세 6시간 캐시의 근거가 사라졌다.** 그건 공공데이터포털 쿼터 때문이었는데,
 *    여기서는 200종목이 1콜이고 초당 15콜이 된다.
 *
 * ## 이 API 로 일할 때 알아야 하는 것 둘
 *
 * 1. 🔴 **허용 IP 가 한 개로 고정돼 있다**(발급 시 등록한 공인 IP). 집 IP 는 **고정이 아니다** —
 *    `oshhome.duckdns.org` 를 쓰는 이유가 그것이다. 바뀌는 날 **전부 403** 이 되고
 *    증상은 "시세가 안 온다" 로만 보인다 ⇒ 403 을 **IP 문제로 명시**해 로그에 남긴다.
 *    ⚠️ 회사망(Zscaler)에서는 출구 IP 가 달라 **개발 PC 에서 호출이 안 된다.**
 * 2. **샌드박스가 없다**(`tsck_live_`/`tssk_live_`만 발급된다). 주문 계열은
 *    **HITL 승인 흐름을 no-op 으로 한 바퀴 돌린 뒤에만** 연결한다. 이 파일에는 주문이 없다.
 */

const BASE_URL = String(process.env.TOSS_BASE_URL || 'https://openapi.tossinvest.com').replace(/\/+$/, '');
const CLIENT_ID = String(process.env.TOSS_CLIENT_ID || '').trim();
const CLIENT_SECRET = String(process.env.TOSS_CLIENT_SECRET || '').trim();

const TIMEOUT_MS = Math.max(3000, Number(process.env.TOSS_TIMEOUT_MS) || 10000);
/** 토큰 만료 전에 미리 갱신할 여유 — 만료 직전 호출이 401 로 새는 것을 막는다 */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;
/** 429 를 맞으면 이 창 동안 그 경로를 쉰다. retry-after 가 없으므로 우리가 정한다 */
const BACKOFF_BASE_MS = 1500;
const BACKOFF_MAX_MS = 60_000;

let token = null; // { value, expiresAt }
let tokenInflight = null;
/** path prefix → { until, streak } */
const backoff = new Map();
/** 실측된 한도를 담아 둔다 — 상위 계층이 갱신 주기를 정할 때 쓴다 */
const observedLimits = new Map();
/** 429 원인 추적용 — 프로세스 시작 이후 호출 수와 경로별 호출 수 */
let callCount = 0;
const pathCounts = new Map();

function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

class TossError extends Error {
  constructor(message, { kind, status, path }) {
    super(message);
    this.name = 'TossError';
    this.kind = kind; // 'unconfigured' | 'ip-denied' | 'auth' | 'rate-limited' | 'timeout' | 'upstream' | 'shape'
    this.status = status;
    this.path = path;
  }
}

/**
 * 🔴 **토스의 Rate Limits Group** (명세 v1.2.17). 우리 내부 버킷(경로)과 다르다 —
 *    경로로 역추정하면 종목마다 버킷이 갈려서 **여유를 못 합산한다.**
 * ⚠️ 명세의 태그 → 그룹 대응을 그대로 옮겼다. **모르면 `null`** 이지 추측하지 않는다.
 */
function tossGroupOf(path) {
  const p = String(path).split('?')[0];
  if (p.startsWith('/oauth2/')) return 'AUTH';
  if (p === '/api/v1/accounts') return 'ACCOUNT';
  if (p === '/api/v1/holdings') return 'ASSET';
  if (p === '/api/v1/buying-power' || p === '/api/v1/commissions' || p === '/api/v1/sellable-quantity') return 'ORDER_INFO';
  if (p === '/api/v1/candles') return 'MARKET_DATA_CHART';
  if (['/api/v1/prices', '/api/v1/orderbook', '/api/v1/price-limits', '/api/v1/trades'].includes(p)) return 'MARKET_DATA';
  if (p === '/api/v1/market-indicators/prices') return 'MARKET_INDICATOR';
  if (/^\/api\/v1\/market-indicators\/[^/]+\/candles$/.test(p)) return 'MARKET_INDICATOR_CHART';
  if (p.startsWith('/api/v1/market-indicators/')) return 'MARKET_INDICATOR';
  if (p.startsWith('/api/v1/market-calendar') || p === '/api/v1/exchange-rate') return 'MARKET_INFO';
  if (p === '/api/v1/rankings') return 'RANKING';
  if (p === '/api/v1/stocks/all') return 'STOCK_ALL';
  if (/^\/api\/v1\/stocks\/[^/]+\/(investor-trading|short-selling|program-trades|credit-trades|securities-lending)$/.test(p)) return 'STOCK_TRADING_TREND';
  if (p.startsWith('/api/v1/stocks')) return 'STOCK';
  if (p.startsWith('/api/v1/conditional-orders')) return 'CONDITIONAL_ORDER';
  if (p.startsWith('/api/v1/orders')) return 'ORDER';
  return null;
}

/** 그룹별 나가는 호출 수 — 🔴 **분모다.** 이게 없으면 "429 0건" 이 *여유* 인지 *안 불렀다* 인지 안 갈린다 */
const groupCalls = new Map();

/** 버킷별로 마지막에 본 잔여치 — 같은 값을 반복해 찍지 않으려고 들고 있는다 */
const rateSeen = new Map();
/** 이 밑으로 떨어지면 시끄럽게 — 기본 20% */
const RATE_WARN_RATIO = Math.min(1, Math.max(0, Number(process.env.TOSS_RATE_WARN_RATIO) || 0.2));

/**
 * `X-RateLimit-*` 를 읽어 남긴다.
 * ⚠️ **없으면 조용히 넘어간다** — 헤더가 없는 것과 한도가 없는 것은 다르지만,
 *    여기서 그걸 오류로 다루면 멀쩡한 호출이 실패한다. 대신 `seen:false` 로 구분한다.
 */
function noteRateLimitHeaders(path, res) {
  const group = tossGroupOf(path);
  /**
   * 🔴 **분모를 먼저 센다** — 헤더가 없어도 *"몇 번 나갔는지"* 는 남아야 한다.
   *    pm2 실측: `candles` 는 성공하면 로그가 **0건**이라 기준선에 축 자체가 없었다.
   *    그 상태에서 "429 0건" 은 *여유* 가 아니라 **판정 불가**다.
   */
  const gkey = group || bucketOf(path);
  groupCalls.set(gkey, (groupCalls.get(gkey) || 0) + 1);

  const limit = Number(res.headers.get('X-RateLimit-Limit'));
  const remaining = Number(res.headers.get('X-RateLimit-Remaining'));
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) return;
  const bucket = group || bucketOf(path);
  const prev = rateSeen.get(bucket);
  const ratio = remaining / limit;
  const low = ratio <= RATE_WARN_RATIO;
  // 처음 보는 버킷이거나, 여유가 적거나, 잔여가 크게 바뀌었을 때만 남긴다
  if (prev === undefined || low || Math.abs((prev.remaining ?? 0) - remaining) >= Math.max(1, limit * 0.25)) {
    const payload = {
      group: group || null, bucket, limit, remaining, ratio: Number(ratio.toFixed(2)),
      // 🔴 분모를 같이 실어 보낸다 — 이 줄 하나로 "여유" 와 "안 불렀다" 가 갈린다
      calls: groupCalls.get(gkey) || 0,
      path: bucketOf(path),
      reset: res.headers.get('X-RateLimit-Reset') || null,
    };
    if (low) logWarn('toss.ratelimit_low', payload);
    else logInfo('toss.ratelimit', payload);
  }
  rateSeen.set(bucket, { limit, remaining, at: Date.now() });
}

/** 지금까지 본 버킷별 여유 — 운영 점검이 한 번에 보게 */
function rateLimitSnapshot() {
  const out = {};
  // ⚠️ **헤더를 못 본 그룹도 넣는다** — 호출은 했는데 헤더가 없는 것과
  //    아예 안 부른 것을 구분해야 한다(`seenHeaders:false` vs 항목 없음)
  for (const [k, calls] of groupCalls) out[k] = { calls, seenHeaders: false };
  for (const [k, v] of rateSeen) out[k] = { ...(out[k] || { calls: 0 }), ...v, seenHeaders: true };
  return out;
}

function bucketOf(path) {
  return String(path).split('?')[0];
}

function backoffActive(path) {
  const rec = backoff.get(bucketOf(path));
  if (!rec) return 0;
  const left = rec.until - Date.now();
  if (left <= 0) {
    backoff.delete(bucketOf(path));
    return 0;
  }
  return left;
}

function noteRateLimited(path) {
  const key = bucketOf(path);
  const prev = backoff.get(key);
  const streak = (prev?.streak || 0) + 1;
  const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (streak - 1));
  backoff.set(key, { until: Date.now() + wait, streak });
  // 🔴 429 는 증상이 "화면 일부만 빈다" 로 나타나 **원인이 안 보인다.**
  //    어느 경로가 **몇 번째 호출에서** 걸렸는지, 그 경로의 관측 한도가 얼마였는지 함께 남긴다.
  const seen = observedLimits.get(key);
  logWarn('toss.rate_limited', {
    path: key,
    streak,
    waitMs: wait,
    callSeq: callCount,
    callsOnThisPath: pathCounts.get(key) || 0,
    observedLimit: seen?.limit ?? null,
    lastRemaining: seen?.remaining ?? null,
  });
}

function noteSuccess(path, res) {
  const key = bucketOf(path);
  if (backoff.has(key)) backoff.delete(key);
  const limit = res.headers.get('x-ratelimit-limit');
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (limit) {
    const prev = observedLimits.get(key);
    observedLimits.set(key, { limit: Number(limit), remaining: Number(remaining), at: Date.now() });
    // 한도가 **바뀌면** 알린다 — 조용히 달라지면 갱신 주기가 근거를 잃는다
    if (prev && prev.limit !== Number(limit)) {
      logWarn('toss.rate_limit_changed', { path: key, from: prev.limit, to: Number(limit) });
    }
  }
}

/** 실측 한도 스냅샷(관측용). 상위가 주기를 정할 때 근거로 쓴다 */
function getObservedLimits() {
  return Object.fromEntries(
    [...observedLimits.entries()].map(([k, v]) => [k, { ...v }])
  );
}

async function fetchToken() {
  const res = await fetch(`${BASE_URL}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.status === 403) {
    // 🔴 여기서 멈추는 이유가 **IP** 라는 걸 말해 주지 않으면 아무도 못 고친다
    throw new TossError(
      '토스 API 가 이 서버의 공인 IP 를 거부했습니다. 발급 시 등록한 허용 IP 와 현재 공인 IP 가 다릅니다'
        + '(집 IP 는 고정이 아닙니다). 토스 개발자센터에서 허용 IP 를 갱신하세요.',
      { kind: 'ip-denied', status: 403, path: '/oauth2/token' }
    );
  }
  if (!res.ok) {
    throw new TossError(`토큰 발급 실패 (${res.status})`, {
      kind: res.status === 429 ? 'rate-limited' : 'auth',
      status: res.status,
      path: '/oauth2/token',
    });
  }
  const body = await res.json();
  if (!body?.access_token) {
    throw new TossError('토큰 응답에 access_token 이 없습니다', { kind: 'shape', path: '/oauth2/token' });
  }
  const ttlMs = Math.max(60_000, Number(body.expires_in || 0) * 1000);
  token = { value: body.access_token, expiresAt: Date.now() + ttlMs };
  logInfo('toss.token.issued', { expiresInSec: Number(body.expires_in || 0) });
  return token.value;
}

async function getToken({ force = false } = {}) {
  if (!isConfigured()) {
    throw new TossError('TOSS_CLIENT_ID/TOSS_CLIENT_SECRET 가 설정되지 않았습니다', { kind: 'unconfigured' });
  }
  if (!force && token && token.expiresAt - TOKEN_MARGIN_MS > Date.now()) return token.value;
  // ⚠️ 동시에 여러 요청이 오면 토큰을 여러 번 받는다 — 토큰 엔드포인트는 한도가 **5** 로 가장 좁다
  if (!tokenInflight) {
    tokenInflight = fetchToken().finally(() => {
      tokenInflight = null;
    });
  }
  return tokenInflight;
}

/**
 * @returns {Promise<any>} `result` 안쪽을 돌려준다
 */
/**
 * @param {object} opts
 * @param {number} [opts.accountSeq] 계좌별 엔드포인트(보유·매수여력 등)에 필요한 헤더.
 *   🔴 **`accountNo` 가 아니라 `accountSeq`(정수)** 다 — accountNo 를 넣으면
 *   `account-not-found` 가 오는데, 그 문구만 보면 "계좌가 없다" 로 읽힌다(실제로는 형식 문제).
 */
async function apiGet(path, { retriedAuth = false, accountSeq = null } = {}) {
  const left = backoffActive(path);
  if (left > 0) {
    // 물러서는 중에 또 때리면 한도만 태운다. **조용히 빈 값을 주지 않는다**
    throw new TossError(`요청 제한으로 대기 중입니다 (${Math.ceil(left / 1000)}초 남음)`, {
      kind: 'rate-limited',
      path: bucketOf(path),
    });
  }

  callCount += 1;
  pathCounts.set(bucketOf(path), (pathCounts.get(bucketOf(path)) || 0) + 1);
  const accessToken = await getToken();
  let res;
  try {
    const headers = { Authorization: `Bearer ${accessToken}` };
    if (accountSeq != null) headers['X-Tossinvest-Account'] = String(accountSeq);
    res = await fetch(`${BASE_URL}${path}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // ★ 타임아웃은 **재시도하지 않는다** — 이미 상한을 다 쓴 뒤라 호출자 예산을 넘긴다
    throw new TossError(`토스 API 응답 없음 (${TIMEOUT_MS}ms 초과)`, { kind: 'timeout', path: bucketOf(path) });
  }

  if (res.status === 401 && !retriedAuth) {
    // 토큰이 만료된 경우에만 한 번 다시 받는다(무한 재발급 금지)
    logInfo('toss.token.refresh_on_401', { path: bucketOf(path) });
    await getToken({ force: true });
    return apiGet(path, { retriedAuth: true, accountSeq });
  }
  if (res.status === 403) {
    throw new TossError(
      '토스 API 가 이 서버의 공인 IP 를 거부했습니다(허용 IP 불일치). 개발자센터에서 갱신하세요.',
      { kind: 'ip-denied', status: 403, path: bucketOf(path) }
    );
  }
  /**
   * 🔴 **한도는 추정하지 말고 응답 헤더를 읽는다** (2026-09-22 명세에서 발견)
   *
   * 토스는 엔드포인트를 **Rate Limits Group** 17개로 묶고 `X-RateLimit-*` 헤더로
   * 한도·잔여·리셋을 알려준다. 명세 원문: *"두 그룹의 한도 응답 헤더를 각각 확인하는 것을 권장"*.
   * 종전엔 **헤더를 통째로 버려서** 호출 간격으로 역산하고 있었다 —
   * 그건 실제 부하는 재도 **남은 여유는 못 잰다.**
   * ⚠️ 매번 찍으면 로그가 넘친다 ⇒ **여유가 적을 때와 처음 볼 때만** 남긴다.
   */
  noteRateLimitHeaders(path, res);

  if (res.status === 429) {
    noteRateLimited(path);
    throw new TossError('토스 API 요청 제한(429)', { kind: 'rate-limited', status: 429, path: bucketOf(path) });
  }
  if (!res.ok) {
    throw new TossError(`토스 API 오류 (${res.status})`, { kind: 'upstream', status: res.status, path: bucketOf(path) });
  }

  noteSuccess(path, res);
  const body = await res.json();
  if (!body || !('result' in body)) {
    throw new TossError('토스 API 응답 형식이 예상과 다릅니다(result 없음)', { kind: 'shape', path: bucketOf(path) });
  }
  return body.result;
}

/** 값이 **문자열로 온다**("272500"). 숫자로 바꾸되 못 바꾸면 null — 0 으로 떨어뜨리지 않는다 */
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 현재가 다건. **한 번에 최대 200종목**.
 * @param {string[]} symbols
 * @returns {Promise<Map<string, {price:number|null, currency:string|null, at:string|null}>>}
 */
async function getPrices(symbols) {
  const list = [...new Set((symbols || []).map((s) => String(s || '').trim()).filter(Boolean))];
  if (list.length === 0) return new Map();
  if (list.length > 200) {
    // 조용히 자르지 않는다 — 잘린 줄 모르면 "일부 종목만 갱신" 이 원인 불명이 된다
    throw new TossError(`한 번에 200종목까지입니다 (요청 ${list.length})`, { kind: 'shape', path: '/api/v1/prices' });
  }
  const rows = await apiGet(`/api/v1/prices?symbols=${encodeURIComponent(list.join(','))}`);
  const out = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r?.symbol) continue;
    out.set(String(r.symbol), {
      price: num(r.lastPrice),
      currency: r.currency || null,
      at: r.timestamp || null,
    });
  }
  return out;
}

/** 국내/미국 장 운영 달력 (전일·당일·익일). C 에서 남긴 holidayAware:false 를 닫는 데 쓴다 */
async function getMarketCalendar(country) {
  const c = String(country || '').toUpperCase();
  if (c !== 'KR' && c !== 'US') {
    throw new TossError(`지원하지 않는 시장: ${country}`, { kind: 'shape', path: '/api/v1/market-calendar' });
  }
  return apiGet(`/api/v1/market-calendar/${c}`);
}

/** USD↔KRW 환율. validFrom/validUntil 창을 함께 준다 */
async function getExchangeRate(base = 'USD', quote = 'KRW') {
  const r = await apiGet(
    `/api/v1/exchange-rate?baseCurrency=${encodeURIComponent(base)}&quoteCurrency=${encodeURIComponent(quote)}`
  );
  return {
    rate: num(r?.rate),
    midRate: num(r?.midRate),
    validFrom: r?.validFrom || null,
    validUntil: r?.validUntil || null,
  };
}


// ── 읽기 전용 시장 데이터 (2026-09-21 대시보드용) ──────────────
// 실측 한도: rankings 5/s · warnings 5/s · orderbook 15/s · investor-trading 10/s
//            price-limits 15/s · stocks 5/s · candles 20/s
// ⚠️ 응답 값이 **전부 문자열**이다. 숫자로 바꾸는 건 소비하는 쪽(provider/대시보드)에서 한다.

/** 랭킹. type=TOP_GAINERS|TOP_LOSERS|tradingVolume|tradingAmount … */
const RANKING_TYPES = new Set([
  'TOP_GAINERS', 'TOP_LOSERS',
  'MARKET_TRADING_AMOUNT', 'MARKET_TRADING_VOLUME',
  'TOSS_SECURITIES_TRADING_AMOUNT', 'TOSS_SECURITIES_TRADING_VOLUME',
]);
/** ⚠️ 급등·급락은 `realtime` 을 **지원하지 않는다**(실측: 400 unsupported-ranking-duration) */
const NO_REALTIME = new Set(['TOP_GAINERS', 'TOP_LOSERS']);

async function getRankings({ type = 'TOP_GAINERS', country = 'KR', duration = '1d', count = 10 } = {}) {
  // 🔴 모르는 값을 그대로 보내지 않는다 — 토스가 400 을 내고 **랭킹 전체가 빈다.**
  //    여기서 막으면 어느 값이 문제인지 메시지에 남는다(400 은 그걸 안 알려준다).
  if (!RANKING_TYPES.has(type)) {
    throw new TossError(`지원하지 않는 랭킹 종류: ${type} (허용: ${[...RANKING_TYPES].join(', ')})`, {
      kind: 'shape',
      path: '/api/v1/rankings',
    });
  }
  if (duration === 'realtime' && NO_REALTIME.has(type)) {
    throw new TossError(`${type} 은 realtime 을 지원하지 않습니다. 1d 등을 쓰세요.`, {
      kind: 'shape',
      path: '/api/v1/rankings',
    });
  }
  const q = new URLSearchParams({
    type,
    marketCountry: String(country).toUpperCase(),
    duration,
    count: String(Math.min(100, Math.max(1, Number(count) || 10))),
  });
  const r = await apiGet(`/api/v1/rankings?${q}`);
  return {
    rankedAt: r?.rankedAt || null,
    rows: (Array.isArray(r?.rankings) ? r.rankings : []).map((x) => ({
      rank: Number(x.rank) || null,
      symbol: String(x.symbol || ''),
      currency: x.currency || null,
      /**
       * 🔴 등락률이 **`price.changeRate` 안에** 있고 **소수비율**이다(실측 '1.4416' = +144.17%).
       *    오후에 보유 손익률에서 고친 **같은 100배 함정**이 여기서 재발할 자리였다.
       *    ★ 작아서 그럴듯해 보이는 종류라("+1.44%") **틀린 줄도 모른다.**
       *    ⚠️ 최상위 `rate` 는 **없다** — 엉뚱한 자리를 보면 "등락률이 안 온다" 로 읽힌다.
       *    ⇒ **경계에서 한 번만** 퍼센트로 바꾼다. price 원본도 함께 남긴다.
       */
      changePct: (() => {
        const v = x.price?.changeRate;
        if (v == null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? Math.round(n * 100 * 100) / 100 : null;
      })(),
      lastPrice: x.price?.lastPrice != null ? Number(x.price.lastPrice) : null,
      price: x.price ?? null,
      volume: x.tradingVolume ?? null,
      amount: x.tradingAmount ?? null,
    })),
  };
}

/** 종목 투자경고·거래정지 등. **빈 배열이 정상**이다(경고 없음) */
async function getWarnings(symbol) {
  const r = await apiGet(`/api/v1/stocks/${encodeURIComponent(symbol)}/warnings`);
  return Array.isArray(r) ? r : [];
}

/** 호가 10단계 */
async function getOrderbook(symbol) {
  const r = await apiGet(`/api/v1/orderbook?symbol=${encodeURIComponent(symbol)}`);
  const side = (arr) =>
    (Array.isArray(arr) ? arr : []).map((x) => ({ price: Number(x.price), volume: Number(x.volume) }));
  return { at: r?.timestamp || null, currency: r?.currency || null, asks: side(r?.asks), bids: side(r?.bids) };
}

/** 캔들. interval=1m|1d, 최대 200개. **최신순**으로 온다 */
async function getCandles(symbol, { interval = '1d', count = 120 } = {}) {
  const q = new URLSearchParams({
    symbol,
    interval,
    count: String(Math.min(200, Math.max(2, Number(count) || 120))),
  });
  const r = await apiGet(`/api/v1/candles?${q}`);
  const rows = (Array.isArray(r?.candles) ? r.candles : []).map((c) => ({
    t: c.timestamp,
    o: Number(c.openPrice),
    h: Number(c.highPrice),
    l: Number(c.lowPrice),
    c: Number(c.closePrice),
    v: Number(c.volume),
  }));
  // 차트는 오래된 것부터가 자연스럽다. **여기서 한 번만 뒤집는다**(소비처마다 뒤집으면 어긋난다)
  return { symbol, interval, currency: r?.candles?.[0]?.currency || null, rows: rows.reverse() };
}

/** 투자자별 매매동향(개인·외국인·기관) */
async function getInvestorTrading(symbol) {
  const r = await apiGet(`/api/v1/stocks/${encodeURIComponent(symbol)}/investor-trading`);
  return Array.isArray(r?.records) ? r.records : [];
}

/** 상·하한가. 미국 등 가격제한 없는 시장은 null 이 온다 */
async function getPriceLimits(symbol) {
  const r = await apiGet(`/api/v1/price-limits?symbol=${encodeURIComponent(symbol)}`);
  return {
    upper: r?.upperLimitPrice != null ? Number(r.upperLimitPrice) : null,
    lower: r?.lowerLimitPrice != null ? Number(r.lowerLimitPrice) : null,
    currency: r?.currency || null,
  };
}

/** 종목 기본정보(최대 200건 다건) */
async function getStockInfo(symbols) {
  const list = [...new Set((symbols || []).map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 200);
  if (!list.length) return new Map();
  const rows = await apiGet(`/api/v1/stocks?symbols=${encodeURIComponent(list.join(','))}`);
  const out = new Map();
  for (const x of Array.isArray(rows) ? rows : []) {
    if (!x?.symbol) continue;
    out.set(String(x.symbol), {
      name: x.name || null,
      market: x.market || null,
      currency: x.currency || null,
      status: x.status || null,
      securityType: x.securityType || null,
      // 거래정지는 화면에서 빨간 표시가 필요하다
      suspended: Boolean(x.koreanMarketDetail?.krxTradingSuspended),
    });
  }
  return out;
}

function _resetForTest() {
  callCount = 0;
  pathCounts.clear();
  token = null;
  tokenInflight = null;
  backoff.clear();
  observedLimits.clear();
}

module.exports = {
  BASE_URL,
  rateLimitSnapshot,
  tossGroupOf,
  TossError,
  isConfigured,
  getToken,
  apiGet,
  getPrices,
  getMarketCalendar,
  getExchangeRate,
  getRankings,
  getWarnings,
  getOrderbook,
  getCandles,
  getInvestorTrading,
  getPriceLimits,
  getStockInfo,
  getObservedLimits,
  _resetForTest,
};

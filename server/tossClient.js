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
  logWarn('toss.rate_limited', { path: key, streak, waitMs: wait });
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
async function apiGet(path, { retriedAuth = false } = {}) {
  const left = backoffActive(path);
  if (left > 0) {
    // 물러서는 중에 또 때리면 한도만 태운다. **조용히 빈 값을 주지 않는다**
    throw new TossError(`요청 제한으로 대기 중입니다 (${Math.ceil(left / 1000)}초 남음)`, {
      kind: 'rate-limited',
      path: bucketOf(path),
    });
  }

  const accessToken = await getToken();
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
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
    return apiGet(path, { retriedAuth: true });
  }
  if (res.status === 403) {
    throw new TossError(
      '토스 API 가 이 서버의 공인 IP 를 거부했습니다(허용 IP 불일치). 개발자센터에서 갱신하세요.',
      { kind: 'ip-denied', status: 403, path: bucketOf(path) }
    );
  }
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

function _resetForTest() {
  token = null;
  tokenInflight = null;
  backoff.clear();
  observedLimits.clear();
}

module.exports = {
  BASE_URL,
  TossError,
  isConfigured,
  getToken,
  apiGet,
  getPrices,
  getMarketCalendar,
  getExchangeRate,
  getObservedLimits,
  _resetForTest,
};

const { logInfo, logWarn, logError } = require('./logger');
/**
 * 🔴 **그룹별 큐** (2026-09-22 사용자 지시) — 종전엔 429 를 맞으면 그 버킷을 잠그고
 *    그 사이 호출을 **던져서 거절**했다. 한도는 아꼈지만 **기능이 멈췄다.**
 *    이제 **기다렸다 보낸다.** 재시도 규칙은 `tossQueue.js` 머리말 참고
 *    (핵심: **429 만 되꽂는다** — 네트워크 실패는 나갔는지 몰라서 재시도가 위험하다).
 */
const tossQueue = require('./tossQueue').createQueue();

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

/**
 * 🔴 **연결조차 못 한 실패**의 코드들 (2026-09-22).
 *
 * 이 코드들은 **요청이 상대에게 간 적이 없다**는 뜻이다 ⇒ 주문이 들어갔을 리 없고 **재시도가 안전하다.**
 * 그 밖(소켓이 중간에 끊김·타임아웃)은 **상대가 이미 처리했을 수 있으므로** 계속 "모름" 이다.
 *
 * ⚠️ `ECONNRESET` 은 **여기 넣지 않는다** — 서버가 받아서 처리한 뒤 끊었을 수도 있다.
 *    "재시도 안전" 쪽으로 잘못 분류하면 **두 번 주문**이 나간다. 애매하면 모름이 맞다.
 */
const NEVER_SENT_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
]);

/**
 * fetch 가 던진 것을 **사실대로** 분류한다.
 *
 * 🔴 종전에는 `catch (e)` 가 `e` 를 **한 번도 안 보고** 전부
 *    *"응답을 받지 못했습니다(10000ms)"* 라고 적었다. 그래서
 *    ① 실제 경과가 5초인데 10초라고 **거짓말**했고
 *    ② 무엇이 실패했는지 **영영 알 수 없었다**(원인을 버렸다)
 *    ③ 확실히 안 나간 실패까지 **"모름"** 으로 잠가 사람이 손으로 확정해야 했다.
 *    2026-09-22 폰 실행 첫 시험에서 정확히 이 세 가지를 한꺼번에 밟았다.
 */
function classifyFetchFailure(e, elapsedMs) {
  const code = e?.cause?.code || e?.code || null;
  const name = e?.name || 'Error';
  const timedOut = name === 'TimeoutError' || name === 'AbortError';
  const neverSent = !timedOut && code != null && NEVER_SENT_CODES.has(code);
  return { code, name, elapsedMs, timedOut, neverSent, detail: `${name}${code ? `/${code}` : ''} ${elapsedMs}ms` };
}
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
  /**
   * ⚠️ **넘기는데 안 받던 필드가 있었다** (2026-09-22 발견) — 호출부는 `code`·`data` 를
   *    성실히 넘기고 있었는데 생성자가 **조용히 버렸다.** 넘기는 쪽만 보면 다 전달되는 것처럼 보인다.
   *    ⇒ 토스가 준 오류 코드로 갈라야 할 자리에서 갈 수 없었다.
   */
  constructor(message, { kind, status, path, code, data, cause } = {}) {
    super(message);
    this.name = 'TossError';
    // 'unconfigured' | 'ip-denied' | 'auth' | 'rate-limited' | 'timeout' | 'unreachable'
    // | 'not-sent'(요청이 나간 적 없음 = 재시도 안전) | 'unknown'(나갔는지 모름 = 재시도 금지)
    // | 'upstream' | 'shape' | 'idempotency-conflict' | 'in-progress'
    this.kind = kind;
    this.status = status;
    this.path = path;
    if (code != null) this.code = code;
    if (data != null) this.data = data;
    if (cause != null) this.cause = cause;
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
 * 이 한도 이하 그룹은 여유 경고를 내지 않는다. `ACCOUNT`(1)·소형 그룹이 대상 —
 * **분모가 작으면 비율이 뜻을 잃는다.** ⚠️ 실제 429 는 이것과 무관하게 따로 드러난다.
 */
const MIN_LIMIT_TO_WARN = Math.max(0, Number(process.env.TOSS_RATE_MIN_LIMIT) || 2);

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
  /**
   * 🔴 **한도가 아주 작은 그룹은 구조적으로 늘 "낮다"** (2026-09-22).
   *    `ACCOUNT` 는 한도 **1** 이라 한 번만 불러도 `0/1`(=ratio 0) 이고, 정상 동작인데 매번 경고다.
   *    비율 임계로는 못 거른다 — 분모가 1~2면 **표현할 수 있는 비율이 0 아니면 1** 뿐이다.
   */
  const tinyLimit = limit <= MIN_LIMIT_TO_WARN;
  /**
   * 🔴 **소음의 진짜 원인은 임계가 아니라 "계속 운다" 였다.**
   *    실측(pm2 05시 관측): `ratelimit_low` **158건이 전부 RANKING**, 실제 429 는 **0건**.
   *    `RANKING` 은 한도 5 라 여유 1(=0.2)이 상시 상태인데 **호출할 때마다** 경고가 나갔다.
   *    ⇒ **상태 전이**에서만 운다(정상→낮음). 낮은 채로 머무는 동안은 조용하고,
   *      회복(`ratio > 임계*1.5`)하면 표시를 지워 **다음 하강이 새 사건**이 된다.
   *    ★ 이 저장소가 이미 두 곳에서 쓴 규율이다(장마감 전이 · 모멘텀 돌파 + 히스테리시스).
   * ⚠️ **429 가 실제로 나면 그건 따로 시끄럽다**(`kind:'rate-limited'`) — 여기서 조용해도 안 가려진다.
   */
  const low = !tinyLimit && ratio <= RATE_WARN_RATIO;
  const wasLow = Boolean(prev?.low);
  const enteredLow = low && !wasLow;
  const recovered = wasLow && ratio > Math.min(1, RATE_WARN_RATIO * 1.5);
  // 처음 보는 버킷이거나, **낮음으로 떨어진 순간**이거나, 잔여가 크게 바뀌었을 때만 남긴다
  if (prev === undefined || enteredLow || recovered
      || Math.abs((prev.remaining ?? 0) - remaining) >= Math.max(1, limit * 0.25)) {
    const payload = {
      group: group || null, bucket, limit, remaining, ratio: Number(ratio.toFixed(2)),
      // 🔴 분모를 같이 실어 보낸다 — 이 줄 하나로 "여유" 와 "안 불렀다" 가 갈린다
      calls: groupCalls.get(gkey) || 0,
      path: bucketOf(path),
      reset: res.headers.get('X-RateLimit-Reset') || null,
    };
    if (enteredLow) logWarn('toss.ratelimit_low', payload);
    else logInfo('toss.ratelimit', { ...payload, low, tinyLimit, recovered });
  }
  /**
   * 🔴 **걸쇠(latch)를 기억한다 — `low` 를 그대로 남기면 히스테리시스가 깨진다.**
   *    임계(0.2)와 회복선(0.3) **사이**에서는 `low=false` 라, 그걸 저장하면 걸쇠가 풀리고
   *    다시 0.2 로 내려갈 때 **새 사건처럼 또 운다**. 0.2↔0.25 를 오가면 매번 경고다.
   *    ⇒ 회복선을 **넘어야** 풀린다(그래서 `recovered` 일 때만 false).
   *    ★ 내 첫 구현이 정확히 이 버그였고 테스트가 잡았다.
   */
  rateSeen.set(bucket, { limit, remaining, low: recovered ? false : (low || wasLow), at: Date.now() });
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

/**
 * ⚠️ **2026-09-22: 이 게이트는 더 이상 호출되지 않는다.** 물러서기는 이제
 *    `tossQueue` 의 `penaltyUntil` 이 담당한다(그룹별 · 큐 안에서 기다린다).
 *    🔴 **정본을 둘로 두지 않으려고 남겨 두지 않고 지웠다** — 둘이 각자 판단하면
 *    한쪽이 풀렸는데 다른 쪽이 막는 상태가 생기고, 그건 로그로 못 가른다.
 *    `noteRateLimited` 는 **기록만** 남긴다(원인 추적에 값이 있다).
 */

function noteRateLimited(path) {
  const key = bucketOf(path);
  const prev = backoff.get(key);
  const streak = (prev?.streak || 0) + 1;
  const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (streak - 1));
  backoff.set(key, { until: Date.now() + wait, streak }); // 관측용 기록(게이트 아님)
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
    // 🔴 **배운 한도를 큐에 준다** — 안 주면 큐가 추측값(보수적 기본값)으로만 돌아
    //    한도가 큰 그룹에서 **쓸데없이 느려진다**(있으나 마나가 아니라 해롭다)
    tossQueue.setLimit(tossGroupOf(key) || key, Number(limit));
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
  // ⚠️ 종전의 "물러서는 중이면 던진다" 를 **없앴다** — 큐가 순서를 지켜 기다렸다 보낸다.
  //    던지면 호출자는 **데이터 없이** 진행하고, 그게 화면·분석의 빈칸으로 나타난다.
  return tossQueue.run(tossGroupOf(path) || bucketOf(path), () => apiGetOnce(path, { retriedAuth, accountSeq }));
}

async function apiGetOnce(path, { retriedAuth = false, accountSeq = null } = {}) {
  const accessToken = await getToken();
  let res;
  const startedAt = Date.now();
  try {
    const headers = { Authorization: `Bearer ${accessToken}` };
    if (accountSeq != null) headers['X-Tossinvest-Account'] = String(accountSeq);
    res = await fetch(`${BASE_URL}${path}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // ★ 타임아웃은 **재시도하지 않는다** — 이미 상한을 다 쓴 뒤라 호출자 예산을 넘긴다
    // 🔴 그러나 **원인은 남긴다** — 버리면 다음 사람이 진단할 수 없다
    const c = classifyFetchFailure(e, Date.now() - startedAt);
    logWarn('toss.fetch_failed', { path: bucketOf(path), method: 'GET', ...c });
    throw new TossError(
      c.neverSent
        ? `토스에 연결하지 못했습니다(${c.detail}). 요청이 나가지 않았습니다.`
        : `토스 API 응답 없음 (${c.detail})`,
      { kind: c.neverSent ? 'unreachable' : 'timeout', path: bucketOf(path), cause: c.detail }
    );
  }

  if (res.status === 401 && !retriedAuth) {
    // 토큰이 만료된 경우에만 한 번 다시 받는다(무한 재발급 금지)
    logInfo('toss.token.refresh_on_401', { path: bucketOf(path) });
    await getToken({ force: true });
    return apiGetOnce(path, { retriedAuth: true, accountSeq });
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
/**
 * 🔴 **금액·수량은 문자열로 온다**(`decimal`, maxLength 30). 명세 확인.
 *    `Number()` 로 바로 바꾸면 원화 큰 금액에서 정밀도가 깎이고, 미국 소수점 주식(`5.5`)도 있다.
 *    ⇒ **원문 문자열을 같이 들고 다닌다.** 표시·비교는 문자열, 산수만 숫자로.
 */
function decimal(v) {
  const raw = v == null ? null : String(v);
  const num = raw == null || raw === '' ? null : Number(raw);
  return { raw, num: Number.isFinite(num) ? num : null };
}

/**
 * 매수 가능 금액(현금). **통화별로 따로 부른다** — 한 번에 둘이 오지 않는다.
 *
 * ⚠️ `currency` 는 **필수**다. 빼면 400 `invalid-request` + `data.field:"currency"` 가 온다
 *    (실측으로도 확인했다 — 그 오류가 무엇이 빠졌는지 정확히 알려줘서 한 번에 찾았다).
 * ⚠️ 명세가 *"클라이언트는 unknown enum 값을 허용하도록 구현해야 한다"* 고 적었다 ⇒
 *    KRW/USD 로 **하드 스위치하지 않는다**(통화가 늘면 조용히 깨진다).
 * ⚠️ 계좌를 못 찾으면 이 엔드포인트는 **404**, `sellable-quantity` 는 **400** 이다 —
 *    **상태코드로 분기하면 한쪽이 깨진다.** 코드(`account-not-found`)로 봐야 한다.
 */
/**
 * 🔴 **쓰기 요청** (주문·조건주문). 읽기(`apiGet`)와 **일부러 다르게** 만들었다.
 *
 * ## 왜 갈랐나 — 재시도가 위험하다
 * `apiGet` 은 401 이면 토큰을 새로 받아 **한 번 다시 보낸다.** 읽기라 안전하다.
 * 🔴 **쓰기에서 그러면 주문이 두 번 나갈 수 있다.** 그래서 여기서는:
 *   - **자동 재시도 없음**(401 포함). 토큰은 보내기 **전에** 확보한다
 *   - 타임아웃은 `kind:'unknown'` — **"실패" 가 아니라 "모름"** 이다.
 *     호출자는 **재시도하지 말고 조회로 확정**해야 한다
 *   - 멱등키(`clientOrderId`)는 **호출자가 넣는다** — 명세: *"서버는 자동 생성하지 않습니다"*
 * ⚠️ 422 `idempotency-key-conflict`(같은 키 다른 본문) · 409 `request-in-progress` 를
 *    **오류 코드로** 구분해 돌려준다. 상태코드만 보면 원인을 못 가른다.
 */
async function apiPost(path, body, { accountSeq, method = 'POST', deadlineAt = null } = {}) {
  /**
   * ⚠️ 주문도 큐를 탄다. **429 재산입은 안전하다** — 서버가 받고 거절한 것이라 처리되지 않았다.
   *    반면 타임아웃·연결실패는 큐가 **재시도하지 않는다**(`tossQueue` 가 `rate-limited` 만 되꽂는다).
   */
  return tossQueue.run(tossGroupOf(path) || bucketOf(path), () => apiPostOnce(path, body, { accountSeq, method }), { deadlineAt });
}

async function apiPostOnce(path, body, { accountSeq, method = 'POST' } = {}) {
  const accessToken = await getToken();
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  if (accountSeq != null) headers['X-Tossinvest-Account'] = String(accountSeq);
  callCount += 1;
  pathCounts.set(bucketOf(path), (pathCounts.get(bucketOf(path)) || 0) + 1);

  let res;
  const startedAt = Date.now();
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    /**
     * 🔴 **여기가 이 파일에서 가장 위험한 자리다.** 보냈는데 답을 못 받았다 —
     *    주문이 들어갔는지 **알 수 없다.** 재시도하면 두 번 살 수 있다.
     *
     * ⚠️ 단 **전부가 "모름" 은 아니다.** 연결조차 못 맺은 실패는 요청이 나간 적이 없다.
     *    그것까지 잠그면 사람이 매번 거래소를 뒤져 확정해야 하고, 그러다 보면
     *    **"모름" 이라는 신호 자체를 가볍게 여기게 된다.**
     */
    const c = classifyFetchFailure(e, Date.now() - startedAt);
    logWarn('toss.fetch_failed', { path: bucketOf(path), method, ...c });
    if (c.neverSent) {
      throw new TossError(
        `토스에 연결하지 못했습니다(${c.detail}). **요청이 나가지 않았으니** 다시 시도해도 됩니다.`,
        { kind: 'not-sent', path: bucketOf(path), cause: c.detail }
      );
    }
    throw new TossError(
      `토스에 보냈지만 응답을 받지 못했습니다(${c.detail}). **재시도하지 말고 주문 조회로 확정하세요.**`,
      { kind: 'unknown', path: bucketOf(path), cause: c.detail }
    );
  }
  noteRateLimitHeaders(path, res);

  if (res.status === 204) return null; // 조건주문 취소는 **204** 다(200 이 아니다)
  let json = null;
  try { json = await res.json(); } catch { /* 본문이 없을 수 있다 */ }

  if (!res.ok) {
    const code = json?.error?.code || null;
    const msg = json?.error?.message || `토스 API 오류 (${res.status})`;
    // ⚠️ 코드로 갈라 준다 — 호출자가 "다시 보내도 되는가" 를 판단할 수 있어야 한다
    const kind = code === 'idempotency-key-conflict' ? 'idempotency-conflict'
      : code === 'request-in-progress' ? 'in-progress'
        : res.status === 429 ? 'rate-limited'
          : res.status === 401 ? 'auth' : 'upstream';
    throw new TossError(msg, { kind, status: res.status, path: bucketOf(path), code, data: json?.error?.data });
  }
  return json?.result ?? json ?? null;
}

/** 주문 생성. ⚠️ 응답은 **`orderId` 뿐**이다 — 상태·체결은 `getOrder` 로 따로 봐야 한다 */
async function createOrder(body, { accountSeq, deadlineAt = null } = {}) {
  return apiPost('/api/v1/orders', body, { accountSeq: await withAccount(accountSeq), deadlineAt });
}

/** 주문 상세 — **"들어갔는지 모를 때" 확정하는 유일한 수단** */
async function getOrder(orderId, { accountSeq } = {}) {
  return apiGet(`/api/v1/orders/${encodeURIComponent(orderId)}`, { accountSeq: await withAccount(accountSeq) });
}

/** 주문 목록. 멱등키로 보낸 주문을 되찾을 때도 쓴다 */
async function listOrders(query = {}, { accountSeq } = {}) {
  const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== ''));
  return apiGet(`/api/v1/orders${q.toString() ? `?${q}` : ''}`, { accountSeq: await withAccount(accountSeq) });
}

/**
 * 주문 취소.
 * 🔴 **성공해도 새 `orderId` 가 발급된다**(원 ID 와 다르다) — 이후 추적은 새 ID 로.
 * 🔴 **멱등키가 없다** ⇒ 자동 재시도 금지.
 */
async function cancelOrder(orderId, { accountSeq } = {}) {
  return apiPost(`/api/v1/orders/${encodeURIComponent(orderId)}/cancel`, undefined, { accountSeq: await withAccount(accountSeq) });
}

/** 주문 정정. 🔴 취소와 같다 — **새 orderId** · **멱등키 없음** · POST(PUT 아님) */
async function modifyOrder(orderId, body, { accountSeq } = {}) {
  return apiPost(`/api/v1/orders/${encodeURIComponent(orderId)}/modify`, body, { accountSeq: await withAccount(accountSeq) });
}

/** 조건주문 생성(손절 등). `orderRules.buildStopLoss()` 가 본문을 만든다 */
async function createConditionalOrder(body, { accountSeq } = {}) {
  return apiPost('/api/v1/conditional-orders', body, { accountSeq: await withAccount(accountSeq) });
}

/** 조건주문 목록. ⚠️ `status` 가 **필수**다(OPEN|CLOSED) */
async function listConditionalOrders({ status = 'OPEN', symbol, cursor, limit } = {}, { accountSeq } = {}) {
  const q = new URLSearchParams(Object.entries({ status, symbol, cursor, limit }).filter(([, v]) => v != null && v !== ''));
  return apiGet(`/api/v1/conditional-orders?${q}`, { accountSeq: await withAccount(accountSeq) });
}

/** 조건주문 취소. ⚠️ 성공이 **204 No Content** 다(일반 주문 취소와 다르다) */
async function cancelConditionalOrder(conditionalOrderId, { accountSeq } = {}) {
  return apiPost(`/api/v1/conditional-orders/${encodeURIComponent(conditionalOrderId)}`, undefined,
    { accountSeq: await withAccount(accountSeq), method: 'DELETE' });
}

/**
 * 계좌 식별자(`accountSeq`) — **캐시한다.**
 *
 * 🔴 `ACCOUNT` 그룹 한도가 **1/s** 다(pm2 헤더 실측: `limit=1 remaining=0`).
 *    호출 한 번에 소진되므로 **요청마다 계좌를 조회하면 바로 429** 다.
 * 🔴 그리고 이걸 안 붙여서 **계좌 검증이 항상 400 으로 실패**하고 있었다 —
 *    `buying-power`·`sellable-quantity`·`commissions` 는 `X-Tossinvest-Account` 가 **필수**인데
 *    호출부가 안 넘겼다. 방향은 안전(막힘)이었지만 **모든 제안이 막혔다.**
 * ⚠️ 계좌는 거의 안 바뀌지만 **영원히 캐시하지 않는다**(기본 10분).
 */
let accountSeqCache = null;
const ACCOUNT_TTL_MS = Math.max(60_000, Number(process.env.TOSS_ACCOUNT_TTL_MS) || 10 * 60_000);

/**
 * 🔴 **단일비행(single-flight)** — 진행 중인 조회가 있으면 **그 약속을 나눠 쓴다**. (2026-09-22)
 *
 * 없으면 **캐시 스탬피드**가 난다: TTL(10분)이 만료된 그 순간 `withAccount` 를 쓰는 **11개 함수**가
 * 동시에 들어오면 각자 `/api/v1/accounts` 를 친다. 그런데 **`ACCOUNT` 한도는 1/s** 라 즉시 429다.
 *
 * ⚠️ 실제로 났다 — 감시를 13 → 41종목으로 늘린 직후 `portfolio.failed kind="rate-limited"`,
 *    그 순간 `ACCOUNT 0/1`. 캐시가 있으니 안전하다고 본 것이 **"캐시 미스가 동시에 일어나는 순간"**
 *    을 안 본 것이다.
 * 🔴 **이게 주문 직전에 나면 `send_unknown` 이 된다** — 사람이 거래소를 확인해야 하는 상태다.
 *    호출이 드문 그룹이라 방심하기 쉬운데, **드문 게 아니라 한도가 1일 뿐**이다.
 */
let accountSeqInflight = null;

async function getAccountSeq({ force = false } = {}) {
  if (!force && accountSeqCache && Date.now() - accountSeqCache.at < ACCOUNT_TTL_MS) return accountSeqCache.seq;
  // ⚠️ `force` 여도 진행 중인 것이 있으면 나눠 쓴다 — 강제 갱신을 동시에 두 번 할 이유가 없다
  if (accountSeqInflight) return accountSeqInflight;
  accountSeqInflight = (async () => {
    const rows = await apiGet('/api/v1/accounts');
    const list = Array.isArray(rows) ? rows : (rows?.accounts || []);
    const seq = list[0]?.accountSeq;
    if (seq == null) throw new TossError('토스 계좌를 찾지 못했습니다', { kind: 'shape', path: '/api/v1/accounts' });
    accountSeqCache = { seq, at: Date.now() };
    return seq;
  })();
  try {
    return await accountSeqInflight;
  } finally {
    // 🔴 **실패해도 반드시 비운다** — 안 비우면 한 번 실패한 뒤 영원히 그 실패를 나눠 쓴다
    accountSeqInflight = null;
  }
}

/** 호출부가 안 주면 **여기서 채운다** — 빠뜨리면 400 이고, 빠뜨리기 쉽다 */
async function withAccount(accountSeq) {
  return accountSeq != null ? accountSeq : getAccountSeq();
}

async function getBuyingPower(currency, { accountSeq } = {}) {
  const c = String(currency || '').trim().toUpperCase();
  if (!c) throw new TossError('통화를 지정해야 합니다(KRW/USD).', { kind: 'shape', path: '/api/v1/buying-power' });
  const r = await apiGet(`/api/v1/buying-power?currency=${encodeURIComponent(c)}`, { accountSeq: await withAccount(accountSeq) });
  return { currency: r?.currency || c, cash: decimal(r?.cashBuyingPower) };
}

/**
 * 판매 가능 수량.
 * 🔴 **응답에 종목이 안 실린다**(`{sellableQuantity}` 하나뿐) ⇒ 요청한 심볼을 **우리가 붙인다.**
 *    여러 종목을 병렬로 물으면 어느 답이 어느 종목인지 알 수 없기 때문이다.
 * ⚠️ 해외주식은 **소수점 수량**이 가능하다(`"5.5"`) — 정수로 파싱하면 깨진다.
 * ⚠️ `currency` 파라미터가 **없다** — 시장 구분은 심볼로만 된다(`buying-power` 와 모양이 다르다).
 */
async function getSellableQuantity(symbol, { accountSeq } = {}) {
  const sym = String(symbol || '').trim();
  if (!sym) throw new TossError('종목을 지정해야 합니다.', { kind: 'shape', path: '/api/v1/sellable-quantity' });
  const r = await apiGet(`/api/v1/sellable-quantity?symbol=${encodeURIComponent(sym)}`, { accountSeq: await withAccount(accountSeq) });
  return { symbol: sym, quantity: decimal(r?.sellableQuantity) };
}

/**
 * 공매도 동향. `STOCK_TRADING_TREND` 그룹.
 * ⚠️ 국내 종목 위주다 — 미국 종목은 빈 배열이 올 수 있다(없는 것과 못 받은 것은 다르다).
 */
async function getShortSelling(symbol) {
  const r = await apiGet(`/api/v1/stocks/${encodeURIComponent(symbol)}/short-selling`);
  return Array.isArray(r?.records) ? r.records : (Array.isArray(r) ? r : []);
}

/**
 * 매매 수수료율. **계좌 헤더 필수**(계좌마다 다를 수 있다).
 *
 * 🔴 **명세와 라이브가 다르다**(에이전트 실측): 명세는 무기한을 `endDate:null` 로 적는데
 *    라이브 국내는 **`"9999-12-31"`** 문자열로 온다. `null` 만 보면 *"만료됐다"* 로 오판한다.
 * 🔴 그리고 실측 미국 `endDate` 가 **측정 당일**이었다 — 프로모션 요율이 곧 끝난다는 뜻이고,
 *    캐시해 두면 **조용히 틀린 수수료로 손익을 계산**하게 된다 ⇒ **유효기간을 반드시 적용**한다.
 * ⚠️ 매수/매도 구분이 **없다**(단일 `commissionRate`). 세금·제비용도 없다 —
 *    이걸로 낸 값은 **"수수료만 반영한 추정"** 이지 실제 비용이 아니다.
 */
async function getCommissions({ accountSeq } = {}) {
  const r = await apiGet('/api/v1/commissions', { accountSeq: await withAccount(accountSeq) });
  const rows = Array.isArray(r) ? r : (Array.isArray(r?.commissions) ? r.commissions : []);
  return pickLiveCommissions(rows);
}

/**
 * 유효한 수수료율만 고른다. **순수 함수라 날짜를 넣어 검증할 수 있다.**
 * @param {Array} rows 원본
 * @param {string} [today] YYYY-MM-DD (테스트용)
 * @param {number} [nowMs] 현재 시각 (테스트용)
 */
function pickLiveCommissions(rows, today = new Date().toISOString().slice(0, 10), nowMs = Date.now()) {
  const FOREVER = '9999-12-31';
  return (rows || []).filter((x) => {
    // ⚠️ `9999-12-31` 도 `null` 도 **무기한**이다 — 둘 다 받아야 한다
    const started = !x?.startDate || x.startDate <= today;
    const notEnded = !x?.endDate || x.endDate === FOREVER || x.endDate >= today;
    return started && notEnded;
  }).map((x) => ({
    market: String(x.marketCountry || '').toUpperCase(),
    rate: decimal(x.commissionRate),
    startDate: x.startDate ?? null,
    endDate: x.endDate ?? null,
    // 🔴 곧 끝나는 요율을 표시한다 — 캐시가 조용히 낡는 것을 막는다
    endsSoon: Boolean(x.endDate && x.endDate !== FOREVER
      && (Date.parse(`${x.endDate}T23:59:59+09:00`) - nowMs) < 7 * 24 * 3600_000),
  }));
}

/**
 * KRX 지수(KOSPI·KOSDAQ)의 **투자자별 매매대금**. (2026-09-22)
 *
 * 🔴 국장 시황 브리핑의 핵심 재료다 — 지수가 왜 움직였는지는 **누가 샀나**에서 나온다.
 * ⚠️ `symbol` 은 **`KOSPI`/`KOSDAQ` 만** 지원한다(명세). 종목 코드를 넣으면 400 이다.
 * ⚠️ 한도 그룹 `MARKET_INDICATOR` — 종목 조회(`STOCK`)와 **다른 통**이라 서로 안 깎는다.
 */
async function getIndexInvestorTrading(symbol, { interval = '1d', count = 5 } = {}) {
  const sym = String(symbol || '').toUpperCase();
  if (sym !== 'KOSPI' && sym !== 'KOSDAQ') {
    throw new TossError(`지수 투자자별 매매대금은 KOSPI/KOSDAQ 만 됩니다: ${symbol}`, { kind: 'bad-request' });
  }
  const q = new URLSearchParams({ interval, count: String(count) });
  const r = await apiGet(`/api/v1/market-indicators/${encodeURIComponent(sym)}/investor-trading?${q}`);
  return Array.isArray(r?.records) ? r.records : (Array.isArray(r) ? r : []);
}

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
  queueSnapshot: () => tossQueue.snapshot(),
  // ⚠️ 검증용 노출 — 이 로직은 네트워크 없이 재야 한다(소음 규율은 헤더만으로 판정된다)
  noteRateLimitHeaders,
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
  apiPost,
  createOrder,
  getOrder,
  listOrders,
  cancelOrder,
  modifyOrder,
  createConditionalOrder,
  listConditionalOrders,
  cancelConditionalOrder,
  getAccountSeq,
  getBuyingPower,
  getSellableQuantity,
  getShortSelling,
  getCommissions,
  pickLiveCommissions,
  getInvestorTrading,
  getIndexInvestorTrading,
  getPriceLimits,
  getStockInfo,
  getObservedLimits,
  _resetForTest,
};

const { logInfo, logWarn } = require('./logger');

/**
 * Yahoo Finance Statistics — 밸류에이션 지표 (2026-09-21)
 *
 * 사용자 사양: *"시장지표는 Yahoo Finance Statistics 화면의 **Current 값**을 최우선으로 사용한다.
 * 밸류 관련 숫자는 다른 화면, 다른 값, 다른 소스와 **섞지 않는다.**"*
 *
 * ## 🔴 인증이 필요하다 — 그런데 키가 아니라 **crumb** 다
 *
 * 차트 엔드포인트(`/v8/chart`)는 무인증인데 **`/v10/quoteSummary` 는 401** 이다(실측).
 * 쿠키를 받고 `/v1/test/getcrumb` 로 crumb 를 얻어 쿼리에 실어야 200 이 온다.
 * ⚠️ **crumb 는 만료된다.** 한 번 받아 두고 끝내면 어느 날 조용히 401 로 돌아간다
 *    ⇒ 401 을 만나면 **한 번 다시 받아** 재시도하고, 그래도 안 되면 실패로 보고한다.
 *
 * ## ⚠️ 여기서 오는 값만 "밸류" 다
 *
 * 사양이 *"다른 소스와 섞지 말라"* 고 못박았다. 토스 가격·야후 차트 종가와 **섞지 않는다** —
 * 이 모듈이 준 `price` 와 배수들은 **같은 스냅샷**이라 서로 정합한다.
 * 🔴 못 받은 항목은 **null 이지 0 이 아니다.** 0 으로 채우면 "PER 0 = 엄청 싸다" 가 된다.
 */

const TIMEOUT_MS = Math.max(4000, Number(process.env.YSTATS_TIMEOUT_MS) || 12000);
const TTL_MS = Math.max(60_000, Number(process.env.YSTATS_TTL_MS) || 10 * 60_000);
const UA = 'Mozilla/5.0';

let crumb = null;
let cookie = null;
/** symbol → { at, data } */
const cache = new Map();

class StatsError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'StatsError';
    this.kind = kind; // network|auth|not-found|shape
  }
}

/** 쿠키 → crumb. 🔴 둘은 **한 쌍**이라 따로 캐시하면 안 맞는다 */
async function refreshCrumb() {
  const res = await fetch('https://fc.yahoo.com', {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((e) => { throw new StatsError(`쿠키 실패: ${e.message}`, 'network'); });

  const raw = res.headers.getSetCookie?.() || [];
  cookie = raw.map((c) => c.split(';')[0]).join('; ');

  const cr = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((e) => { throw new StatsError(`crumb 실패: ${e.message}`, 'network'); });

  const text = (await cr.text()).trim();
  // ⚠️ 실패해도 200 에 HTML 이 올 수 있다 — 길이·모양으로 가른다
  if (!text || text.length > 40 || /[<>]/.test(text)) {
    throw new StatsError('crumb 를 받지 못했습니다(응답이 crumb 모양이 아님).', 'auth');
  }
  crumb = text;
  logInfo('ystats.crumb', { len: crumb.length, cookie: Boolean(cookie) });
  return crumb;
}

const raw = (o, k) => {
  const v = o?.[k];
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const r = v.raw;
  return Number.isFinite(r) ? r : null;
};

async function fetchOnce(symbol) {
  const mods = 'defaultKeyStatistics,financialData,summaryDetail,price,summaryProfile';
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`
    + `?modules=${mods}&crumb=${encodeURIComponent(crumb)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) throw new StatsError(`인증 거부 (${res.status})`, 'auth');
  if (res.status === 404) throw new StatsError(`종목을 찾지 못했습니다: ${symbol}`, 'not-found');
  if (!res.ok) throw new StatsError(`HTTP ${res.status}`, 'network');

  const json = await res.json();
  const r = json?.quoteSummary?.result?.[0];
  if (!r) throw new StatsError('응답에 결과가 없습니다.', 'shape');
  return r;
}

/**
 * 밸류 지표 한 벌.
 * ⚠️ **못 받은 항목은 null 이다** — 사양이 *"숫자가 완벽히 안 맞아도 최대한 채우라"* 고 했으니
 *    있는 것만 채우고 **없는 것은 없다고** 내보낸다(0 으로 메우지 않는다).
 */
async function getStats(symbol, { force = false } = {}) {
  const key = String(symbol || '').trim().toUpperCase();
  if (!key) throw new StatsError('종목 코드가 비었습니다.', 'shape');

  const hit = cache.get(key);
  if (hit && !force && Date.now() - hit.at < TTL_MS) return { ...hit.data, cached: true };

  if (!crumb) await refreshCrumb();
  let r;
  try {
    r = await fetchOnce(key);
  } catch (e) {
    // 🔴 crumb 만료는 **한 번 다시 받아** 재시도한다 — 안 그러면 어느 날 조용히 전부 401 이 된다
    if (e.kind === 'auth') {
      logWarn('ystats.crumb_stale', { symbol: key });
      await refreshCrumb();
      r = await fetchOnce(key);
    } else {
      throw e;
    }
  }

  const ks = r.defaultKeyStatistics || {};
  const fd = r.financialData || {};
  const sd = r.summaryDetail || {};
  const px = r.price || {};

  const data = {
    symbol: key,
    name: px.longName || px.shortName || key,
    exchange: px.exchangeName || null,
    currency: px.currency || null,
    sector: r.summaryProfile?.sector || null,
    industry: r.summaryProfile?.industry || null,
    // 사양이 지정한 항목 — 이름을 그대로 쓴다
    price: raw(px, 'regularMarketPrice'),
    marketCap: raw(px, 'marketCap') ?? raw(sd, 'marketCap'),
    enterpriseValue: raw(ks, 'enterpriseValue'),
    trailingPE: raw(sd, 'trailingPE'),
    forwardPE: raw(sd, 'forwardPE') ?? raw(ks, 'forwardPE'),
    pegRatio: raw(ks, 'pegRatio'),
    priceToSales: raw(sd, 'priceToSalesTrailing12Months'),
    priceToBook: raw(ks, 'priceToBook'),
    evToRevenue: raw(ks, 'enterpriseToRevenue'),
    evToEbitda: raw(ks, 'enterpriseToEbitda'),
    // 질을 재는 데 쓰는 보조 숫자(밸류가 아니다 — 섞지 않도록 이름을 나눴다)
    quality: {
      revenueGrowth: raw(fd, 'revenueGrowth'),
      earningsGrowth: raw(fd, 'earningsGrowth'),
      operatingMargins: raw(fd, 'operatingMargins'),
      profitMargins: raw(fd, 'profitMargins') ?? raw(ks, 'profitMargins'),
      returnOnEquity: raw(fd, 'returnOnEquity'),
      freeCashflow: raw(fd, 'freeCashflow'),
      totalDebt: raw(fd, 'totalDebt'),
      totalCash: raw(fd, 'totalCash'),
      debtToEquity: raw(fd, 'debtToEquity'),
      currentRatio: raw(fd, 'currentRatio'),
      dividendYield: raw(sd, 'dividendYield'),
      payoutRatio: raw(sd, 'payoutRatio'),
      fiveYearAvgDividendYield: raw(sd, 'fiveYearAvgDividendYield'),
      beta: raw(sd, 'beta') ?? raw(ks, 'beta'),
      recommendationMean: raw(fd, 'recommendationMean'),
    },
    links: {
      quote: `https://finance.yahoo.com/quote/${encodeURIComponent(key)}`,
      statistics: `https://finance.yahoo.com/quote/${encodeURIComponent(key)}/key-statistics`,
    },
    at: new Date().toISOString(),
  };

  // 🔴 **몇 칸이 비었는지 세어 준다** — 판단하는 쪽이 "덜 채워진 자료" 임을 알아야 한다
  const valueKeys = ['trailingPE', 'forwardPE', 'pegRatio', 'priceToSales', 'priceToBook', 'evToRevenue', 'evToEbitda'];
  data.missing = valueKeys.filter((k) => data[k] == null);

  cache.set(key, { at: Date.now(), data });
  logInfo('ystats.fetch', { symbol: key, missing: data.missing.length });
  return { ...data, cached: false };
}

function _resetForTest() {
  crumb = null;
  cookie = null;
  cache.clear();
}

module.exports = { getStats, refreshCrumb, StatsError, _resetForTest };

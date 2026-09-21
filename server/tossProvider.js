const toss = require('./tossClient');
const { logInfo, logWarn } = require('./logger');
const { APP_TIMEZONE } = require('./time');

/**
 * 토스증권을 시세 프로바이더로 쓰는 층 (2026-09-21 신설)
 *
 * ## 왜 따로 있나 — `/prices` 만으로는 화면을 못 그린다
 *
 * 실측: `PriceResponse` 는 **4필드뿐**(`symbol`·`timestamp`·`lastPrice`·`currency`).
 * **등락률이 없다.** 그런데 이 앱 화면의 핵심이 등락 표시다.
 * 기준가를 주는 곳은 `/api/v1/candles`(일봉) 하나뿐이라 **두 엔드포인트를 합쳐야** 한다.
 *
 * ```
 * /api/v1/prices   limit 15/s · **200종목을 1콜**       → 매 갱신마다 1콜
 * /api/v1/candles  limit 20/s · 최신순, [1]=전일 종가   → **종목당 하루 1콜**
 * ```
 * ⇒ 전일 종가는 **거래일이 바뀔 때만** 다시 받는다. 9종목이면 하루 9콜이다.
 *
 * 🔴 **KR 6시간 캐시의 근거가 여기서 사라진다.** 그건 공공데이터포털 쿼터 때문이었다.
 *
 * ## 안 하는 것
 *
 * - **주문·계좌를 부르지 않는다.** 샌드박스가 없어서(라이브 키만 발급된다) 주문은
 *   HITL 승인 흐름을 no-op 으로 한 바퀴 돌린 뒤에만 연결한다.
 * - 실패를 **빈 값으로 감싸지 않는다.** 시세가 없는 것과 못 받은 것은 화면에서 달라야 한다.
 */

/** symbol → { close:number, forDate:'YYYY-MM-DD' } */
const prevCloseCache = new Map();

function tradingDateKey(now = new Date()) {
  // 거래일 경계는 시장마다 다르지만, "하루 1회" 판정에는 앱 기준시 날짜면 충분하다.
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE }).format(now);
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 전일 종가를 받아 캐시에 채운다. 이미 오늘 자로 받은 종목은 건너뛴다.
 * ⚠️ 실패한 종목은 **조용히 넘어가되 세어서 로그에 남긴다** — 전부 실패해도
 *    "등락률만 빈 화면" 이 되므로 원인을 모르면 못 고친다.
 */
async function ensurePrevCloses(symbols, { now = new Date(), gapMs = 60 } = {}) {
  const today = tradingDateKey(now);
  const need = symbols.filter((s) => {
    const c = prevCloseCache.get(s);
    return !c || c.forDate !== today;
  });
  if (need.length === 0) return { fetched: 0, failed: 0 };

  let fetched = 0;
  let failed = 0;
  for (const symbol of need) {
    try {
      const r = await toss.apiGet(`/api/v1/candles?symbol=${encodeURIComponent(symbol)}&interval=1d&count=2`);
      const candles = Array.isArray(r?.candles) ? r.candles : [];
      // 최신순이다 — [0]=오늘(진행 중), [1]=전일 종가
      const prev = num(candles[1]?.closePrice);
      if (prev == null) {
        failed += 1;
        continue;
      }
      prevCloseCache.set(symbol, { close: prev, forDate: today });
      fetched += 1;
    } catch (e) {
      failed += 1;
      // 첫 실패에서 바로 멈춘다 — IP 거부·요청제한이면 나머지도 전부 실패한다(한도만 태운다)
      if (e?.kind === 'ip-denied' || e?.kind === 'rate-limited' || e?.kind === 'unconfigured') {
        logWarn('toss.prevclose.abort', { reason: e.kind, done: fetched, left: need.length - fetched - failed });
        break;
      }
    }
    if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
  }
  if (fetched || failed) logInfo('toss.prevclose', { fetched, failed, cached: prevCloseCache.size });
  return { fetched, failed };
}

/**
 * 관심종목 전체의 시세를 **한 번에** 받는다.
 * @returns {Promise<Map<string, {price:number|null, changePct:number|null, currency:string|null, at:string|null, source:'toss'}>>}
 */
async function fetchQuotes(symbols, { now = new Date() } = {}) {
  const list = [...new Set((symbols || []).map((s) => String(s || '').trim()).filter(Boolean))];
  if (list.length === 0) return new Map();

  // ⚠️ 200 초과는 client 가 던진다(조용히 자르지 않는다). 여기서 나눠 보낸다.
  const chunks = [];
  for (let i = 0; i < list.length; i += 200) chunks.push(list.slice(i, i + 200));

  const prices = new Map();
  for (const chunk of chunks) {
    const got = await toss.getPrices(chunk);
    for (const [k, v] of got) prices.set(k, v);
  }

  await ensurePrevCloses([...prices.keys()], { now });

  const out = new Map();
  for (const [symbol, p] of prices) {
    const prev = prevCloseCache.get(symbol);
    let changePct = null;
    if (p.price != null && prev && prev.close > 0) {
      changePct = ((p.price - prev.close) / prev.close) * 100;
      // 소수 셋째 자리에서 끊는다 — 화면은 두 자리를 쓴다
      changePct = Math.round(changePct * 1000) / 1000;
    }
    out.set(symbol, {
      price: p.price,
      changePct,
      currency: p.currency,
      at: p.at,
      source: 'toss',
    });
  }
  return out;
}

/** 환율 — 자체 조회를 대체한다. 유효 창(validUntil)을 함께 준다 */
async function fetchUsdKrw() {
  const r = await toss.getExchangeRate('USD', 'KRW');
  return { rate: r.rate, validUntil: r.validUntil, source: 'toss' };
}

function isEnabled() {
  return toss.isConfigured();
}

function _resetForTest() {
  prevCloseCache.clear();
  toss._resetForTest();
}

module.exports = {
  fetchQuotes,
  fetchUsdKrw,
  ensurePrevCloses,
  isEnabled,
  tradingDateKey,
  _prevCloseCache: prevCloseCache,
  _resetForTest,
};

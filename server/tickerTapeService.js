const { logInfo, logWarn } = require('./logger');

/**
 * 헤더 시세 테이프 (2026-09-21)
 *
 * 사용자 지시(스크린샷): *"시간 및 원/달러/엔/유로/비트코인/나스닥/snp/다우/코스피/코스닥/wti
 * 지수 표시 좌→우 자동으로 흘러가게"*
 *
 * ## 먼저 재고 만들었다
 *
 * 없는 데이터로 화면을 만들면 빈칸이 남는다 ⇒ **열 개를 전부 찔러 보고** 시작했다
 * (2026-09-21 실측: 10/10 응답 · 현재가와 전일종가 모두 옴). 그래서 등락률을 **계산으로** 낸다.
 *
 * ## ⚠️ 조각 실패를 전체 실패로 만들지 않는다
 *
 * 열 개 중 하나가 죽어도 나머지는 흐른다. 못 받은 것은 **그 자리를 비우는 게 아니라**
 * 목록에서 빠지고 `failed` 로 센다 — 화면이 "몇 개를 못 받았는지" 를 말할 수 있어야 한다.
 *
 * ## ⚠️ 토스가 아니라 Yahoo 다
 *
 * 토스 API 는 **종목**을 주지 지수를 주지 않는다. 지수·원자재·코인은 야후 차트 엔드포인트가
 * 유일하게 열 개를 다 덮었다. 🔴 무인증이라 **쿼터·차단이 있을 수 있다** ⇒ 캐시를 길게 잡고
 * 실패해도 **직전 값을 계속 보여준다**(테이프가 비는 것보다 낫다).
 */

const ENDPOINT = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const TIMEOUT_MS = Math.max(3000, Number(process.env.TAPE_TIMEOUT_MS) || 8000);
/** 지수는 초 단위로 안 봐도 된다. 무인증 API 라 아껴 쓴다 */
const TTL_MS = Math.max(30_000, Number(process.env.TAPE_TTL_MS) || 60_000);

/**
 * 표시 순서 = 사용자가 적은 순서. 🔴 마음대로 바꾸지 않는다.
 * `unit` 은 화면이 숫자를 어떻게 쓸지 정한다(통화 기호가 아니라 **자릿수** 문제다).
 */
const TAPE_SYMBOLS = [
  // 지수
  { symbol: '^KS11', label: '코스피', digits: 2 },
  { symbol: '^KQ11', label: '코스닥', digits: 2 },
  { symbol: '^IXIC', label: '나스닥', digits: 2 },
  { symbol: 'NQ=F', label: '나스닥100 선물', digits: 2 },
  { symbol: '^GSPC', label: 'S&P 500', digits: 2 },
  { symbol: 'ES=F', label: 'S&P 500 선물', digits: 2 },
  { symbol: '^RUT', label: '러셀2000', digits: 2 },
  { symbol: 'RTY=F', label: '러셀2000 선물', digits: 2 },
  { symbol: '^DJI', label: '다우존스', digits: 2 },
  /**
   * ⚠️ **대용품이다.** 지수 `^SOX` 는 야후에서 404 라 **ETF `SOXX`** 로 받는다.
   *    지수와 ETF 는 값도 등락도 **다르다** ⇒ 라벨에 그대로 적는다.
   *    적지 않으면 사용자는 필라델피아 반도체 **지수**를 보고 있다고 믿는다.
   */
  { symbol: 'SOXX', label: '반도체 SOXX', digits: 2, prefix: '$' },
  { symbol: '^VIX', label: 'VIX', digits: 2 },

  // 환율
  { symbol: 'USDKRW=X', label: '원/달러', digits: 2 },
  { symbol: 'JPYKRW=X', label: '엔/원', digits: 2, scale: 100, labelSuffix: '(100엔)' },
  { symbol: 'EURKRW=X', label: '유로/원', digits: 2 },
  { symbol: 'DX-Y.NYB', label: '달러인덱스', digits: 2 },

  /**
   * 국채 수익률 — 값의 단위가 **%** 다(가격이 아니다).
   * 🔴 **`^TYX` 는 30년물이다.** 사용자는 "20년" 을 적었지만 야후에 20년물 수익률 심볼이 없다.
   *    20년이라 적으면 **그냥 거짓말**이라 있는 그대로 30년으로 단다.
   * ⚠️ 2년물은 현물 심볼이 없어 **선물(2YY=F)** 이다 — 현물 수익률과 미세하게 다르다.
   */
  { symbol: '2YY=F', label: '미국채 2년(선물)', digits: 2, suffix: '%' },
  { symbol: '^FVX', label: '미국채 5년', digits: 2, suffix: '%' },
  { symbol: '^TNX', label: '미국채 10년', digits: 2, suffix: '%' },
  { symbol: '^TYX', label: '미국채 30년', digits: 2, suffix: '%' },

  // 원자재
  { symbol: 'GC=F', label: '금', digits: 2, prefix: '$' },
  { symbol: 'SI=F', label: '은', digits: 2, prefix: '$' },
  { symbol: 'CL=F', label: 'WTI', digits: 2, prefix: '$' },
  { symbol: 'NG=F', label: '천연가스', digits: 3, prefix: '$' },
  { symbol: 'HG=F', label: '구리', digits: 3, prefix: '$' },
  // ⚠️ 밀은 야후가 **센트(USX)** 로 준다 — 달러 기호를 붙이면 1,000배 틀린 값이 된다
  { symbol: 'ZW=F', label: '밀', digits: 2, suffix: '¢' },

  // 코인
  { symbol: 'BTC-USD', label: '비트코인', digits: 0, prefix: '$' },
  { symbol: 'ETH-USD', label: '이더리움', digits: 2, prefix: '$' },
  { symbol: 'XRP-USD', label: '리플', digits: 4, prefix: '$' },
  { symbol: 'SOL-USD', label: '솔라나', digits: 2, prefix: '$' },
];

/**
 * 🔴 **한국 국채(2·3·5·10·20·30년)는 못 띄운다.** 야후에 심볼이 없다(6종 전부 404).
 *    다른 출처(금투협 채권정보센터·한국은행 ECOS)가 필요하고 **키 발급이 선행**이다.
 *    ⇒ 조용히 빼지 않고 여기 적어 둔다 — 다음 사람이 "왜 없지" 하고 다시 찾지 않게.
 */
const UNAVAILABLE = ['국고채 2·3·5·10·20·30년 — 야후에 심볼 없음(ECOS 등 별도 출처 필요)'];

let cache = { at: 0, items: [], failed: 0 };
let inflight = null;

async function fetchOne(spec) {
  const url = `${ENDPOINT}${encodeURIComponent(spec.symbol)}?interval=1d&range=5d`;
  const res = await fetch(url, {
    // ⚠️ User-Agent 가 없으면 야후가 거부한다(실측)
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('meta 없음');

  const price = Number(meta.regularMarketPrice);
  const prev = Number(meta.chartPreviousClose ?? meta.previousClose);
  if (!Number.isFinite(price)) throw new Error('가격 없음');

  const scale = spec.scale || 1;
  return {
    symbol: spec.symbol,
    label: spec.label + (spec.labelSuffix || ''),
    price: price * scale,
    // 🔴 등락률은 **계산으로** 낸다 — 야후 meta 에 직접 주는 칸이 없다.
    //    전일종가가 없으면 **null 이지 0이 아니다**(0% 는 "안 움직였다" 는 거짓말이다)
    changePct: Number.isFinite(prev) && prev !== 0 ? ((price - prev) / prev) * 100 : null,
    digits: spec.digits,
    prefix: spec.prefix || '',
    suffix: spec.suffix || '',
  };
}

/**
 * 테이프 한 벌. 캐시가 살아 있으면 그대로 준다.
 * 🔴 실패해도 **직전 값을 버리지 않는다** — 테이프가 비는 것보다 조금 낡은 게 낫다.
 */
async function getTape({ force = false } = {}) {
  const fresh = Date.now() - cache.at < TTL_MS;
  if (fresh && !force && cache.items.length) return { ...cache, cached: true };
  // 동시에 여러 요청이 와도 한 번만 받아온다(무인증 API 를 아낀다)
  if (inflight) return inflight;

  inflight = (async () => {
    const started = Date.now();
    /**
     * ⚠️ **한 번에 다 때리지 않는다.** 심볼이 29개로 늘었다 — 무인증 API 에 29개를 동시에
     *    던지면 차단당하기 쉽다. 8개씩 끊어 받는다(전체 소요는 여전히 1초대).
     */
    const settled = [];
    for (let i = 0; i < TAPE_SYMBOLS.length; i += 8) {
      const part = await Promise.allSettled(TAPE_SYMBOLS.slice(i, i + 8).map(fetchOne));
      settled.push(...part);
    }
    const items = [];
    const failures = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') items.push(r.value);
      else failures.push({ symbol: TAPE_SYMBOLS[i].symbol, error: String(r.reason?.message || r.reason).slice(0, 120) });
    });

    if (!items.length && cache.items.length) {
      // 전부 실패했다 — **직전 값을 유지**하되 그 사실을 남긴다
      logWarn('tape.all_failed', { keptStale: cache.items.length, failures: failures.slice(0, 3) });
      inflight = null;
      return { ...cache, cached: true, stale: true, failed: failures.length };
    }

    cache = { at: Date.now(), items, failed: failures.length };
    if (failures.length) logWarn('tape.partial', { ok: items.length, failed: failures.length, failures });
    logInfo('tape.refresh', { ok: items.length, failed: failures.length, durationMs: Date.now() - started });
    inflight = null;
    return { ...cache, cached: false };
  })();

  return inflight;
}

function _resetForTest() {
  cache = { at: 0, items: [], failed: 0 };
  inflight = null;
}

module.exports = { getTape, TAPE_SYMBOLS, UNAVAILABLE, _resetForTest };

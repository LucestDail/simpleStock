const toss = require('./tossClient');
const tossPortfolio = require('./tossPortfolio');
const { logInfo, logWarn } = require('./logger');

/**
 * 한 화면 대시보드 집계 (2026-09-21)
 *
 * 사용자: *"모멘텀 기반 분석 및 주식 관련 대시보드, 현황 관리 및 상태 정보 어디에 있어"*
 * ⇒ 화면이 필요한 것을 **한 번에** 준다. 화면이 조각마다 요청하면 토스 한도를 금방 태운다.
 *
 * ## 🔴 부분 실패를 전체 성공으로 보고하지 않는다
 *
 * 조각이 여럿이라 **하나가 실패해도 나머지는 살아야** 한다. 그런데 실패를 조용히
 * 빈 값으로 만들면 화면은 *"데이터가 없네"* 로 보이고 **원인을 영영 모른다.**
 * ⇒ 조각마다 `{ok, data, error}` 를 그대로 싣고, 상위에 `failed` 개수를 낸다.
 *   (워크스페이스 규율: *"검사 못 함 ≠ 통과"*, *"버려지는 경로는 반드시 warn"*)
 *
 * ## 한도 — 🔴 **추정하지 말고 `X-RateLimit-*` 헤더를 본다** (2026-09-22 갱신)
 *
 * 토스는 엔드포인트를 **Rate Limits Group 17개**로 묶고 한도·잔여를 **헤더로** 준다.
 * 종전 이 주석은 경로 단위 추정이었고, 헤더 실측과 **두 군데가 달랐다**.
 *
 * ```
 * 그룹                     한도   경로
 * ACCOUNT                   1 🔴  /accounts            ← 호출 한 번에 소진된다
 * ASSET                     5     /holdings
 * ORDER_INFO                6     /buying-power · /sellable-quantity · /commissions
 * MARKET_DATA              15     /prices · /orderbook · /price-limits · /trades
 * MARKET_DATA_CHART        20     /candles
 * MARKET_INFO               3     /market-calendar/* · /exchange-rate
 * STOCK                     5     /stocks · /stocks/{s}/warnings
 * ORDER                    10     /orders(생성) · /orders/{id}/cancel
 * ORDER                     5 ⚠️  /orders/{id}(조회)   ← **같은 그룹인데 경로별로 다르다**
 * STOCK_TRADING_TREND       —     /stocks/{s}/investor-trading 등 (아직 실측 0건 = 판정 불가)
 * ```
 * ★ **"그룹 한도" 가정에 반례가 있다** — `ORDER` 는 생성 10 / 조회 5 다.
 *   ⇒ 표는 **그룹 + 경로** 두 축으로 읽어야 한다.
 * ⚠️ **여기 적힌 숫자보다 헤더가 맞다.** 어긋나면 헤더를 따르고 이 표를 고친다
 *    (`toss.ratelimit` · `toss.ratelimit_low` · `rateLimitSnapshot()`).
 * ⚠️ `STOCK_TRADING_TREND` 는 **아직 안 불려서 모른다** — 0 은 "여유" 가 아니라 "판정 불가" 다.
 * ⇒ 조각을 **동시에 다 던지지 않는다.** 묶어서 순차로 돌리고, 429 는 클라이언트가 물러선다.
 */

/** 조각 하나를 감싸 실패를 값으로 만든다 — 던지지 않는다 */
async function part(name, fn) {
  try {
    return { name, ok: true, data: await fn() };
  } catch (e) {
    // 조용히 넘기지 않는다. 화면도 알고 로그도 안다.
    logWarn('dashboard.part_failed', { part: name, kind: e?.kind || 'unknown', message: e?.message });
    return { name, ok: false, error: e?.message || '실패', kind: e?.kind || 'unknown' };
  }
}

/** 한도가 좁은 것들을 한 번에 던지지 않도록 묶어서 돌린다 */
async function sequential(tasks, gapMs = 120) {
  const out = [];
  for (const t of tasks) {
    out.push(await t());
    if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string[]} opts.watchSymbols 관심종목 심볼
 * @param {{rate:number, asOf?:string, source?:string}} [opts.fx]
 * @param {number} [opts.momentumPct] 모멘텀 임계값(%)
 * @param {string[]} [opts.rankingTypes]
 */
async function build({
  watchSymbols = [],
  fx = null,
  momentumPct = 3,
  rankingTypes = ['TOP_GAINERS', 'TOP_LOSERS'],
  rankingCountries = ['US', 'KR'],
} = {}) {
  const startedAt = Date.now();

  // ① 보유 — 화면의 중심. 실패해도 나머지는 그린다
  const holdings = await part('holdings', () => tossPortfolio.getHoldings({ fx }));

  // ② 보유 + 관심종목을 합쳐 한 번에 시세·정보를 받는다(둘 다 200건까지 다건)
  const heldSymbols = holdings.ok ? holdings.data.items.map((i) => i.symbol) : [];
  const symbols = [...new Set([...heldSymbols, ...watchSymbols])].filter(Boolean);

  const [info, limits, rankings] = await sequential([
    () => part('stockInfo', async () => Object.fromEntries(await toss.getStockInfo(symbols))),
    // 상·하한가는 국내 종목에만 의미가 있다. 보유 중 KR 만, 그것도 상위 몇 개만 본다
    () =>
      part('priceLimits', async () => {
        const kr = (holdings.ok ? holdings.data.items : []).filter((i) => i.market === 'KR').slice(0, 5);
        const out = {};
        for (const it of kr) {
          out[it.symbol] = await toss.getPriceLimits(it.symbol);
          await new Promise((r) => setTimeout(r, 80));
        }
        return out;
      }),
    () =>
      part('rankings', async () => {
        /**
         * 🔴 2026-09-21: 두 가지가 틀려 있었다(사용자 지적).
         *  ① **종목명이 없다** — 랭킹 응답에는 `symbol` 뿐이라 화면에 코드만 떴다.
         *     ⇒ 받은 심볼을 모아 `/stocks` **한 번**으로 이름을 붙인다(종목마다 부르지 않는다).
         *  ② **한국만 봤다** — 사용자는 주로 미국장을 본다. `marketCountry` 를 설정으로 받는다.
         */
        const out = {};
        const symbols = new Set();
        for (const country of rankingCountries) {
          for (const type of rankingTypes) {
            // 🔴 종류 하나가 실패해도 **나머지 랭킹은 살린다.**
            //    라이브에서 잘못된 종류 하나 때문에 랭킹이 통째로 비었다(2026-09-21).
            try {
              const r = await toss.getRankings({ type, country, duration: '1d', count: 10 });
              out[`${country}:${type}`] = { ...r, country, type };
              r.rows.forEach((x) => symbols.add(x.symbol));
            } catch (e) {
              out[`${country}:${type}`] = { country, type, rows: [], error: e.message, kind: e.kind || 'unknown' };
              logWarn('dashboard.ranking_one_failed', { country, type, kind: e.kind, message: e.message });
            }
            await new Promise((z) => setTimeout(z, 220)); // 한도 5/s
          }
        }
        // 이름 붙이기 — 실패해도 랭킹 자체는 살린다(코드만 보이는 게 아무것도 없는 것보다 낫다)
        try {
          const info = await toss.getStockInfo([...symbols]);
          for (const g of Object.values(out)) {
            g.rows = g.rows.map((x) => ({ ...x, name: info.get(x.symbol)?.name || null }));
          }
        } catch (e) {
          logWarn('dashboard.ranking_names_failed', { message: e?.message });
        }
        return out;
      }),
  ]);

  // ③ 종목 경고 — **빈 배열이 정상**(경고 없음)이다. 보유분만 본다
  const warnings = await part('warnings', async () => {
    const out = {};
    for (const s of heldSymbols.slice(0, 10)) {
      const w = await toss.getWarnings(s);
      if (w.length) out[s] = w;
      await new Promise((r) => setTimeout(r, 220));
    }
    return out;
  });

  const momentum = holdings.ok ? tossPortfolio.pickMomentum(holdings.data.items, momentumPct) : [];

  const parts = [holdings, info, limits, rankings, warnings];
  const failed = parts.filter((p) => !p.ok);

  logInfo('dashboard.built', {
    symbols: symbols.length,
    momentum: momentum.length,
    failedParts: failed.map((f) => f.name),
    durationMs: Date.now() - startedAt,
  });

  return {
    asOf: new Date().toISOString(),
    // 🔴 조각별 성패를 그대로 싣는다 — 화면이 "없음" 과 "못 받음" 을 구분해야 한다
    parts: Object.fromEntries(parts.map((p) => [p.name, p.ok ? { ok: true } : { ok: false, error: p.error, kind: p.kind }])),
    failedCount: failed.length,
    portfolio: holdings.ok ? holdings.data : null,
    momentum,
    momentumPct,
    stockInfo: info.ok ? info.data : {},
    priceLimits: limits.ok ? limits.data : {},
    rankings: rankings.ok ? rankings.data : {},
    warnings: warnings.ok ? warnings.data : {},
  };
}

module.exports = { build, _part: part };

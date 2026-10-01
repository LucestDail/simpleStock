const toss = require('./tossClient');
const stockIdentity = require('./stockIdentity');
const { logInfo, logWarn } = require('./logger');

/**
 * 실제 보유 자산 (2026-09-21 신설) — **증권사가 정본이다**
 *
 * ## 왜 이게 있나
 *
 * v3 에서 `portfolio.json`(손으로 적던 보유 내역)을 걷어냈다. 사용자가 09-21 에 물었다:
 * *"내 주식 정보는 어디에 나와? 내 포트폴리오는 기존의 toss 꺼 가져와야지."*
 * ⇒ 맞다. 손으로 적으면 **틀리고 낡는다**. 토스가 실물을 준다.
 *
 * ## 실측한 계약 (2026-09-21 `.25` 탐침)
 *
 * ```
 * GET /api/v1/accounts    limit 1/s  → [{accountNo, accountSeq, accountType}]
 * GET /api/v1/holdings    limit 5/s  → 🔴 헤더 **X-Tossinvest-Account = accountSeq**(정수)
 *                                        accountNo 를 넣으면 account-not-found 다
 * ```
 * 응답: 계좌 합계(총매입·평가액·손익·**일간손익**) + `items[]`(종목별 같은 구조)
 * ⚠️ **모든 수치가 문자열**이다("272500"). 그리고 금액은 **통화별로 갈려서 온다**(krw/usd).
 *
 * ## 다루는 자세
 *
 * 🔴 이건 **개인 금융정보**다.
 *  - 계좌번호(`accountNo`)는 **받아도 밖으로 내보내지 않는다.** 필요한 건 seq 뿐이다
 *  - 로그에 금액·수량을 찍지 않는다(건수와 성패만)
 *  - 파일에 저장하지 않는다 — **매번 증권사에서 읽는다.** 사본을 만들면
 *    백업(.25→.23→맥)으로 퍼지고, 그게 09-01 에 걷어낸 `portfolio.json` 이 만든 문제다
 */

const ACCOUNT_TTL_MS = 6 * 60 * 60 * 1000; // 계좌 목록은 거의 안 바뀐다. limit 이 1/s 라 아껴 쓴다
let accountCache = null; // { seq, type, at }

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 🔴 손익률은 **퍼센트가 아니라 소수비율**로 온다.
 * 스펙 원문: *"손익률. 소수비율 (0.1077 = 10.77%)"*
 * 처음에 그대로 화면에 뿌려 **100배 작게** 나왔다(+28.45% 가 "+0.28%" 로).
 * 숫자가 작아서 "오늘 별로 안 움직였네" 로 읽히는 게 더 나빴다 — **틀린 줄도 모른다.**
 * ⇒ **경계에서 한 번만** 퍼센트로 바꾸고, 이후 코드는 전부 퍼센트로 다룬다.
 */
/**
 * 금액과 매입액으로 수익률을 **직접 계산**한다. 증권사 값과 어긋나면 경고하되 **덮어쓰지 않는다**
 * (원본 `profitRate` 와 유도값 `profitRateDerived` 를 나란히 싣는다 — 그 필드의 의미를 우리가 모른다).
 *
 * ⚠️ 통화가 섞이면(원화+달러) 환율 없이는 합칠 수 없다 ⇒ 그때는 **계산하지 않고**
 *    증권사 값을 그대로 쓴다(모르는 것을 지어내지 않는다).
 * ⚠️ 매입액이 0이면 수익률이 정의되지 않는다 — 나누지 않는다.
 */
/**
 * 🔴 **같은 사실을 매번 외치지 않는다** (2026-10-01 저녁 — 내가 **같은 날 두 번째로** 밟았다).
 *
 * 처음엔 어긋날 때마다 `logWarn` 했다. `getHoldings` 는 화면 폴링·브리핑·채팅마다 불린다 ⇒
 * 배포 3.3시간에 **284건**(시간당 86 → 117 로 증가). 값은 가격이 틱할 때마다 끝자리만
 * 바뀔 뿐 **괴리 자체는 상수**(약 10%p)다.
 *
 * ⚠️ 몇 시간 전에 `watchlist.stale_quote_dropped` 에서 똑같은 것을 고치고, 그 교훈을
 *    메모리에 적어 놓고, **같은 세션에서 또 만들었다.**
 *    ★ *"규칙을 아는 것과 그 순간에 적용하는 것은 다른 능력"* 의 실례 ⇒ 규칙이 아니라 **코드**로 옮긴다.
 *
 * ⇒ **괴리 폭이 달라질 때**(1%p 단위)와 **한 시간에 한 번**만 남긴다. 그래야 한 줄이
 *   *"지금 이렇다"* 가 아니라 **"달라졌다"** 또는 **"아직도 그렇다"** 를 뜻한다.
 * ⚠️ 완전히 끄지 않는다 — 조용해지면 *"고쳐졌다"* 와 *"검사가 멈췄다"* 가 같아 보인다.
 */
const RATE_MISMATCH_COOLDOWN_MS = Math.max(0, Number(process.env.TOSS_RATE_MISMATCH_COOLDOWN_MS) || 60 * 60_000);
const rateMismatchSeen = new Map();   // label → { bucket, at }

function reportRateMismatch(label, reported, derived, now = Date.now()) {
  const bucket = Math.round(derived - reported);   // 가격이 틱해도 같은 사실이면 같은 값
  const prev = rateMismatchSeen.get(label);
  const changed = !prev || prev.bucket !== bucket;
  const stale = Boolean(prev) && now - prev.at >= RATE_MISMATCH_COOLDOWN_MS;
  if (!changed && !stale) return false;
  rateMismatchSeen.set(label, { bucket, at: now });
  logWarn('toss.rate_mismatch', {
    field: label, reported, derived, gapPct: bucket,
    why: changed ? (prev ? 'gap_changed' : 'first_seen') : 'still_mismatched',
    // ⚠️ 금액은 로그에 안 남긴다(이 파일의 기존 방침) — 비율만으로 진단된다
    note: '증권사 수익률이 자기 금액과 맞지 않는다 — 원본은 profitRate, 유도값은 profitRateDerived 로 둘 다 싣는다',
  });
  return true;
}

/** 테스트용 — 프로세스 상태를 격리한다 */
function _resetRateMismatchForTest() { rateMismatchSeen.clear(); }

function deriveRatePct(amountObj, purchaseObj, reportedPct, label) {
  const aK = num(amountObj?.krw) || 0;
  const aU = num(amountObj?.usd) || 0;
  const pK = num(purchaseObj?.krw) || 0;
  const pU = num(purchaseObj?.usd) || 0;
  const mixed = (aK && aU) || (pK && pU);
  if (mixed) return reportedPct;                       // 통화 혼재 — 환율 없이 못 합친다
  const amount = aU || aK;
  const purchase = pU || pK;
  if (!purchase) return reportedPct;                   // 0 으로 나누지 않는다
  const derived = Math.round((amount / purchase) * 100 * 100) / 100;
  if (reportedPct != null && Math.abs(derived - reportedPct) > 0.5) {
    reportRateMismatch(label, reportedPct, derived);
  }
  return derived;
}

function ratePct(v) {
  const n = num(v);
  return n == null ? null : Math.round(n * 100 * 10000) / 10000;
}

/**
 * {krw, usd} 쌍을 숫자로 + **원화 환산을 여기서 끝낸다**.
 *
 * 🔴 토스는 통화별로 갈라서 준다. 미국 종목만 있으면 `krw` 는 **0** 이다.
 *    처음엔 프론트에서 환산했는데, **소비자가 화면 하나가 아니다** —
 *    텔레그램 발송·API 직접 조회는 그대로 **₩0 을 본다**(사용자가 스크린샷으로 잡은 그 증상).
 *    ⇒ 표시 로직이 여러 소비자를 가지면 **뒤쪽(서버)으로 내린다.**
 *
 * ⚠️ 환율을 모르면 `krw` 를 **0 으로 채우지 않는다.** 0 은 "0원이다" 로 읽힌다.
 *    `null` + `converted:false` 로 두고 **모른다는 사실을 그대로 내보낸다.**
 */
function pair(o, fxRate) {
  const krw = num(o?.krw);
  const usd = num(o?.usd);
  const base = krw || 0;
  if (!usd) return { krw: krw, usd: usd, converted: false };
  if (!fxRate) return { krw: krw || null, usd, converted: false, fxMissing: true };
  return { krw: Math.round(base + usd * fxRate), usd, converted: true };
}

async function getAccount({ force = false } = {}) {
  if (!force && accountCache && Date.now() - accountCache.at < ACCOUNT_TTL_MS) return accountCache;
  const rows = await toss.apiGet('/api/v1/accounts');
  const first = Array.isArray(rows) ? rows[0] : null;
  if (!first || first.accountSeq == null) {
    throw new toss.TossError('토스 계좌를 찾지 못했습니다', { kind: 'shape', path: '/api/v1/accounts' });
  }
  // ⚠️ accountNo 는 **일부러 안 담는다** — 밖으로 나갈 일이 없다
  accountCache = { seq: Number(first.accountSeq), type: first.accountType || null, at: Date.now() };
  logInfo('toss.account.resolved', { type: accountCache.type });
  return accountCache;
}

/**
 * 보유 현황. **저장하지 않고 매번 읽는다.**
 * @returns {Promise<{summary:object, items:object[], asOf:string}>}
 */
/**
 * @param {object} [opts]
 * @param {{rate:number, asOf?:string, source?:string}} [opts.fx] 원화 환산에 쓸 환율.
 *   없으면 환산하지 않는다(krw 는 null 로 남는다).
 */
async function getHoldings({ fx = null } = {}) {
  const acc = await getAccount();
  const fxRate = Number(fx?.rate) || 0;
  const r = await toss.apiGet('/api/v1/holdings', { accountSeq: acc.seq });

  const items = (Array.isArray(r?.items) ? r.items : []).map((it) => ({
    symbol: String(it.symbol || ''),
    name: String(it.name || it.symbol || ''),
    market: String(it.marketCountry || '').toUpperCase() || null,
    currency: it.currency || null,
    quantity: num(it.quantity),
    lastPrice: num(it.lastPrice),
    avgPrice: num(it.averagePurchasePrice),
    purchaseAmount: num(it.marketValue?.purchaseAmount),
    marketValue: num(it.marketValue?.amount),
    profit: num(it.profitLoss?.amount),
    profitRate: ratePct(it.profitLoss?.rate),
    // 🔴 모멘텀의 재료 — "오늘 얼마나 움직였나" 는 증권사가 계산해서 준다
    dailyProfit: num(it.dailyProfitLoss?.amount),
    dailyRate: ratePct(it.dailyProfitLoss?.rate),
  }));

  /**
   * 🔴 종목 정체(정식명·레버리지 배수·상장일)를 **여기 한 곳**에서 붙인다 (2026-09-22).
   *    분석 프롬프트·채팅 도구·화면이 전부 이 items 를 물려받는다 — 세 곳에 따로 붙이면
   *    하나가 빠진 채 "채워진 척" 한다. 실패해도 보유는 돌려준다(정체는 곁가지, 6h 캐시).
   */
  const enriched = await stockIdentity.enrich(items);

  /**
   * 현금은 **통화별 별도 호출**이라 둘을 함께 받는다.
   * ⚠️ 한쪽이 실패해도 다른 쪽은 쓴다 — `null` 은 "0" 이 아니라 **"못 받았다"** 로 구분한다.
   */
  const cash = { krw: null, usd: null, failed: [] };
  for (const cur of ['KRW', 'USD']) {
    try {
      const bp = await toss.getBuyingPower(cur, { accountSeq: acc.seq });
      cash[cur.toLowerCase()] = { raw: bp.cash.raw, amount: bp.cash.num };
    } catch (e) {
      cash.failed.push(cur);
      // 🔴 조용히 넘기지 않는다 — 현금이 안 보이면 사용자는 "0 원인가" 로 읽는다
      logWarn('toss.buying_power_failed', { currency: cur, kind: e.kind, message: e.message });
    }
  }

  const summary = {
    purchase: pair(r?.totalPurchaseAmount, fxRate),
    value: pair(r?.marketValue?.amount, fxRate),
    profit: pair(r?.profitLoss?.amount, fxRate),
    /**
     * 🔴 **증권사 수익률이 자기 금액과 안 맞는다 — 그런데 우리는 그 이유를 모른다** (2026-10-01)
     *
     * 라이브 실측:
     * ```
     * profitLoss.amount   usd "220.235217"    ← +$220 (이익)
     * profitLoss.rate     "-0.087"            ← -8.7%  🔴 **부호가 반대**
     * totalPurchaseAmount usd "14146.884783"  ⇒ 220.24/14146.88 = **+1.56%**
     * ```
     * ⚠️ **오늘 생긴 일이 아니다.** 저장소에 캡처된 실제 응답(`tests/tossClient.test.js:448`)
     *    에서도 amount −272.72 / purchase 15,539.90 = **−1.75%** 인데 rate 는 **−9.88%** 였다.
     *    즉 **일관되게 약 8%p 어긋나는 필드**이고, 오늘은 보유 구성이 바뀌어 **부호까지** 갈렸다.
     *
     * 🔴 **그래서 덮어쓰지 않는다.** 그 필드가 "미실현만" 이 아니라 **실현 손익을 포함한
     *    누적 수익률** 같은 다른 의미일 수 있다(사용자가 최근 QLD 99→90 · RAM 442→400 을
     *    줄였다). **의미를 모르는 제3자 값을 우리 해석으로 갈아끼우면, 맞았을 때도 틀렸을
     *    때도 아무도 모르게 된다.**
     * ⇒ 원본은 `profitRate` 로 **그대로** 두고, 금액에서 유도한 값을 `profitRateDerived`
     *   로 **나란히** 싣는다. 어긋나면 경고한다. 쓰는 쪽이 **무엇을 쓰는지 알고** 고르게 한다.
     *
     * ★ 이 결함이 드러난 경위: 모델이 우리 `profitRate`(-8.9%)를 안 믿고 **부분 합으로 다시
     *   계산해** "+0.98%" 라고 답했고, 사용자가 그 불일치를 물었다. 모델이 믿었으면 묻힌다.
     */
    profitRate: ratePct(r?.profitLoss?.rate),
    profitRateDerived: deriveRatePct(r?.profitLoss?.amount, r?.totalPurchaseAmount, ratePct(r?.profitLoss?.rate), 'profit'),
    dailyProfit: pair(r?.dailyProfitLoss?.amount, fxRate),
    // ⚠️ 일간은 **매입액 기준이 아니다**(전일 평가액 기준) ⇒ 우리가 다시 계산할 근거가 없다.
    //    실측에서 금액과도 맞으므로 **증권사 값을 그대로 쓴다.** 고칠 것만 고친다.
    dailyRate: ratePct(r?.dailyProfitLoss?.rate),
    accountType: acc.type,
    /**
     * 🔴 **현금(매수 가능 금액)** — 사용자: *"내 자산에 내 현금 보유액은 안보이는데 토스에서 제공하나?"*
     *    제공한다(`GET /api/v1/buying-power`). **우리가 안 부르고 있었다.**
     *
     * ⚠️ 이게 없으면 분석 프롬프트의 *"현금 여력을 넘지 않게"* 가 **지킬 수 없는 지시**다 —
     *    모델에게 근거를 안 주고 규칙만 요구하고 있었다.
     * ⚠️ 통화별로 따로 부른다(한 번에 둘이 안 온다) · **실패해도 보유는 돌려준다**(곁가지다).
     * ⚠️ 금액은 **문자열**로 온다(정밀도) — 원문과 숫자를 함께 들고 간다.
     */
    cash,
    // 🔴 **언제·어디 환율로 계산했는지**를 값과 함께 내보낸다.
    //    없으면 "어제 환율로 계산된 금액" 을 사용자가 구분할 수 없다.
    fx: fxRate
      ? { rate: fxRate, asOf: fx?.asOf || null, source: fx?.source || null }
      : null,
  };

  // 금액·수량은 로그에 남기지 않는다. 건수와 성패만.
  logInfo('toss.holdings', { items: enriched.length });
  return { summary, items: enriched, asOf: new Date().toISOString() };
}

/**
 * 모멘텀 후보 — **판단하지 않고 고르기만** 한다.
 * 임계값을 넘은 종목을 돌려주고, 무엇을 할지는 사람(또는 HITL 제안)이 정한다.
 * @param {number} thresholdPct 당일 등락 절대값 기준
 */
function pickMomentum(items, thresholdPct = 3) {
  const t = Math.abs(Number(thresholdPct) || 0);
  return (items || [])
    .filter((it) => it.dailyRate != null && Math.abs(it.dailyRate) >= t)
    .sort((a, b) => Math.abs(b.dailyRate) - Math.abs(a.dailyRate));
}

function isEnabled() {
  return toss.isConfigured();
}

function _resetForTest() {
  accountCache = null;
}

module.exports = {
  reportRateMismatch,
  _resetRateMismatchForTest, getAccount, getHoldings, pickMomentum, isEnabled, _resetForTest };

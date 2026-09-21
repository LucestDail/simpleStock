const toss = require('./tossClient');
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

/** {krw, usd} 쌍을 숫자로. 없는 쪽은 null 로 둔다(0 으로 만들지 않는다) */
function pair(o) {
  return { krw: num(o?.krw), usd: num(o?.usd) };
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
async function getHoldings() {
  const acc = await getAccount();
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
    profitRate: num(it.profitLoss?.rate),
    // 🔴 모멘텀의 재료 — "오늘 얼마나 움직였나" 는 증권사가 계산해서 준다
    dailyProfit: num(it.dailyProfitLoss?.amount),
    dailyRate: num(it.dailyProfitLoss?.rate),
  }));

  const summary = {
    purchase: pair(r?.totalPurchaseAmount),
    value: pair(r?.marketValue?.amount),
    profit: pair(r?.profitLoss?.amount),
    profitRate: num(r?.profitLoss?.rate),
    dailyProfit: pair(r?.dailyProfitLoss?.amount),
    dailyRate: num(r?.dailyProfitLoss?.rate),
    accountType: acc.type,
  };

  // 금액·수량은 로그에 남기지 않는다. 건수와 성패만.
  logInfo('toss.holdings', { items: items.length });
  return { summary, items, asOf: new Date().toISOString() };
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

module.exports = { getAccount, getHoldings, pickMomentum, isEnabled, _resetForTest };

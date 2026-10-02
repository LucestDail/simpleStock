/**
 * 주문 사전 점검 (2026-10-02 — 와이어프레임 ⑨ "매매 제안 → 승인 → 토스 주문 플로우")
 *
 * 원칙(와이어프레임 원문): *"에이전트는 주문 '초안'까지만 만든다. 실제 주문 전송은
 * 사람의 최종 확인 한 번을 반드시 거친다."*
 *
 * ## 왜 필요했나
 * 종전 화면에는 **제안 → 실제 주문 경로가 없었다.** 매매 제안이 *"승인"* 이라는 문구로만
 * 존재했고, 사람이 승인 버튼을 누를 때 **무엇을 근거로** 누르는지가 화면에 없었다 —
 * 잔고가 충분한지, 장이 열려 있는지, 같은 종목에 미체결이 있는지, 체결되면 비중이
 * 어떻게 바뀌는지가 전부 **보이지 않았다.**
 *
 * ## 🔴 이 모듈은 **막지 않는다 — 사실만 모은다**
 * 각 항목은 `pass | warn | fail | unknown` 을 돌려주고, **집행 여부는 호출자와 사람이**
 * 정한다. 여기서 막아 버리면 "왜 승인 버튼이 없지" 가 되고, 그건 사용자가 이유를 모르는
 * 침묵이다(이 저장소가 반복해 배운 축).
 *
 * ⚠️ **`unknown` 은 `pass` 가 아니다.** 못 잰 항목을 통과로 보여주면 그게 바로
 *    *"검사 안 한 것을 초록불로 보여주는"* 그 실패 모드다.
 */
const { logWarn } = require('./logger');

/** 한 항목의 결과 — 화면이 그대로 그릴 수 있는 모양 */
function item(key, label, status, detail, extra = {}) {
  return { key, label, status, detail, ...extra };
}

/**
 * 체결 후 비중을 **지금 스냅샷에서** 계산한다.
 * ⚠️ 현금이 분모에 있어야 "현금 비중" 이라는 축이 산다(portfolioWeights 와 같은 규율).
 * ⚠️ 못 구하면 `null` — 0 으로 채우면 "영향 없음" 으로 읽힌다.
 */
function projectWeights({ items = [], summary = null, side, symbol, quantity, price, weightsOf }) {
  const qty = Number(quantity);
  const px = Number(price);
  const sym = String(symbol || '').toUpperCase();
  if (!(qty > 0) || !(px > 0) || !sym) return null;

  const before = weightsOf(items, summary, null);
  if (!before) return null;

  const delta = qty * px;
  const isBuy = String(side || '').toUpperCase() === 'BUY';
  const next = [];
  let matched = false;
  for (const h of items || []) {
    const s = String(h.symbol || '').toUpperCase();
    const value = Number(h.marketValue) || (Number(h.quantity) * Number(h.lastPrice)) || 0;
    if (s !== sym) { next.push(h); continue; }
    matched = true;
    const after = isBuy ? value + delta : Math.max(0, value - delta);
    // ⚠️ 수량도 함께 옮긴다 — marketValue 만 바꾸면 화면의 "몇 주" 가 거짓이 된다
    const q = Number(h.quantity) || 0;
    next.push({ ...h, marketValue: after, quantity: isBuy ? q + qty : Math.max(0, q - qty) });
  }
  if (!matched && isBuy) {
    next.push({ symbol: sym, marketValue: delta, quantity: qty, lastPrice: px, currency: 'USD' });
  }

  /** 현금은 반대로 움직인다 — 사면 줄고 팔면 는다 */
  const cashUsd = Number(summary?.cash?.usd?.amount) || 0;
  const nextSummary = {
    ...summary,
    cash: { ...(summary?.cash || {}), usd: { ...(summary?.cash?.usd || {}), amount: isBuy ? cashUsd - delta : cashUsd + delta } },
  };
  const after = weightsOf(next, nextSummary, null);
  if (!after) return null;
  return { before, after };
}

/**
 * 제안 하나에 대한 사전 점검.
 *
 * @param {object} proposal  orderService 가 들고 있는 제안
 * @param {object} deps      주입(테스트가 실물 없이 돌 수 있어야 한다)
 */
async function precheck(proposal, deps = {}) {
  const {
    getHoldings = () => require('./tossPortfolio').getHoldings({ fx: null }),
    checkAccountLimits = (a) => require('./orderService').checkAccountLimits(a),
    getSessions = () => require('./marketDataService').getMarketSessionSnapshot(),
    getOpenOrders = null,
    weightsOf = (i, s) => require('./analystService').portfolioWeights(i, s, require('./regimeService').readCatalog()),
    now = Date.now(),
  } = deps;

  const p = proposal || {};
  const sym = String(p.symbol || '').toUpperCase();
  const side = String(p.side || '').toUpperCase();
  const qty = Number(p.quantity);
  const px = Number(p.price);
  const checks = [];
  let holdings = null;

  // ① 잔고 재조회 — **방금** 읽은 값인지가 핵심이다(스냅샷 불일치가 이 화면의 존재 이유다)
  try {
    holdings = await getHoldings();
    const age = holdings?.asOf ? Math.round((now - Date.parse(holdings.asOf)) / 1000) : null;
    checks.push(item('balance', '잔고 재조회', 'pass',
      holdings?.asOf ? `${String(holdings.asOf).slice(11, 19)}${age != null ? ` (${age}초 전)` : ''}` : '조회됨',
      { asOf: holdings?.asOf || null }));
  } catch (e) {
    // ⚠️ 못 읽은 것은 **통과가 아니다**
    checks.push(item('balance', '잔고 재조회', 'fail', e.message || '조회 실패'));
  }

  // ② 주문가능금액 · 보유수량 — orderService 가 이미 판정한다(자를 새로 만들지 않는다)
  try {
    const chk = await checkAccountLimits({ symbol: sym, side, quantity: qty, price: px });
    if (chk?.ok) {
      checks.push(item('limits', side === 'BUY' ? '주문가능금액' : '보유수량 ≥ 주문수량', 'pass', '통과'));
    } else {
      /**
       * 🔴 수량 부족은 **fail 이 아니라 warn** 이다 — `maxQuantity` 로 줄이면 주문이 성립한다.
       *    브리핑 경로가 이미 그렇게 깎아서 낸다(10-02). 화면도 같은 선택지를 줘야 한다.
       */
      const canTrim = chk?.kind === 'insufficient' && Number(chk?.maxQuantity) >= 1;
      checks.push(item('limits', side === 'BUY' ? '주문가능금액' : '보유수량 ≥ 주문수량',
        canTrim ? 'warn' : 'fail', chk?.error || '한도 초과',
        canTrim ? { suggestQuantity: Number(chk.maxQuantity) } : {}));
    }
  } catch (e) {
    checks.push(item('limits', '한도 확인', 'unknown', e.message || '확인 못 함'));
  }

  // ③ 장 운영시간 — 마감이면 **막지 않고** "예약 주문으로 접수" 라고 알린다
  try {
    const snap = await getSessions();
    const key = /^\d{6}$/.test(sym) ? 'kr' : 'us';
    const st = snap?.sessions?.[key]?.state || null;
    const open = st === 'open' || st === 'regular';
    checks.push(item('session', `${key === 'kr' ? '한국' : '미국'} 정규장 운영시간`,
      open ? 'pass' : 'warn',
      open ? '정규장' : '장 마감 · 예약 주문으로 접수', { state: st }));
  } catch (e) {
    checks.push(item('session', '장 운영시간', 'unknown', e.message || '확인 못 함'));
  }

  // ④ 동일 종목 미체결 — **중복 주문**을 막는 유일한 축이다
  if (typeof getOpenOrders === 'function') {
    try {
      const open = await getOpenOrders(sym);
      const n = Array.isArray(open) ? open.length : 0;
      checks.push(item('open_orders', '동일 종목 미체결 주문', n ? 'warn' : 'pass', n ? `${n}건` : '없음', { count: n }));
    } catch (e) {
      checks.push(item('open_orders', '동일 종목 미체결 주문', 'unknown', e.message || '확인 못 함'));
    }
  } else {
    // ⚠️ **조회 수단이 없다는 사실을 적는다** — 항목을 빼면 "확인했다" 로 읽힌다
    checks.push(item('open_orders', '동일 종목 미체결 주문', 'unknown', '조회 수단 미연결'));
  }

  // ⑤ 체결 후 비중 — 승인 버튼을 누르기 전에 **무엇이 바뀌는지** 보여준다
  let impact = null;
  if (holdings) {
    try {
      impact = projectWeights({
        items: holdings.items, summary: holdings.summary,
        side, symbol: sym, quantity: qty, price: px, weightsOf,
      });
    } catch (e) { logWarn('precheck.impact_failed', { message: e.message }); }
  }

  /**
   * 🔴 **종합 판정은 "막는다/안 막는다" 가 아니라 "사람이 무엇을 알아야 하나" 다.**
   *    fail 이 하나라도 있으면 `blocked`(그 주문은 지금 성립 못 한다),
   *    warn·unknown 만 있으면 `caution`(사람이 보고 정한다), 전부 pass 면 `ready`.
   */
  const has = (s) => checks.some((c) => c.status === s);
  const verdict = has('fail') ? 'blocked' : (has('warn') || has('unknown')) ? 'caution' : 'ready';

  return { proposalId: p.id || null, symbol: sym, side, quantity: qty, price: px, checks, impact, verdict };
}

module.exports = { precheck, projectWeights, _item: item };

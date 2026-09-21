/**
 * 주문 규칙 — **순수 함수** (2026-09-22, 토스 명세 v1.2.17)
 *
 * 돈이 움직이는 규칙은 네트워크 없이 검증할 수 있어야 한다. 그래야 *"장중에만 알 수 있다"* 는
 * 핑계 없이 **지금** 잴 수 있다. 이 파일은 토스도 LLM 도 파일도 모른다.
 *
 * ## 🔴 명세에서 뽑은 것 중 **틀리면 돈이 나가는** 것들
 *
 * ```
 * price        LIMIT 이면 필수 · MARKET 이면 **전달 금지**(보내면 400)
 * quantity     기본 **양의 정수**. 소수점은 US + MARKET + SELL 일 때만(6자리)
 * 소수점 매수   quantity 가 아니라 **orderAmount**(달러 금액), US MARKET 전용
 * 시간 제약     소수점·금액 주문은 **정규장 종료 1시간 전**까지만 접수(밖이면 422)
 * clientOrderId 멱등키. **서버가 자동 생성하지 않는다** · 10분 유효 · ^[a-zA-Z0-9\\-_]+$ · ≤36
 * KR 호가단위   가격 구간별로 다르다 — 어긋나면 거부된다
 * ```
 *
 * ## 🔴 재시도가 위험한 자리 (명세 근거)
 *
 * `POST /orders` 는 `clientOrderId` 로 멱등이 걸리지만 **정정·취소는 멱등키가 없다.**
 * 게다가 **정정·취소가 성공하면 새 `orderId` 가 발급**되고 원 ID 는 추적에서 끊긴다.
 * ⇒ 정정·취소는 **자동 재시도 금지**다. 타임아웃이면 조회로 확정해야 한다.
 */

/** 멱등키 규격 — 명세: `maxLength 36`, `^[a-zA-Z0-9\-_]+$` */
const CLIENT_ORDER_ID_RE = /^[a-zA-Z0-9\-_]{1,36}$/;

/**
 * 한국거래소 호가 단위 (2023-01 개편 기준).
 * ⚠️ **이 표는 바뀐다** — 거래소가 개편하면 조용히 틀린다. 그래서 여기 한 곳에만 둔다.
 * ⚠️ ETF·ETN 은 단위가 다르다(전 구간 5원). 그건 종목 종류를 알아야 해서 **여기서 판정하지 않는다** —
 *    모르면 `null` 을 주고 호출자가 *"확인 못 함"* 으로 다룬다. **추측해서 통과시키지 않는다.**
 */
const KR_TICKS = [
  [2000, 1], [5000, 5], [20000, 10], [50000, 50],
  [200000, 100], [500000, 500], [Infinity, 1000],
];

function krTickSize(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return null;
  for (const [cap, tick] of KR_TICKS) if (p < cap) return tick;
  return 1000;
}

const isKr = (symbol) => /^\d{6}$/.test(String(symbol || '').trim());

/** 소수 자릿수 */
function scaleOf(v) {
  const s = String(v);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/**
 * 주문 요청이 **보낼 수 있는 모양인지** 판정한다.
 *
 * @returns {{ok:boolean, errors:string[], warnings:string[], body?:object}}
 *
 * ⚠️ **모르면 통과시키지 않는다.** 예컨대 ETF 호가 단위를 모르면 경고가 아니라
 *    *"확인 못 함"* 으로 남기고 호출자가 사람에게 묻게 한다.
 */
function validateOrderRequest(input = {}, { isEtf = null } = {}) {
  const errors = [];
  const warnings = [];
  /**
   * 🔴 **"확인 못 한 것" 을 기계가 읽을 수 있게 남긴다.**
   *    경고 문구를 정규식으로 판정하면 문구를 고치는 순간 조용히 통과한다.
   *    실거래 경로는 이 목록이 **비어 있을 때만** 보낸다.
   */
  const uncertain = [];
  const symbol = String(input.symbol || '').trim();
  const side = String(input.side || '').toUpperCase();
  const orderType = String(input.orderType || input.type || '').toUpperCase();
  const qty = input.quantity;
  const price = input.price;
  const amount = input.orderAmount;

  if (!symbol) errors.push('symbol 이 없습니다.');
  if (side !== 'BUY' && side !== 'SELL') errors.push('side 는 BUY/SELL 이어야 합니다.');
  if (orderType !== 'LIMIT' && orderType !== 'MARKET') errors.push('orderType 은 LIMIT/MARKET 이어야 합니다.');

  const kr = isKr(symbol);

  // ── 가격 ──────────────────────────────────────────────
  if (orderType === 'LIMIT') {
    if (!(Number(price) > 0)) errors.push('LIMIT 주문은 price 가 필요합니다.');
    else if (kr) {
      if (!Number.isInteger(Number(price))) errors.push('국내 지정가는 원 단위 정수여야 합니다.');
      const tick = krTickSize(price);
      if (isEtf === true) {
        // ETF 는 전 구간 5원 — 종류를 **아는 경우에만** 판정한다
        if (Number(price) % 5 !== 0) errors.push(`국내 ETF 호가 단위(5원)에 맞지 않습니다: ${price}`);
      } else if (isEtf === null) {
        // 🔴 모르면 통과도 실패도 아니다 — 사람이 보게 남긴다
        uncertain.push('kr_tick');
        warnings.push(`호가 단위를 확정하지 못했습니다(ETF 여부 미상). 일반주 기준 ${tick}원으로 보면 ${Number(price) % tick === 0 ? '맞습니다' : '어긋납니다'}.`);
      } else if (Number(price) % tick !== 0) {
        errors.push(`국내 호가 단위(${tick}원)에 맞지 않습니다: ${price}`);
      }
    }
  } else if (price != null) {
    // 🔴 명세: MARKET 에 price 를 **보내면 안 된다**
    errors.push('MARKET 주문에는 price 를 보내면 안 됩니다.');
  }

  // ── 수량 / 금액 ────────────────────────────────────────
  const hasQty = qty != null && qty !== '';
  const hasAmt = amount != null && amount !== '';
  if (hasQty && hasAmt) errors.push('quantity 와 orderAmount 를 함께 보낼 수 없습니다.');
  if (!hasQty && !hasAmt) errors.push('quantity 또는 orderAmount 가 필요합니다.');

  if (hasQty) {
    const q = Number(qty);
    if (!(q > 0)) errors.push('quantity 는 0 보다 커야 합니다.');
    else if (!Number.isInteger(q)) {
      /**
       * 🔴 소수점 수량은 **미국 + 시장가 + 매도** 일 때만 가능하다(명세).
       *    그 밖이면 400 이다 — 여기서 막지 않으면 사용자가 승인을 누른 뒤에 실패를 안다.
       */
      if (kr) errors.push('국내 주식은 소수점 수량을 쓸 수 없습니다.');
      else if (orderType !== 'MARKET' || side !== 'SELL') {
        errors.push('소수점 수량은 해외주식 **시장가 매도**에서만 가능합니다(매수는 orderAmount 를 쓰세요).');
      } else if (scaleOf(qty) > 6) {
        errors.push(`소수점은 6자리까지입니다: ${qty}`);
      }
    }
  }

  if (hasAmt) {
    if (kr) errors.push('금액 주문(orderAmount)은 해외주식 전용입니다.');
    if (orderType !== 'MARKET') errors.push('금액 주문은 시장가에서만 가능합니다.');
    if (!(Number(amount) > 0)) errors.push('orderAmount 는 0 보다 커야 합니다.');
  }

  // ── 멱등키 ────────────────────────────────────────────
  if (input.clientOrderId != null && !CLIENT_ORDER_ID_RE.test(String(input.clientOrderId))) {
    errors.push('clientOrderId 는 영숫자·하이픈·밑줄 36자 이내여야 합니다.');
  }

  /**
   * 🔴 **소수점·금액 주문은 시간 제약이 있다** — 정규장 종료 1시간 전까지.
   *    여기서는 시각을 모르므로 **경고로 남긴다**(막지는 않는다) — 막으려면 캘린더가 필요하다.
   */
  if ((hasAmt || (hasQty && !Number.isInteger(Number(qty)))) ) {
    warnings.push('소수점·금액 주문은 **정규장 종료 1시간 전**까지만 접수됩니다(밖이면 422).');
  }

  if (errors.length) return { ok: false, errors, warnings, uncertain };

  // 명세대로 **문자열**로 만든다 — number 로 보내면 정밀도가 깎인다
  const body = { symbol, side, orderType };
  if (hasQty) body.quantity = String(qty);
  if (hasAmt) body.orderAmount = String(amount);
  if (orderType === 'LIMIT') body.price = String(price);
  if (input.clientOrderId) body.clientOrderId = String(input.clientOrderId);
  if (input.timeInForce && !hasAmt) body.timeInForce = String(input.timeInForce);
  return { ok: true, errors: [], warnings, uncertain, body };
}

/**
 * 제안 id 로 멱등키를 만든다.
 * 🔴 명세: *"서버는 자동 생성하지 않습니다"* ⇒ **우리가 주지 않으면 멱등성이 없다**
 *    (같은 제안을 두 번 승인하면 **주문이 두 번 나간다**).
 * ⚠️ 유효기간이 **10분**이다 — 그 뒤 같은 키는 **새 주문**이 된다. 제안 TTL(5분)이 그보다 짧아
 *    지금 구조에서는 안전하지만, TTL 을 늘리면 이 전제가 깨진다.
 */
function idempotencyKeyFor(proposalId) {
  const raw = String(proposalId || '').replace(/[^a-zA-Z0-9\-_]/g, '');
  return raw.slice(0, 36) || null;
}

/**
 * 조건주문(스탑로스) 요청을 만든다.
 *
 * 🔴 명세에 **"스탑로스" 라는 타입이 없다.** 조건 종류(`STOP`/`PROFIT_RATE`)는 **응답 전용**이고
 *    요청은 `type`(SINGLE/OCO/OTO) + `first/second{orderSide, triggerPrice, orderPrice}` 뿐이다.
 *    ⇒ 손절은 **`SINGLE` + `SELL` + `triggerPrice`** 로 표현한다.
 * 🔴 **트레일링 스탑은 명세에 없다** — 만들 수단이 없다. "나중에" 라는 문구만 있다.
 * ⚠️ OCO 는 둘 다 `SELL` 이고 `first 감시가 > 현재가 > second 감시가` 이며 `LIMIT` 만 된다.
 * ⚠️ `expireDate` 가 **필수**다 — 안 주면 거부된다.
 */
function buildStopLoss({ symbol, quantity, triggerPrice, orderPrice, expireDate, clientOrderId } = {}) {
  const errors = [];
  if (!symbol) errors.push('symbol 이 없습니다.');
  if (!(Number(quantity) > 0)) errors.push('quantity 가 필요합니다.');
  if (!(Number(triggerPrice) > 0)) errors.push('triggerPrice(감시가) 가 필요합니다.');
  if (!(Number(orderPrice) > 0)) errors.push('orderPrice(주문가) 가 필요합니다. 조건주문은 LIMIT 만 됩니다.');
  if (!expireDate) errors.push('expireDate 가 필요합니다(명세상 필수).');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      symbol: String(symbol),
      type: 'SINGLE',
      orderType: 'LIMIT',
      quantity: String(quantity),
      expireDate: String(expireDate),
      first: {
        orderSide: 'SELL',
        triggerPrice: String(triggerPrice),
        orderPrice: String(orderPrice),
      },
      ...(clientOrderId ? { clientOrderId: String(clientOrderId) } : {}),
    },
  };
}

module.exports = {
  validateOrderRequest,
  buildStopLoss,
  idempotencyKeyFor,
  krTickSize,
  isKr,
  CLIENT_ORDER_ID_RE,
};

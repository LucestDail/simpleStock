/**
 * 포트폴리오 진단 기준선 — **막지 않고 말한다** (2026-10-12 신설)
 *
 * ## 왜 생겼나
 *
 * 이 값들은 원래 `orderService` 안에 있었고 **주문을 거부하는 게이트**였다.
 * 2026-10-12 에 주문 집행을 통째로 걷어내면서, 값은 그대로 두되 **뜻을 바꿨다**:
 *
 *   종전  "QLD 가 43% 라 매수를 거부한다"
 *   지금  "QLD 가 43% 다 — 기준선 40% 위에 있다"  ← 사람이 보고 판단한다
 *
 * ★ 값을 버리지 않은 이유: 사용자가 실제 운용 방식에 맞춰 **직접 고른 숫자**다
 *   (2026-10-06 "20/40/40 비율로 가도 괜찮네" · "총 종목수 3종목 이하").
 *   집행이 사라졌다고 기준까지 사라지면 **포트폴리오가 어디로 기울었는지 말할 자가 없어진다.**
 *
 * ## 🔴 한 벌이어야 하는 이유
 *
 * 종전에 `analystService` 가 "매수 여력이 남는가" 를 판정하려고 `process.env` 를 **다시 읽는**
 * 자리가 있었다. 그러면 상수가 복제되고, 누가 값을 바꿔도 **그 판정만 옛 값을 보고 거짓말한다**
 * (이 저장소가 반복해 적어 둔 *"가드가 검사하는 값이 실제로 쓰이는 값인지"* 그 실패 모드).
 * ⇒ **읽는 곳이 여럿이면 쥐는 곳은 하나여야 한다.** 그 하나가 이 파일이다.
 *
 * 확인법 = **진짜 값을 바꿔 보고 리스크 화면 판정이 따라 바뀌는가**(안 바뀌면 복사본을 보고 있다).
 */

/** 한 종목이 전체 평가액에서 차지해도 되는 최대 비중(%) */
const SINGLE_POSITION_MAX_PCT = Number(process.env.SINGLE_POSITION_MAX_PCT ?? 40);

/** 동시에 들고 갈 종목 수 상한 — 0 이면 "상한 없음" */
const MAX_POSITIONS = Math.max(0, Number(process.env.MAX_POSITIONS ?? 3));

/**
 * 레버리지(배수 가중) 합계 상한(%).
 * 🔴 목표 배분의 레버 합(QLD 30 + TQQQ 10 = 40)과 **같은 값**이다 —
 *    목표를 다 채워도 기준선 안에 들도록 맞춰 둔 것이지 우연이 아니다.
 */
const LEVERAGE_MAX_PCT = Number(process.env.LEVERAGE_MAX_PCT ?? 40);

/** 현금으로 남겨 두기로 한 비율(%) — 0 이면 버퍼 없음 */
const CASH_FLOOR_PCT = Math.max(0, Number(process.env.CASH_FLOOR_PCT ?? 0));

/** 기준선 판정 한 건 */
function check(key, label, actual, limit, { unit = '%', direction = 'max' } = {}) {
  /**
   * 🔴 `Number(null)` 은 **0 이다.** 그대로 쓰면 *"못 쟀다"* 가 **"0%"** 가 되어
   *    기준선 안으로 조용히 통과한다 — 이 파일이 막으려던 바로 그 실패 모드다.
   *    (첫 구현이 실제로 그랬고 `portfolioRules.test.js` 가 잡았다.)
   */
  const a = actual == null ? NaN : Number(actual);
  const measured = Number.isFinite(a);
  if (!measured) {
    // 🔴 "검사 못 함" 과 "통과" 를 구분한다 — 못 잰 것을 초록불로 보여주지 않는다
    return { key, label, actual: null, limit, unit, status: 'unknown', over: null };
  }
  const over = direction === 'max' ? a > limit : a < limit;
  return { key, label, actual: a, limit, unit, direction, status: over ? 'over' : 'ok', over };
}

/**
 * 포트폴리오 하나를 기준선에 대 본다.
 *
 * @param {object} p
 * @param {number} [p.maxWeightPct]   최대 종목 비중(%)
 * @param {number} [p.positionCount]  보유 종목 수
 * @param {number} [p.leveragePct]    배수 가중 레버리지(%)
 * @param {number} [p.cashPct]        현금 비중(%)
 * @returns {{checks: object[], overCount: number, unknownCount: number}}
 */
function diagnose({ maxWeightPct, positionCount, leveragePct, cashPct } = {}) {
  const checks = [
    check('concentration', '종목 집중도', maxWeightPct, SINGLE_POSITION_MAX_PCT),
    check('leverage', '레버리지', leveragePct, LEVERAGE_MAX_PCT),
    check('positions', '보유 종목 수', positionCount, MAX_POSITIONS, { unit: '종목' }),
    check('cash', '현금 버퍼', cashPct, CASH_FLOOR_PCT, { direction: 'min' }),
  ].filter((c) => {
    // 상한이 0 이면 "그 기준을 안 쓴다" 는 뜻 — 판정 자체를 내지 않는다
    if (c.key === 'positions' && MAX_POSITIONS === 0) return false;
    if (c.key === 'cash' && CASH_FLOOR_PCT === 0) return false;
    return true;
  });
  return {
    checks,
    overCount: checks.filter((c) => c.status === 'over').length,
    unknownCount: checks.filter((c) => c.status === 'unknown').length,
  };
}

/** 프롬프트·화면이 함께 읽는 한 줄 요약 */
function limitsSummary() {
  const parts = [
    `종목 집중 ${SINGLE_POSITION_MAX_PCT}%`,
    `레버리지 ${LEVERAGE_MAX_PCT}%`,
  ];
  if (MAX_POSITIONS > 0) parts.push(`보유 ${MAX_POSITIONS}종목`);
  if (CASH_FLOOR_PCT > 0) parts.push(`현금 ${CASH_FLOOR_PCT}% 이상`);
  return parts.join(' · ');
}

module.exports = {
  SINGLE_POSITION_MAX_PCT,
  MAX_POSITIONS,
  LEVERAGE_MAX_PCT,
  CASH_FLOOR_PCT,
  diagnose,
  check,
  limitsSummary,
};

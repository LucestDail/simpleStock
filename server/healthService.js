/**
 * 헬스 판정 — **순수 로직**. (2026-09-22)
 *
 * 09-18 에 *"의존물이 죽어도 UP"* 으로 **기록만 하고** 넘긴 항목을 끝낸다.
 * ⚠️ 같은 기록의 *"헬스가 SPA HTML"* 쪽은 **09-21 에 이미 고쳐져 있었다** — 오늘 내가 그 옛 기록을
 *    확인 없이 인용해 사용자에게 미해결로 보고했다. **기록은 낡는다. 실물을 본다.**
 *
 * ## 이 엔드포인트는 **무인증 공개**다 — 규칙 셋
 * ① **규모 정보를 담지 않는다**(종목 수·사용자 수·호스트·경로·시각). 상태 낱말만 낸다
 * ② **외부를 부르지 않는다.** 저장된 마지막 갱신 결과만 읽는다 —
 *    헬스가 토스를 부르면 **헬스 폴링이 곧 쿼터 소모**이고, 상대가 느린 날엔 헬스가 같이 죽는다
 * ③ **200 을 유지한다.** 의존물이 상해도 프로세스는 살아 있다 ⇒ nginx·허브에는 "떴다" 가 맞고,
 *    상한 사실은 본문 `status:'degraded'` 로 낸다.
 *    🔴 503 을 내면 **장이 닫힌 밤마다 허브가 빨개진다**. 오탐이 잦으면 아무도 안 본다
 *    ⇒ 워치독은 **본문을 읽어야** 한다(상태코드만 보면 종전과 같다)
 */

const DEFAULT_STALE_MS = 30 * 60_000;

/**
 * @param {object} deps `{ loadStore }` — 주입받는다. 주입 없이 도는 테스트는
 *   **실제 저장소 경로를 안 태우므로** 배선 결함(import 누락 등)을 못 본다.
 */
function healthChecks({ loadStore, now = Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  const checks = {};
  let store = null;

  // ① 저장소를 **실제로 읽어 본다**(존재 확인이 아니라 파싱까지)
  try {
    store = typeof loadStore === 'function' ? loadStore() : null;
    checks.data = store && store.memory && store.watchlist ? 'ok' : 'fail';
  } catch {
    checks.data = 'fail';
  }

  // ② 시세 업스트림 — 저장된 결과만 본다
  try {
    const market = store?.memory?.market || {};
    const at = Date.parse(market.lastSuccessAt || '');
    if (!Number.isFinite(at)) {
      /**
       * ⚠️ **"한 번도 성공 못 함" 을 정상으로 읽지 않는다.**
       *    검사하지 않은 것과 통과한 것은 다르다 — 이 저장소가 여러 번 밟은 자리다.
       */
      checks.upstream = market.refreshStatus === 'error' ? 'error' : 'unknown';
    } else {
      checks.upstream = now - at > staleMs ? 'stale' : 'ok';
    }
  } catch {
    checks.upstream = 'unknown';
  }

  return checks;
}

function healthPayload(deps) {
  const checks = healthChecks(deps);
  const degraded = Object.values(checks).some((v) => v !== 'ok');
  return { status: degraded ? 'degraded' : 'ok', service: 'simplestock', checks };
}

module.exports = { healthChecks, healthPayload, DEFAULT_STALE_MS };

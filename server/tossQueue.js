/**
 * 토스 호출 **그룹별 큐 + 한도 스케줄러** (2026-09-22 사용자 지시)
 *
 * > *"간이 큐 시스템을 구성해서 토스 rate-limit 에 맞게 맞춰서 거기서 뽑아서 던지고 호출해.
 * >  429 찍혀서 멈추면 안되잖아. 큐 산입 → rate limit 맞게 호출 → 실패하면 큐 상단 재산입"*
 *
 * ## 종전 동작이 왜 문제였나
 * 429 를 맞으면 그 버킷을 **물러서기 창** 동안 잠그고, 그 사이 들어온 호출을 **던져서 거절**했다.
 * ⇒ 한도를 아끼는 대신 **기능이 멈췄다**(화면 일부가 비고, 분석이 데이터 없이 돈다).
 * 사용자 표현대로 *"429 찍혀서 멈추면 안 된다"* — **기다렸다 보내야** 한다.
 *
 * ## 설계
 * ```
 * 산입      그룹별 FIFO. 그룹이 17개라 **하나의 전역 큐를 쓰지 않는다**
 *           (ACCOUNT 이 막혔다고 MARKET_DATA 가 같이 서면 안 된다)
 * 발사      **슬라이딩 1초 창**. 최근 1초 안에 보낸 수가 한도 미만일 때만 보낸다
 *           한도는 응답 헤더(`X-RateLimit-Limit`)로 **배워서** 갱신한다
 * 재산입    🔴 **429 를 받았을 때만** 큐 **앞**에 되꽂는다
 * ```
 *
 * ## 🔴 재시도 조건이 이 파일에서 가장 중요한 줄이다
 * ```
 * 429 응답      → 서버가 **받고 거절**했다 ⇒ 처리되지 않았음이 확실 ⇒ 재산입 **안전**
 * 네트워크 실패  → **나갔는지 모른다** ⇒ 재시도하면 **두 번 주문**이 될 수 있다 ⇒ 절대 금지
 * ```
 * 어젯밤 `send_unknown` 사고가 정확히 뒤쪽이다. 큐는 **응답을 받은 429 만** 되꽂는다.
 * ⚠️ 큐에서 **대기하다 시간이 다 된 것도 "안 나갔다"** 로 돌려준다 — 그건 재시도해도 안전하다.
 */

const { logInfo, logWarn } = require('./logger');

/**
 * 그룹별 기본 한도(초당). 헤더로 배우기 전까지 쓰는 **보수적 출발값**이다.
 * ⚠️ 모르는 그룹은 **1** 로 둔다 — 넘겨 짚어 크게 잡으면 첫 폭주에서 429 가 난다.
 * ⚠️ 실측(2026-09-22): ACCOUNT 1 · MARKET_INFO 3 · RANKING 5 · ORDER_INFO 6.
 */
/**
 * 🔴 **2026-09-22 실측으로 갱신** — pm2 가 응답 헤더로 잰 값과 큐가 학습한 값이
 *    **서로 다른 경로에서 정확히 일치**했다(ASSET 5 · ORDER_INFO 6 · MARKET_DATA 15 · CHART 20).
 *    종전 추측값은 최대 **4배 보수적**이라, 재기동 직후 학습 전 구간에서 41종목 캔들이
 *    필요 없이 느렸다. ⇒ 실측으로 시드한다. **헤더가 오면 어차피 갱신되므로 틀려도 자기교정된다.**
 * ⚠️ **`ACCOUNT` 는 1 을 유지한다** — 실측이자 최악값이고, 여기만은 낙관적으로 잡으면 바로 429 다.
 * ⚠️ 실측이 없는 그룹(AUTH·ORDER 등)은 보수값 그대로 — 시드는 **잰 것만** 한다.
 */
const DEFAULT_LIMITS = {
  AUTH: 1, ACCOUNT: 1, ASSET: 5, ORDER_INFO: 6, ORDER: 5, CONDITIONAL_ORDER: 5,
  MARKET_DATA: 15, MARKET_DATA_CHART: 20, MARKET_INDICATOR: 3, MARKET_INDICATOR_CHART: 3,
  MARKET_INFO: 3, RANKING: 5, STOCK: 5, STOCK_ALL: 1, STOCK_TRADING_TREND: 3,
};
const FALLBACK_LIMIT = 1;
const WINDOW_MS = 1000;
/** 한 건이 큐에서 기다릴 수 있는 기본 상한. 호출자가 더 짧게 줄 수 있다 */
const DEFAULT_MAX_WAIT_MS = Math.max(1000, Number(process.env.TOSS_QUEUE_MAX_WAIT_MS) || 20_000);
/**
 * 🔴 **주문 계열은 더 짧게 기다린다** (2026-09-22, pm2 지적).
 *
 * 주문은 **사람이 방금 누른 것**이다. 큐가 몇 분 들고 있다가 보내면
 *  - 지정가라 불리한 체결은 없지만 **판단은 그만큼 낡은 가격 기준**이고
 *  - 사용자는 *"방금 눌렀는데 왜 지금 나가지"* 를 본다
 * ⇒ 기다리게 하는 것보다 **못 보냈다고 돌려주고 다시 누르게 하는 편이 낫다.**
 * ⚠️ `not-sent` 로 돌려주므로 **재시도가 안전하다**(나간 적이 없다).
 */
const ORDER_MAX_WAIT_MS = Math.max(1000, Number(process.env.TOSS_QUEUE_ORDER_MAX_WAIT_MS) || 30_000);
const ORDER_GROUPS = new Set(['ORDER', 'ORDER_INFO', 'CONDITIONAL_ORDER', 'ACCOUNT', 'ASSET']);
/** 429 재산입 상한. 넘으면 **조용히 포기하지 않고** 사유를 붙여 던진다 */
const MAX_RETRY = Math.max(0, Number(process.env.TOSS_QUEUE_MAX_RETRY) || 3);
/** 큐 길이 상한 — 넘으면 **즉시 거절**한다(무한히 쌓으면 호출자가 영영 못 돌아온다) */
const MAX_QUEUE = Math.max(10, Number(process.env.TOSS_QUEUE_MAX_DEPTH) || 500);

/**
 * 🔴 **되꽂아도 되는 실패** (2026-09-22 확장).
 *
 * 처음엔 `rate-limited` 하나였다. 그런데 **그건 내 설계가 덜 간 것**이었다 —
 * `unreachable`·`not-sent` 는 **연결조차 못 맺은** 것이라 *"서버가 받고 거절한"* 429 **보다도**
 * 안 나갔음이 확실하다. 재시도 안전 판정의 근거를 만들어 놓고 **정작 큐에서 안 썼다.**
 *
 * ⚠️ 실측이 대가를 보여 줬다 — 도커 내장 DNS 간헐 실패(`EAI_AGAIN`)로
 *    **30분에 시세 갱신 1324건이 그냥 버려졌다.** 되꽂았으면 앱이 통째로 흡수했을 것이다.
 * 🔴 **주문도 안전하다** — `not-sent` 는 서버에 닿지도 않았다는 뜻이다(두 번 주문이 될 수 없다).
 * 🔴 **`unknown`·`timeout` 은 절대 넣지 않는다** — 그건 *나갔는지 모르는* 것이고, 되꽂으면 두 번 산다.
 * ⚠️ 큐가 **스스로** 내는 `not-sent`(대기 상한·큐 포화)는 `item.fn()` 을 거치지 않으므로
 *    이 분기에 오지 않는다 — 자기 거절을 자기가 재시도하는 고리는 생기지 않는다.
 */
const RETRYABLE = new Set(['rate-limited', 'unreachable', 'not-sent']);
/** 네트워크 실패의 재시도 간격 — 429(1초 창)보다 길게. DNS 는 초가 바뀐다고 낫지 않는다 */
const NET_RETRY_MS = Math.max(200, Number(process.env.TOSS_QUEUE_NET_RETRY_MS) || 1500);

class RateLimitedError extends Error {
  constructor(message, kind) { super(message); this.name = 'TossQueueError'; this.kind = kind; }
}

function createQueue({ now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  /** group → { items:[], sent:[], limit, draining, penaltyUntil } */
  const groups = new Map();

  function g(name) {
    const key = String(name || 'UNKNOWN');
    if (!groups.has(key)) {
      groups.set(key, { items: [], sent: [], limit: DEFAULT_LIMITS[key] ?? FALLBACK_LIMIT, draining: false, penaltyUntil: 0 });
    }
    return groups.get(key);
  }

  /** 응답 헤더로 관측한 한도를 반영한다 — 추측보다 사실이 낫다 */
  function setLimit(group, limit) {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) return;
    const s = g(group);
    if (s.limit !== n) {
      logInfo('tossq.limit', { group, from: s.limit, to: n });
      s.limit = n;
    }
  }

  /** 지금 보낼 수 있으면 0, 아니면 기다려야 할 ms */
  function waitFor(s, t) {
    if (t < s.penaltyUntil) return s.penaltyUntil - t;
    s.sent = s.sent.filter((x) => t - x < WINDOW_MS);
    if (s.sent.length < s.limit) return 0;
    return WINDOW_MS - (t - s.sent[0]);
  }

  async function drain(group) {
    const s = g(group);
    if (s.draining) return;
    s.draining = true;
    try {
      while (s.items.length) {
        const t = now();
        const wait = waitFor(s, t);
        if (wait > 0) { await sleep(Math.min(wait, WINDOW_MS)); continue; }

        const item = s.items.shift();
        /**
         * 🔴 **마감시각을 넘겼으면 보내지 않는다.** 제안 만료 검사는 큐에 넣기 전 한 번뿐이라,
         *    여기서 다시 안 보면 *"제안은 EXPIRED 인데 주문은 나간"* 상태가 생긴다.
         */
        if (item.deadlineAt != null && now() > item.deadlineAt) {
          item.reject(new RateLimitedError(
            `대기 중 유효시간이 지났습니다(${group}). **나가지 않았습니다.** 다시 산출하세요.`,
            'not-sent',
          ));
          continue;
        }
        // ⚠️ 대기 중에 상한을 넘겼으면 **보내지 않는다** — 그리고 "안 나갔다" 로 알린다
        if (now() - item.at > item.maxWaitMs) {
          item.reject(new RateLimitedError(
            `요청이 큐에서 ${Math.round((now() - item.at) / 1000)}초 기다려 포기했습니다(${group}). **나가지 않았습니다.**`,
            'not-sent',
          ));
          continue;
        }

        s.sent.push(now());
        try {
          item.resolve(await item.fn());
        } catch (e) {
          /**
           * 🔴 **여기가 이 파일의 핵심 분기다.**
           *    `rate-limited` = 서버가 **받고 거절**했다 ⇒ 처리 안 됨이 확실 ⇒ 앞에 되꽂는다.
           *    그 밖(타임아웃·연결 실패·업스트림 오류)은 **나갔는지 모르거나 재시도가 의미 없다**
           *    ⇒ 그대로 호출자에게 돌려준다. **여기서 재시도하면 두 번 주문이 될 수 있다.**
           */
          if (RETRYABLE.has(e?.kind) && item.attempt < MAX_RETRY) {
            item.attempt += 1;
            /**
             * 그 그룹을 잠깐 쉬게 한다 — 바로 다시 쏘면 같은 초에 또 맞는다.
             * ⚠️ **네트워크 실패는 더 길게 쉰다** — 429 는 "초가 바뀌면 풀리는" 것이지만
             *    DNS·연결 실패는 그 짧은 창에 다시 쏘면 **똑같이 실패한다**(2026-09-22 실측:
             *    도커 내장 DNS 간헐 실패가 30분에 1300건 넘게 났다).
             */
            const unit = e?.kind === 'rate-limited' ? WINDOW_MS : NET_RETRY_MS;
            s.penaltyUntil = now() + unit * item.attempt;
            s.items.unshift(item); // 🔴 **앞에** 되꽂는다(사용자 지시: "큐 상단 재산입")
            logWarn('tossq.requeue', { group, kind: e?.kind, attempt: item.attempt, depth: s.items.length, penaltyMs: unit * item.attempt });
            continue;
          }
          if (RETRYABLE.has(e?.kind)) {
            logWarn('tossq.gave_up', { group, kind: e?.kind, attempt: item.attempt });
          }
          item.reject(e);
        }
      }
    } finally {
      s.draining = false;
    }
  }

  /**
   * 큐에 넣고 차례가 오면 `fn()` 을 부른다.
   * @param {string} group `tossGroupOf(path)` 결과
   * @param {Function} fn 실제 호출(응답을 그대로 반환하거나 던진다)
   */
  /**
   * @param {number} [opts.deadlineAt] 🔴 **이 시각을 넘기면 보내지 않는다**(epoch ms).
   *   주문 제안의 `expiresAt` 을 그대로 넘긴다 — 안 그러면 **제안은 만료됐는데 주문은 나가는**
   *   상태가 생긴다(만료 검사는 큐에 넣기 **전**에 한 번뿐이기 때문이다).
   */
  function run(group, fn, { maxWaitMs, deadlineAt = null } = {}) {
    const s = g(group);
    const wait = maxWaitMs != null ? maxWaitMs : (ORDER_GROUPS.has(group) ? ORDER_MAX_WAIT_MS : DEFAULT_MAX_WAIT_MS);
    if (s.items.length >= MAX_QUEUE) {
      return Promise.reject(new RateLimitedError(
        `${group} 큐가 가득 찼습니다(${s.items.length}). **요청이 나가지 않았습니다.**`, 'not-sent',
      ));
    }
    return new Promise((resolve, reject) => {
      s.items.push({ fn, resolve, reject, at: now(), attempt: 0, maxWaitMs: wait, deadlineAt });
      drain(group);
    });
  }

  function snapshot() {
    const out = {};
    for (const [k, s] of groups) {
      if (!s.items.length && !s.sent.length) continue;
      out[k] = { depth: s.items.length, limit: s.limit, inWindow: s.sent.filter((x) => now() - x < WINDOW_MS).length };
    }
    return out;
  }

  return { run, setLimit, snapshot, _groups: groups };
}

module.exports = { createQueue, RETRYABLE, NET_RETRY_MS, DEFAULT_LIMITS, WINDOW_MS, MAX_RETRY, DEFAULT_MAX_WAIT_MS, ORDER_MAX_WAIT_MS, ORDER_GROUPS, RateLimitedError };

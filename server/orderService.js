const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { logInfo, logWarn, logError } = require('./logger');

/**
 * 주문 제안 → 사람 승인 → 실행 (2026-09-21)
 *
 * ## 전제 — 이건 바뀌지 않는다
 *
 * 🔴 **토스는 샌드박스가 없다.** 발급된 키가 `tsck_live_`/`tssk_live_` 뿐이다.
 *    연습할 곳이 없으므로 **실행을 붙이기 전에 no-op 으로 한 바퀴 돌린다.**
 * 🔴 사용자 결정(2026-09-21): **"주문은 제안만 · 실행은 항상 사람 승인"**.
 *
 * ## 왜 이름·의도 추론으로 판정하지 않는가
 *
 * 이 워크스페이스에서 이미 두 번 졌다 — 셸 가드가 파괴적 명령 **18/18** 을 통과시켰고,
 * AIm 의 승인 게이트가 부작용 결정 **8/8** 을 놓쳤다. 둘 다 **이름을 열거**했기 때문이다.
 * ⇒ 여기서는 **구조로 막는다**: 실행 경로는 `approvedAt` 이 찍힌 레코드가 **있을 때만** 돈다.
 *    기본이 거부이고, 판단이 아니라 **존재 확인**이다.
 *
 * ## 다섯 가지 안전장치
 *
 * 1. **fail-closed** — 승인 레코드 없으면 실행 없음. `ORDERS_ENABLED` 도 기본 꺼짐
 * 2. **완전한 제안만** — 종목·방향·수량·가격·유형이 전부 값이어야 한다.
 *    빈칸을 사람이 채우게 하면 **승인 화면이 곧 주문 화면**이 된다
 * 3. **유효기간** — 시세는 움직인다. 만료된 제안은 승인해도 실행 안 되고 재산출
 * 4. **멱등키** — 승인 1건 = 주문 1건. 중복 클릭·재시도가 두 번 사지 않게
 * 5. 🔴 **"실패" 와 "모름" 을 구분** — 전송 후 타임아웃이 최악이다(들어갔는지 모른다).
 *    이때 **재시도 금지**, 주문 조회로 확정한다. *"검사 못 함 ≠ 통과"* 의 돈 버전이다
 *
 * ## 감사
 *
 * append-only JSONL. **'현재 상태'가 아니라 '일어난 일의 목록'** 이라 통째로 덮어쓰지 않는다
 * (Probius `AuditStore` 선례).
 */

const DATA_DIR = path.join(__dirname, '..', 'data');
/**
 * ⚠️ **경로를 환경변수로 뺄 수 있게 한다** (2026-10-01) — 운영이 아니라 **테스트** 때문이다.
 *    `node --test` 는 파일을 병렬 프로세스로 돌리는데, 이 경로가 하드코딩이라 테스트가
 *    **저장소의 진짜 감사 파일**에 쓴다(실측: 전체 실행 후 `data/orders-audit.jsonl` 해시가 바뀐다).
 *    형제 경로들은 이미 그렇게 하고 있었다(`ORDERS_FILE`·`ALERTS_STATE_FILE`·`ANALYST_CHAT_FILE`
 *    ·`SETTINGS_FILE`·`ACTIVITY_FILE`) — **여기만 빠져 있었다.**
 * 🔴 감사 파일은 **지우면 안 되는 것**이라 더더욱 테스트가 건드리면 안 된다.
 */
const AUDIT_FILE = process.env.ORDERS_AUDIT_FILE || path.join(DATA_DIR, 'orders-audit.jsonl');

/** 🔴 기본 꺼짐. **없어도 꺼짐**이다 — 미설정이 켜짐이 되면 안 된다 */
const ORDERS_ENABLED = String(process.env.ORDERS_ENABLED || '').trim().toLowerCase() === 'true';
/** 🔴 현금 버퍼 %(2026-09-24 사용자 확정 15) — VIX 사다리 실탄 보전. 0 이면 끔 */
/**
 * 🔴 **현금 버퍼 기본값 0** (2026-10-02 사용자 지시: *"매수 현금바닥 구조 없애.
 *    제한 걸지말고 냉철하게 공격적 포트폴리오 관점에서 구성해야해."*).
 *
 * 종전 15% 는 "VIX 사다리 실탄 보전" 용이었는데, 실제로는 **매수 제안을 구조적으로
 * 0으로 만들고 있었다** — 10-01~02 라이브 5회차 중 3회가 `no_buying_capacity ·
 * capacity:blocked` 였고, 그 사이 **매도 제안만** 나갔다(현금이 없는데 파는 쪽만 열려 있었다).
 * ⚠️ 0 이면 아래 `CASH_FLOOR_PCT > 0` 가드가 통째로 꺼진다 — 코드는 그대로 두고 값만 0이다.
 *    되살리려면 `CASH_FLOOR_PCT=15` 환경변수 하나면 된다(지우지 않는 이유).
 */
const CASH_FLOOR_PCT = Math.max(0, Number(process.env.CASH_FLOOR_PCT ?? 0));
/**
 * 🔴 종목당 최대 비중 (2026-10-04) — 운용규칙 화면 한도표가 "20% 초과 시 추가 매수 차단
 * (계좌 검증)" 이라 **주장**해 왔는데 실제 게이트가 없었다("문서가 주장하는 안전망이
 * 실재하는가" 의 그 실패 모드). vshape 백테스트에서 모델이 전 재산을 한 종목에 넣어
 * 사다리 실탄이 0 이 됐고(-23.5%), 회차 간 분산도 이 몰빵이 키웠다 — 집중 상한은
 * 수익 깎개가 아니라 **분산(변동성) 통제 장치**다. 기존 보유 초과분은 건드리지 않고
 * **추가 매수만** 막는다.
 */
/** 불리 방향(매도↓·매수↑) 지정가 허용 괴리 — 슬리피지 하한을 모델이 못 정하게(2026-10-05) */
/**
 * 🔴 **불리 방향 허용 폭 0.3% → 0** (2026-10-06 사용자: *"또 현재 시세보다 싸게 qld
 * 올려놓았네 너 진짜 왜그러는거야?"*).
 *
 * 0.3% 는 "마켓터블 리밋이라 체결이 보장된다" 는 이유로 뒀는데, 사용자 기준은 분명하다 —
 * **현재가보다 싸게 파는 제안은 그 자체가 손해**다(QLD SELL @100.16 vs 현재가 100.19).
 * 0.03% 라 게이트는 설계대로 통과했지만, 설계가 사용자 의도와 달랐다.
 * ⇒ 0 = 불리 방향을 **전면 금지**. 매도는 현재가 이상, 매수는 현재가 이하만.
 * ⚠️ 체결 가능성은 낮아진다(현재가 지정은 호가에 걸려야 체결) — 그 대가를 알고 고른 값이다.
 *    급히 털어야 하면 사람이 시장가로 내면 된다(그건 사람의 판단).
 * ⚠️ `analyst` 경로는 거부 대신 **현재가로 보정**한다(clamp) — 그쪽이 먼저 걸리므로
 *    실제로는 "제안이 사라지는" 게 아니라 "현재가로 고쳐져" 올라온다.
 */
const ADVERSE_PRICE_PCT = Number(process.env.ADVERSE_PRICE_PCT ?? 0);
/**
 * 🔴 종목 한도 20 → **35** (2026-10-06 사용자 결정).
 *
 * 근거(사용자 원문): *"35% 까지 나는 종목을 한번에 4종목 이상 가져갈 생각이 없어"*.
 * 4종목 이하로 운용하면 균등해도 종목당 25% 이므로 20 은 **운용 방식과 모순**이었다
 * (실제로 QLD 31.8% 가 상한을 넘어 **추가 매수가 하드 차단**됐고, 사용자 전략인
 *  "QLD 를 모아나간다" 가 원리상 불가능했다).
 * ★ 40 도 분산을 포기하는 값이 아니다 — **최소 3종목이 구조적으로 강제된다**
 *   (40+40 = 80 < 100 이라 두 종목으로 전액을 채울 수 없다). 사용자가 제시한
 *   **20/40/40** 비율이 정확히 이 상한의 경계다(2026-10-06 두 번째 조정: 35 → 40).
 * ⚠️ 위 주석의 vshape 몰빵(-23.5%) 교훈은 **그대로 유효하다** — 한 종목에 전 재산을
 *   넣는 것은 여전히 막힌다. 바뀐 것은 "몇 종목으로 나누는가" 의 가정뿐이다.
 * ⚠️ 목표 배분의 `core_aggressive`(QLD) 30% 와의 관계: 상한 35 − 목표 30 = **여유 5%p**.
 *   목표를 채운 뒤에도 가격 상승으로 비중이 5%p 늘 여지가 있어 즉시 재-차단되지 않는다.
 */
const SINGLE_POSITION_MAX_PCT = Number(process.env.SINGLE_POSITION_MAX_PCT ?? 40);
/**
 * 🔴 **보유 종목 수 상한** (2026-10-06 사용자: *"총 종목수 3종목 이하로 관리하도록
 * 구성, 설정해"*).
 *
 * 종목 한도 40% 와 짝이다 — 40+40+20 = 100 이므로 **3종목이 구조적 상한**이고,
 * 사용자가 그 운용 방식을 명시했다. 넷째 종목을 담으면 평균 비중이 25% 로 내려가
 * "집중해서 소수만 본다" 는 전략 자체가 흐려진다.
 * ⚠️ **신규 종목 매수만** 막는다 — 이미 보유한 종목의 추가 매수·전량 매도는 그대로다
 *    (상한을 넘긴 기존 보유를 강제로 팔게 만들지 않는다. 집중 상한과 같은 철학).
 * ⚠️ 0 이면 끈다.
 */
const MAX_POSITIONS = Math.max(0, Number(process.env.MAX_POSITIONS ?? 3));
/** 🔴 즉시 제안 지정가의 현재가 괴리 상한 % — 넘으면 조건주문으로 안내(2026-09-24) */
const PRICE_DRIFT_PCT = Math.max(0.5, Number(process.env.PRICE_DRIFT_PCT ?? 2.5));

/** 실행을 실제 API 로 보낼지. ORDERS_ENABLED 와 **둘 다** 켜져야 한다(두 겹) */
const ORDERS_LIVE = String(process.env.ORDERS_LIVE || '').trim().toLowerCase() === 'true';

/**
 * 제안 유효기간. **10분**(2026-09-22 사용자 지시 — 5분은 폰을 늦게 보면 놓친다).
 *
 * 🔴 **왜 하필 10분에서 멈추는가** — 토스 멱등키(`clientOrderId`)의 유효기간이 **10분**이다.
 *    이중발주를 막는 층이 둘인데, 둘째 층이 여기에 걸려 있다:
 *
 *      ① 상태기계 — `execute()` 는 `APPROVED` 에서만 돈다. 한 번 보내면 `SENT`/`UNKNOWN` 이 돼
 *         다시 못 돈다. `APPROVED` 로 남는 유일한 실패는 `not-sent`(연결조차 못 맺음)이고,
 *         그건 **주문이 존재하지 않는다**는 뜻이라 재시도가 중복이 될 수 없다.
 *      ② 멱등키 — ①이 어딘가에서 뚫려도 같은 키로 들어간 둘째 주문을 토스가 막는다.
 *
 *    두 번의 전송은 반드시 `[createdAt, createdAt+TTL]` 안에서 일어나므로 **간격이 TTL 을 못 넘는다.**
 *    ⇒ `TTL ≤ 멱등창` 이면 ②가 항상 유효하다. **TTL 을 10분 위로 올리면 ②가 사라지고**
 *      ① 하나만 남는다. 그래도 즉시 위험해지지는 않지만 **층이 하나 없어진 것**이다.
 *    ⇒ `orderTtlRule.test.js` 가 이 관계를 강제한다(올리면 빨간불로 알려 준다).
 *
 * ⚠️ 중복과 별개로 **옛 시세** 위험이 남는다 — 10분 전 값으로 낸 지정가다.
 *    그래서 폰 전송 확인에 **제안 나이**를 적는다.
 */
const PROPOSAL_TTL_MS = Math.max(30_000, Number(process.env.ORDER_PROPOSAL_TTL_MS) || 10 * 60_000);

/** 토스 `clientOrderId` 멱등키 유효기간(명세 v1.2.17). 위 관계를 테스트가 본다. */
const IDEMPOTENCY_WINDOW_MS = 10 * 60_000;
const SIDES = new Set(['BUY', 'SELL']);
const TYPES = new Set(['LIMIT', 'MARKET']);

/**
 * 제안이 만들어졌을 때 부를 함수들(텔레그램 알림 등).
 * ⚠️ 여기에 등록된 것은 **제안을 막지 못한다** — 알림은 곁가지다.
 */
const listeners = [];
function onProposed(fn) {
  if (typeof fn === 'function') listeners.push(fn);
}

/**
 * 🔴 **제안이 끝났을 때** 부를 함수들(폰의 승인 버튼 지우기).
 *
 * pm2 가 API 로 거절했는데 **사용자 폰의 `✅ 승인` 버튼은 그대로 남아 있었다** —
 * 버튼 제거가 **텔레그램 콜백 경로에만** 있었기 때문이다. 나중에 누르면
 * `이미 REJECTED 상태입니다` 가 뜬다. 위험한 쪽이 아니라 **놓치는 쪽**이지만,
 * 사용자는 **아직 결정할 게 남았다고 믿는다** — 그게 HITL 에서 나쁜 상태다.
 *
 * ⚠️ 여기서 텔레그램을 직접 부르지 않는다 — `onProposed` 와 같은 이유(순환 참조).
 *    **알림은 곁가지다**: 버튼을 못 지워도 상태 전이는 이미 끝났다.
 */
const settledListeners = [];
function onSettled(fn) {
  if (typeof fn === 'function') settledListeners.push(fn);
}

/** 어떤 상태가 "끝" 인가 — PENDING 만 아직 사람을 기다린다 */
function emitSettled(p, why) {
  for (const fn of settledListeners) {
    try {
      Promise.resolve(fn(p, why)).catch((e) => logWarn('orders.settle_notify_failed', { message: e.message }));
    } catch (e) {
      logWarn('orders.settle_notify_failed', { message: e.message });
    }
  }
}

/**
 * 제안 알림의 메시지 id 를 붙여 둔다 — **이게 없으면 버튼을 못 지운다.**
 * ⚠️ 영속화된다(재기동 뒤에 거절해도 버튼이 지워지게).
 */
function attachNotice(id, { messageId } = {}) {
  const p = proposals.get(id);
  if (!p || messageId == null) return { ok: false };
  p.noticeMessageId = messageId;
  persist();
  return { ok: true };
}

/**
 * id → proposal. **파일로 영속화한다** (2026-09-21 사용자 결정).
 *
 * ## 왜 바꿨나 — 종전 주석은 *"메모리에만 둔다, 재기동하면 사라지는 게 맞다"* 였다
 *
 * 그 이유(**옛 시세의 제안은 위험하다**)는 지금도 맞다. 하지만 실제로 겪은 문제는 반대쪽이었다:
 * 배포로 컨테이너가 재시작되자 **승인 대기 제안이 사라졌고**, 그때 사용자 폰에는
 * `[✅ 승인]` 버튼이 **그대로 남아 있었다.** 나중에 누르면 `제안을 찾을 수 없습니다` 다 —
 * 판단은 유효한데 **실행 경로만 조용히 죽은** 상태다.
 *
 * ⇒ 영속화하되 **옛 시세 우려는 TTL 로 그대로 지킨다**: 복원할 때 **만료를 다시 판정**해
 *    시간이 지난 것은 `PENDING` 이 아니라 `EXPIRED` 로 되살린다. **승인해도 실행되지 않는다.**
 *    즉 "되살리는 것" 이 아니라 **"무슨 일이 있었는지 잃지 않는 것"** 이다.
 *
 * ⚠️ **감사 로그와 역할이 다르다.** 감사는 append-only 이고 *'일어난 일의 목록'* 이다.
 *    이 파일은 *'지금 상태'* 라 통째로 덮어쓴다 — 둘을 한 파일에 섞지 않는다.
 * ⚠️ **정본은 하나다** — 이 파일이 제안의 정본이고 감사에서 재구성하지 않는다
 *    (my-computer Quartz 선례: 정본이 둘이 되면 어느 쪽이 맞는지 알 수 없다).
 */
const proposals = new Map();

/** ⚠️ 테스트는 **다른 파일**을 써야 한다 — 안 그러면 테스트가 라이브 대기열을 건드린다 */
const STORE_FILE = process.env.ORDERS_FILE || path.join(DATA_DIR, 'orders-proposals.json');
/** 아주 오래된 것은 안 들고 있는다 — 상태 파일이 무한히 자라면 안 된다 */
const KEEP_MS = Math.max(PROPOSAL_TTL_MS, Number(process.env.ORDERS_KEEP_MS) || 24 * 60 * 60_000);

/**
 * 🔴 **원자적으로 쓴다** — 쓰는 도중에 죽으면 반쪽 JSON 이 남고, 다음 기동에서
 *    대기열을 통째로 못 읽는다(승인 대기가 조용히 사라지는 것과 같은 결과다).
 */
function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const now = Date.now();
    const rows = [...proposals.values()].filter((p) => now - Date.parse(p.createdAt || 0) < KEEP_MS);
    const tmp = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, at: new Date().toISOString(), proposals: rows }, null, 1));
    fs.renameSync(tmp, STORE_FILE);
  } catch (e) {
    // 저장 실패가 제안 자체를 막지는 않지만 **조용하지도 않다** — 다음 재기동에 사라진다는 뜻이다
    logError('orders.persist_failed', e, { file: STORE_FILE });
  }
}

/** 기동 시 복원. ⚠️ **읽기 실패로 서비스가 죽으면 안 된다** — 비어 있는 채로 뜬다 */
function restore() {
  let raw;
  try {
    raw = fs.readFileSync(STORE_FILE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') logWarn('orders.restore_unreadable', { file: STORE_FILE, message: e.message });
    return;
  }
  let rows;
  try {
    rows = JSON.parse(raw)?.proposals;
  } catch (e) {
    logWarn('orders.restore_corrupt', { file: STORE_FILE, message: e.message });
    return;
  }
  if (!Array.isArray(rows)) return;

  const now = Date.now();
  let expired = 0;
  for (const p of rows) {
    if (!p?.id) continue;
    /**
     * 🔴 **만료를 다시 판정한다** — 이게 옛 주석의 우려("옛 시세의 제안은 위험하다")를
     *    지키는 자리다. 시간이 지난 PENDING 은 **되살리지 않고 EXPIRED 로** 올린다.
     */
    if (p.status === 'PENDING' && isExpired(p, now)) { p.status = 'EXPIRED'; expired += 1; }
    proposals.set(p.id, p);
  }
  // 🔴 복원하며 EXPIRED 로 올린 것을 **저장한다** — 안 하면 다음 기동에 또 PENDING 으로 읽힌다
  if (expired) {
    persist();
    // 🔴 재기동하며 만료된 것들의 **폰 버튼도 지운다** — 안 그러면 밤새 살아 있는 버튼이 남는다
    for (const p of proposals.values()) if (p.status === 'EXPIRED' && p.noticeMessageId) emitSettled(p, 'expired');
  }
  logInfo('orders.restored', {
    total: proposals.size,
    pending: [...proposals.values()].filter((x) => x.status === 'PENDING').length,
    // ★ **되살리지 않은 개수를 함께 남긴다** — 0 이면 "복원이 안 됐나" 를 스스로 구분하게
    expiredOnRestore: expired,
  });
}

function audit(event, payload) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...payload });
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, `${line}\n`);
  } catch (e) {
    // 기록 실패가 흐름을 멈추지는 않지만 **조용하지도 않다**
    logError('orders.audit_failed', e, { event });
  }
  logInfo(`orders.${event}`, payload);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 제안을 만든다. **빈칸이 있으면 만들지 않는다.**
 * @returns {{ok:true, proposal:object}|{ok:false, error:string, missing:string[]}}
 */
/**
 * @param {object} opts
 * @param {boolean} [opts.notify] 제안 알림(폰의 승인 버튼)을 보낼지. 기본 `true`.
 *
 * 🔴 **점검할 문을 낸다** (2026-09-21). pm2 가 영속화를 검증하며 이 경로로 제안을 만들었고
 *    *"코드를 봤는데 텔레그램을 안 보낸다"* 고 보고했지만 **실제로는 사용자 폰에 승인 버튼이 갔다** —
 *    발송이 `propose()` 본문이 아니라 **리스너**(`onProposed → alerts.onProposal`)에서 일어나기 때문이다.
 *    ★ **부작용이 이벤트로 나가는 구조에서는 함수 본문만 봐서는 확인이 아니다.**
 *
 *    `analyst/run` 의 `dryRun` 과 같은 이유로 문을 낸다:
 *    **검증할 수 없는 경로는 결국 검증 안 된 채로 배포된다.**
 * ⚠️ 기본은 **보낸다** — 사용자 지시(*"승인 버튼 주고 사용자가 승인하면 진행"*)를 바꾸지 않는다.
 * ⚠️ 제안 **자체는 만들어진다.** 안 보내는 것뿐이라 승인 대기 목록에는 뜬다.
 */
/**
 * 🔴 **계좌로 막는다** — 프롬프트는 지시일 뿐이고 거부는 코드가 한다 (2026-09-22)
 *
 * 종전엔 프롬프트가 *"보유 수량과 현금 여력을 넘지 않게"* 라고 **말만** 했다.
 * 심지어 **현금 데이터를 주지도 않았다** — 지킬 수 없는 규칙을 요구한 셈이다.
 * ⇒ 실제 판정은 토스에 **물어서** 한다: 매수는 `buying-power`, 매도는 `sellable-quantity`.
 *
 * ⚠️ **`propose()` 는 동기**라 여기서 분리했다. 대신 호출자가 빠뜨리지 못하게
 *    `orderCheckRule.test.js` 가 **`propose(` 를 부르는 파일은 이것도 부르는지** 구조로 강제한다.
 * ⚠️ **못 물어봤으면 통과가 아니다** — 조회 실패는 `unknown` 이고, 그때는 제안을 **막는다**.
 *    *"검사하지 않은 것" 과 "통과한 것" 을 구분하지 못하는 자를 만들지 말 것* 의 돈 버전이다.
 * ⚠️ 금액·수량은 **문자열**로 온다(정밀도) — 비교만 숫자로 하고 표시는 원문을 쓴다.
 */
async function checkAccountLimits({ symbol, side, quantity, price, currency, exemptCashFloor = false } = {}) {
  const sym = String(symbol || '').trim();
  const qty = Number(quantity);
  const px = Number(price);
  const up = String(side || '').toUpperCase();
  if (!sym || !SIDES.has(up) || !(qty > 0)) return { ok: false, kind: 'shape', error: '종목·방향·수량이 필요합니다.' };

  const toss = require('./tossClient');
  try {
    /**
     * 🔴 **상·하한가 검증** (2026-09-22 — 토스 API 정비. `getPriceLimits` 가 만들어져 있었는데 소비 0).
     *    KR 지정가가 상·하한 밖이면 **거래소가 거부**한다 — 여기서 안 막으면 사용자가
     *    승인을 누른 **뒤에야** 실패를 안다(HITL 이 헛수고가 되는 그 자리).
     * ⚠️ KR + 지정가일 때만 본다(미국은 상하한 제도가 다르고, 시장가는 가격이 없다).
     * ⚠️ **못 물어봤으면 막지 않는다** — 상하한은 계좌 검증(현금·수량)과 달리 *보조* 축이라,
     *    조회 실패로 정당한 제안까지 막으면 오탐이 잦아 게이트를 끄게 된다. 경고만 남긴다.
     */
    if (/^\d{6}$/.test(sym) && Number.isFinite(px) && px > 0) {
      try {
        const lim = await toss.getPriceLimits(sym);
        if (lim.upper != null && px > lim.upper) {
          return { ok: false, kind: 'price-limit', error: `지정가 ${px} 가 상한가(${lim.upper})를 넘습니다 — 거래소가 거부합니다.` };
        }
        if (lim.lower != null && px < lim.lower) {
          return { ok: false, kind: 'price-limit', error: `지정가 ${px} 가 하한가(${lim.lower}) 아래입니다 — 거래소가 거부합니다.` };
        }
      } catch (e) {
        logWarn('orders.price_limit_check_failed', { symbol: sym, kind: e.kind, message: e.message });
      }
    }
    /**
     * 🔴 가격-현재가 괴리 게이트 (2026-09-24 사용자 지적 "제안이 정상적인 가격을 추적하지
     *    않는다" — 실측: 어제 제안 3건 전부 당일 고가 옆 지정가 = 현재가보다 2~6% 위,
     *    10분 TTL 안에 체결 불가능. 모델이 target 레벨을 제안가로 쓰는 패턴).
     *    즉시 제안(TTL 10분)은 **체결 가능 가격**이어야 한다 — 멀리 있는 가격은
     *    조건주문(예약)이 맞는 수단이다. ⚠️ 조회 실패는 막지 않는다(보조 축·오탐 방지).
     */
    if (Number.isFinite(px) && px > 0) {
      try {
        const pm = await toss.getPrices([sym]);
        const last = Number(pm.get(sym)?.price);
        /**
         * 🔴 **기준가는 `lastPrice` 가 아니라 "내가 받을 수 있는 쪽 호가" 다** (2026-10-06).
         *
         *    사용자가 **세 번** 같은 것을 지적했다: `SELL @97.5 vs 97.87`(10-05) ·
         *    `SELL @100.16 vs 100.19` · `SELL @100.17 vs ask 100.19`(내가 올린 것).
         *    원인은 하나다 — 게이트가 `lastPrice` 하나만 봤고, **`lastPrice` 는 bid 일 수도
         *    ask 일 수도 있다.** 그래서 "불리 0%" 로 조여도 **매수 호가에 매도를 던지는**
         *    일이 그대로 통과했다(실측: last 100.17 = bid 100.17, ask 는 100.19).
         * ⇒ 매도는 **ask 최상단**, 매수는 **bid 최상단**을 기준으로 본다. 그 방향이 곧
         *    "같은 조건에서 더 받는/덜 내는" 쪽이고, 사용자가 말한 "이득" 이다.
         * ⚠️ 호가 조회 실패면 `lastPrice` 로 폴백하고 **warn** — 조용히 옛 기준으로
         *    돌아가면 같은 사고가 재발한다.
         */
        let now = last;
        try {
          const ob = await toss.getOrderbook(sym);
          const side1 = up === 'SELL' ? (ob?.asks || [])[0] : (ob?.bids || [])[0];
          const q = Number(side1?.price);
          if (q > 0) now = q;
          else logWarn('orders.orderbook_empty', { symbol: sym, side: up, fallback: last });
        } catch (e) {
          logWarn('orders.orderbook_failed', { symbol: sym, side: up, message: e.message, fallback: last });
        }
        if (now > 0) {
          const driftPct = ((px - now) / now) * 100;
          if (Math.abs(driftPct) > PRICE_DRIFT_PCT) {
            return {
              ok: false, kind: 'price-drift',
              error: `지정가 ${px} 가 현재가 ${now} 에서 ${driftPct.toFixed(1)}% 떨어져 있습니다 — 10분 안에 체결될 수 없는 가격입니다. 이 가격을 원하면 **조건주문(예약)** 으로 내세요.`,
              currentPrice: now,
            };
          }
          /**
           * 🔴 **불리 방향 지정가 상한** (2026-10-05 사용자: "현재가 98 근접인데 왜 97.5 에 파냐").
           *
           * 매도 지정가 < 현재가(또는 매수 > 현재가)는 marketable limit 이라 보통은
           * 현재 호가에서 체결되지만, **그 지정가가 슬리피지 하한이 된다** — 주간거래처럼
           * 호가가 얕은 세션에선 최악의 경우 그 가격까지 밀려 체결된다. 모델이 그 하한을
           * 마음대로 정하게 두지 않는다: 불리 방향 괴리는 ADVERSE_PRICE_PCT(0.3%)까지만.
           * ⚠️ 유리 방향(매도를 비싸게·매수를 싸게 걸기)은 ±2.5% 밴드가 이미 상한이다 —
           *    여기서 더 조이면 정당한 레벨 지정을 죽인다(양방향을 같이 보고 이쪽만 조인다).
           */
          const adverse = up === 'SELL' ? -driftPct : driftPct; // 양수 = 불리 방향 괴리(%)
          if (adverse > ADVERSE_PRICE_PCT) {
            return {
              ok: false, kind: 'adverse-price',
              error: `${up === 'SELL' ? '매도' : '매수'} 지정가 ${px} 가 현재가 ${now} 보다 ${adverse.toFixed(2)}% ${up === 'SELL' ? '낮습니다' : '높습니다'} — 체결 불리 방향은 ${ADVERSE_PRICE_PCT}% 까지만. 현재가 기준으로 다시 내세요.`,
              currentPrice: now, maxAdversePct: ADVERSE_PRICE_PCT,
            };
          }
        }
      } catch (e) {
        logWarn('orders.price_drift_check_failed', { symbol: sym, message: e.message });
      }
    }
    if (up === 'SELL') {
      const r = await toss.getSellableQuantity(sym);
      const have = r.quantity.num;
      if (have == null) return { ok: false, kind: 'unknown', error: '판매 가능 수량을 확인하지 못했습니다.' };
      if (qty > have) {
        return { ok: false, kind: 'insufficient', error: `판매 가능 수량을 넘습니다 (요청 ${qty} > 가능 ${r.quantity.raw}).`, available: r.quantity.raw };
      }
      return { ok: true, available: r.quantity.raw };
    }
    /**
     * 매수 — 통화를 모르면 **추측하지 않는다.** 6자리 숫자면 국내(KRW), 아니면 달러로 본다.
     * ⚠️ 이건 심볼 모양에 기댄 판정이라, 호출자가 `currency` 를 주면 그걸 **우선**한다.
     */
    const cur = String(currency || (/^\d{6}$/.test(sym) ? 'KRW' : 'USD')).toUpperCase();
    const bp = await toss.getBuyingPower(cur);
    const cash = bp.cash.num;
    if (cash == null) return { ok: false, kind: 'unknown', error: `${cur} 매수 가능 금액을 확인하지 못했습니다.` };
    // ⚠️ 시장가는 가격을 모른다 — 그때는 **금액 판정을 못 한다**고 말한다(통과시키지 않는다)
    if (!(px > 0)) return { ok: false, kind: 'unknown', error: '지정가가 없어 필요 금액을 계산할 수 없습니다.' };
    const need = qty * px;
    if (need > cash) {
      return { ok: false, kind: 'insufficient', error: `현금이 부족합니다 (필요 ${need.toFixed(2)} ${cur} > 가능 ${bp.cash.raw}).`, available: bp.cash.raw, currency: cur };
    }
    /**
     * 🔴 현금 버퍼 (2026-09-24 사용자 확정 15%) — VIX 사다리 실탄 보전.
     *    백테스트 근거: V자 -5.1% → +9.9%(버퍼 덕에 사다리 3/3 전탄 집행) · 상승장 -4.2%p ·
     *    하락장 중립 — 비대칭 유리. 기준은 **총 평가액**(현금+주식, 같은 통화 환산은 없음 —
     *    통화별 자산 기준. 백테스트의 "초기 자산" 을 실전에선 평가액으로 옮긴 것).
     * ⚠️ exemptCashFloor(사다리 전용): 사다리 취지가 공포에 실탄 소진이라 버퍼 면제 —
     *    백테스트도 같은 구조였다(floor 는 LLM 매수에만).
     */
    /**
     * 종목 집중 상한 — ⚠️ 면제 플래그는 버퍼와 공유한다: exemptCashFloor 는 사실상
     * "VIX 사다리(코드 기계매수) 면제" 다. 사다리는 설계상 공포에서 한 종목(QQQ)을
     * 단계 매수하므로 집중 상한도 함께 면제가 맞다(막으면 사다리 존재 이유가 죽는다).
     */
    /**
     * 💰 적립 면제 결과를 **반환에 실어 호출자에게 넘긴다** (2026-10-06).
     * 🔴 면제가 아니면 이 키들을 **넣지 않는다** — `accrualExempt: false` 를 싣는 모양을
     *    만들면 어디선가 객체 존재만 보고 참으로 읽는다. "없음" 은 키의 부재로 표현한다.
     */
    let accrual = null;
    if (!exemptCashFloor && SINGLE_POSITION_MAX_PCT > 0) {
      try {
        const h = await require('./tossPortfolio').getHoldings({});
        const sameCur = (h.items || []).filter((it) => String(it.currency || '').toUpperCase() === cur);
        /**
         * 🔴 **보유 종목 수 상한** — 신규 종목이면 여기서 끊는다(위 MAX_POSITIONS 참조).
         *    수량이 0 인 항목은 보유가 아니다(청산 직후 잔여 레코드가 칸을 먹으면 안 된다).
         */
        if (up === 'BUY' && MAX_POSITIONS > 0) {
          const heldSyms = new Set((h.items || [])
            .filter((it) => (Number(it.quantity) || 0) > 0)
            .map((it) => String(it.symbol || '').toUpperCase()));
          if (!heldSyms.has(sym) && heldSyms.size >= MAX_POSITIONS) {
            logWarn('orders.position_count_blocked', { symbol: sym, held: [...heldSyms], max: MAX_POSITIONS });
            return {
              ok: false, kind: 'position-count',
              error: `보유 종목이 이미 ${heldSyms.size}개(${[...heldSyms].join(', ')})입니다 — 상한 ${MAX_POSITIONS}개. 신규 종목을 담으려면 기존 종목을 먼저 정리하십시오.`,
              held: [...heldSyms], maxPositions: MAX_POSITIONS,
            };
          }
        }
        const holdingsVal = sameCur.reduce((sum, it) => sum + (Number(it.marketValue) || 0), 0);
        const equity = cash + holdingsVal;
        const symVal = sameCur.filter((it) => String(it.symbol).toUpperCase() === sym.toUpperCase())
          .reduce((sum, it) => sum + (Number(it.marketValue) || 0), 0);
        const capVal = equity * (SINGLE_POSITION_MAX_PCT / 100);
        if (symVal + need > capVal) {
          /**
           * 💰 **수익 기반 적립 면제** (2026-10-06 — 사용자 전략 *"방어주/수익 기반으로 QLD 를
           *    모아나간다"*). 집중 상한은 **원금을 레버리지로 옮기는 것**을 막는 장치인데,
           *    배당·실현수익으로 적립하는 것은 원금이 줄지 않으므로 같은 위험이 아니다.
           *    종전에는 둘이 코드에 같아 보여서, QLD 31.8% 에서 "모아나간다" 가 원리상 불가능했다.
           *
           * ⛔ 면제되는 것은 **이 집중 상한 하나**다. 불리가격·현금 버퍼·HITL·일일 손실·
           *    `agentLedger` 예산 게이트는 그대로 지난다(다른 축이다).
           * 🔴 조용한 면제는 구멍이다 — 걸릴 것이 안 걸렸으면 **왜 안 걸렸는지**가 로그에 남는다.
           * ⚠️ 판정 실패(파일 없음·예산 부족)는 **면제 없음**으로 떨어진다(fail-closed) —
           *    `incomeLedger.canAccrue` 가 그 책임을 진다.
           */
          const acc = require('./incomeLedger').canAccrue(sym, need, { currency: cur });
          if (acc.ok) {
            /**
             * 🔴 **차감은 집행 시점에 하고, 그 근거는 여기서만 알 수 있다** — 그래서 제안에
             *    실어 `execute()` 까지 들고 간다(아래 `accrual` → `propose` → `p.accrualExempt`).
             * ❌ **기각한 대안: 집행 시점에 `canAccrue` 를 다시 묻기.** 그러면 *"한도 안이어서
             *    면제가 필요 없었던 매수"* 까지 차감해, 적립 예산이 *"수익으로 모은 양"* 이 아니라
             *    *"QLD 매수 총량"* 을 추적하게 된다 — 사용자가 **원금으로** QLD 를 사도 예산이
             *    깎인다. 면제를 **근거로 한도를 뚫은 주문만** 차감하는 것이 이 원장의 정의다.
             */
            accrual = { accrualExempt: true, accrualUsd: Math.round(need * 100) / 100 };
            logWarn('orders.accrual_exempt', {
              symbol: sym, needUsd: Math.round(need * 100) / 100,
              accrualBudgetUsd: acc.budgetUsd, currency: cur,
              symPct: equity > 0 ? Math.round((symVal / equity) * 1000) / 10 : null,
              capPct: SINGLE_POSITION_MAX_PCT,
              why: '수익 기반 적립 예산 — 집중 상한만 면제',
            });
          } else {
            const maxQty = Math.max(0, Math.floor((capVal - symVal) / px));
            return {
              ok: false, kind: 'concentration',
              error: `매수 후 ${sym} 비중이 종목 한도(${SINGLE_POSITION_MAX_PCT}%)를 넘습니다 — 현재 ${equity > 0 ? ((symVal / equity) * 100).toFixed(1) : '?'}% + 이번 ${need.toFixed(2)} ${cur}. 가능 수량 ${maxQty}주. (적립 면제 불가: ${acc.why})`,
              maxQuantity: maxQty, currency: cur, accrual: acc.why,
            };
          }
        }
      } catch (e) {
        // 집중 계산 실패가 정당한 매수를 막으면 오탐 게이트다 — 기본 현금 검증은 위에서 통과했다
        logWarn('orders.concentration_check_failed', { message: e.message });
      }
    }
    if (!exemptCashFloor && CASH_FLOOR_PCT > 0) {
      try {
        const h = await require('./tossPortfolio').getHoldings({});
        const holdingsVal = (h.items || [])
          .filter((it) => String(it.currency || '').toUpperCase() === cur)
          .reduce((s, it) => s + (Number(it.marketValue) || 0), 0);
        const floor = (cash + holdingsVal) * (CASH_FLOOR_PCT / 100);
        if (cash - need < floor) {
          const maxQty = Math.max(0, Math.floor((cash - floor) / px));
          return {
            ok: false, kind: 'cash-floor',
            error: `매수 후 현금이 버퍼(평가액의 ${CASH_FLOOR_PCT}% = ${floor.toFixed(0)} ${cur}) 밑으로 떨어집니다 — VIX 사다리 실탄 보전(운용 방침). 가능 수량 ${maxQty}주.`,
            maxQuantity: maxQty, currency: cur,
          };
        }
      } catch (e) {
        // 버퍼 계산 실패가 정당한 매수를 막으면 오탐 게이트다 — 기본 현금 검증은 위에서 이미 통과
        logWarn('orders.cash_floor_check_failed', { message: e.message });
      }
    }
    return { ok: true, available: bp.cash.raw, currency: cur, ...(accrual || {}) };
  } catch (e) {
    // 🔴 조회 실패를 **통과로 읽지 않는다**
    logWarn('orders.account_check_failed', { symbol: sym, side: up, kind: e.kind, message: e.message });
    return { ok: false, kind: 'unknown', error: `계좌 확인 실패: ${e.message}` };
  }
}

/**
 * @param opts.accrual 💰 `checkAccountLimits` 결과를 그대로 넘기면 **적립 면제 플래그가
 *   제안에 보존**된다(집행 시 차감의 근거). 호출자가 한도 검사를 **밖에서** 하는 경로를 위한
 *   이음새다 — `POST /api/orders/proposals`(server.js) 와 `analystChat` 이 그 모양이고,
 *   거기서는 `chk` 를 검사 후 버려서 면제 사실이 제안에 닿지 않는다.
 *   ⚠️ 자율 경로는 `propose` **안에서** 검사하므로 이 인자가 필요 없다(아래에서 직접 심는다).
 */
function propose(input = {}, { source = 'manual', notify = true, accrual = null } = {}) {
  /**
   * 🛑 **비상정지 게이트** (2026-10-03 D-4) — 정지 중에는 어떤 제안도 만들어지지 않는다.
   *    여기가 길목이다: 분석·채팅·사다리·수동이 전부 이 함수를 지난다.
   * 🔴 조용히 막지 않는다 — 감사에 `blocked` 로 남는다(차단도 일어난 일이다).
   */
  const gate = require('./agentControl').gateProposal();
  if (!gate.allowed) {
    logWarn('orders.blocked_by_pause', { symbol: input.symbol, side: input.side, source, why: gate.why });
    audit('blocked', { symbol: String(input.symbol || '').toUpperCase(), side: String(input.side || '').toUpperCase(), source, reason: gate.why.slice(0, 160) });
    return { ok: false, error: gate.why, kind: 'agent_paused' };
  }
  const symbol = String(input.symbol || '').trim().toUpperCase();
  const side = String(input.side || '').trim().toUpperCase();
  const type = String(input.type || 'LIMIT').trim().toUpperCase();
  const quantity = num(input.quantity);
  const price = type === 'MARKET' ? null : num(input.price);

  /**
   * 🔴 조건부(예약) 제안 (2026-09-23) — 사용자: *"100불 도달하면 100불보다 비싸게
   *    지정가로 QLD 전량 매도"*. 즉시 주문이 아니라 **거래소가 감시가를 지켜보다 발동**한다.
   *    승인·집행·감사는 즉시 주문과 **같은 HITL 흐름**을 탄다(문이 하나 더 생기는 게 아니다).
   */
  const conditional = input.conditional
    ? {
        triggerPrice: num(input.conditional.triggerPrice),
        orderPrice: input.conditional.orderPrice != null ? num(input.conditional.orderPrice) : null,
        orderType: String(input.conditional.orderType || 'LIMIT').trim().toUpperCase(),
        expireDate: String(input.conditional.expireDate || '').trim(),
      }
    : null;

  const missing = [];
  if (!symbol) missing.push('symbol');
  if (!SIDES.has(side)) missing.push('side(BUY|SELL)');
  if (!TYPES.has(type)) missing.push('type(LIMIT|MARKET)');
  if (!(quantity > 0)) missing.push('quantity>0');
  // ⚠️ 지정가인데 가격이 없으면 **거부한다.** 사람이 승인 화면에서 채우게 하면
  //    그 화면이 곧 주문 화면이 되고, "승인" 의 의미가 사라진다
  if (!conditional && type === 'LIMIT' && !(price > 0)) missing.push('price>0 (지정가)');
  if (conditional) {
    // 보내기 전 모양 검증을 **제안 시점에** 한다 — 승인 눌렀는데 형식으로 막히면 신뢰가 깎인다
    const pre = require('./orderRules').buildConditionalSingle({
      symbol, side, quantity,
      triggerPrice: conditional.triggerPrice, orderPrice: conditional.orderPrice,
      orderType: conditional.orderType, expireDate: conditional.expireDate,
    });
    if (!pre.ok) missing.push(...pre.errors);
  }

  if (missing.length) {
    audit('proposal_rejected', { symbol, side, type, missing, source });
    return {
      ok: false,
      error: `제안에 빠진 값이 있습니다: ${missing.join(', ')}. 승인 화면에서 채우게 두지 않습니다.`,
      missing,
    };
  }

  const now = Date.now();
  const proposal = {
    id: crypto.randomUUID(),
    // 멱등키 — 승인 1건 = 주문 1건. 중복 클릭·재시도가 두 번 사지 않게
    idempotencyKey: crypto.randomUUID(),
    symbol,
    side,
    type,
    quantity,
    price,
    // 조건부(예약)면 감시가·주문가·만료일이 여기 산다 — null 이면 즉시 주문 제안
    conditional,
    reason: String(input.reason || '').slice(0, 500),
    source,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PROPOSAL_TTL_MS).toISOString(),
    status: 'PENDING',
    approvedAt: null,
    executedAt: null,
    result: null,
  };
  /**
   * 💰 적립 면제 플래그 — 호출자가 밖에서 한도를 본 경우(위 `opts.accrual` 참조).
   * ⚠️ 면제가 아니면 **키를 안 만든다**(부재로 "없음" 을 표현한다 — `false` 를 싣지 않는다).
   * ★ 영속은 자동이다: `persist()` 가 제안 객체를 **통째로** 직렬화하고 `restore()` 가
   *   `proposals.set(p.id, p)` 로 되읽는다 — 필드 허용목록이 없다(실측 확인). 그래도
   *   왕복 테스트로 잠근다 — 나중에 누가 정규화를 넣으면 이 필드가 조용히 사라지고
   *   **차감만 안 되는** 상태가 된다(09-22 watch 필드·10-05 momentumMinPct 와 같은 자리).
   */
  if (accrual?.accrualExempt) {
    proposal.accrualExempt = true;
    proposal.accrualUsd = Number(accrual.accrualUsd) || 0;
  }
  proposals.set(proposal.id, proposal);
  persist();
  audit('proposed', {
    id: proposal.id, symbol, side, type, quantity, price, source,
    ...(conditional ? { conditional } : {}),
  });
  /**
   * 🔴 제안이 생기면 **밖으로 알린다**(텔레그램 승인 버튼).
   * ⚠️ 여기서 `require` 를 위로 올리면 **순환 참조**가 된다
   *    (alertService → telegramBot → orderService). 그래서 부를 때 가져온다.
   * ⚠️ 알림이 실패해도 **제안은 이미 만들어졌다** — 삼켜서 제안을 되돌리지 않는다.
   */
  if (!notify) {
    // 🔴 안 보낸 이유를 남긴다 — 나중에 "왜 버튼이 안 왔지" 를 겪지 않게
    logInfo('orders.notify_skipped', { id: proposal.id, symbol, why: 'notify:false' });
  }
  for (const fn of notify ? listeners : []) {
    try {
      Promise.resolve(fn(proposal)).catch((e) => logWarn('orders.notify_failed', { message: e.message }));
    } catch (e) {
      logWarn('orders.notify_failed', { message: e.message });
    }
  }
  /**
   * 🤖 자율 집행 (2026-10-04 — 자율 수준 1단+). 조건 전부 참일 때만:
   *  - 수준 ≥ 1 (사람이 화면에서 타이핑 확인으로 올린 값 — agentControl 이 영속)
   *  - **에이전트 발 제안만**(analyst·vix-ladder) — 수동·채팅 제안을 자동으로 쏘면
   *    "내가 입력한 게 바로 나갔다" 가 된다(그건 자율이 아니라 사고다)
   *  - checkAccountLimits **통과** — 한도에 걸리면 자동이 아니라 HITL 대기로 남는다
   * ⚠️ 비동기 — 제안 등록을 집행 실패가 막지 않는다. 결과는 감사(auto_executed/auto_skipped)에.
   */
  const AUTO_SOURCES = new Set(['analyst', 'vix-ladder']);
  if (require('./agentControl').autonomyLevel() >= 1 && AUTO_SOURCES.has(source)) {
    (async () => {
      try {
        /**
         * 📒 AI 원장 게이트 (2026-10-05 — "비율 일임"). 자동 집행의 돈 범위를 계좌 전체에서
         *    **맡긴 예산**으로 좁힌다: 매수 = 예산 잔액 안(미설정이면 0 — 기본이 전 재산이면
         *    안 된다) · 매도 = **AI 가 산 수량까지만**(기존 보유는 영원히 HITL 로 남는다).
         */
        const ledger = require('./agentLedger');
        if (proposal.side === 'BUY') {
          const can = ledger.canBuy(Number(proposal.quantity) * Number(proposal.price));
          if (!can.ok) {
            audit('auto_skipped', { id: proposal.id, symbol, reason: can.why.slice(0, 160) });
            logInfo('orders.auto_skipped', { id: proposal.id, symbol, kind: 'ledger_budget' });
            return; // HITL 대기 — 사람은 여전히 승인해서 살 수 있다
          }
        } else {
          const own = ledger.sellableQty(symbol);
          if (own < Number(proposal.quantity)) {
            audit('auto_skipped', { id: proposal.id, symbol, reason: `AI 원장 보유 ${own} < 제안 ${proposal.quantity} — 기존 보유 매도는 HITL` });
            logInfo('orders.auto_skipped', { id: proposal.id, symbol, kind: 'ledger_not_owned' });
            return;
          }
        }
        // module.exports 경유 — 내부 참조로 부르면 테스트가 한도 축을 스텁할 수 없다(09-30 구조분해 함정의 변형)
        const chk = await module.exports.checkAccountLimits({
          symbol: proposal.symbol, side: proposal.side,
          quantity: proposal.quantity, price: proposal.price,
        });
        if (!chk.ok) {
          audit('auto_skipped', { id: proposal.id, symbol, reason: (chk.error || chk.kind || '').slice(0, 160) });
          logInfo('orders.auto_skipped', { id: proposal.id, symbol, kind: chk.kind });
          return; // HITL 대기로 남는다 — 한도 밖 자동은 없다
        }
        /**
         * 💰 적립 면제로 한도를 뚫었으면 **제안에 적어 둔다** — `execute()` 가 그걸 보고 차감한다.
         * 🔴 `execute()` 보다 **먼저** 심어야 한다(아래 approve→execute 가 이 플래그를 읽는다).
         */
        if (chk.accrualExempt) {
          proposal.accrualExempt = true;
          proposal.accrualUsd = Number(chk.accrualUsd) || 0;
          persist();
        }
        const ap = approve(proposal.id);
        if (!ap.ok) { audit('auto_skipped', { id: proposal.id, symbol, reason: 'approve_failed' }); return; }
        const ex = await execute(proposal.id);
        if (ex.ok) {
          // 전송 성공 = 원장 투입/회수 기록(미체결 보정은 reconcile 영역 — 보수적으로 잠근다)
          const rec = { symbol, quantity: Number(proposal.quantity), price: Number(proposal.price), proposalId: proposal.id, dryRun: Boolean(ex.dryRun) };
          if (proposal.side === 'BUY') require('./agentLedger').recordBuy(rec);
          else require('./agentLedger').recordSell(rec);
        }
        audit('auto_executed', {
          id: proposal.id, symbol, side: proposal.side, quantity: proposal.quantity,
          level: require('./agentControl').autonomyLevel(), ok: ex.ok, dryRun: Boolean(ex.dryRun),
        });
        try {
          require('./activityLog').record('execution',
            `자율 집행(${require('./agentControl').autonomyLevel()}단) — ${proposal.side === 'BUY' ? '매수' : '매도'} ${symbol} ${proposal.quantity}주${ex.dryRun ? ' (모의)' : ''}`,
            { proposalId: proposal.id, symbol });
        } catch { /* 기록 실패가 집행 결과를 바꾸지 않는다 */ }
        /**
         * 🔴 **자율 집행을 폰에 분명히 알린다** (2026-10-06 — 사용자:
         *    *"텔레그램에 너가 자동으로 한게 바로 그냥 승인됨 떠버리는데 뭐냐 이게 AI 판단
         *    구매인지 나한테 문의하는건지 텔레그램에 안내는 있어야 하지 않냐?"*).
         *
         *    종전 흐름: 제안 생성 → 텔레그램에 **승인/취소 버튼**과 함께 발송 → 곧바로
         *    자율 집행이 approve+execute → 버튼이 "승인됨" 으로 바뀐다.
         *    ⇒ 사용자 화면에는 **"내가 승인한 것"과 똑같이 보인다.** 실제로는 사람이 한 번도
         *      손대지 않았고 **실주문이 이미 나간 뒤**다. 가장 나쁜 종류의 모호함이다
         *      (돈이 나갔는데 누가 결정했는지 폰만 보고는 알 수 없다).
         * ⚠️ activityLog 는 **화면에만** 남는다 — 결정을 내리는 사람은 폰을 본다
         *    (10-01 "텔레그램이 모든 자기고발을 삼키고 있었다" 와 같은 자리).
         * ⚠️ 발송 실패가 집행 결과를 바꾸지 않는다. 다만 조용하지도 않다.
         */
        try {
          const lv = require('./agentControl').autonomyLevel();
          const led = require('./agentLedger').status();
          const side = proposal.side === 'BUY' ? '매수' : '매도';
          const px = Number(proposal.price);
          require('./telegramService').send(
            [
              `🤖 AI 자동 집행 — 사람 승인 없이 나갔습니다 (자율 ${lv}단)`,
              `${side} ${symbol} ${proposal.quantity}주 @ ${Number.isFinite(px) ? px : '시장가'}${ex.dryRun ? '  ⚠️모의(실주문 아님)' : ''}`,
              `AI 예산: 투입 $${led.openCostUsd} / $${led.budgetUsd} · 잔액 $${led.availableUsd}`,
              `근거: ${String(proposal.reason || '').slice(0, 140)}`,
              '',
              '⚠️ 이 주문은 **버튼을 누르지 않아도** 나갑니다. 멈추려면 운용 규칙에서 자율 0단으로',
              '   내리거나 AI 예산을 해제하십시오(비상정지는 전체를 멈춥니다).',
            ].join('\n'),
            { reason: 'auto_exec' },
          );
        } catch (e) { logWarn('orders.auto_exec_notify_failed', { id: proposal.id, message: e.message }); }
      } catch (e) {
        logWarn('orders.auto_exec_failed', { id: proposal.id, message: e.message });
        audit('auto_skipped', { id: proposal.id, symbol, reason: `error: ${e.message}`.slice(0, 160) });
      }
    })();
  }
  return { ok: true, proposal };
}

function isExpired(p, now = Date.now()) {
  return Date.parse(p.expiresAt) <= now;
}

function list() {
  const now = Date.now();
  return [...proposals.values()].map((p) => ({ ...p, expired: isExpired(p, now) }));
}

/**
 * 승인. **승인만으로는 아무것도 나가지 않는다** — 실행은 별도 단계다.
 */
function approve(id) {
  const p = proposals.get(id);
  if (!p) return { ok: false, error: '제안을 찾을 수 없습니다.' };
  if (p.status !== 'PENDING') return { ok: false, error: `이미 ${p.status} 상태입니다.` };
  if (isExpired(p)) {
    p.status = 'EXPIRED';
    persist();
    emitSettled(p, 'expired');
    audit('expired', { id, symbol: p.symbol });
    return { ok: false, error: '제안이 만료되었습니다. 시세가 움직였으니 다시 산출하세요.' };
  }
  p.status = 'APPROVED';
  p.approvedAt = new Date().toISOString();
  persist();
  emitSettled(p, 'approved');
  audit('approved', { id, symbol: p.symbol, side: p.side, quantity: p.quantity, price: p.price });
  return { ok: true, proposal: p };
}

function reject(id, reason = '') {
  const p = proposals.get(id);
  if (!p) return { ok: false, error: '제안을 찾을 수 없습니다.' };
  p.status = 'REJECTED';
  persist();
  emitSettled(p, 'rejected');
  audit('rejected', { id, symbol: p.symbol, reason: String(reason).slice(0, 200) });
  return { ok: true, proposal: p };
}

/**
 * 💰 **적립 예산 차감** — 집행 성공 시 한 번. `execute()` 의 성공 출구가 셋이라 함수로 뺐다
 *    (한 곳만 고치면 나머지에서 조용히 안 깎인다 — "형제 중 하나만 빠짐" 의 그 자리).
 *
 * 🔴 `agentLedger.recordBuy` 와 **독립**이다 — 둘은 다른 축이고(AI 전용 자금 vs 적립 재원)
 *    한 주문이 양쪽에 다 걸릴 수 있다. 그래서 여기서 agentLedger 를 보지 않는다.
 * 🔴 **면제를 근거로 한도를 뚫은 매수만** 깎는다(`p.accrualExempt`). 한도 안의 매수는
 *    적립 예산을 쓴 것이 아니므로 차감하지 않는다 — 안 그러면 예산이 "수익으로 모은 양" 이
 *    아니라 "매수 총량" 을 추적하게 된다.
 * ⚠️ 차감 실패가 **주문 결과를 바꾸지 않는다** — 주문은 이미 나갔다(되돌릴 수 없다). 대신
 *    조용하지도 않다: 실패하면 warn 이고, 그건 "예산이 덜 깎였다 = 면제가 더 열려 있다" 는 뜻이다.
 * ⚠️ **알려진 한계**: 기준이 `agentLedger` 와 같은 **"전송 = 투입"** 이다. 미체결·부분체결·
 *    발동 안 된 조건주문은 예산을 돌려받지 못한다(reconcile 영역). 예산을 넉넉히 잠그는
 *    방향의 오차라 안전한 쪽이고, 두 원장이 같은 주문을 다르게 세지 않게 기준을 맞춘 것이다.
 */
function deductAccrual(p, { dryRun = false } = {}) {
  if (!p?.accrualExempt) return;
  try {
    const r = require('./incomeLedger').recordAccrual({
      symbol: p.symbol, quantity: Number(p.quantity), price: Number(p.price),
      proposalId: p.id, dryRun,
    });
    if (!r?.ok) logWarn('orders.accrual_deduct_rejected', { id: p.id, symbol: p.symbol, error: r?.error });
    else audit('accrual_deducted', { id: p.id, symbol: p.symbol, usd: r.usd, remainingUsd: r.remainingUsd, dryRun });
  } catch (e) {
    logWarn('orders.accrual_deduct_failed', { id: p.id, symbol: p.symbol, message: e.message });
  }
}

/**
 * 실행. 🔴 **지금은 no-op 이다.**
 *
 * `ORDERS_ENABLED` 와 `ORDERS_LIVE` 가 **둘 다** 켜져야 실제 호출로 간다.
 * 그 전까지는 흐름만 돌려 보고 결과를 `DRY_RUN` 으로 남긴다 —
 * **승인 흐름의 결함을 실주문으로 배우면 안 된다**(샌드박스가 없다).
 */
async function execute(id) {
  const p = proposals.get(id);
  if (!p) return { ok: false, error: '제안을 찾을 수 없습니다.' };

  // ⓪ 구조로 막는다 — 승인 레코드가 **있어야만** 진행한다(이름·의도 추론 아님)
  if (p.status !== 'APPROVED' || !p.approvedAt) {
    audit('execute_blocked', { id, status: p.status, reason: 'not_approved' });
    return { ok: false, error: '승인되지 않은 제안은 실행할 수 없습니다.' };
  }
  if (isExpired(p)) {
    p.status = 'EXPIRED';
    persist();
    audit('execute_blocked', { id, reason: 'expired' });
    return { ok: false, error: '승인 후 만료되었습니다. 다시 산출하세요.' };
  }

  if (!ORDERS_ENABLED || !ORDERS_LIVE) {
    p.status = 'DRY_RUN';
    persist();
    p.executedAt = new Date().toISOString();
    p.result = {
      mode: 'dry-run',
      note: ORDERS_ENABLED
        ? 'ORDERS_LIVE 가 꺼져 있어 실제로 보내지 않았습니다.'
        : 'ORDERS_ENABLED 가 꺼져 있어 실제로 보내지 않았습니다.',
    };
    audit('dry_run', { id, symbol: p.symbol, side: p.side, quantity: p.quantity, price: p.price });
    // 💰 dryRun 도 차감한다 — agentLedger.recordBuy 가 dryRun 을 투입으로 세는 것과 **같은 기준**.
    //    두 원장이 같은 주문을 다르게 세면 어느 쪽이 맞는지 알 수 없다(예산을 잠그는 방향이라 안전).
    deductAccrual(p, { dryRun: true });
    return { ok: true, proposal: p, dryRun: true };
  }

  /**
   * ── 여기부터 **실거래**다 ──────────────────────────────────────
   *
   * 종전 주석이 남겨 둔 열린 질문 셋에 **명세가 답을 줬다**(2026-09-22):
   * ```
   * Q 멱등키를 받는가?     A `clientOrderId` (본문). **서버가 자동 생성하지 않는다** · 10분 유효
   *                         ⚠️ 우리가 안 주면 **두 번 승인 = 두 번 주문**이다
   * Q 타임아웃이면?        A 재시도 금지. 성공 응답에도 **orderId 만** 오므로
   *                         상태는 `GET /orders/{id}` 로 **따로** 확정한다
   * Q 정정·취소는?         A **멱등키가 없고** 성공해도 **새 orderId** 가 발급된다 ⇒ 자동 재시도 절대 금지
   * ```
   * ⚠️ 그래도 **첫 실주문은 소액 1주 · 사람이 직접 · 1회** 라는 원칙은 그대로다.
   */
  const rules = require('./orderRules');
  const key = rules.idempotencyKeyFor(p.id);
  // 조건부(예약)와 즉시 주문은 **모양 검증과 전송 API 만 다르고** 나머지 안전망은 같다
  const built = p.conditional
    ? rules.buildConditionalSingle({
        symbol: p.symbol, side: p.side, quantity: p.quantity,
        triggerPrice: p.conditional.triggerPrice, orderPrice: p.conditional.orderPrice,
        orderType: p.conditional.orderType, expireDate: p.conditional.expireDate,
        clientOrderId: key,
      })
    : rules.validateOrderRequest({
    symbol: p.symbol, side: p.side, orderType: p.type,
    quantity: p.quantity, price: p.type === 'LIMIT' ? p.price : undefined,
    clientOrderId: key,
  });
  if (!built.ok) {
    // 🔴 보내기 전에 막는다 — 거래소가 거부하는 것보다 여기서 걸리는 게 낫다
    p.status = 'BLOCKED';
    persist();
    audit('execute_blocked', { id, reason: 'invalid_request', errors: built.errors });
    return { ok: false, error: `주문 형식이 맞지 않습니다: ${built.errors.join(' · ')}` };
  }
  if (built.uncertain?.length) {
    /**
     * 🔴 **모르면 보내지 않는다.** 예: 국내 종목의 ETF 여부를 몰라 호가 단위를 확정 못 하면
     *    일반주 기준으로 추측해 보내지 않는다 — 거래소가 거부하거나, 더 나쁘게는
     *    **의도와 다른 가격으로 체결**될 수 있다.
     * ★ *"검사하지 않은 것" 과 "통과한 것" 을 구분하지 못하는 자를 만들지 말 것* 의 돈 버전이다.
     *    제안 단계에서는 경고로 두고, **실거래에서만** 막는다(제안까지 막으면 화면이 비어 버린다).
     */
    p.status = 'BLOCKED';
    persist();
    audit('execute_blocked', { id, reason: 'uncertain', uncertain: built.uncertain });
    return { ok: false, error: `확인하지 못한 조건이 있어 보내지 않았습니다: ${built.warnings.join(' · ')}` };
  }
  if (!key) {
    /**
     * 🔴 **멱등키 없이 보내지 않는다.** 명세가 *"미전달: 멱등성 미적용, 매 요청을 별개 주문으로 처리"*
     *    라고 못박았다 — 그 상태로 타임아웃이 나면 **중복 주문을 막을 방법이 없다.**
     */
    p.status = 'BLOCKED';
    persist();
    audit('execute_blocked', { id, reason: 'no_idempotency_key' });
    return { ok: false, error: '멱등키를 만들 수 없어 실행하지 않았습니다(중복 주문 위험).' };
  }

  const toss = require('./tossClient');
  audit('sending', { id, symbol: p.symbol, side: p.side, quantity: p.quantity, clientOrderId: key });
  let created;
  try {
    /**
     * 🔴 **제안의 유효시각을 큐까지 넘긴다** (2026-09-22, pm2 지적).
     *    만료 검사는 이 함수 **맨 위에서 한 번**뿐인데, 그 뒤 큐에서 기다릴 수 있다.
     *    안 넘기면 *"제안은 EXPIRED 인데 주문은 나간"* 상태가 생긴다 — 상태가 갈리면
     *    사람이 무엇을 취소해야 하는지 모른다.
     */
    created = p.conditional
      ? await toss.createConditionalOrder(built.body, { deadlineAt: Date.parse(p.expiresAt) || null })
      : await toss.createOrder(built.body, { deadlineAt: Date.parse(p.expiresAt) || null });
  } catch (e) {
    if (e.kind === 'unknown') {
      /**
       * 🔴🔴 **보냈는데 답을 못 받았다** — 최악의 상태다. 재시도하면 두 번 산다.
       *    ⇒ `UNKNOWN` 으로 남기고 **조회로 확정**하게 한다. 사람이 볼 수 있게 감사에도 남긴다.
       */
      p.status = 'UNKNOWN';
      p.result = { mode: 'unknown', clientOrderId: key, note: '전송 후 응답 없음 — 주문 조회로 확정해야 합니다. **재시도 금지**.' };
      persist();
      audit('send_unknown', { id, clientOrderId: key, message: e.message });
      return { ok: false, unknown: true, error: e.message, proposal: p };
    }
    if (e.kind === 'not-sent') {
      /**
       * 🔴 **안 나간 것과 모르는 것은 다르다** (2026-09-22 폰 실행 첫 시험에서 갈라냈다).
       *    연결조차 못 맺었으면 주문이 들어갔을 리 없다 ⇒ **승인을 태우지 않는다.**
       *    사람이 «전송» 을 다시 누르면 된다.
       * ⚠️ 그래도 안전망은 그대로다 — 멱등키가 **제안 id** 라서, 만에 하나 실제로는
       *    나갔더라도 두 번째가 막힌다 — **TTL 이 멱등키 유효기간(10분)보다 길어진 뒤로는
       *    근거가 멱등키가 아니라 상태기계다**(보낸 제안은 APPROVED 가 아니라 재실행 자체가 안 된다).
       */
      p.result = { mode: 'not_sent', error: e.message, kind: e.kind, at: new Date().toISOString() };
      persist();
      audit('send_not_sent', { id, kind: e.kind, message: e.message });
      return { ok: false, retryable: true, error: e.message, kind: e.kind, proposal: p };
    }
    if (e.kind === 'idempotency-conflict') {
      // 같은 키로 **다른 내용**을 보냈다 — 우리 상태가 꼬인 것이다. 조용히 재시도하면 안 된다
      p.status = 'FAILED';
      persist();
      audit('send_conflict', { id, clientOrderId: key, message: e.message });
      return { ok: false, error: `멱등키 충돌: ${e.message}` };
    }
    p.status = 'FAILED';
    p.result = { mode: 'failed', error: e.message, kind: e.kind };
    persist();
    audit('send_failed', { id, kind: e.kind, message: e.message });
    return { ok: false, error: e.message, kind: e.kind };
  }

  /**
   * 🔴 **응답에 `orderId` 만 온다** — 체결됐는지는 **모른다.**
   *    여기서 "성공" 이라고 적으면 사용자는 체결된 줄 안다 ⇒ **SENT** 로 두고 상태를 따로 확인한다.
   */
  if (p.conditional) {
    /**
     * 조건주문은 **등록 = 감시 시작**이다(체결이 아니다). 거래소가 감시가 도달 시 주문을 낸다.
     * ⚠️ 만료일까지 미도달이면 자동 소멸 — 그것도 정상 결말이다(사용자에게 만료일을 보인다).
     */
    const conditionalOrderId = created?.conditionalOrderId || created?.id || null;
    p.status = 'SENT';
    p.conditionalOrderId = conditionalOrderId;
    p.executedAt = new Date().toISOString();
    p.result = {
      mode: 'live-conditional', conditionalOrderId, clientOrderId: key,
      note: `예약이 등록됐습니다. 감시가 ${p.conditional.triggerPrice} 도달 시 ${p.conditional.orderType === 'MARKET' ? '시장가' : `지정가 ${p.conditional.orderPrice}`} ${p.side === 'SELL' ? '매도' : '매수'} 주문이 나갑니다(만료 ${p.conditional.expireDate}).`,
    };
    persist();
    audit('conditional_sent', { id, conditionalOrderId, clientOrderId: key, conditional: p.conditional });
    // ⚠️ 등록 = 감시 시작이지 체결이 아니다. 그래도 차감한다(위 '전송 = 투입' 기준) —
    //    발동 안 된 예약은 예산을 돌려받지 못하는 것이 알려진 한계다.
    deductAccrual(p);
    return { ok: true, proposal: p, conditionalOrderId };
  }

  const orderId = created?.orderId || created?.id || null;
  p.status = 'SENT';
  p.orderId = orderId;
  p.executedAt = new Date().toISOString();
  p.result = { mode: 'live', orderId, clientOrderId: key, note: '접수됐습니다. 체결 여부는 주문 조회로 확인합니다.' };
  persist();
  audit('sent', { id, orderId, clientOrderId: key });
  deductAccrual(p);

  // 상태를 한 번 확인한다 — ⚠️ 실패해도 **주문은 이미 나갔다**(되돌리지 않는다)
  try {
    const detail = await toss.getOrder(orderId);
    p.result.orderStatus = detail?.status ?? null;
    persist();
    audit('status_checked', { id, orderId, status: detail?.status ?? null });
  } catch (e) {
    logWarn('orders.status_check_failed', { id, orderId, message: e.message });
  }
  return { ok: true, proposal: p, orderId };
  p.result = { mode: 'not-implemented', note: '실거래 연결은 아직 만들지 않았습니다.' };
  audit('execute_not_implemented', { id, symbol: p.symbol });
  logWarn('orders.live_path_missing', { id });
  return { ok: false, error: '실거래 연결이 아직 구현되지 않았습니다(의도된 상태).' };
}

/** 화면·기동 로그가 상태를 알 수 있게 */
function status() {
  return {
    ordersEnabled: ORDERS_ENABLED,
    ordersLive: ORDERS_LIVE,
    // 둘 다 켜져야 실제로 나간다. 하나만 켜진 상태를 화면이 구분할 수 있어야 한다
    effective: ORDERS_ENABLED && ORDERS_LIVE ? 'live' : 'dry-run',
    proposalTtlMs: PROPOSAL_TTL_MS,
    idempotencyWindowMs: IDEMPOTENCY_WINDOW_MS,
    pending: [...proposals.values()].filter((p) => p.status === 'PENDING').length,
  };
}

function _resetForTest() {
  // ⚠️ 파일도 함께 지운다 — 안 그러면 회차가 서로에게 샌다
  try { fs.unlinkSync(STORE_FILE); } catch { /* 없으면 그만 */ }
  proposals.clear();
  listeners.length = 0;
}

// 🔴 모듈이 로드될 때 **한 번** 복원한다(기동 시점)
restore();

/**
 * 🔴 **나간 주문을 취소한다** (2026-09-22 신설)
 *
 * ## 왜 없었나 — 그게 사고를 만들었다
 * 종전엔 `reject()` 가 **제안**을 거절할 뿐이고, **이미 나간 주문을 취소하는 함수가 없었다.**
 * 그래서 첫 실주문을 취소할 때 `tossClient.cancelOrder` 를 **직접** 불렀고,
 * 감사는 `orderService` 에만 있으니 **취소가 기록되지 않았다** —
 * 감사만 보면 그 주문은 아직 `PENDING` 이다. **기록이 사실과 달랐다.**(pm2 발견)
 * ★ 돈 경로에서 *"기록이 한 벌이 아니다"* 는 값이 크다. 우회 경로를 쓰면 그 대가가 여기서 나온다.
 *
 * ⚠️ 취소는 **멱등키가 없다**(명세) ⇒ **자동 재시도 금지.** 응답을 못 받으면 조회로 확정한다.
 * ⚠️ 성공해도 **새 `orderId` 가 발급**된다(원 ID 와 다르다) — 둘 다 남긴다.
 */
async function cancelLiveOrder(proposalId, { orderId } = {}) {
  const p = proposals.get(proposalId) || null;
  const target = orderId || p?.orderId;
  if (!target) return { ok: false, error: '취소할 주문 ID 가 없습니다.' };

  const toss = require('./tossClient');
  audit('cancel_requested', { id: proposalId ?? null, orderId: target });
  let res;
  try {
    res = await toss.cancelOrder(target);
  } catch (e) {
    if (e.kind === 'unknown') {
      // 🔴 보냈는데 답이 없다 — **재시도하지 않는다.** 조회로 확정해야 한다
      audit('cancel_unknown', { id: proposalId ?? null, orderId: target, message: e.message });
      return { ok: false, unknown: true, error: `${e.message} (취소가 됐는지 조회로 확정하세요)` };
    }
    audit('cancel_failed', { id: proposalId ?? null, orderId: target, kind: e.kind, message: e.message });
    return { ok: false, error: e.message, kind: e.kind };
  }

  const newOrderId = res?.orderId || null;
  if (p) {
    p.status = 'CANCELED';
    p.canceledAt = new Date().toISOString();
    p.result = { ...(p.result || {}), canceledOrderId: newOrderId };
    persist();
    emitSettled(p, 'rejected');
  }
  audit('canceled', { id: proposalId ?? null, orderId: target, newOrderId });
  return { ok: true, orderId: target, newOrderId, proposal: p };
}

/**
 * 🔴 **밖에서 확인한 사실을 기록에 반영한다** (2026-09-22 신설)
 *
 * `UNKNOWN`(보냈는데 답을 못 받음)을 만들어 놓고 **그것을 해소할 함수가 없었다** —
 * *"조회로 확정하세요"* 라고 적어 놓고 확정한 결과를 적을 자리가 없었던 것이다.
 * 같은 구멍으로, 앱 밖(우회 프로세스·토스 앱)에서 일어난 일도 기록이 끊긴다.
 *
 * ⚠️ **시각을 소급하지 않는다.** `at` 은 **지금**이고 `observedAt` 에 관측 시각을 따로 적는다 —
 *    감사는 *"일어난 일의 목록"* 이지 *"고쳐 쓴 과거"* 가 아니다.
 */
function reconcile(proposalId, { status, orderId, observedAt, why } = {}) {
  const p = proposals.get(proposalId) || null;
  const before = p?.status ?? null;
  if (p && status) {
    p.status = String(status).toUpperCase();
    p.reconciledAt = new Date().toISOString();
    persist();
  }
  audit('reconciled', {
    id: proposalId ?? null,
    orderId: orderId ?? p?.orderId ?? null,
    from: before,
    to: status ?? null,
    observedAt: observedAt ?? null,
    why: why || null,
    note: '앱 밖에서 확인한 사실을 반영했습니다(소급 기록이 아니라 지금 시점의 보정입니다).',
  });
  return { ok: true, proposal: p };
}

/**
 * 🔭 **제안 성과 집계** (2026-10-03 — 자율 트레이딩 대시보드).
 *
 * 자율로 가려면 *"이 에이전트의 제안이 얼마나 받아들여지고 있나"* 가 먼저 보여야 한다 —
 * 생애 제안의 73.7% 를 사용자가 거절한 상태에서 자율은 성립하지 않는다. 그 수치가
 * 내려가는 것이 자율의 전제 조건이고, **내려가는지 화면에서 보여야** 한다.
 *
 * ⚠️ 감사 파일(JSONL append-only)에서 센다 — 메모리 Map 은 KEEP_MS 로 지워져 **생애 집계가 안 된다.**
 * ⚠️ 파일을 못 읽으면 null — 0 으로 채우면 "제안이 없었다" 로 읽힌다.
 */
function proposalStats() {
  try {
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
    const by = { proposed: 0, approved: 0, rejected: 0, executed: 0, expired: 0, canceled: 0 };
    const recent = [];
    for (const line of lines) {
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (d.event in by) by[d.event] += 1;
      // ⚠️ 수량·가격은 싣지 않는다 — 화면 집계에 금액은 불요(민감 축)
      recent.push({ at: d.at, event: d.event, symbol: d.symbol || null, side: d.side || null });
    }
    return { ...by, total: lines.length, recent: recent.slice(-12).reverse() };
  } catch {
    return null;
  }
}

module.exports = {
  proposalStats,
  propose,
  /** 제안 밖에서 일어난 돈 관련 사건(예: 예약 취소)을 같은 감사 파일에 남긴다 */
  auditExternal: (event, payload) => audit(event, payload),
  cancelLiveOrder,
  reconcile,
  checkAccountLimits,
  SINGLE_POSITION_MAX_PCT, MAX_POSITIONS,
  onSettled,
  attachNotice,
  _restoreForTest: restore,
  _persistForTest: persist,
  onProposed,
  approve,
  reject,
  execute,
  list,
  status,
  AUDIT_FILE,
  /**
   * 🔴 **버퍼 비율은 한 벌이어야 한다** (2026-10-01) — `analystService` 가 "매수 여력이
   *    남는가" 를 미리 판정하려면 이 값이 필요한데, 거기서 `process.env` 를 다시 읽으면
   *    **상수가 복제**된다. 그러면 누가 `CASH_FLOOR_PCT` 를 바꿔도 그 판정만 옛 값을 보고
   *    "살 수 있다" 고 거짓말한다(이 저장소가 적어 둔 *"가드가 검사하는 값이 실제로 쓰이는
   *    값인지"* 그 실패 모드). ⇒ 게이트를 **실제로 거는 쪽**이 값을 공개한다.
   */
  CASH_FLOOR_PCT,
  _resetForTest,
};

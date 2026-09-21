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
const AUDIT_FILE = path.join(DATA_DIR, 'orders-audit.jsonl');

/** 🔴 기본 꺼짐. **없어도 꺼짐**이다 — 미설정이 켜짐이 되면 안 된다 */
const ORDERS_ENABLED = String(process.env.ORDERS_ENABLED || '').trim().toLowerCase() === 'true';
/** 실행을 실제 API 로 보낼지. ORDERS_ENABLED 와 **둘 다** 켜져야 한다(두 겹) */
const ORDERS_LIVE = String(process.env.ORDERS_LIVE || '').trim().toLowerCase() === 'true';

const PROPOSAL_TTL_MS = Math.max(30_000, Number(process.env.ORDER_PROPOSAL_TTL_MS) || 5 * 60_000);
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

/** id → proposal. 메모리에만 둔다 — 재기동하면 사라지는 게 맞다(옛 시세의 제안은 위험하다) */
const proposals = new Map();

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
function propose(input = {}, { source = 'manual' } = {}) {
  const symbol = String(input.symbol || '').trim().toUpperCase();
  const side = String(input.side || '').trim().toUpperCase();
  const type = String(input.type || 'LIMIT').trim().toUpperCase();
  const quantity = num(input.quantity);
  const price = type === 'MARKET' ? null : num(input.price);

  const missing = [];
  if (!symbol) missing.push('symbol');
  if (!SIDES.has(side)) missing.push('side(BUY|SELL)');
  if (!TYPES.has(type)) missing.push('type(LIMIT|MARKET)');
  if (!(quantity > 0)) missing.push('quantity>0');
  // ⚠️ 지정가인데 가격이 없으면 **거부한다.** 사람이 승인 화면에서 채우게 하면
  //    그 화면이 곧 주문 화면이 되고, "승인" 의 의미가 사라진다
  if (type === 'LIMIT' && !(price > 0)) missing.push('price>0 (지정가)');

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
    reason: String(input.reason || '').slice(0, 500),
    source,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PROPOSAL_TTL_MS).toISOString(),
    status: 'PENDING',
    approvedAt: null,
    executedAt: null,
    result: null,
  };
  proposals.set(proposal.id, proposal);
  audit('proposed', { id: proposal.id, symbol, side, type, quantity, price, source });
  /**
   * 🔴 제안이 생기면 **밖으로 알린다**(텔레그램 승인 버튼).
   * ⚠️ 여기서 `require` 를 위로 올리면 **순환 참조**가 된다
   *    (alertService → telegramBot → orderService). 그래서 부를 때 가져온다.
   * ⚠️ 알림이 실패해도 **제안은 이미 만들어졌다** — 삼켜서 제안을 되돌리지 않는다.
   */
  for (const fn of listeners) {
    try {
      Promise.resolve(fn(proposal)).catch((e) => logWarn('orders.notify_failed', { message: e.message }));
    } catch (e) {
      logWarn('orders.notify_failed', { message: e.message });
    }
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
    audit('expired', { id, symbol: p.symbol });
    return { ok: false, error: '제안이 만료되었습니다. 시세가 움직였으니 다시 산출하세요.' };
  }
  p.status = 'APPROVED';
  p.approvedAt = new Date().toISOString();
  audit('approved', { id, symbol: p.symbol, side: p.side, quantity: p.quantity, price: p.price });
  return { ok: true, proposal: p };
}

function reject(id, reason = '') {
  const p = proposals.get(id);
  if (!p) return { ok: false, error: '제안을 찾을 수 없습니다.' };
  p.status = 'REJECTED';
  audit('rejected', { id, symbol: p.symbol, reason: String(reason).slice(0, 200) });
  return { ok: true, proposal: p };
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
    audit('execute_blocked', { id, reason: 'expired' });
    return { ok: false, error: '승인 후 만료되었습니다. 다시 산출하세요.' };
  }

  if (!ORDERS_ENABLED || !ORDERS_LIVE) {
    p.status = 'DRY_RUN';
    p.executedAt = new Date().toISOString();
    p.result = {
      mode: 'dry-run',
      note: ORDERS_ENABLED
        ? 'ORDERS_LIVE 가 꺼져 있어 실제로 보내지 않았습니다.'
        : 'ORDERS_ENABLED 가 꺼져 있어 실제로 보내지 않았습니다.',
    };
    audit('dry_run', { id, symbol: p.symbol, side: p.side, quantity: p.quantity, price: p.price });
    return { ok: true, proposal: p, dryRun: true };
  }

  // ── 여기부터는 **실거래**다. 아직 연결하지 않는다 ────────────────
  // 🔴 연결하는 그 커밋이 이 프로젝트에서 가장 위험한 한 줄이다.
  //    붙일 때 지켜야 할 것:
  //      · 전송 후 타임아웃이면 **재시도 금지** — `GET /api/v1/orders` 로 **조회해 확정**한다
  //        ("실패" 와 "모름" 은 다르다. 모르는 채 재시도하면 두 번 산다)
  //      · idempotencyKey 를 토스가 받는지 확인(스펙에서 아직 못 봤다). 안 받으면
  //        전송 직전/직후 조회로 중복을 막는다
  //      · 첫 실주문은 **소액 1주 · 사람이 직접 · 1회**
  p.status = 'BLOCKED';
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
    pending: [...proposals.values()].filter((p) => p.status === 'PENDING').length,
  };
}

function _resetForTest() {
  proposals.clear();
  listeners.length = 0;
}

module.exports = {
  propose,
  onProposed,
  approve,
  reject,
  execute,
  list,
  status,
  AUDIT_FILE,
  _resetForTest,
};

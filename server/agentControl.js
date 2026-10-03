/**
 * 🛑 에이전트 운용 제어 — 일시정지 · 비상정지 (2026-10-03 와이어프레임 D-4)
 *
 * 와이어프레임 원문: *"정지 범위를 고르세요. 정지 중에는 어떤 자동 주문도 나가지 않습니다."*
 * 자율 트레이딩의 **첫 번째 안전장치**다 — 자율 수준을 올리기 전에 내리는 길부터 만든다.
 *
 * ## 정지 범위 3단 (와이어프레임 그대로)
 * ```
 * halt_new      신규 주문만 중단 — 보유·미체결은 그대로
 * halt_cancel   미체결 취소 + 중단
 * halt_flatten  전 포지션 시장가 청산 + 중단   ⚠️ 이번 판엔 "요청 기록" 까지만 —
 *                                              청산 주문 자동 발사는 자율 2단계 전까지 막아 둔다
 * ```
 * 🔴 **정지는 즉시, 재개는 사람만.** 코드가 스스로 재개하는 경로는 만들지 않는다 —
 *    "다음 거래일 자동 재개" 옵션은 와이어프레임에 있지만, 그것도 **정지 시점에 사람이
 *    고른 것**이라 허용한다(사람의 사전 결정이지 코드의 재량이 아니다).
 *
 * ## 설계
 * - 상태는 **파일로 영속**한다 — 재기동이 정지를 풀면 안전장치가 아니다.
 * - 소비자는 둘: `orderService.propose`(생성 차단) · `alertService`/자동 트리거(분석 자체는
 *   돌아도 되지만 제안이 안 나간다 — 분석까지 멈추면 "왜 조용하지" 가 된다).
 * - 🔴 **차단은 조용하면 안 된다** — 차단된 제안은 로그 + 활동 기록에 남는다.
 */
const fs = require('node:fs');
const path = require('node:path');
const { logInfo, logWarn } = require('./logger');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'agent-control.json');

const SCOPES = new Set(['halt_new', 'halt_cancel', 'halt_flatten']);

let state = load();

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (d && typeof d === 'object') return d;
  } catch { /* 첫 기동 또는 파손 — 기본값(운용 중) */ }
  return { paused: false, scope: null, reason: null, at: null, resumeAt: null, by: null };
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    // 🔴 정지 상태를 디스크에 못 남기면 **재기동이 정지를 푼다** — 조용히 넘기지 않는다
    logWarn('agent.control_persist_failed', { message: e.message });
  }
}

/** 예약된 자동 재개 시각이 지났으면 상태에 반영한다 — 읽는 쪽이 항상 이걸 통해 본다 */
function effective() {
  if (state.paused && state.resumeAt && Date.now() >= Date.parse(state.resumeAt)) {
    // ⚠️ 사람이 정지 시점에 고른 예약이다 — 코드 재량의 재개가 아니다 (상단 주석)
    logInfo('agent.auto_resumed', { scheduledAt: state.resumeAt, pausedAt: state.at });
    state = { paused: false, scope: null, reason: null, at: null, resumeAt: null, by: null };
    persist();
  }
  return { ...state };
}

function pause({ scope = 'halt_new', reason = '', resumeNextDay = false, by = 'web' } = {}) {
  if (!SCOPES.has(scope)) return { ok: false, error: `scope 는 ${[...SCOPES].join('|')} 중 하나여야 합니다.` };
  let resumeAt = null;
  if (resumeNextDay) {
    // 다음 거래일 09:00 KST 근사 — 주말이면 월요일. 휴장일은 그날 사람이 보면 된다(안전한 쪽).
    const d = new Date(Date.now() + 24 * 3600_000);
    while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    resumeAt = d.toISOString();
  }
  state = { paused: true, scope, reason: String(reason).slice(0, 200), at: new Date().toISOString(), resumeAt, by };
  persist();
  logWarn('agent.paused', { scope, reason: state.reason, resumeAt, by });
  return { ok: true, state: effective() };
}

function resume({ by = 'web' } = {}) {
  const was = { ...state };
  state = { paused: false, scope: null, reason: null, at: null, resumeAt: null, by: null };
  persist();
  logInfo('agent.resumed', { by, wasScope: was.scope, pausedAt: was.at });
  return { ok: true, state: effective() };
}

/**
 * 제안 생성 직전에 부른다. 🔴 차단이면 **이유를 돌려준다** — 호출자가 로그·화면에 적는다.
 * ⚠️ 매도 제안도 막는다(halt_new 포함) — "신규" 는 **에이전트발 모든 신규 제안**이다.
 *    보유 정리는 사람이 화면·토스 앱에서 직접 한다(정지 중 에이전트는 손을 뗀다).
 */
function gateProposal() {
  const s = effective();
  if (!s.paused) return { allowed: true };
  return { allowed: false, why: `에이전트 정지 중 (${s.scope} · ${s.at?.slice(0, 16)})${s.reason ? ` — ${s.reason}` : ''}` };
}

module.exports = { effective, pause, resume, gateProposal, SCOPES, _STATE_FILE: STATE_FILE };

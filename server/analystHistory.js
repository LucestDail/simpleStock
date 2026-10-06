/**
 * 📜 분석 보고서 이력 (2026-10-04 — 승인 대기 메뉴 재편의 데이터 축)
 *
 * 사용자: *"지금까지 나왔던 AI 애널리스트 보고 및 매수/매도 제안 관련 보고서 취합해서
 * 이력관리가 되어야 해."* — 종전에는 `analyst-last.json`(마지막 1건)뿐이라 보고서가
 * 다음 분석에 **덮여 사라졌다.**
 *
 * ## 설계
 * - JSONL append-only (감사·스냅샷과 같은 규율 — 이력은 "일어난 일의 목록"이다).
 * - 목록 API 는 **메타만** 돌려준다(보고서 전문 13k자 × 수백 건을 매번 보내면 화면이 느려진다).
 * - 16MB 넘으면 한 세대만 민다(AuditStore 와 같은 수 — 지우지 않고 .1 로).
 * - 🔴 제안 연결은 저장 시점의 `created`(등록된 제안 id)로 — 시각 근접 매칭은 안 한다
 *   (추정 매칭은 다른 보고서의 제안을 끌어온다).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { logInfo, logWarn } = require('./logger');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'analyst-history.jsonl');
const MAX_BYTES = 16 * 1024 * 1024;

function record(entry) {
  try {
    const row = {
      id: crypto.randomUUID(),
      at: entry.at || new Date().toISOString(),
      trigger: entry.trigger ?? null,
      // 🔍 점검(dryRun) 회차 표식 (2026-10-06) — 실전과 구분해 그려야 한다.
      //    true 일 때만 싣는다(기존 행과 모양을 안 바꾼다 — 없으면 실전).
      ...(entry.dryRun === true || entry.report?.dryRun === true ? { dryRun: true } : {}),
      report: entry.report ?? null,
      // 제안 연결 — id·방향·심볼만(상태는 조회 시점에 orders 쪽이 정본)
      proposals: (entry.created || []).map((c) => ({
        id: c.id || null, symbol: c.symbol || null, side: c.side || null,
        quantity: c.quantity ?? null, price: c.price ?? null,
      })),
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      if (fs.statSync(FILE).size > MAX_BYTES) {
        fs.renameSync(FILE, `${FILE}.1`);
        logInfo('analyst.history_rotated', {});
      }
    } catch { /* 파일 없음 — 첫 기록 */ }
    fs.appendFileSync(FILE, `${JSON.stringify(row)}\n`);
    return row.id;
  } catch (e) {
    logWarn('analyst.history_write_failed', { message: e.message });
    return null;
  }
}

function readAll() {
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/**
 * 목록 — 메타만. 최신이 앞.
 * 🔄 2026-10-04 2차: 이력 체계 신설(오늘) **이전의 분석**은 전문이 없고 활동 기록에
 *    한 줄 요약만 남아 있다 — 사용자: "과거 이력도 하나도 없고?" ⇒ 그 요약들을
 *    `kind:'summary'` 행으로 합류시킨다(전문 행은 `kind:'full'`). 비슷한 시각(±2분)에
 *    전문 행이 있으면 요약 행은 접는다(같은 분석이다).
 */
function list({ limit = 100 } = {}) {
  const full = readAll().reverse().map((r) => ({
    kind: 'full',
    id: r.id, at: r.at,
    // 점검 회차 표식 보존 — get() 은 행을 통째로 주니 자동이지만, 목록은 재조립이라 명시해야 나간다
    dryRun: r.dryRun === true,
    trigger: r.trigger?.why || r.trigger?.kind || (typeof r.trigger === 'string' ? r.trigger : null),
    marketView: String(r.report?.marketView || '').slice(0, 140),
    positions: Array.isArray(r.report?.positions) ? r.report.positions.length : 0,
    proposals: (r.proposals || []).map((p) => ({ id: p.id, symbol: p.symbol, side: p.side })),
    /**
     * 📒 AI 예산 판단 (2026-10-06) — 목록에서 "어느 회차가 예산 판단을 냈나" 를 보려면
     *    여기 **명시해야 나간다.** `get()` 은 행을 통째로 주니 자동인데 목록은 재조립이다
     *    (바로 위 `dryRun` 과 같은 자리·같은 이유). 화면이 이 필드를 이미 읽고 있어서
     *    여기 한 줄이 없으면 **코드는 다 있는데 칩만 영영 안 뜬다** —
     *    "등록됐다 ≠ 도달한다" 가족이고, 실제로 그 상태로 한 번 완성 보고가 났다.
     */
    budgetDecision: r.report?.budgetDecision ?? null,
  }));
  let summaries = [];
  try {
    summaries = (require('./activityLog').list({ limit: 500 }) || [])
      .filter((a) => a.kind === 'analysis')
      .filter((a) => !full.some((f) => Math.abs(Date.parse(f.at) - Date.parse(a.at)) < 2 * 60_000))
      .map((a) => ({
        kind: 'summary', id: null, at: a.at, trigger: null,
        marketView: String(a.title || '').slice(0, 140),
        positions: a.positions ?? null, proposals: [],
      }));
  } catch { /* 활동 기록을 못 읽어도 전문 이력은 나간다 */ }
  return [...full, ...summaries]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
}

function get(id) {
  return readAll().find((r) => r.id === id) || null;
}

module.exports = { record, list, get, _FILE: FILE };

const fs = require('node:fs');
const path = require('node:path');
const { logWarn, logError } = require('./logger');

/**
 * 활동 타임라인 (2026-09-21)
 *
 * 사용자: *"자동 텔레그램 알림과 애널리스트의 **모든 분석 기록들이 시간순**으로 나와야 하는데."*
 *
 * ## 왜 따로 두나
 *
 * 지금까지 이 앱의 "일어난 일" 은 **세 곳에 흩어져** 있었다:
 * ```
 * 애널리스트 리포트  화면 메모리에만 — 새로고침하면 사라진다
 * 텔레그램 알림      로그 파일에만 — 사람이 못 본다
 * 제안 승인/거절     orders-audit.jsonl — 감사용이라 읽기 어렵다
 * ```
 * ⇒ 사람이 보는 **하나의 시간축**이 필요하다. 이 파일이 그것이다.
 *
 * ## 🔴 이어붙이기만 한다
 *
 * **'현재 상태' 가 아니라 '일어난 일의 목록'** 이다(Probius `AuditStore` 와 같은 이유).
 * 통째로 다시 쓰면 동시 쓰기에 한쪽이 사라진다.
 * ⚠️ 다만 **감사 기록은 아니다** — 대화 초기화처럼 사람이 지울 수 있고, 상한을 두고 민다.
 *    지우면 안 되는 것은 `orders-audit.jsonl` 이고 그건 **여기서 안 건드린다.**
 */

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = process.env.ACTIVITY_FILE || path.join(DATA_DIR, 'activity.jsonl');
/** 파일이 이만큼 넘으면 한 세대만 민다(무한히 자라지 않게) */
const MAX_BYTES = Math.max(256 * 1024, Number(process.env.ACTIVITY_MAX_BYTES) || 4 * 1024 * 1024);

/**
 * @param {string} kind  analysis | alert | proposal | approval | rejection | order
 * @param {string} title 한 줄 요약(화면에 그대로 뜬다)
 * @param {object} [meta] 숫자·식별자 등 부가 정보
 */
function record(kind, title, meta = {}) {
  const row = { at: new Date().toISOString(), kind, title: String(title).slice(0, 400), ...meta };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, `${JSON.stringify(row)}\n`);
    rotateIfBig();
  } catch (e) {
    // 기록 실패가 흐름을 멈추지는 않지만 **조용하지도 않다**
    logError('activity.append_failed', e, { kind });
  }
  return row;
}

function rotateIfBig() {
  try {
    if (!fs.existsSync(FILE)) return;
    if (fs.statSync(FILE).size <= MAX_BYTES) return;
    // ⚠️ 한 세대만 민다 — 여러 세대를 쌓으면 디스크를 조용히 먹는다
    fs.renameSync(FILE, `${FILE}.1`);
    logWarn('activity.rotated', { file: FILE });
  } catch (e) {
    logWarn('activity.rotate_failed', { message: e.message });
  }
}

/**
 * 최근 것부터 돌려준다.
 * 🔴 파일이 없으면 **빈 배열**이다 — 그건 "아직 아무 일도 없었다" 이지 오류가 아니다.
 */
function list({ limit = 100, kinds = null } = {}) {
  try {
    if (!fs.existsSync(FILE)) return [];
    const lines = fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean);
    const rows = [];
    // 뒤에서부터 읽는다 — 최근 것이 필요하고 파일 전체를 파싱할 이유가 없다
    for (let i = lines.length - 1; i >= 0 && rows.length < limit; i -= 1) {
      try {
        const r = JSON.parse(lines[i]);
        if (kinds && !kinds.includes(r.kind)) continue;
        rows.push(r);
      } catch {
        // 깨진 줄 하나가 전체를 막지 않는다
      }
    }
    return rows;
  } catch (e) {
    logWarn('activity.read_failed', { message: e.message });
    return [];
  }
}

function clear() {
  try {
    const had = fs.existsSync(FILE);
    if (had) fs.rmSync(FILE);
    return { ok: true, cleared: had };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { record, list, clear, FILE };

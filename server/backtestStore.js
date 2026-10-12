/**
 * 백테스트 회차 저장소 (2026-10-12 신설)
 *
 * ## 왜 생겼나
 *
 * `backtestRunner` 는 결과를 **`backtest-last.json` 한 개**에만 썼다. 다음 회차가 돌면
 * **앞 회차가 덮인다** — 전략 둘을 비교하려면 둘을 나란히 놓아야 하는데 그럴 수가 없었다.
 *
 * 🔴 **더 중요한 이유: 자를 고치면 옛 회차를 다시 채점할 수 있어야 한다.**
 *    Probius 에서 회차 원자료를 안 남겨 **소급 채점이 영영 불가능**해진 적이 있다.
 *    그래서 여기는 요약만이 아니라 **실행 당시의 입력(시나리오·유니버스·설정)** 까지 담는다.
 *
 * ## 설계에서 갈린 지점
 *
 * - **JSONL 이 아니라 회차당 한 파일** — 회차 하나가 수백 KB(자산 곡선·거래 로그)라
 *   한 파일에 이어 붙이면 목록을 읽을 때마다 전부를 파싱하게 된다.
 *   목록용 **요약 색인**(`index.json`)을 따로 둔다.
 * - **덮어쓰지 않는다** — 같은 id 가 이미 있으면 **쓰지 않고 멈춘다**.
 *   한 번 덮어쓰기를 허용하면 *"v3 를 보고 판단했다"* 가 무의미해진다(Probius 팩과 같은 규율).
 * - **보관 상한은 개수로** — 디스크가 아니라 **읽을 수 있는 양**이 한계다. 기본 50회차.
 */
const fs = require('fs');
const path = require('path');
const { logInfo, logWarn } = require('./logger');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const RUN_DIR = path.join(DATA_DIR, 'backtest-runs');
const INDEX_FILE = path.join(RUN_DIR, 'index.json');
const KEEP = Math.max(5, Number(process.env.BACKTEST_KEEP_RUNS) || 50);

function ensureDir() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
}

function readIndex() {
  try {
    const rows = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    if (e.code !== 'ENOENT') logWarn('backtest.index_unreadable', { message: e.message });
    return [];
  }
}

function writeIndex(rows) {
  const tmp = `${INDEX_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 1));
  fs.renameSync(tmp, INDEX_FILE);
}

/** 회차 id — 시각 기반이라 파일 이름만 봐도 순서를 안다 */
function makeId(at) {
  return String(at || new Date().toISOString()).replace(/[:.]/g, '-');
}

/**
 * 회차 하나를 저장한다.
 * @returns {{ok: boolean, id?: string, created?: boolean, error?: string}}
 */
function save(result, { scenario = '', onlyScenarios = [], label = '' } = {}) {
  try {
    ensureDir();
    const at = result?.at || new Date().toISOString();
    const id = makeId(at);
    const file = path.join(RUN_DIR, `${id}.json`);

    // 🔴 덮어쓰지 않는다 — 같은 id 가 있으면 그 회차는 이미 확정된 사실이다
    if (fs.existsSync(file)) {
      logWarn('backtest.run_exists', { id });
      return { ok: true, id, created: false };
    }

    const row = {
      id,
      at,
      scenario: String(scenario || result?.scenario || ''),
      onlyScenarios: Array.isArray(onlyScenarios) ? onlyScenarios : [],
      label: String(label || ''),
      ok: Boolean(result?.ok),
      final: result?.final ?? null,
      bench: result?.bench ?? null,
      exitCode: result?.exitCode ?? null,
    };

    fs.writeFileSync(file, JSON.stringify({ ...row, result }, null, 1));

    const rows = [row, ...readIndex().filter((r) => r.id !== id)].slice(0, KEEP);
    writeIndex(rows);

    // 색인에서 밀려난 회차의 파일도 지운다 — 안 지우면 디스크만 쌓이고 아무도 못 읽는다
    const keep = new Set(rows.map((r) => r.id));
    for (const f of fs.readdirSync(RUN_DIR)) {
      if (f === 'index.json' || f.endsWith('.tmp')) continue;
      if (!keep.has(f.replace(/\.json$/, ''))) {
        try { fs.unlinkSync(path.join(RUN_DIR, f)); } catch { /* 지워져 있으면 그만 */ }
      }
    }

    logInfo('backtest.run_saved', { id, scenario: row.scenario, final: row.final, kept: rows.length });
    return { ok: true, id, created: true };
  } catch (e) {
    logWarn('backtest.save_failed', { message: e.message });
    return { ok: false, error: e.message };
  }
}

/** 목록(요약만) — 최신순 */
function list({ limit = 30 } = {}) {
  return readIndex().slice(0, Math.max(1, Math.min(200, Number(limit) || 30)));
}

/** 회차 하나 전문 */
function get(id) {
  const safe = String(id || '');
  // 🔴 경로를 이어붙이지 않는다 — 허용 문자만. `../` 가 들어오면 데이터 디렉토리 밖이 열린다
  if (!/^[A-Za-z0-9_-]+$/.test(safe)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(RUN_DIR, `${safe}.json`), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') logWarn('backtest.run_unreadable', { id: safe, message: e.message });
    return null;
  }
}

module.exports = { save, list, get, RUN_DIR, KEEP };

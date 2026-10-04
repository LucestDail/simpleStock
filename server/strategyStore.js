/**
 * 🧪 전략 연구소 저장소 (2026-10-04)
 *
 * 세 가지를 맡는다:
 *  ① 플레이북 열람·수정 — `config/playbook.json` 이 정본. 수정은 **검증 후 원자적 쓰기 + 백업**
 *     (화면 편집기를 미루던 이유가 "검증 없이 라이브가 바뀐다" 였다 — 검증을 넣고 연다).
 *  ② 승급 전략 — 백테스트가 좋았던 시나리오 조합을 `data/promoted-strategies.json` 에 보존.
 *  ③ RAG — 승급 전략을 애널리스트 프롬프트 절로 변환(매수/매도 시나리오의 일부로).
 */
const fs = require('node:fs');
const path = require('node:path');
const { logInfo, logWarn } = require('./logger');

const ROOT = path.join(__dirname, '..');
const PLAYBOOK = path.join(ROOT, 'config', 'playbook.json');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PROMOTED = path.join(DATA_DIR, 'promoted-strategies.json');

function readPlaybook() {
  return JSON.parse(fs.readFileSync(PLAYBOOK, 'utf8'));
}

/** 시나리오 한 건 수정 — 🔴 구조 검증이 먼저다(틀린 JSON 이 라이브 판정을 바꾼다) */
function updateScenario(id, patch) {
  const allowed = new Set(['name', 'steps', 'categories', 'modelPortfolio', 'match']);
  const bad = Object.keys(patch || {}).filter((k) => !allowed.has(k));
  if (bad.length) return { ok: false, error: `수정 불가 필드: ${bad.join(', ')}` };
  if (patch.steps && (!Array.isArray(patch.steps) || !patch.steps.every((x) => typeof x === 'string'))) {
    return { ok: false, error: 'steps 는 문자열 배열이어야 합니다.' };
  }
  if (patch.categories && (!Array.isArray(patch.categories) || !patch.categories.every((x) => typeof x === 'string'))) {
    return { ok: false, error: 'categories 는 문자열 배열이어야 합니다.' };
  }
  if (patch.match && (typeof patch.match !== 'object' || Array.isArray(patch.match))) {
    return { ok: false, error: 'match 는 객체여야 합니다.' };
  }
  const pb = readPlaybook();
  const idx = (pb.scenarios || []).findIndex((s) => s.id === id);
  if (idx < 0) return { ok: false, error: `시나리오 없음: ${id}` };
  // 백업 — 편집 전 원본을 남긴다(사람 실수의 롤백망)
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.mkdirSync(path.join(ROOT, 'config', 'backups'), { recursive: true });
    fs.copyFileSync(PLAYBOOK, path.join(ROOT, 'config', 'backups', `playbook-${stamp}.json`));
  } catch (e) { logWarn('strategy.backup_failed', { message: e.message }); }
  pb.scenarios[idx] = { ...pb.scenarios[idx], ...patch, _editedAt: new Date().toISOString(), _editedVia: 'web' };
  const tmp = `${PLAYBOOK}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pb, null, 2));
  // 🔴 쓰기 전 재파싱 — 조립이 깨졌으면 정본을 건드리지 않는다
  JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.renameSync(tmp, PLAYBOOK);
  logInfo('strategy.scenario_updated', { id, fields: Object.keys(patch) });
  return { ok: true, scenario: pb.scenarios[idx] };
}

function readPromoted() {
  try { return JSON.parse(fs.readFileSync(PROMOTED, 'utf8')); } catch { return []; }
}

/** 승급 — 백테스트 근거(결과 스냅샷)를 반드시 함께 보존한다(근거 없는 승급은 장식이다) */
function promote({ name, scenarioIds = [], backtest = null, note = '' } = {}) {
  if (!name || !Array.isArray(scenarioIds) || !scenarioIds.length) {
    return { ok: false, error: 'name 과 scenarioIds 가 필요합니다.' };
  }
  if (!backtest || backtest.final == null || backtest.bench == null) {
    return { ok: false, error: '백테스트 결과 없이 승급할 수 없습니다 — 먼저 조합 백테스트를 돌리세요.' };
  }
  const rows = readPromoted();
  const row = {
    id: require('node:crypto').randomUUID(),
    at: new Date().toISOString(),
    name: String(name).slice(0, 80),
    scenarioIds,
    backtest: { scenario: backtest.scenario, final: backtest.final, bench: backtest.bench, finishedAt: backtest.finishedAt },
    note: String(note).slice(0, 300),
    active: true,
  };
  rows.push(row);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${PROMOTED}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, PROMOTED);
  logInfo('strategy.promoted', { id: row.id, name: row.name, scenarios: scenarioIds.length });
  return { ok: true, row };
}

function setActive(id, active) {
  const rows = readPromoted();
  const row = rows.find((r) => r.id === id);
  if (!row) return { ok: false, error: '없음' };
  row.active = Boolean(active);
  const tmp = `${PROMOTED}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, PROMOTED);
  return { ok: true, row };
}

/** 애널리스트 RAG 절 — 활성 승급 전략만 */
function promptSection() {
  const act = readPromoted().filter((r) => r.active);
  if (!act.length) return '';
  const lines = ['## 승급 전략 (전략 연구소에서 백테스트로 검증·승급된 조합 — 판단의 참고 축)'];
  for (const r of act) {
    const edge = r.backtest ? ` (백테스트 ${r.backtest.scenario}: $10k→$${Math.round(r.backtest.final)} vs 벤치 $${Math.round(r.backtest.bench)})` : '';
    lines.push(`- ${r.name}: 시나리오 [${r.scenarioIds.join(', ')}]${edge}${r.note ? ` — ${r.note}` : ''}`);
  }
  return lines.join('\n');
}

module.exports = { readPlaybook, updateScenario, readPromoted, promote, setActive, promptSection, _PROMOTED: PROMOTED };

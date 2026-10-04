/**
 * 🧪 백테스트 러너 (2026-10-04 — D-9 전략 연구소)
 *
 * `verify/backtest.js` 는 **제품과 같은 판정**(decideOnContext · 같은 SYSTEM_PROMPT·스키마)
 * 으로 합성 시나리오를 태우는 CLI 다. 웹에서 쓸 수 있게 감싼다.
 *
 * 🔴 **LLM 을 실제로 태운다** — 회당 수 분 + 토큰. 그래서:
 *   - 동시 **1개** (두 번째 요청은 409 — 큐를 만들면 몰래 쌓인다)
 *   - 결과는 파일로 영속(`data/backtest-last.json`) — 재기동해도 마지막 결과가 남는다
 *   - UI 가 "실행 중" 을 보여줄 수 있게 상태를 노출
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { logInfo, logWarn } = require('./logger');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
/**
 * SIGKILL 상한 — ⚠️ 안쪽(LLM 콜 180초 × 최대 6콜 = 18분)보다 **넉넉해야** 한다.
 * 역전되면 안쪽이 실패를 곱게 감싸는 경로를 건너뛰고 통째로 죽는다(타임아웃 역전 가족).
 * 관계는 tests/backtestRunner.test.js 가 잠근다.
 */
const KILL_MS = 20 * 60_000;
const LAST_FILE = path.join(DATA_DIR, 'backtest-last.json');
const SCENARIOS = ['vshape', 'bull', 'bear', 'chop'];

let running = null;   // { scenario, startedAt, pid }

function status() {
  let last = null;
  try { last = JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')); } catch { /* 없음 */ }
  return { running: running ? { ...running } : null, last, scenarios: SCENARIOS };
}

function run(scenario) {
  if (!SCENARIOS.includes(scenario)) return { ok: false, error: `scenario 는 ${SCENARIOS.join('|')} 중 하나` };
  if (running) return { ok: false, error: `이미 실행 중 (${running.scenario} · ${running.startedAt})`, kind: 'busy' };

  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, [path.join(ROOT, 'verify', 'backtest.js'), '--scenario', scenario], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  running = { scenario, startedAt, pid: child.pid };
  logInfo('backtest.started', { scenario, pid: child.pid });

  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  // 🔴 상한 — LLM 이 멈추면 러너가 영원히 "실행 중" 이 된다(무응답이 제일 위험하다)
  const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 이미 죽음 */ } }, KILL_MS);

  child.on('close', (code) => {
    clearTimeout(killer);
    running = null;
    // SUMMARY 줄 파싱 — 스크립트의 마지막 기계 판독 줄
    const m = /SUMMARY (\S+) floor=(\S+) final=([\d.,-]+) bench=([\d.,-]+)/.exec(out);
    const result = {
      scenario, startedAt, finishedAt: new Date().toISOString(), exitCode: code,
      ok: code === 0 && Boolean(m),
      final: m ? Number(m[3].replace(/,/g, '')) : null,
      bench: m ? Number(m[4].replace(/,/g, '')) : null,
      // ⚠️ 원문 꼬리를 남긴다 — 숫자 둘로 요약하면 "무엇을 샀는지" 를 영영 못 본다
      tail: out.split('\n').slice(-40).join('\n').slice(0, 6000),
      error: code !== 0 ? (err.slice(0, 500) || `exit ${code}`) : null,
    };
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(LAST_FILE, JSON.stringify(result, null, 2));
    } catch (e) { logWarn('backtest.persist_failed', { message: e.message }); }
    logInfo('backtest.finished', { scenario, exitCode: code, ok: result.ok, final: result.final, bench: result.bench });
  });
  return { ok: true, startedAt };
}

module.exports = {
  _KILL_MS: KILL_MS, run, status, SCENARIOS };

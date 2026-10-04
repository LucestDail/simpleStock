/** 🧪 백테스트 러너 (2026-10-04 D-9) — LLM 을 태우는 작업이라 동시 1개가 생명 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
for (const k of Object.keys(require.cache)) if (/backtestRunner/.test(k)) delete require.cache[k];
const bt = require('../server/backtestRunner');

test('모르는 시나리오는 거부 — 조용히 기본값으로 바꾸지 않는다', () => {
  const r = bt.run('moonshot');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /vshape\|bull\|bear\|chop/);
});

test('🔴 동시 1개 — 두 번째는 busy (큐를 만들면 LLM 토큰이 몰래 쌓인다)', () => {
  // ⚠️ 실제 spawn 이 일어난다 — 자식은 LLM 설정이 없으면 빨리 죽지만 running 플래그는 그 순간 선다
  const r1 = bt.run('chop');
  assert.ok(r1.ok, `첫 실행이 거부됐다: ${r1.error}`);
  const r2 = bt.run('bull');
  assert.strictEqual(r2.kind, 'busy', '동시 2개가 허용되면 토큰이 두 배로 탄다');
});

test('상태에 시나리오 목록이 실린다 (화면이 하드코딩하지 않게)', () => {
  const st = bt.status();
  assert.deepStrictEqual(st.scenarios, ['vshape', 'bull', 'bear', 'chop']);
  assert.ok(st.running === null || typeof st.running === 'object');
});

test('🔴 verify/backtest.js 의 require 가 상대 경로다 — 절대경로는 도커 밖에서 조용히 죽는다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'verify', 'backtest.js'), 'utf8');
  assert.ok(!src.includes("require('/app/"), '도커 전용 절대경로가 남아 있다');
  assert.match(src, /path\.join\(__dirname/, '상대 경로 require 가 없다');
});

test('🔴 타임아웃 순서 — 러너 SIGKILL 이 안쪽 LLM 예산 합보다 넉넉하다', () => {
  /*
   * 2026-10-04 bear 백테스트: 기본 120초 예산의 출력 캡(2,592토큰)에 마지막 회차가
   * 정확히 잘려 2회 연속 exit 1. 예산을 180초로 넓혔는데(캡 3,888), 그 순간
   * **바깥 러너 상한(20분)과의 역전**이 새 위험이 된다 — 회차 최대 6콜 × 180초 = 18분.
   * 안쪽을 또 키우는 사람이 바깥을 같이 보도록 관계를 여기서 잠근다.
   * (한 곳에서 유도하지 못하는 이유: 러너는 자식 프로세스 경계 너머라 상수를 공유할 수 없다)
   */
  const { _KILL_MS } = require('../server/backtestRunner');
  const { _CTX_CALL_TIMEOUT_MS } = require('../server/analystService');
  const MAX_LLM_CALLS = 6; // verify/backtest.js 헤더 주석의 상한(국면 3 × 리밸런스 2)
  assert.ok(
    _KILL_MS > MAX_LLM_CALLS * _CTX_CALL_TIMEOUT_MS,
    `역전: 러너 ${_KILL_MS / 60000}분 ≤ 안쪽 최악 ${(MAX_LLM_CALLS * _CTX_CALL_TIMEOUT_MS) / 60000}분 — 바깥 안전망이 안쪽보다 촘촘하다`
  );
});

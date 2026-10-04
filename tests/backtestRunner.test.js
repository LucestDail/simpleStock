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

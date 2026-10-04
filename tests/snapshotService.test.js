/** 📈 일일 자산 스냅샷 (2026-10-04 D-10) — 성과 리포트의 수익률 축 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
for (const k of Object.keys(require.cache)) if (/snapshotService/.test(k)) delete require.cache[k];
const snap = require('../server/snapshotService');

test('하루 1건 — 두 번째 호출은 **갱신하지 않는다** (첫 관측이 그날의 값)', () => {
  const r1 = snap.recordDaily({ totalKrw: 15_000_000, cashPct: 30, leveragePct: 70, benchmarks: { kospi: 7000, qqq: 24000 } });
  assert.ok(r1.ok && r1.row);
  const r2 = snap.recordDaily({ totalKrw: 15_500_000 });
  assert.strictEqual(r2.skipped, 'already_recorded', '장중 재호출이 그날 값을 덮으면 "그날 수익률" 의 정의가 흔들린다');
});

test('🔴 0·음수 총액은 적지 않는다 — 조회 실패가 "자산 0" 으로 역사에 박히면 수익률이 거짓', () => {
  const r = snap.recordDaily({ totalKrw: 0 });
  assert.strictEqual(r.ok, false);
});

test('⚠️ 데이터 1건이면 수익률은 null — 한 점으로 수익률을 지어내지 않는다', () => {
  const p = snap.performance();
  assert.strictEqual(p.days, 1);
  assert.strictEqual(p.returns, null);
  assert.strictEqual(p.monthly.length, 1);
});

test('🔴 수량·종목별 금액이 스냅샷에 없다 (민감 축 최소화)', () => {
  const raw = fs.readFileSync(snap._FILE, 'utf8');
  for (const bad of ['quantity', 'avgPrice', 'symbol']) {
    assert.ok(!raw.includes(bad), `스냅샷에 ${bad} 가 샜다`);
  }
});

test('날짜 키는 KST — UTC 로 적으면 프리장 함정(09-28)의 재발 자리', () => {
  // 2026-01-01T20:00Z = KST 01-02 05:00
  assert.strictEqual(snap.kstDay(new Date('2026-01-01T20:00:00Z')), '2026-01-02');
});

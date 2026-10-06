const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * dryRun 회차도 **이력에는 남는다** — 다만 last 파일(화면 정본)은 덮지 않는다 (2026-10-06)
 *
 * 종전: `if (!dryRun) saveLast(...)` 라 dryRun 이면 last 도 이력도 전부 스킵 →
 * 화면 이력에 활동 로그 summary 행만 남고 전문(full)을 영영 못 본다.
 *
 * ## 이 자가 지키는 쌍
 * 1. `historyOnly: true` → **record 는 호출되고 + last 파일은 안 덮인다** (둘 다 봐야 한다 —
 *    한쪽만 보면 "이력만 끊김" 또는 "점검이 정본을 덮음" 중 하나를 놓친다)
 * 2. 이력 행·목록(list)·단건(get) 전부에 `dryRun: true` 표식이 보존된다 — 화면이 실전과 구분한다
 * 3. 기본 호출(옵션 없음)은 종전과 같다 — last 도 쓰고 이력도 남고 dryRun 표식은 없다
 */

// 🔴 테스트 파일은 병렬로 돈다 + 이력은 DATA_DIR 를 본다 — 실제 data/ 를 건드리면 안 된다
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-dryhist-'));
process.env.ANALYST_LAST_FILE = path.join(process.env.DATA_DIR, 'analyst-last.json');
process.env.ANALYST_LAST_PROMPT_FILE = path.join(process.env.DATA_DIR, 'analyst-last-prompt.txt');
process.env.ACTIVITY_FILE = path.join(process.env.DATA_DIR, 'activity.jsonl');

const analyst = require('../server/analystService');
const history = require('../server/analystHistory');

test('🔴 historyOnly: 이력에는 남고 last 파일은 **안 덮인다** (쌍으로 확인)', () => {
  // 실전 회차가 먼저 last 를 채운다 — "안 덮였다" 를 확인하려면 덮일 대상이 있어야 한다
  analyst.saveLast({ at: '2026-10-06T01:00:00Z', marketView: '실전 정본', trigger: { why: 'manual' }, created: [] });
  const before = fs.readFileSync(process.env.ANALYST_LAST_FILE, 'utf8');
  assert.match(before, /실전 정본/);

  // 점검(dryRun) 회차 — 이력만
  analyst.saveLast(
    { at: '2026-10-06T02:00:00Z', marketView: '점검 회차', trigger: { why: 'manual' }, created: [], dryRun: true },
    { historyOnly: true }
  );

  // ① last 파일이 그대로다 — 점검이 화면 정본을 덮으면 안 된다(09-21 규율)
  const after = fs.readFileSync(process.env.ANALYST_LAST_FILE, 'utf8');
  assert.equal(after, before, '점검 회차가 last 파일(화면 정본)을 덮었다');
  assert.equal(analyst.readLast().marketView, '실전 정본');

  // ② 이력에는 **둘 다** 있다 — dryRun 이 full 로 남아야 화면이 "요약만" 으로 안 떨어진다
  const rows = history.list({ limit: 10 }).filter((r) => r.kind === 'full');
  assert.equal(rows.length, 2, `이력이 ${rows.length}건 — dryRun 회차가 빠졌거나 중복됐다`);

  // ③ 표식 보존 — 목록과 단건 모두
  const dry = rows.find((r) => /점검 회차/.test(r.marketView));
  const real = rows.find((r) => /실전 정본/.test(r.marketView));
  assert.ok(dry && real, '두 회차가 이력 목록에서 식별이 안 된다');
  assert.equal(dry.dryRun, true, '목록(list)에서 dryRun 표식이 사라졌다 — 화면이 실전과 구분 못 한다');
  assert.equal(real.dryRun, false, '실전 회차에 dryRun 표식이 붙었다');
  assert.equal(history.get(dry.id)?.dryRun, true, '단건(get)에서 dryRun 표식이 사라졌다');
  assert.ok(!history.get(real.id)?.dryRun, '단건(get)의 실전 회차에 dryRun 이 붙었다');
});

test('기본 호출(옵션 없음)은 종전과 같다 — last 도 쓰고 이력도 남는다', () => {
  analyst.saveLast({ at: '2026-10-06T03:00:00Z', marketView: '회귀 확인', trigger: { why: 'manual' }, created: [] });
  assert.equal(analyst.readLast().marketView, '회귀 확인', 'last 저장이 회귀했다');
  const row = history.list({ limit: 10 }).find((r) => /회귀 확인/.test(r.marketView));
  assert.ok(row, '이력이 안 남았다');
  assert.equal(row.dryRun, false);
});

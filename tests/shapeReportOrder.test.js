/**
 * **`holdings` 가 `positions` 를 이긴다 — 키 순서에 맡기지 않는다** (2026-10-03 실측)
 *
 * `holdings`(보유 전용)를 신설한 뒤 `analyst.duplicate_stance` 가 **회차당 3~4건** 떴다.
 * 모델이 **같은 종목을 두 배열에 모두** 넣기 때문이다. 대부분 같은 판단이라 무해한데,
 * 05:04 회차에서 **`RAM kept=HOLD dropped=SELL`** — 두 배열에 **다른 판단**을 써서
 * `dedupePositions` 가 확신도를 `LOW` 로 낮췄다.
 *
 * 🔴 그런데 **어느 쪽이 남는지가 `Object.values` 의 키 순서에 달려 있었다.**
 *    JSON 키 순서는 **모델이 정한다** — 즉 *"보유 판단이 남을지 후보 판단이 남을지"* 가
 *    **매 회차 운에 맡겨져 있었다.** 그건 재현도 안 되고 설명도 안 된다.
 */
const test = require('node:test');
const assert = require('node:assert');
const { _shapeReport: shapeReport } = require('../server/analystService');

const base = { marketView: 'v', momentumRead: 'm', dataGaps: [], proposals: [] };
const pos = (symbol, stance, rationale) =>
  ({ symbol, stance, confidence: 'HIGH', rationale, evidence: [], risk: 'r' });

test('🔴 보유 판단이 남는다 — 키 순서가 반대여도', () => {
  for (const o of [
    { ...base, positions: [pos('RAM', 'SELL', '후보쪽')], holdings: [pos('RAM', 'HOLD', '보유쪽')] },
    { ...base, holdings: [pos('RAM', 'HOLD', '보유쪽')], positions: [pos('RAM', 'SELL', '후보쪽')] },
  ]) {
    const r = shapeReport(o);
    assert.strictEqual(r.positions.length, 1);
    assert.strictEqual(r.positions[0].stance, 'HOLD', '보유 판단이 밀려났다');
    assert.match(r.positions[0].rationale, /보유쪽/);
  }
});

test('⚠️ 상반 판단은 **그대로 드러난다** — 조용히 고르지 않는다', () => {
  const r = shapeReport({ ...base, holdings: [pos('RAM', 'HOLD', 'h')], positions: [pos('RAM', 'SELL', 'p')] });
  assert.strictEqual(r.positions[0].confidence, 'LOW', '확신도를 안 낮추면 갈린 판단이 확신처럼 보인다');
  assert.match(r.positions[0].rationale, /상반된 판단/);
});

test('⚠️ holdings 가 없어도 종전대로 동작한다', () => {
  const r = shapeReport({ ...base, positions: [pos('QLD', 'BUY', 'x')] });
  assert.strictEqual(r.positions.length, 1);
  assert.strictEqual(r.positions[0].stance, 'BUY');
});

test('🔴 배선 — holdings 를 명시적으로 먼저 넣는다', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert.match(src, /const named = Array\.isArray\(o\.holdings\)/, 'holdings 우선 처리가 없다');
  assert.ok(!/const arrays = Object\.values\(o\)\.filter\(Array\.isArray\);/.test(src),
    '🔴 옛 방식(키 순서 의존)이 남아 있다');
});

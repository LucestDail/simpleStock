/**
 * **개수가 아니라 집합으로 판정한다** (2026-10-02 라이브 dryRun 실측)
 *
 * 🔴 같은 구멍이 **두 곳**에 있었다:
 * ```
 * ① positions_short 진입 조건  report.positions.length < heldSymbols.length
 *    → 보유 3종(O·QLD·RAM)인데 후보 3종(SOXX·VONG·XLV)을 내면 `3 < 3` 거짓 ⇒ 발동 안 함
 * ② 재요청 채택 조건          fixed.positions.length >= report.positions.length
 *    → `got:4 had:3` 이라 채택했는데 그 4개가 **전부 후보**, 보유는 0개
 * ```
 * 그 회차의 최종 보고서에 **보유 종목이 하나도 없었다** — 사용자가 보는 화면에
 * 자기 보유 판단이 통째로 없는 상태다.
 *
 * ★ `missing`(집합 차이)은 **어차피 바로 아래에서 계산하고 있었다.**
 *   값은 있는데 **조건이 그걸 안 봤다** — *"수집해 놓고 안 쓰는"* 의 판정판.
 *
 * ⚠️ 소스를 훑는 자다. **주석을 먼저 지운다** — 설명문에 옛 식이 남아 통과하면 장식이 된다.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function src() {
  return fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

test('🔴 positions_short 는 **집합 차이**로 발동한다 (개수 비교가 남아 있으면 안 된다)', () => {
  const s = src();
  assert.match(s, /const missing = heldSymbols\.filter\(/, 'missing 계산이 없다');
  assert.match(s, /if \(missing\.length\) \{/, '집합으로 판정하지 않는다');
  assert.ok(!/report\.positions\.length < heldSymbols\.length/.test(s),
    '🔴 옛 개수 비교가 남아 있다 — 보유가 통째로 바뀌어도 통과한다');
});

test('🔴 재요청 채택이 **잃어버린 심볼**을 본다', () => {
  const s = src();
  assert.match(s, /lostSyms/, '잃어버린 심볼 계산이 없다');
  assert.match(s, /lostSyms\.length === 0/, '채택 조건이 심볼 보존을 요구하지 않는다');
  assert.match(s, /lost_symbols/, '거부 이유가 "종목이 바뀌었다" 를 구분하지 않는다');
  // ⚠️ 개수 조건도 **함께** 남아 있어야 한다 — 하나만으로는 둘 다 못 막는다
  assert.match(s, /fixed\.positions\.length >= report\.positions\.length/, '개수 조건이 사라졌다');
});

/**
 * ⚠️ **자가 살아 있는지** — 옛 조건으로 되돌리면 반드시 빨간불이어야 한다.
 *    (변이를 영구 테스트로 둔다: 일회성 손 변이는 "안 돌았다" 를 "통과" 로 읽기 쉽다)
 */
test('🔴 판정 로직이 한 곳에 모여 있다 — 두 벌이면 갈라진다', () => {
  const s = src();
  const adopted = (s.match(/adopted: improved && keptCount/g) || []).length;
  assert.strictEqual(adopted, 1, '채택 판정이 여러 벌이다');
  const gate = (s.match(/if \(keptCount && improved\)/g) || []).length;
  assert.strictEqual(gate, 1, '게이트가 여러 벌이거나 로그와 다른 식을 쓴다');
});

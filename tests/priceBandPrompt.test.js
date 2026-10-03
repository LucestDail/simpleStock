/**
 * **종목별 가격대를 프롬프트에 못박는다** (2026-10-03 실측)
 *
 * 밤새 4회차 **전부**에서 모델이 RAM(현재가 14.3)의 레벨을 **80~95 달러**로 썼다.
 * 프롬프트를 뒤져 보니 그 숫자들이 **다른 종목 줄에 있었다**:
 * ```
 * QLD  20일선 92.75 · 60일선 90.15 · 스윙 86.96
 * XLP  80.53 / 82.62 / 84.37
 * SHY  81.045
 * ```
 * ⇒ 모델이 **종목별로 숫자를 묶어 읽지 못하고** 이웃 줄의 값을 가져온다.
 * ★ *"QLD 시나리오가 SOXX 를 말한다"*(주제 이탈)와 같은 가족인데, 이번엔
 *   **종목명 없이 숫자만** 건너와서 `findSubjectDrift` 가 못 잡았다.
 *
 * 🔴 **핵심은 프롬프트와 코드가 같은 상수를 본다는 것**이다 — 따로 두면 갈라지고,
 *    갈라지면 *"프롬프트는 ±30% 라는데 코드는 ±50% 에서 잡는"* 상태가 된다.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = () => fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf8');
const CODE = () => SRC().replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

test('🔴 프롬프트가 종목별 범위를 **코드 상수에서 유도**한다', () => {
  const c = CODE();
  assert.match(c, /## 🔴 종목별 가격대/, '가격대 절이 없다');
  // 🔴 하드코딩된 숫자가 아니라 **가드와 같은 상수**를 써야 한다
  assert.match(c, /px \* \(1 - ENTRY_GAP_MAX_PCT \/ 100\)/, '하한이 상수에서 안 나온다');
  assert.match(c, /px \* \(1 \+ ENTRY_GAP_MAX_PCT \/ 100\)/, '상한이 상수에서 안 나온다');
  // ⚠️ 상수가 **한 벌**이어야 한다 — 두 벌이면 조용히 갈라진다
  assert.strictEqual((c.match(/const ENTRY_GAP_MAX_PCT/g) || []).length, 1, '상수가 여러 벌이다');
});

test('⚠️ 현재가를 못 구한 종목은 **범위를 지어내지 않는다**', () => {
  const c = CODE();
  assert.match(c, /if \(!\(px > 0\)\) continue;/, '없는 현재가로 범위를 만들면 거짓 제약이 된다');
});

test('⚠️ 보유가 없으면 절을 **아예 안 넣는다** — 빈 표제는 소음이다', () => {
  assert.match(CODE(), /if \(band\.length\) \{/, '빈 목록에도 표제를 찍는다');
});

test('🔴 가드와 프롬프트가 **같은 기준**이라는 것이 코드로 확인된다', () => {
  const c = CODE();
  // 가드 쪽
  assert.match(c, /if \(gap > ENTRY_GAP_MAX_PCT\) \{/, '가드가 상수를 안 쓴다');
  // ★ 둘이 같은 식별자를 쓰므로 **한쪽만 바꾸는 것이 불가능하다**
  const uses = (c.match(/ENTRY_GAP_MAX_PCT/g) || []).length;
  assert.ok(uses >= 4, `상수 사용이 ${uses}곳 — 선언·가드·범위 하한/상한 넷은 돼야 한다`);
});

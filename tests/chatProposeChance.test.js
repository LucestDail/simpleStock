/**
 * **제안을 낼 기회를 뺏지 않는다** (2026-10-02 라이브로 확정)
 *
 * 사용자 *"RAM + QLD 상쇄분으로 더 현금만들고 기다려볼까"* 에 대한 답변 끝이
 * *"제가 지금 제안을 등록할 수는 없지만(**도구가 없음**)"* 이었다.
 *
 * 🔴 **그 말은 거짓이 아니었다.** 최종 답변 단계가 `[시스템] 도구 단계는 끝났다` 를
 *    명시하므로 그 시점엔 **정말로 도구가 없다.** (처음에 "거짓" 이라고 적은 내가 틀렸다.)
 * 진짜 결함은 **조회를 한 번 더 부르려다 중복에 막힌 라운드가 그대로 도구 단계를 닫은 것**:
 * ```
 * chat.round_all_duplicates round:2   → break → 최종 답변
 * ```
 * ⇒ 두 축을 **한 쌍으로** 고친다:
 *   ① 중복으로 빈 라운드면 **한 번만** 더 기회(`duplicateGraceUsed`) — 그 라운드에
 *      `propose_order` 를 부를 수 있다
 *   ② 최종 답변 지시에 *"도구가 없다고 쓰지 말고 권하는 주문을 말로 적어라"*
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = () => fs.readFileSync(path.join(__dirname, '..', 'server', 'analystChat.js'), 'utf8');
const CODE = () => SRC().replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

test('🔴 중복으로 빈 라운드에서 **즉시 break 하지 않는다**', () => {
  const c = CODE();
  assert.match(c, /duplicateGraceUsed/, '유예 플래그가 없다');
  assert.match(c, /if \(!duplicateGraceUsed\) \{/, '유예 분기가 없다');
  assert.match(c, /chat\.duplicate_grace/, '유예를 썼다는 기록이 없다 — 0건과 구분 불가');
  // ⚠️ `continue` 가 있어야 **그 라운드가 실제로 한 번 더 돈다**
  const block = c.slice(c.indexOf('if (!duplicateGraceUsed)'));
  assert.match(block.slice(0, 1200), /continue;/, '유예 뒤 continue 가 없으면 기회가 안 생긴다');
});

test('🔴 유예는 **한 번뿐**이다 — 안 그러면 중복↔기회 루프가 돈다', () => {
  const c = CODE();
  assert.match(c, /duplicateGraceUsed = true;/, '플래그를 세우지 않으면 무한히 돈다');
  const i = c.indexOf('duplicateGraceUsed = true;');
  const j = c.indexOf('continue;', i);
  assert.ok(i > 0 && j > i && j - i < 1500, '플래그 설정이 continue 보다 뒤에 있으면 무의미하다');
});

test('⚠️ 제안을 **강요하지 않는다** — 억지 제안은 사용자 폰으로 간다', () => {
  const raw = SRC();
  assert.match(raw, /제안이 필요 없으면 아무 도구도 부르지 말고/, '빠져나갈 길을 안 주면 억지로 만든다');
});

test('🔴 최종 답변에서 **"도구가 없다"를 쓰지 말라고** 못박는다', () => {
  const raw = SRC();
  assert.match(raw, /"도구가 없다"고 쓰지 말고/, '내부 사정이 사용자에게 새는 것을 안 막는다');
  assert.match(raw, /말로 적어라/, '대안(말로 권하기)을 안 주면 그냥 침묵한다');
  // ⚠️ 말로 적는 것이 **등록은 아니다** — 그 구분이 주석에 남아야 다음 사람이 안 헷갈린다
  assert.match(raw, /말로 적는 것은 \*\*제안 등록이 아니다\*\*/, '구분이 기록되지 않았다');
});

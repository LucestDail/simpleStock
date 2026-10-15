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
 *   ① 중복으로 빈 라운드면 **한 번만** 더 기회(`duplicateGraceUsed`)
 *   ② 최종 답변 지시에 *"도구가 없다고 쓰지 말고 … 말로 적어라"*
 *
 * 🔄 **2026-10-15 — 기능은 남고 이유가 바뀌었다.** ①의 원래 목적은 *"그 라운드에
 *    `propose_order` 를 부를 수 있다"* 였는데 **그 도구는 2026-10-12 에 사라졌다.**
 *    지금 유예가 지키는 것은 **조회를 한 번 더 할 기회**다 — 지우면 모델이 아무것도 못 받은 채
 *    최종 답변으로 떨어진다. ⇒ **테스트는 그대로 두고 설명만 갱신한다**(축이 살아 있다).
 *
 * 🔴 **그리고 이 파일이 저지른 것 — 주석을 문자열로 잠갔다.** 마지막 테스트가
 *    "말로 적는 것은 제안 등록이 아니다" 라는 **대상 코드의 주석 본문**을 정규식으로
 *    단언하고 있었다(⚠️원문을 그대로 옮기면 별표가 블록 주석을 닫는다 — 실제로 밟았다).
 *    그래서 제안 기능이 사라진 뒤에도 **그 주석을 고칠 수 없었고**, 낡은 기록이 굳었다
 *    (2026-10-15 에 실제로 "고치면 테스트가 깨진다" 는 이유로 방치된 것이 발견됐다).
 *    ★ **테스트는 "무엇을 지시했는가" 를 재고, 설명 문구는 잠그지 않는다** — 2026-10-14 에
 *      적은 *"문구를 박지 말고 알렸는가를 재라"* 의 같은 가족이다.
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

/**
 * 🔴 2026-10-12 — 문구의 '제안' 이 '도구' 가 됐다(제안 도구 제거).
 *    **축은 그대로다**: 빠져나갈 길을 안 주면 모델이 억지로 뭔가를 부른다.
 */
test('⚠️ 도구를 **강요하지 않는다** — 억지 호출은 비용과 소음이 된다', () => {
  const raw = SRC();
  assert.match(raw, /도구가 필요 없으면 아무 도구도 부르지 말고/, '빠져나갈 길을 안 주면 억지로 만든다');
});

test('🔴 최종 답변에서 **"도구가 없다"를 쓰지 말라고** 못박는다', () => {
  const raw = SRC();
  assert.match(raw, /"도구가 없다"고 쓰지 말고/, '내부 사정이 사용자에게 새는 것을 안 막는다');
  assert.match(raw, /말로 적어라/, '대안을 안 주면 그냥 침묵한다');
});

/**
 * 🔴 **최종 답변 지시가 주문·제안을 시키지 않는다** (2026-10-15 신설 — 위 주석 단언을 대체).
 *
 * 이 줄은 **모델이 보는 마지막 지시**라 시스템 프롬프트보다 힘이 세다. 2026-10-15 까지
 * *"제안이 필요하다고 판단되면 어떤 주문을 왜 권하는지 말로 적어라(수량·가격 포함)"* 가
 * 그대로 살아 있었다 — **주문 집행이 사라진 지 사흘 뒤였다.**
 * ★ 2026-10-14 에 분석 프롬프트에서 같은 것을 걷으며 *"쓰지 마세요는 금지가 아니다"* 를
 *   배웠는데, **채팅 경로를 안 훑어서** 같은 모양이 남아 있었다.
 */
test('🔴 최종 답변 지시에 주문·제안 어휘가 없다', () => {
  const code = CODE();
  const at = code.indexOf('[시스템] 도구 단계는 끝났다');
  assert.ok(at > 0, '최종 답변 지시를 못 찾았다 — 문구가 바뀌었으면 이 자도 함께 고친다');
  const instruction = code.slice(at, code.indexOf('}] });', at) + 6);

  // 자 생존: 이 구간을 실제로 떴는지 — 빈 문자열이면 아래 전부가 공허하게 통과한다
  assert.ok(instruction.length > 100, `지시 구간이 ${instruction.length}자 — 범위 추출이 깨졌다`);
  assert.match(instruction, /결론부터/, '엉뚱한 구간을 떴다');

  const BANNED = ['제안', '주문', '매수', '매도', '등록', '수량·가격'];
  const found = BANNED.filter((w) => instruction.includes(w));
  assert.deepStrictEqual(
    found, [],
    `최종 답변 지시가 행동 어휘를 쓴다: ${found.join(', ')}`
      + ' — 이 제품은 주문·제안을 내지 않는다(2026-10-12)',
  );
});

const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * 🔴 **폰으로 가는 답에서 소음을 걷어낸다** — 2026-10-02 사용자 지적
 *
 * > *"내 질문과 발화 의도도 지금 확인 못하고 계속 지금 도구 목록 보여주고 난리났는데"*
 *
 * 실물 두 가지가 섞여 있었다:
 * ```
 * 12:22  chat.turn chars:280 → tgbot.chat_relayed chars:339   (차이 59자)
 *        = "🔧 확인한 것: get_portfolio · get_candles · get_rankings · web_search"
 * 08:53  "(사용자의 질문 \"금리상승기에는 주식 뭘 사야하지?\"에 대한 답을 준비 중입니다.)"
 * ```
 * 앞은 **매 정상 회차마다** 붙었고, 뒤는 모델이 **자기 사고 과정**을 답에 쓴 것이다.
 * `isStubAnswer`(미완)에도 `fake`(도구 호출 흉내)에도 안 걸리는 **새 축**이다.
 */

const tg = require('../server/telegramBot');

test('🔴 첫머리 메타 서술을 걷어낸다 (08:53 실물)', () => {
  const out = tg.stripLeadingMeta(
    '(사용자의 질문 "금리상승기에는 주식 뭘 사야하지?"에 대한 답을 준비 중입니다.)\n\n'
    + '금리상승기에는 배당주가 먼저 맞습니다. 할인율 상승이 근거입니다.'
  );
  assert.ok(!out.includes('준비 중입니다'), '메타 서술이 그대로 폰에 갔다');
  assert.ok(out.startsWith('금리상승기에는'), '본문이 훼손됐다');
});

/**
 * 🔴 **오탐이 더 해롭다** — 본문 중간의 괄호는 정상적인 보충 설명이다.
 *    넓게 잡으면 멀쩡한 답을 훼손하고, 그러면 다음 사람이 이 가드를 꺼 버린다.
 */
test('🔴 오탐 축: 본문 중간 괄호는 건드리지 않는다', () => {
  const t = 'QLD(2배 레버리지)는 금리상승기에 불리합니다. 비중을 줄이는 쪽이 맞습니다.';
  assert.equal(tg.stripLeadingMeta(t), t);
});

test('오탐 축: 괄호로 시작해도 메타가 아니면 유지한다', () => {
  const t = '(참고) 아래는 요약입니다. 보유 3종에 대한 판단을 정리했습니다. 추가 질문 주세요.';
  assert.equal(tg.stripLeadingMeta(t), t);
});

/**
 * ⚠️ 괄호를 떼면 **남는 게 없을 때**는 원문을 돌려준다 —
 *    답을 통째로 지우는 것보다 메타 서술이 보이는 쪽이 낫다.
 */
test('🔴 떼면 답이 사라지는 경우는 원문을 지킨다', () => {
  const t = '(답을 준비 중입니다.)';
  assert.equal(tg.stripLeadingMeta(t), t);
});

test('빈 입력·null 에 안 터진다', () => {
  assert.equal(tg.stripLeadingMeta(''), '');
  assert.equal(tg.stripLeadingMeta(null), null);
});

/**
 * 🔴 **성공한 도구 목록은 안 보낸다** — 소스로 확인한다(발송 경로는 실제 API 를 탄다).
 *    ⚠️ 없애는 게 아니라 **조건을 바꾼 것**이다: 실패가 하나라도 있을 때만 보여준다.
 *       어제 *"텔레그램이 자기고발을 삼킨다"* 를 고친 취지는 그대로 살아 있어야 한다.
 */
test('🔴 도구 목록은 **실패가 있을 때만** 붙는다 (구조)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../server/telegramBot'), 'utf8');
  const m = /if \(toolsUsed\.length([^)]*)\)\s*\{\s*\n\s*answer \+= `\\n\\n🔧/.exec(src);
  assert.ok(m, '도구 목록 조건을 못 찾았다 — 이 자가 아무것도 안 보고 있다');
  assert.match(m[1], /notices\.length/, '🔴 조건에 실패 여부가 없다 — 정상 회차마다 도구 목록이 붙는다');
});

test('🔴 실패는 여전히 폰으로 간다 (삼키지 않는다)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../server/telegramBot'), 'utf8');
  assert.match(src, /notices\.push\(`\$\{data\?\.name \|\| '도구'\} 실패/, '도구 실패 전달이 사라졌다');
  assert.match(src, /if \(notices\.length\) answer \+= /, '경고 전달이 사라졌다');
});

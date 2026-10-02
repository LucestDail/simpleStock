/**
 * recall 자기 되먹임 차단 (2026-10-02 라이브 실사고)
 *
 * 사용자: *"QLD 100불 넘으면 또 하락할거같은데… RAM+QLD 상쇄분으로 더 현금만들고 기다려볼까"*
 * → 답변은 **금리 인상 수혜주**를 찾고 *"관심 업종 있으신가요?"* 로 끝났다.
 *
 * 서버에서 그 질의로 recall 을 **재현**해 원인을 확정했다:
 * ```
 * score=3.48  hits=["넘으면"]  role=assistant  at=2026-09-26   ← 아이온큐 답변
 * ```
 * 🔴 두 가지가 겹쳤다:
 *   ① **내 과거 답변**이 recall 대상이었다 — 빗나간 답이 다음 턴의 근거가 되는 **되먹임**
 *   ② 형태소 분석이 없어 **한국어 활용형**(`넘으면`)이 df 1~2 로 잡혀
 *      *"희귀어 = 주제어"* 예외를 타고 들어왔다
 */
const test = require('node:test');
const assert = require('node:assert');
const chat = require('../server/analystChat');

/** 말뭉치가 작으면 idf 가 0이 되어 **자가 아무것도 안 재게 된다** — 채움 문장을 넣는다 */
const FILLER = Array.from({ length: 14 }, (_, i) => ({
  role: 'user', turnId: `f${i}`, at: `2026-09-0${(i % 9) + 1}T00:00:00Z`,
  text: `채움 문장 ${i} 시장 상황 점검`,
}));
const Q = 'QLD뭔가 100불 넘으면 또 하락할거같은데... RAM + QLD 상쇄분으로 더 현금만들고 기다려볼까';

test('🔴 내 과거 답변은 끌어오지 않는다 — 되먹임의 뿌리', () => {
  const history = [
    { role: 'assistant', turnId: 'a', at: '2026-09-26T21:04:52Z',
      text: '아이온큐 프리장 상승 브리핑. 나스닥이 넘으면 추가 상승 …' },
    ...FILLER,
  ];
  assert.deepStrictEqual(chat.recall(Q, { history }), [],
    '내 답변이 걸렸다 — 빗나간 답이 다음 턴을 또 덮는다');
});

test('🔴 활용형 한 낱말로는 못 들어온다 — `넘으면` 은 주제어가 아니다', () => {
  const history = [
    { role: 'user', turnId: 'u', at: '2026-09-26T21:00:00Z', text: '나스닥이 넘으면 어떻게 되나' },
    ...FILLER,
  ];
  assert.deepStrictEqual(chat.recall(Q, { history }), [],
    '활용형이 희귀 주제어로 오판됐다');
});

test('⚠️ 정당한 recall 은 살아 있다 — 종목명·다중 일치는 들어온다', () => {
  const history = [
    { role: 'user', turnId: 'u1', at: '2026-09-20T10:00:00Z', text: 'QLD 상쇄분 현금만들고 어떻게 할까' },
    ...FILLER,
  ];
  const got = chat.recall(Q, { history });
  assert.ok(got.length >= 1, '여러 주제어가 맞는 과거 **질문**은 들어와야 한다');
  assert.strictEqual(got[0].role, 'user');
});

test('⚠️ 활용형 꼬리 목록이 **방향이 안전한** 쪽으로 쓰였다', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystChat.js'), 'utf8');
  assert.match(src, /INFLECTION_TAIL/, '활용형 가드가 없다');
  // 🔴 이 가드는 **희귀어 예외를 막는 쪽**으로만 쓰여야 한다 — 토큰 자체를 지우면
  //    `현금만들고` 같은 실제 주제어까지 사라진다
  assert.match(src, /inflected \|\| df\.get\(hits\[0\]\) > RECALL_RARE_DF/,
    '활용형 판정이 단일-일치 거부 외의 곳에 쓰이고 있다');
});

test('🔴 배선 — recall 행 필터가 user 만 통과시킨다', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystChat.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert.match(src, /if \(r\.role !== 'user'\) return false;/, 'assistant 가 다시 들어왔다');
  assert.ok(!/r\.role !== 'user' && r\.role !== 'assistant'/.test(src), '옛 필터가 남아 있다');
});

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * 대화 맥락 오염 — 2026-10-01 라이브 실사고 가드
 *
 * ## 무엇이 아팠나 (실측 · 사용자가 알려 줄 때까지 아무도 몰랐다)
 *
 * ```
 * 09-24 08:30  "아이온큐 프리장 상승 이유"      → 아이온큐 ✅
 * 09-26 21:03  "다음주 주말 시황 정리해줘"      → **아이온큐 프리장 상승** 🔴
 * 09-30 07:49  "내 보유주식상황 분석해"         → QLD + **"아이온큐가 고베타 성장주라"** 🔴
 * 10-01 15:37  "리얼티인컴 매수 매력 판단해줘"   → **아이온큐 프리장 급등 이유** 🔴
 * ```
 * 09-24 의 아이온큐가 **8일을 살아남아** 전혀 다른 질문들의 답을 끌고 갔다.
 *
 * ## 🔴 가장 중요한 사실 — 도구는 멀쩡했다
 * 그 턴의 로그: `rounds:1 toolCalls:4 toolFailed:0`, my-computer 쪽 질의는
 * `리얼티인컴 최근 하락 이유` 로 **정확했고 5건을 받았다.**
 * ⇒ **검색이 고장난 게 아니라 낡은 맥락이 맞는 결과를 덮었다.**
 *   "답이 이상하다 → 검색을 고치자" 로 갔으면 멀쩡한 것을 건드렸을 자리다.
 *
 * ## 두 경로로 들어왔다 — 하나만 막으면 다른 쪽으로 샌다
 * ```
 * ① recent  = history.slice(-8)   개수만 보므로 8일 전 대화가 "현재 대화" 로 실린다
 * ② recall  = 낱말 겹침 점수       `매수` 한 낱말로 아이온큐 답변 4건이 1점씩 따라 들어왔다
 * ```
 *
 * ## 🔴 이 자가 **반드시** 재야 하는 반대 축
 * "전부 막기" 는 쉽다 — recall 을 꺼 버리면 이 파일의 발동 테스트는 전부 통과한다.
 * 그래서 **같은 주제를 물으면 제대로 찾아오는지**를 함께 본다. 그게 없으면
 * 이 자는 *"recall 을 죽였다"* 와 *"recall 을 고쳤다"* 를 구분하지 못한다.
 */

let chat;
let FILE;

beforeEach(() => {
  FILE = path.join(os.tmpdir(), `chat-bleed-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env.ANALYST_CHAT_FILE = FILE;
  delete require.cache[require.resolve('../server/analystChat')];
  chat = require('../server/analystChat');
});

afterEach(() => {
  try { fs.rmSync(FILE, { force: true }); } catch { /* 지울 게 없으면 그만이다 */ }
  delete process.env.ANALYST_CHAT_FILE;
  delete require.cache[require.resolve('../server/analystChat')];
});

const H = 60 * 60_000;
const iso = (ms) => new Date(ms).toISOString();

/** 실사고를 그대로 재현한 이력 — 시각 간격이 핵심이라 날짜를 지키다 */
function 실사고이력(now = Date.parse('2026-10-01T06:37:00Z')) {
  const DAY = 24 * H;
  return [
    { at: iso(now - 7 * DAY), turnId: 't1', role: 'user', text: '아이온큐 프리장 상승 이유랑 지금 시장 상황 브리핑해줘' },
    { at: iso(now - 7 * DAY + 60_000), turnId: 't1', role: 'assistant', text: '아이온큐(IonQ) 프리장 상승은 양자 오류 정정 돌파 + 엔비디아 협업이 원인입니다. 매수 판단은 신중해야 합니다.' },
    { at: iso(now - 4 * DAY), turnId: 't2', role: 'user', text: '다음주 장 개장 전 주말동안 시황 정리해줘' },
    { at: iso(now - 4 * DAY + 60_000), turnId: 't2', role: 'assistant', text: '아이온큐 프리장 상승 + 시장 상황 브리핑. 엔비디아 파트너십 확대가 매수 재료입니다.' },
    { at: iso(now - 1 * DAY), turnId: 't3', role: 'user', text: '내 보유주식상황 분석해' },
    { at: iso(now - 1 * DAY + 60_000), turnId: 't3', role: 'assistant', text: 'QLD 보유는 유지가 맞습니다. 20일선 위이고 매수 단가 대비 수익 구간입니다.' },
    // 기계 출력 — 대화가 아니다
    { at: iso(now - 1 * DAY + 90_000), turnId: 't3', role: 'assistant', text: '[도구 결과] get_candles({"symbol":"QLD"}) {"bars":50,"last":96.7,"ma20":92.4} 매수' },
  ];
}

const 이력쓰기 = (rows) => fs.writeFileSync(FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

// ── ① 세션 경계 ──────────────────────────────────────────────────

test('🔴 하루 넘게 벌어진 과거 대화는 "현재 대화" 에 안 들어온다', () => {
  const rows = 실사고이력();
  이력쓰기(rows);
  const sess = chat.currentSession(chat.readHistory());
  // 하루 전 t3 묶음(질문+답변)만 남는다. 도구 결과 줄은 대화가 아니라 빠진다.
  assert.equal(sess.length, 2, `세션이 ${sess.length}턴 — 종전 slice(-8) 은 7턴을 다 실었다`);
  const 본문 = sess.map((s) => s.text).join(' ');
  assert.ok(!본문.includes('아이온큐'), '8일 전 아이온큐가 현재 대화로 실렸다');
});

test('같은 세션 안의 후속 질문은 맥락을 유지한다 (오탐 축 — 이게 없으면 그냥 기능을 죽인 것이다)', () => {
  const t = Date.parse('2026-10-01T06:00:00Z');
  이력쓰기([
    { at: iso(t), turnId: 'a', role: 'user', text: 'QLD 지금 어때' },
    { at: iso(t + 60_000), turnId: 'a', role: 'assistant', text: 'QLD 는 20일선 위입니다.' },
    { at: iso(t + 2 * H), turnId: 'b', role: 'user', text: '그럼 더 사도 되나' },
  ]);
  const sess = chat.currentSession(chat.readHistory());
  assert.equal(sess.length, 3, '2시간 간격 후속 질문의 맥락이 끊겼다 — 너무 좁게 잡았다');
});

test('세션 경계는 개수가 아니라 간격이다 (경계값)', () => {
  const t = Date.parse('2026-10-01T06:00:00Z');
  const gap = chat.SESSION_GAP_MS;
  이력쓰기([
    { at: iso(t - 2 * gap - 60_000), turnId: 'x', role: 'user', text: '아주 오래된 질문' },
    { at: iso(t - gap + 60_000), turnId: 'y', role: 'user', text: '경계 안쪽 질문' },  // z 와 gap 미만
    { at: iso(t), turnId: 'z', role: 'user', text: '지금 질문' },
  ]);
  const sess = chat.currentSession(chat.readHistory());
  assert.deepEqual(sess.map((s) => s.turnId), ['y', 'z'], '간격 경계가 어긋났다');
});

test('시각을 못 읽는 줄이 세션을 통째로 끊지 않는다', () => {
  // ⚠️ 모르는 것을 "오래됐다" 로 단정하면 멀쩡한 대화가 매번 끊긴다
  const t = Date.parse('2026-10-01T06:00:00Z');
  이력쓰기([
    { at: 'not-a-date', turnId: 'a', role: 'user', text: '시각이 깨진 줄' },
    { at: iso(t), turnId: 'b', role: 'user', text: '지금 질문' },
  ]);
  assert.equal(chat.currentSession(chat.readHistory()).length, 2);
});

test('이력이 비어도 터지지 않는다', () => {
  이력쓰기([]);
  assert.deepEqual(chat.currentSession(chat.readHistory()), []);
});

// ── ② recall 정밀도 ──────────────────────────────────────────────

test('🔴 흔한 낱말 하나로 무관한 과거 답변이 따라오지 않는다 (그 사고 그대로)', () => {
  이력쓰기(실사고이력());
  const hits = chat.recall('리얼티인컴도 많이 내려간거 같은데 매수 매력 판단해줘');
  const 본문 = hits.map((h) => h.text).join(' ');
  assert.ok(!본문.includes('아이온큐'),
    `아이온큐가 ${hits.length}건 중에 끼어 있다: ${hits.map((h) => `[${h.hits}]`).join(',')}`);
});

test('🔴 같은 주제를 물으면 제대로 찾아온다 (판별력 — "전부 막기" 와 가르는 유일한 축)', () => {
  이력쓰기(실사고이력());
  const hits = chat.recall('아이온큐 프리장 상승 이유 다시 알려줘');
  assert.ok(hits.length >= 1, 'recall 이 아무것도 못 찾는다 — 고친 게 아니라 죽인 것이다');
  assert.ok(hits.some((h) => h.text.includes('아이온큐')), '정작 아이온큐를 못 찾았다');
});

test('한국어 조사가 붙어도 주제어를 찾는다', () => {
  // 종전엔 `리얼티인컴도` 를 통째로 찾아 `리얼티인컴` 을 못 맞혔다
  이력쓰기([
    { at: iso(Date.now() - 10 * 24 * H), turnId: 'a', role: 'user', text: '리얼티인컴 배당 괜찮나' },
    { at: iso(Date.now() - 9 * 24 * H), turnId: 'b', role: 'user', text: '다른 얘기' },
    { at: iso(Date.now() - 8 * 24 * H), turnId: 'c', role: 'user', text: '또 다른 얘기' },
  ]);
  const hits = chat.recall('리얼티인컴도 지금 사도 되나');
  assert.ok(hits.some((h) => h.text.includes('리얼티인컴')), `조사 때문에 주제어를 놓쳤다: ${JSON.stringify(hits)}`);
  assert.ok(chat.tokenize('리얼티인컴도 사도 되나').includes('리얼티인컴'), '조사 분리가 안 된다');
});

test('조사처럼 보이지만 낱말의 일부인 것을 망가뜨리지 않는다', () => {
  // `정보`·`주가` 의 끝 글자를 조사로 떼면 엉뚱한 낱말이 된다 ⇒ **원형을 함께 남긴다**
  const t = chat.tokenize('시장 정보와 주가를 알려줘');
  assert.ok(t.includes('정보와') && t.includes('정보'), '원형과 분리형이 둘 다 있어야 한다');
  assert.ok(t.includes('주가를') && t.includes('주가'));
});

test('도구 결과 줄은 대화가 아니라 recall 대상이 아니다', () => {
  이력쓰기(실사고이력());
  const hits = chat.recall('QLD 캔들 ma20 bars');
  assert.ok(!hits.some((h) => h.text.startsWith('[도구 결과]')),
    '기계 출력이 recall 로 들어왔다 — 숫자·티커가 잔뜩이라 낱말 겹침에서 부당하게 이긴다');
});

test('이번 턴을 자기 자신으로 되찾지 않는다 (recall 도구 경로)', () => {
  const rows = 실사고이력();
  rows.push({ at: iso(Date.now()), turnId: 'now', role: 'user', text: '리얼티인컴 지금 사도 되나' });
  이력쓰기(rows);
  // 🔴 첫 판은 공허했다 — recall 반환에 turnId 가 없어 `h.turnId === 'now'` 가 **영원히 거짓**이라
  //    자기턴 제외를 떼도 통과했다(변이 E 미탐). 제품이 turnId 를 싣게 하고 **본문으로도** 본다.
  const hits = chat.recall('리얼티인컴 지금 사도 되나', { excludeTurnId: 'now' });
  assert.ok(hits.every((h) => h.turnId !== undefined), 'recall 이 turnId 를 안 싣는다 — 이 단언이 공허해진다');
  assert.ok(!hits.some((h) => h.turnId === 'now'), '자기 발화가 recall 한 자리를 먹었다');
  assert.ok(!hits.some((h) => h.text === '리얼티인컴 지금 사도 되나'), '자기 발화가 본문으로 들어왔다');
});

test('관련 없는 질문이면 아무것도 안 집어온다', () => {
  이력쓰기(실사고이력());
  const hits = chat.recall('내일 비 오나');
  assert.equal(hits.length, 0, `무관한 질문에 ${hits.length}건을 집어왔다: ${JSON.stringify(hits.map((h) => h.hits))}`);
});

test('빈 질의·공백에 터지지 않는다', () => {
  이력쓰기(실사고이력());
  assert.deepEqual(chat.recall(''), []);
  assert.deepEqual(chat.recall('   '), []);
  assert.deepEqual(chat.recall(null), []);
});

// ── ③ 규칙별 고립 검증 — 🔴 변이가 안 잡혀서 추가했다 ──────────────
//
// 처음 쓴 테스트는 **변이 3종 중 1종만** 잡았다. 이유를 재 보니 두 규칙이
// **서로를 덮고 있었다**: 말버릇 상한을 떼면 희귀어 규칙이 막고, 희귀어 규칙을 떼면
// 말버릇 상한이 막는다 ⇒ 하나씩 떼서는 아무 테스트도 안 깨진다.
// ★ 겹겹 방어는 **제품에는 좋고 자에는 함정**이다 — 각 규칙이 **혼자 일하는 상황**을
//   따로 만들어야 그 규칙이 살아 있는지 알 수 있다.

test('말버릇 상한이 혼자 일한다 — 흔한 낱말 **둘**이 겹쳐도 안 들어온다', () => {
  /**
   * 🔴 **상한만이 막는 구간을 일부러 만든다.**
   *    · 희귀어 규칙은 "겹친 낱말이 하나" 일 때만 작동 ⇒ 셋을 겹치게 해 비활성화
   *    · idf 는 df == N(전부에 있음)일 때만 0 이 된다 ⇒ **절반에만** 넣어 idf > 0 유지
   *    N=10 · df=5 → dfCap = max(2, 2) = 2 이므로 상한이 자른다. 상한을 떼면
   *    idf = log(10/5) = 0.69 × 3 = 2.08 로 **통과해 버린다.**
   *    ⚠️ 첫 판은 10건 **전부**에 넣어 idf 가 0 이 됐고, 그래서 상한을 떼도 안 깨졌다
   *       (변이 C 미탐). "막혔다" 와 "내가 재려던 것이 막았다" 는 다르다.
   */
  const t = Date.parse('2026-10-01T00:00:00Z');
  const DAY = 24 * H;
  const rows = [];
  for (let i = 0; i < 5; i += 1) {
    rows.push({ at: iso(t - (30 - i) * DAY), turnId: `o${i}`, role: 'assistant', text: `아이온큐 소식. 매수 판단과 시장 상황. ${i}` });
  }
  for (let i = 0; i < 5; i += 1) {
    rows.push({ at: iso(t - (20 - i) * DAY), turnId: `z${i}`, role: 'user', text: `전혀 다른 잡담입니다 ${i}` });
  }
  이력쓰기(rows);
  const hits = chat.recall('리얼티인컴 매수 판단 시장');
  assert.equal(hits.length, 0,
    `말버릇(매수·판단·시장)만 겹쳤는데 ${hits.length}건을 집어왔다 — 비율 상한이 죽었다`);
});

test('희귀어 규칙이 혼자 일한다 — 드물지 않은 낱말 **하나**로는 안 들어온다', () => {
  /**
   * 🔴 **비율 상한이 개입하지 않는 구간을 일부러 만든다.**
   *    N=20 · df=3 이면 dfCap = max(2, 20*0.2) = 4 라 비율 상한은 통과시킨다.
   *    그런데 겹친 낱말이 **하나뿐**이고 df(3) > RARE_DF(2) 라 희귀어 규칙만이 막는다.
   *    ⚠️ 첫 판은 N=10·df=2 로 잡아 **비율 상한이 대신 막아 버렸고**, 그래서 희귀어
   *       규칙을 떼도 테스트가 안 깨졌다(변이 B 미탐). 고립이 안 된 고립 테스트였다.
   */
  const t = Date.parse('2026-10-01T00:00:00Z');
  const DAY = 24 * H;
  const rows = [];
  for (let i = 0; i < 17; i += 1) rows.push({ at: iso(t - (40 - i) * DAY), turnId: `x${i}`, role: 'user', text: `무관한 잡담 ${i}` });
  for (let i = 0; i < 3; i += 1) rows.push({ at: iso(t - (20 - i) * DAY), turnId: `y${i}`, role: 'assistant', text: `아이온큐 급등 이유 ${i} 반도체` });
  이력쓰기(rows);
  const hits = chat.recall('반도체');
  assert.equal(hits.length, 0,
    `낱말 하나(df=3, 비율상한 통과)로 ${hits.length}건을 집어왔다 — 희귀어 규칙이 죽었다`);
});

test('🔴 chat() 이 실제로 세션 경계를 쓴다 (순수 함수만 테스트하면 "안 불린다" 를 못 잡는다)', () => {
  const fs2 = require('node:fs');
  const src = fs2.readFileSync(require.resolve('../server/analystChat'), 'utf8');
  const body = src.slice(src.indexOf('async function chat('), src.indexOf('function parseToolCalls'));
  assert.ok(body.includes('currentSession(history)'),
    'chat() 이 currentSession 을 안 쓴다 — slice(-8) 로 되돌아갔다(8일 전 대화가 다시 실린다)');
  assert.ok(!/history\s*\.filter\([^)]*\)\s*\.slice\(-8\)/.test(body),
    '옛 slice(-8) 이 되살아났다');
  assert.ok(body.includes('excludeTurnId: turnId'),
    'recall 에 이번 턴 제외를 안 넘긴다');
});

// ── ④ 도구 중복 판정 · 검색어 품질 ────────────────────────────────

test('🔴 같은 도구를 다른 종목에 부르는 것은 정당하다 (종전엔 둘째가 조용히 사라졌다)', async () => {
  const r = await chat.decideTools('x', { tools: [
    { name: 'get_candles', argsJson: JSON.stringify({ symbol: 'QLD' }) },
    { name: 'get_candles', argsJson: JSON.stringify({ symbol: 'O' }) },
  ] });
  assert.equal(r.tools.length, 2,
    '두 종목 비교 질문에서 한쪽 데이터가 통째로 사라진다 — 모델은 없는 쪽을 지어낸다');
  assert.deepEqual(r.tools.map((t) => t.args.symbol).sort(), ['O', 'QLD']);
});

test('완전히 같은 호출은 여전히 한 번만 (오탐 축)', async () => {
  const r = await chat.decideTools('x', { tools: [
    { name: 'get_portfolio', argsJson: '{}' },
    { name: 'get_portfolio', argsJson: '{}' },
  ] });
  assert.equal(r.tools.length, 1, '같은 인자로 두 번 부르면 외부 API 비용이 두 배다');
});

test('검색어의 맨 연도 토큰을 지운다 (기간은 recency 가 이미 자른다)', () => {
  // 실측: 이력의 모델 생성 질의 8건 중 6건에 연도가 박혀 있었고 3건은 **틀린 연도**였다
  assert.equal(chat.sanitizeQuery('RAM ETF 반도체 전망 2025'), 'RAM ETF 반도체 전망');
  assert.equal(chat.sanitizeQuery('2026 반도체 전망'), '반도체 전망');
});

test('조사·단위가 붙은 연도는 문장의 일부라 안 건드린다 (오탐 축)', () => {
  assert.ok(chat.sanitizeQuery('2026년 반도체 전망').includes('2026년'));
  assert.ok(chat.sanitizeQuery('리얼티인컴 최근 하락 이유'), '멀쩡한 질의가 바뀌면 안 된다');
  assert.equal(chat.sanitizeQuery('리얼티인컴 최근 하락 이유'), '리얼티인컴 최근 하락 이유');
});

test('연도가 아닌 네 자리 수는 지키되, 금액성 숫자는 기존대로 거른다', () => {
  // 1500 은 연도가 아니다 — YEAR_TOKEN 은 19xx·20xx 만 본다
  assert.ok(chat.sanitizeQuery('환율 1500 돌파').includes('1500'));
  assert.ok(!chat.sanitizeQuery('평가금액 12,345,678 원').includes('12,345,678'));
});

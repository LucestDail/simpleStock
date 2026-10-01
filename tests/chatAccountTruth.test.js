const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

/**
 * 채팅이 **조회하지 않은 숫자를 조회한 것처럼** 답하던 것 — 2026-10-01 라이브 실사고
 *
 * ## 무엇이 아팠나 (KST)
 * ```
 * 17:31  "매일매일 1주씩 사고 50달러 하방 돌파시…"   toolCalls=0 → 평단·현재가·비중을 그대로 인용
 * 17:41  "qld 점점 수량 줄일거야"                   toolCalls=0 → **"지금 2주 남은 걸"**(실제 90주)
 * 17:41  "뭔소리야 나 아직 90주 남았어"              toolCalls=0 → 사용자가 직접 정정
 * 20:57  "공격적으로 투자한다면 자산비율 조정?"       toolCalls=0 → **전량 청산 + O 1주**
 * ```
 * 마지막 답은 *"공격적"* 을 물었는데 **3시간 12분 전 자기 답변의 "제안 요약" 을 글자까지
 * 그대로** 재탕했다. 그 사이 계좌를 **한 번도 안 봤다.**
 *
 * ## 🔴 뿌리 — 판단기와 답변기가 보는 것이 다르다
 * ```
 * 판단기  현재 발화 **한 줄**만 본다          → 종목도 모르고, 트리거 문구 열거에 안 걸리면 도구 0
 * 답변기  과거 대화 **전체**를 본다           → 거기 있는 묵은 숫자를 자신 있게 인용
 * ```
 * 판단기의 *"도구 안 불러도 된다"* 는 **답변기에 데이터가 없다는 전제 하에서만** 맞다.
 * 그런데 답변기에겐 과거 대화가 있다 — 그래서 *"안 불러도 된다"* 가 *"묵은 걸 써도 된다"* 가 됐다.
 *
 * 라이브 판단기 실측(2026-10-01, 배포본 그대로):
 * ```
 * 🔴 "공격적으로 투자한다면 내 자산비율 조정 어떻게 해야할까?"  → 도구 0
 * 🔴 "qld 점점 수량 줄일거야…"                                → 도구 0
 * ✅ "내 자산 비중 어때?"                                     → get_portfolio
 * ✅ "포트폴리오 리밸런싱 해줘"                                → get_portfolio
 * ```
 * **"자산 비중" 은 걸리고 "자산비율 조정" 은 안 걸린다** — 열거하는 쪽이 지는 그 비대칭이고,
 * 이 저장소가 셸 가드·MCP 도구 이름·HTML 태그에서 이미 세 번 진 자리다.
 *
 * ## 🔴🔴 프롬프트로 고치려던 시도가 이미 있었고 **실패했다**
 * `toolCalls === 0` 이면 *"과거 대화의 숫자를 재사용하지 마라"* 를 넣는 가드가
 * **09-30 에 똑같은 사고로 들어가 네 턴 전부 라이브였다**(커밋 `4c3982c`).
 * 모델은 **네 번 다 무시했다.** ⇒ *"프롬프트로 못 고치는 것을 프롬프트로 고치려 하지 말 것"*
 * (2026-09-14). 이 자가 재는 것은 그래서 **프롬프트 문구가 아니라 데이터의 존재**다.
 *
 * ## 처방 — 묻지 말고 **준다**
 * 분석 경로(`analyze`)는 `## 계좌` 를 **매 회차 프롬프트에 싣는다.** 채팅만 안 실었다
 * (*형제 중 하나만 빠진* 전형). 싣고 나면 모델이 묵은 숫자를 쓸 이유가 없다 —
 * **금지가 아니라 대체**다.
 */

process.env.ANALYST_CHAT_FILE = path.join(os.tmpdir(), `ss-truth-chat-${process.pid}.jsonl`);
process.env.SETTINGS_FILE = path.join(os.tmpdir(), `ss-truth-set-${process.pid}.json`);
process.env.ACTIVITY_FILE = path.join(os.tmpdir(), `ss-truth-act-${process.pid}.jsonl`);
process.env.ORDERS_FILE = path.join(os.tmpdir(), `ss-truth-ord-${process.pid}.json`);

const HOLDINGS = {
  asOf: '2026-10-01T11:57:00.000Z',
  summary: {
    value: { krw: 19537164, usd: 14335.1 },
    purchase: { usd: 14146.88 },
    profitRate: -8.9,
    profitRateDerived: 1.33,
    dailyRate: 1.12,
    cash: { krw: { amount: 0 }, usd: { amount: 1429.06 } },
  },
  items: [
    { symbol: 'QLD', name: 'ProShares Ultra QQQ', quantity: 90, avgPrice: 71.78, lastPrice: 96.54, profitRate: 34.5, dailyRate: 0.4, currency: 'USD' },
    { symbol: 'RAM', name: 'Roundhill DRAM ETF', quantity: 400, avgPrice: 19.08, lastPrice: 13.98, profitRate: -26.7, dailyRate: -1.2, currency: 'USD' },
    { symbol: 'O', name: 'Realty Income', quantity: 1, avgPrice: 54.40, lastPrice: 54.50, profitRate: 0.2, dailyRate: 0.1, currency: 'USD' },
  ],
};

let captured;

function fresh({ holdings = HOLDINGS, holdingsError = null, decide = { tools: [] }, answer = '답변입니다.' } = {}) {
  captured = { contents: null, decidePrompts: [], warns: [], notices: [], holdingsCalls: 0, proposed: [] };

  for (const k of Object.keys(require.cache)) {
    if (/analystChat|geminiClient|aiService|settingsService|tossPortfolio|tossClient|logger|orderService|mcpClient|stockRating|analystService/.test(k)) {
      delete require.cache[k];
    }
  }

  const put = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  };

  put('../server/geminiClient', {
    isAiConfigured: () => true,
    createGeminiClient: async () => ({
      models: {
        generateContentStream: async ({ contents }) => {
          // 🔴 **모델이 실제로 받은 것**을 붙잡는다 — 이 자가 재는 유일한 참값이다
          captured.contents = contents;
          return (async function* () {
            yield { candidates: [{ content: { parts: [{ text: answer }] } }] };
          })();
        },
      },
    }),
  });
  put('../server/settingsService', {
    getEffectiveAiConfig: () => ({ model: 'm', includeThoughts: false, thinkingBudget: 0 }),
    getSettings: () => ({}),
  });
  put('../server/aiService', {
    generateStructuredOutput: async (opts) => {
      captured.decidePrompts.push(String(opts?.userPrompt || ''));
      return decide;
    },
    getAiSettings: () => ({}),
  });
  const realLogger = jest_realLogger();
  put('../server/logger', {
    ...realLogger,
    logInfo: () => {},
    logWarn: (ev, d) => { captured.warns.push({ ev, d }); },
    logError: () => {},
  });
  put('../server/tossPortfolio', {
    getHoldings: async () => {
      captured.holdingsCalls += 1;
      if (holdingsError) throw new Error(holdingsError);
      return holdings;
    },
  });
  /**
   * ⚠️ 실물 `orderService` 는 테스트 환경에서 계좌 한도 확인에 실패해 `ok:false` 를 낸다.
   *    그러면 *"제안이 등록됐다"* 축을 **원리상 못 재고**, 오탐 테스트가 거짓 빨간불을 낸다.
   */
  put('../server/orderService', {
    checkAccountLimits: async () => ({ ok: true }),
    propose: (p) => { captured.proposed.push(p); return { ok: true, proposal: { id: 'p-test' } }; },
  });

  const chat = require('../server/analystChat');
  return chat;
}

/** logger 를 통째로 갈아끼우면 다른 export 가 사라져 모듈이 깨진다 — 실물에서 복사한다 */
function jest_realLogger() {
  const p = require.resolve('../server/logger');
  delete require.cache[p];
  const real = require(p);
  delete require.cache[p];
  return real;
}

const run = async (chat, message, extra = {}) => {
  const events = [];
  await chat.chat({ message, emit: (e, d) => { events.push({ e, d }); if (e === 'notice') captured.notices.push(d.text); }, ...extra });
  return events;
};

/** 모델에게 간 프롬프트 전문 */
const promptText = () => (captured.contents || []).map((c) => (c.parts || []).map((p) => p.text).join('\n')).join('\n---\n');

beforeEach(() => {
  try { require('node:fs').unlinkSync(process.env.ANALYST_CHAT_FILE); } catch { /* 없으면 그만 */ }
});
afterEach(() => { captured = null; });

// ── ① 계좌 정본이 매 턴 실린다 ──────────────────────────────────

test('🔴 도구를 한 번도 안 불러도 계좌 정본이 프롬프트에 실린다 (20:57 턴의 재현)', async () => {
  const chat = fresh({ decide: { tools: [] } });
  await run(chat, '공격적으로 투자한다면 내 자산비율 조정 어떻게 해야할까?');
  const p = promptText();
  assert.ok(p.includes('## 계좌'), '계좌 절이 없다 — 모델은 과거 대화의 숫자밖에 볼 게 없다');
  assert.ok(p.includes('QLD') && p.includes('90'), 'QLD 보유 수량이 안 실렸다');
  assert.ok(p.includes('RAM') && p.includes('400'), 'RAM 보유 수량이 안 실렸다');
  assert.ok(p.includes('1429') || p.includes('1,429'), '가용 현금이 안 실렸다 — 매수 가능 여부를 모델이 모른다');
});

test('🔴 계좌 숫자가 "지금 조회한 것" 임을 명시한다 (과거 대화의 숫자와 구분된다)', async () => {
  const chat = fresh();
  await run(chat, '내 자산 어때?');
  const p = promptText();
  assert.match(p, /지금 조회|방금 조회/, '언제 조회한 값인지 안 적으면 과거 숫자와 구분이 안 된다');
});

test('🔴 조회에 실패하면 조용히 빠지지 않고 "쓰지 마라" 를 싣는다', async () => {
  const chat = fresh({ holdingsError: '토스 502' });
  await run(chat, '내 자산 어때?');
  const p = promptText();
  assert.ok(p.includes('## 계좌'), '실패했다고 절 자체가 사라지면 모델은 과거 숫자를 쓴다');
  assert.match(p, /토스 502/, '왜 실패했는지가 없다');
  assert.match(p, /쓰지 마|인용하지 마/, '못 읽었는데 "쓰지 마라" 를 안 알렸다');
  assert.ok(captured.warns.some((w) => w.ev === 'chat.account_failed'), '실패가 로그에 안 남았다');
});

test('계좌 조회는 턴당 한 번이다 (판단기가 get_portfolio 를 또 불러도)', async () => {
  const chat = fresh({ decide: { tools: [{ name: 'get_portfolio', argsJson: '{}' }] } });
  await run(chat, '내 주식 뭐있어?');
  assert.equal(captured.holdingsCalls, 1, `${captured.holdingsCalls}회 조회했다 — 같은 턴에 두 번 부르면 외부 호출이 두 배다`);
});

// ── ② 보유 방침이 채팅에도 간다 ─────────────────────────────────

test('🔴 보유 방침이 채팅 프롬프트에 실린다 (16:44 에 배포했는데 채팅 배선이 0건이었다)', async () => {
  const analyst = require('../server/analystService');
  const chat = fresh();
  await run(chat, '내 주식 어떻게 할까?');
  const p = promptText();
  const lines = analyst.holdingPolicyLines();
  assert.ok(lines.length, '방침 정본이 비었다 — 이 자가 아무것도 안 본 것이다');
  /**
   * ⚠️ **심볼로 단언하면 공허하다** — RAM 은 바로 위 `## 계좌` 절에도 있어서, 방침이
   *    통째로 빠져도 통과한다. 방침 **문장 자체**가 들어갔는지를 본다.
   */
  for (const line of lines) {
    assert.ok(p.includes(line), `방침 문구가 채팅 프롬프트에 없다: ${line.slice(0, 40)}…`);
  }
  assert.match(p, /보유 방침/, '방침 절 제목이 없다 — 모델이 그 줄들을 방침으로 안 읽는다');
});

// ── ③ 판단기가 맥락을 본다 (종목 환각 축) ───────────────────────

test('🔴 판단기가 직전 사용자 발화를 함께 본다 (TQQQ 환각의 원인)', async () => {
  const chat = fresh();
  await run(chat, '나 리얼티인컴도 이제 1주씩 살건데');
  const chat2 = fresh();
  // 앞 턴이 이력에 남은 상태에서 대명사 질의
  await run(chat2, '매일매일 1주씩 사고 50달러 하방 돌파시 추가로 더 사는건?');
  const d = captured.decidePrompts.join('\n');
  assert.match(d, /리얼티인컴/, '판단기가 직전 발화를 못 봐서 어느 종목인지 모른다 (라이브에서 TQQQ 를 지어냈다)');
});

test('🔴 판단기 입력에 과거 [도구 결과]·모델 답변은 넣지 않는다', async () => {
  const chat = fresh();
  await run(chat, '내 주식 뭐있어?');
  const chat2 = fresh();
  await run(chat2, '그럼 어떻게 할까?');
  const d = captured.decidePrompts.join('\n');
  assert.ok(!d.includes('[도구 결과]'),
    '과거 도구 결과가 들어가면 판단기가 "이미 받았다" 며 도구를 안 부른다 — 결함을 고치다 같은 결함을 만든다');
  assert.ok(!d.includes('답변입니다.'), '모델의 과거 답변이 판단기 입력에 섞였다');
});

// ── ④ 말과 행동이 어긋나면 잡는다 ───────────────────────────────

test('🔴 "제안을 등록합니다" 라고 쓰고 실제로 안 했으면 잡는다 (20:57 턴이 그랬다)', async () => {
  const chat = fresh({ decide: { tools: [] }, answer: 'RAM 400주 전량 매도 제안을 등록합니다. 상단 HITL 목록에서 승인해 주세요.' });
  await run(chat, '공격적으로 투자한다면?');
  assert.ok(captured.warns.some((w) => w.ev === 'chat.proposal_claim_unbacked'),
    '등록했다고 말만 하고 실제 등록이 0건인데 아무도 몰랐다');
  assert.ok(captured.notices.some((t) => /등록되지 않았|실제로는/.test(t)),
    '사용자에게 "말뿐이었다" 를 안 알리면 승인 버튼을 찾으러 간다');
});

test('오탐 축: 실제로 제안을 등록했으면 경고하지 않는다', async () => {
  const chat = fresh({
    decide: { tools: [{ name: 'propose_order', argsJson: '{"symbol":"O","side":"BUY","quantity":1,"price":54.5}' }] },
    answer: '제안을 등록했습니다. 상단에서 승인해 주세요.',
  });
  await run(chat, 'O 1주 사줘');
  assert.ok(!captured.warns.some((w) => w.ev === 'chat.proposal_claim_unbacked'),
    '정상 등록인데 경고가 났다 — 오탐하면 다음 사람이 이 가드를 끈다');
});

test('오탐 축: 제안 얘기를 안 한 답은 건드리지 않는다', async () => {
  const chat = fresh({ answer: 'QLD 는 20일선 위라 추세가 살아 있습니다.' });
  await run(chat, 'qld 어때?');
  assert.ok(!captured.warns.some((w) => w.ev === 'chat.proposal_claim_unbacked'));
  assert.equal(captured.notices.length, 0, '아무 일도 없는데 알림이 갔다');
});

// ── ⑤ 자기 자신 검사 — 이 자가 진짜 보고 있는가 ─────────────────

test('🔴 이 자는 "프롬프트에 무엇이 있나" 를 본다 — 붙잡은 것이 비면 실패다', async () => {
  const chat = fresh();
  await run(chat, '안녕');
  assert.ok(Array.isArray(captured.contents) && captured.contents.length > 0,
    'contents 를 못 붙잡았다 — 위 테스트 전부가 공허하게 통과했을 것이다');
  assert.ok(promptText().length > 50, '프롬프트가 비었다');
});

// ── ⑥ 채팅의 제안 경로에도 보유 방침이 걸린다 ───────────────────

/**
 * 🔴 방침 게이트는 16:44 에 **분석 경로에만** 붙었다. 채팅에는 `propose_order` ·
 *    `propose_conditional_order` 라는 **같은 문이 둘 더** 있었다.
 *    이 구멍은 위 "오탐 축" 테스트가 빨간불을 내면서 드러났다 — 가드를 만들다 다른 구멍을 찾았다.
 */
test('🔴 채팅에서도 방침을 어기는 매도 제안은 막힌다 (12:19 에 폰으로 간 그 제안)', async () => {
  const chat = fresh({
    decide: { tools: [{ name: 'propose_order', argsJson: '{"symbol":"RAM","side":"SELL","quantity":400,"price":13.98,"reason":"손절"}' }] },
  });
  await run(chat, 'RAM 전량 손절해줘');
  assert.equal(captured.proposed.length, 0, '방침을 어긴 제안이 그대로 등록됐다');
  assert.ok(captured.warns.some((w) => w.ev === 'chat.policy_blocked'), '막혔는데 로그에 안 남았다');
  assert.match(promptText(), /보유 방침|방침을 그대로 알리고/, '왜 막혔는지가 모델에게 안 돌아갔다 — 또 시도한다');
});

test('조건부는 **발동가**로 판정한다 (방침이 허용한 16.0 트리거는 통과해야 한다)', async () => {
  const chat = fresh({
    decide: { tools: [{ name: 'propose_conditional_order', argsJson: '{"symbol":"RAM","side":"SELL","quantity":400,"triggerPrice":16.5,"orderPrice":16.5,"expiresAt":"2026-12-31","reason":"목표가"}' }] },
  });
  await run(chat, 'RAM 16.5 되면 팔아줘');
  assert.ok(!captured.warns.some((w) => w.ev === 'chat.policy_blocked'),
    '현재가(13.98)로 판정해서 사용자가 정한 바로 그 조건을 막았다 — 오탐하면 가드가 제품을 해친다');
});

test('오탐 축: 방침 없는 종목 매도는 안 막는다 (QLD)', async () => {
  const chat = fresh({
    decide: { tools: [{ name: 'propose_order', argsJson: '{"symbol":"QLD","side":"SELL","quantity":1,"price":96.5,"reason":"축소"}' }] },
  });
  await run(chat, 'QLD 1주 팔아줘');
  assert.ok(!captured.warns.some((w) => w.ev === 'chat.policy_blocked'), '방침에 없는 종목을 막았다');
  assert.equal(captured.proposed.length, 1, '정상 제안이 등록되지 않았다');
});

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createGeminiClient, isAiConfigured } = require('./geminiClient');
const { getEffectiveAiConfig } = require('./settingsService');
const { generateStructuredOutput } = require('./aiService');
const { logInfo, logWarn, logError } = require('./logger');
const toss = require('./tossClient');
const tossPortfolio = require('./tossPortfolio');
const mcp = require('./mcpClient');
const orderService = require('./orderService');
const rating = require('./stockRating');

/**
 * 애널리스트 채팅 — 스트리밍 + 툴 콜링 (2026-09-21)
 *
 * 사용자(스크린샷 주석): *"애널리스트와 채팅 — **스트리밍 형태로 출력되어야 함.
 * REST 형태로 안 나오게 주의**"* · *"툴 콜링, 관련 스트리밍 처리 및 thinking_delta,
 * tool-calling, tool-result 다 구현하고, 기존 대화 이력 기반 recall 구현, dreaming 구현"*
 *
 * ## 왜 별도 파일인가
 *
 * `aiService.generateContentStream` 은 **한 번 물어보고 한 번 답하는** 구조다(툴 없음).
 * 툴 콜링은 *모델 → 도구 → 모델* 로 **여러 바퀴**를 돌아야 해서 흐름 자체가 다르다.
 * 기존 함수를 비틀면 브리핑·리포트까지 같이 흔들리므로 **여기서 따로 돈다.**
 *
 * ## 🔴 REST 로 새지 않게 하는 것이 요구사항이다
 *
 * 모델이 다 말할 때까지 모았다가 한 번에 주면 **겉보기 결과는 같고 체감만 나빠진다** —
 * 그래서 조용히 그렇게 되기 쉽다. 이 파일은 **콜백으로만** 밖에 내보내고
 * 전체 문자열을 반환하지 않는다(마지막에 요약만 돌려준다).
 * 라우트도 `res.write` 로 흘리고, 테스트가 **조각이 2개 이상 도착했는지**를 본다.
 *
 * ## 도구는 **읽기 전용**이다
 *
 * 주문은 여기서 내지 않는다. 사용자 결정(09-21): *"주문은 제안만 · 실행은 항상 사람 승인."*
 * 매매는 `orderService` 의 제안·승인 경로로만 간다.
 */

/**
 * ⚠️ 경로를 환경변수로 뺄 수 있게 한다.
 *    이유는 운영이 아니라 **테스트**다 — `node --test` 는 파일을 **병렬로** 돌리는데
 *    채팅 테스트와 dreaming 테스트가 같은 파일을 쓰면 서로의 이력을 지운다.
 *    실제로 단독 실행은 통과하고 전체 실행에서만 2건이 깨졌다
 *    (워크스페이스 규율: *"실행 중인 작업의 파일을 지우지 말 것"* 의 테스트 판본).
 */
const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = process.env.ANALYST_CHAT_FILE || path.join(DATA_DIR, 'analyst-chat.jsonl');

/** 도구 바퀴 상한. 🔴 없으면 무한 루프가 밤새 토큰을 태운다(Probius 선례) */
const MAX_ROUNDS = Math.max(1, Number(process.env.ANALYST_MAX_TOOL_ROUNDS) || 6);
/** 한 바퀴 안에서 부를 수 있는 도구 수 */
const MAX_CALLS_PER_ROUND = 4;
const RECALL_LIMIT = 6;

// ── 도구 선언 ────────────────────────────────────────────────

const TOOL_DECLARATIONS = [
  {
    name: 'get_portfolio',
    description: '사용자의 실제 보유 종목과 평가금액·손익을 가져온다. 인자 없음.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_candles',
    description: '종목의 일봉/분봉을 가져온다. 추세·이동평균 판단에 쓴다.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '종목 코드 또는 티커 (예: 005930, QLD)' },
        interval: { type: 'string', description: "'1d'(일봉) 또는 '1m'(분봉)" },
        count: { type: 'number', description: '봉 개수 (최대 200)' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_rankings',
    description: '급등·급락·거래대금 랭킹을 가져온다.',
    parameters: {
      type: 'object',
      properties: {
        country: { type: 'string', description: "'KR' 또는 'US'" },
        type: { type: 'string', description: 'TOP_GAINERS · TOP_LOSERS · MARKET_TRADING_AMOUNT 등' },
      },
      required: ['country', 'type'],
    },
  },
  {
    name: 'get_warnings',
    description: '종목의 투자주의·경고·위험 지정 여부를 확인한다.',
    parameters: {
      type: 'object',
      properties: { symbol: { type: 'string' } },
      required: ['symbol'],
    },
  },
  {
    name: 'web_search',
    description: '최신 뉴스·시장 정보를 웹에서 찾는다. 종목명이나 주제어를 넣는다.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '검색어. 보유 수량·금액은 절대 넣지 않는다.' } },
      required: ['query'],
    },
  },
  {
    /**
     * 🔴 사용자 지시로 만든 **계층 평가** 도구 — 10항목 100점 + 투자의견 + 확신도.
     * ⚠️ 이건 **기업의 질**을 재는 것이지 "지금 사라" 가 아니다.
     */
    name: 'rate_stock',
    description:
      '종목을 10개 항목 100점으로 평가한다(Yahoo Statistics Current 값 기준). 유형(대형주/중소형 성장주/'
      + '대형배당주)을 자동 판정하고 총점·투자의견·확신도를 낸다. **기업의 질** 평가이며 매매 타이밍이 아니다.',
    parameters: {
      type: 'object',
      properties: { symbol: { type: 'string', description: '종목 티커. 한국 종목은 6자리 코드' } },
      required: ['symbol'],
    },
  },
  {
    /**
     * 🔴 **유일하게 쓰기 비슷한 도구다.** 사용자 지시(스크린샷):
     *    *"상단 매매 분석 및 주식 관련 내용 발생시 상단 HITL 에 토픽으로 등록 ·
     *      사용자 승인시 매수/매도 실행"*
     * ⚠️ 그래도 **주문이 아니다** — `PENDING` 제안을 하나 만들 뿐이고,
     *    승인·실행은 여전히 사람이 화면에서 누른다. 이 도구는 승인도 실행도 못 한다.
     */
    name: 'propose_order',
    description:
      '매수/매도 제안을 상단 HITL 목록에 등록한다. 주문이 아니라 **제안**이며 사람이 승인해야 한다.'
      + ' 종목·방향·수량·지정가를 전부 확신할 때만 쓴다. 하나라도 모르면 쓰지 말고 사람에게 물어라.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '종목 코드 또는 티커' },
        side: { type: 'string', description: 'BUY 또는 SELL' },
        quantity: { type: 'number', description: '수량(주). 매도는 보유 수량 이내' },
        price: { type: 'number', description: '지정가' },
        reason: { type: 'string', description: '왜 이 제안인지 한두 문장' },
      },
      required: ['symbol', 'side', 'quantity', 'price', 'reason'],
    },
  },
  {
    name: 'propose_conditional_order',
    description:
      '예약(조건부) 매매 제안을 등록한다 — "가격이 X에 도달하면 Y에 매도/매수" 형태.'
      + ' 즉시 주문이 아니라 거래소가 감시가를 지켜보다 발동한다. 사람이 승인해야 예약이 등록된다.'
      + ' 예: "100불 도달하면 100.5 지정가로 전량 매도" → triggerPrice 100, orderPrice 100.5, side SELL.'
      + ' 값을 하나라도 모르면 지어내지 말고 사람에게 물어라(특히 expireDate — 사용자가 기간을 안 줬으면 물어라).',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '종목 코드 또는 티커' },
        side: { type: 'string', description: 'BUY 또는 SELL' },
        quantity: { type: 'number', description: '수량(주). 매도는 보유 수량 이내' },
        triggerPrice: { type: 'number', description: '감시가 — 이 가격에 닿으면 주문이 나간다' },
        orderPrice: { type: 'number', description: '주문가(지정가). 시장가면 생략' },
        orderType: { type: 'string', description: 'LIMIT(기본) 또는 MARKET' },
        expireDate: { type: 'string', description: '예약 만료일 YYYY-MM-DD — 사용자가 말한 기간. 없으면 묻는다' },
        reason: { type: 'string', description: '왜 이 예약인지 한두 문장' },
      },
      required: ['symbol', 'side', 'quantity', 'triggerPrice', 'expireDate', 'reason'],
    },
  },
  {
    name: 'list_conditional_orders',
    description: '등록된 예약(조건부) 주문 목록을 본다. "내 예약 주문 뭐 있어" 류 질문에 쓴다.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_my_orders',
    description: '내 계좌의 주문 내역(접수·체결·취소 상태)을 본다. "내 주문 어떻게 됐어"·"체결됐어?" 류 질문에 쓴다.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_trades',
    description: '한 종목의 최근 시장 체결 틱(최대 50건)을 본다 — 체결 방향·강도 판단용. ⚠️ 내 계좌 체결이 아니다(그건 get_my_orders).',
    parameters: {
      type: 'object',
      properties: { symbol: { type: 'string', description: '종목 코드 또는 티커' } },
      required: ['symbol'],
    },
  },
  {
    name: 'recall',
    description: '과거 대화에서 관련된 내용을 찾아온다. 사용자가 전에 한 말·판단을 확인할 때 쓴다.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '찾을 주제어' } },
      required: ['query'],
    },
  },
];

/**
 * 🔴 **네이티브 function calling 을 쓰지 않는다 — 게이트웨이가 안 넘긴다.**
 *
 * 실측(2026-09-21): `tools: [{functionDeclarations}]` 를 실어 osh-ai-gateway 로 보냈더니
 * **31청크가 전부 `text`** 였고 `functionCall` 파트는 **0개**였다. 모델은 도구가 있는 줄도
 * 모르고 *"저는 사용자의 보유 종목을 확인할 수 없습니다"* 라고 답했다.
 * (채팅으로도 같은 증상 — *"포트폴리오를 확인할게요"* 라고 **말만 하고** 아무 일도 안 일어났다.)
 *
 * ⇒ 이 생태계 표준대로 **프롬프트 기반**으로 간다(Probius 도 같은 이유로 그렇게 한다 —
 *   폐쇄망·로컬 모델에도 그대로 붙는다는 부수 이점이 있다).
 * ⚠️ 네이티브 경로는 **지우지 않는다** — `GEMINI_API_KEY` 직결이면 실제로 동작하고,
 *    게이트웨이가 나중에 지원해도 그대로 받는다. 둘 다 받게 열어 둔다.
 */
function toolCatalog() {
  return TOOL_DECLARATIONS.map((t) => {
    const props = Object.entries(t.parameters?.properties || {})
      .map(([k, v]) => `${k}: ${v.type}${(t.parameters.required || []).includes(k) ? ' (필수)' : ''} — ${v.description || ''}`)
      .join(' · ');
    return `- \`${t.name}\` — ${t.description}${props ? `\n    인자: ${props}` : '\n    인자: 없음'}`;
  }).join('\n');
}

const SYSTEM_PROMPT = [
  '당신은 사용자의 주식 포트폴리오를 함께 보는 매수·매도 애널리스트입니다.',
  '',
  '## 도구',
  '',
  toolCatalog(),
  '',
  '도구는 **시스템이 대신 실행해서 결과를 넣어 줍니다.** 당신은 도구를 부르는 글을',
  '쓰지 않습니다 — 결과가 `[도구 결과]` 로 들어오면 그것만 근거로 답하세요.',
  '- 도구가 실패했다고 적혀 있으면 **실패했다고 말합니다.** 값을 지어내지 않습니다.',
  '',
  '## 답하는 방식',
  '- **제공된 숫자를 인용**합니다. 근거 없는 수치는 쓰지 않습니다.',
  '- 재무제표·DCF·PER/PBR·기관 수급·내부자 거래·옵션 IV 는 이 시스템에 **없습니다**.',
  '  필요하면 "그 데이터는 없다" 고 말합니다.',
  '- 뭉뚱그리지 않습니다. 판단이 안 서면 "판단 못 하겠다" 고 그렇게 말합니다.',
  '- 한국어로, 과장 없이 씁니다.',
  '',
  '## 🔴 답은 "종합 소견" 이다 — 결과 나열이 아니다 (2026-09-22 사용자 지적)',
  '- 🔴 **도구 실행 여부를 사용자에게 묻지 않는다.** "실행해 드릴까요?" "확인해 볼까요?" 금지 —',
  '  필요한 도구는 **당신이 지금 부른다.** 사용자가 원한 것은 답이지 계획이 아니다.',
  '- 🔴 검색·도구 결과를 **늘어놓고 끝내지 않는다.** 결과들을 사용자 지침(아래 템플릿)과',
  '  포트폴리오 맥락으로 **종합해 소견을 낸다**: ①결론 한 줄 → ②근거(숫자 인용) → ③판단이',
  '  안 서면 무엇이 더 필요한지 **한 줄**(도구 나열이 아니라 "무엇을 모르는지").',
  '- 확인 못 한 것은 "확인 못 했다" 한 줄로 — 못 한 과정을 길게 쓰지 않는다.',
  '',
  '## 🔴 주문은 내지 않습니다',
  '매수/매도가 필요하다고 판단되면 **제안으로 등록**됩니다(상단 HITL 목록).',
  '그건 주문이 아닙니다 — **사람이 승인해야** 진행되고, 당신은 승인도 실행도 할 수 없습니다.',
  '제안을 등록했으면 사용자에게 **"상단에서 승인해 달라"** 고 안내하세요.',
].join('\n');

/**
 * ── 도구 판단기 ─────────────────────────────────────────────
 *
 * 🔴 **왜 대화와 분리했나 — 실측 세 번의 결과다(2026-09-21).**
 *
 * ```
 * ① 네이티브 function calling      게이트웨이가 안 넘긴다 (31청크 전부 text · functionCall 0)
 * ② 프롬프트로 "JSON 만 내라"       모델이 **서술을 택한다**
 *                                  ("포트폴리오를 조회할게요" 라고 말만 하고 끝)
 * ③ systemInstruction 이 안 닿나?  **닿는다** (구분력 있는 지시로 확인: 양쪽 다 따랐다)
 * ④ 스키마로 강제                  ✅ **된다** — 보유 질문→get_portfolio ·
 *                                  "고마워"→[] · "20일선 위야?"→get_candles(005930,1d,30)
 * ```
 * ⇒ ②를 프롬프트로 더 밀어붙이지 않는다. 워크스페이스 규율 그대로다 —
 *   *"프롬프트로 못 고치는 것을 프롬프트로 고치려 하지 말 것."* **구조를 바꾼다.**
 *
 * ⚠️ 대가: 라운드마다 **짧은 호출이 하나 더** 든다(실측 1.3~2.9초).
 *    대신 사람에게 보이는 답은 **여전히 스트리밍**이고, 도구가 **실제로 불린다.**
 * ★ ④ 검증에서 "고마워" 에 `[]` 가 나온 것이 중요하다 — 도구를 **안 쓸 줄도 알아야**
 *   판단기이지, 늘 부르면 그냥 낭비다(자의 판별력을 함께 잰 것).
 */
const DECIDE_SCHEMA = {
  type: 'object',
  properties: {
    tools: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          // ⚠️ enum 을 줘도 **키 이름은 모델이 바꾼다** — 아래 파서가 값으로 판정한다
          name: { type: 'string', enum: TOOL_DECLARATIONS.map((d) => d.name) },
          // ⚠️ 인자는 **JSON 문자열**로 받는다 — 도구마다 모양이 달라 한 스키마로 못 쓴다
          argsJson: { type: 'string' },
        },
        required: ['name', 'argsJson'],
      },
    },
  },
  required: ['tools'],
};

function decidePrompt() {
  return [
    '당신은 **도구 사용 여부만** 정하는 판단기입니다. 사람에게 하는 답은 쓰지 않습니다.',
    '',
    '## 쓸 수 있는 도구',
    toolCatalog(),
    '',
    '',
    '## 🔴 전제 — 답하는 쪽은 **아무 데이터도 없습니다**',
    '보유 종목·시세·차트·뉴스는 **도구를 부르지 않으면 존재하지 않습니다.** 모델의 사전 지식으로',
    '답할 수 없는 것들입니다. 사용자가 그런 것을 물었는데 도구를 안 부르면,',
    '답하는 쪽은 **모른다고 하거나 지어냅니다.**',
    '',
    '- 필요한 도구를 `tools` 에 담습니다. `argsJson` 은 인자를 담은 **JSON 문자열**입니다(없으면 "{}").',
    '- `[도구 결과]` 가 **아직 없는데** 사용자가 아래를 물으면 반드시 도구를 부릅니다:',
    '    · 보유·잔고·평가금액·손익 → get_portfolio',
    '    · 주가·추세·이동평균·차트 → get_candles',
    '    · 급등·급락·랭킹 → get_rankings',
    '    · 뉴스·최근 소식·전망 → web_search',
    '    · 예전에 한 얘기 → recall',
    '    · 매수/매도를 **하자고 정했을 때** → propose_order (주문이 아니라 제안 등록이다)',
    '    🔴 propose 계열은 사용자가 **명시적으로 요청**했을 때만("사줘/팔아줘/제안해줘/걸어줘").',
    '      "뭘 사겠냐/어떻게 생각하냐/판다면 뭘로" 는 **질문**이다 — 답만 하고 제안을 만들지 마라.',
    '      (실측 2026-09-23: 가정형 질문에 제안 3건을 등록해 사용자 폰에 승인 버튼이 갔다)',
    '    · "X 도달하면/떨어지면 사줘·팔아줘" 같은 **조건이 붙은 매매** → propose_conditional_order',
    '      (만료일을 사용자가 안 줬으면 도구를 부르지 말고 먼저 물어라)',
    '    · "예약 주문 뭐 있어" → list_conditional_orders · "내 주문 체결됐어?" → get_my_orders',
    '    · 한 종목의 단기 체결 강도가 필요할 때 → get_trades',
    '    · 기업의 질·밸류·점수 → rate_stock (10항목 100점 · 유형별 기준)',
    '- 🔴 잡담·인사·감사이거나 **이미 `[도구 결과]` 로 받은 것**이면 `tools` 를 **빈 배열**로 둡니다.',
  ].join('\n');
}

/**
 * 어떤 도구를 부를지 정한다.
 * 🔴 실패하면 **빈 배열**을 돌려준다 — 판단기가 죽었다고 대화까지 죽이지 않는다.
 *    다만 조용하지는 않다(로그 + 호출자가 notice 로 알린다).
 */
async function decideTools(transcript, injected = null) {
  let out = injected;
  try {
    if (out) return shapeToolCalls(out);
    out = await generateStructuredOutput({
      systemPrompt: decidePrompt(),
      userPrompt: transcript,
      schema: DECIDE_SCHEMA,
      logLabel: 'analyst_decide',
      fallback: { tools: [] },
    });
  } catch (e) {
    logWarn('chat.decide_failed', { message: e.message });
    return { tools: [], error: e.message };
  }
  return shapeToolCalls(out);
}

/**
 * 모델이 준 덩어리에서 도구 호출을 **모양으로** 읽어낸다(키 이름을 믿지 않는다).
 *
 * 🔴 **층마다 땜질하다 세 번 놓쳤다.** 실측된 모양들:
 * ```
 * {"tools":[{"name":"get_portfolio"}]}                    1회차
 * {"tools":[{"tool":"..."}]}  ·  {"tools":[{"id":"..."}]}  2·3회차 (항목 키가 바뀐다)
 * {"tool_requests":[...]}                                  4회차 (목록 키가 바뀐다)
 * {"tool_name":"get_portfolio","argsJson":"{}"}            **배열이 아예 없다**
 * {"tool_calls":[{"function":{"name":"...","arguments":…}}]} OpenAI 형식 — **한 겹 더**
 * ```
 * 앞의 넷을 하나씩 막다가 뒤의 둘을 또 맞았다. ★ **깊이도 열거의 대상이 된다** —
 * 그래서 이번엔 **재귀로 끝까지** 훑는다. 판정 근거는 여전히 하나뿐이다:
 * **값이 우리가 아는 도구 이름인가**(도구 목록은 우리가 정하는 **닫힌 집합**이다).
 *
 * ⚠️ 도구 이름을 찾은 객체 **안쪽으로는 더 내려가지 않는다** — 같은 호출을 두 번 세지 않으려고.
 */
function collectCallNodes(node, known, out, depth = 0) {
  if (depth > 6 || out.length >= MAX_CALLS_PER_ROUND * 2) return;
  if (Array.isArray(node)) {
    for (const n of node) collectCallNodes(n, known, out, depth + 1);
    return;
  }
  if (!node || typeof node !== 'object') return;

  for (const v of Object.values(node)) {
    if (typeof v === 'string' && known.has(v.trim())) {
      out.push({ node, name: v.trim() });
      return; // 이 객체가 호출이다 — 안으로 더 안 내려간다
    }
  }
  for (const v of Object.values(node)) collectCallNodes(v, known, out, depth + 1);
}

/** 호출 객체에서 인자를 꺼낸다 — 키가 아니라 **모양**으로(객체이거나 JSON 문자열) */
function argsOf(node, name) {
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && v.trim() === name) continue; // 이름 칸
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v === 'string' && /^\s*\{/.test(v)) {
      try {
        return JSON.parse(v);
      } catch {
        logWarn('chat.bad_args', { name, key: k, raw: v.slice(0, 120) });
      }
    }
  }
  return {};
}

function shapeToolCalls(out) {
  const known = new Set(TOOL_DECLARATIONS.map((d) => d.name));
  const found = [];
  collectCallNodes(out, known, found);

  if (!found.length && out && typeof out === 'object') {
    // 🔴 "도구 없음" 과 "내가 못 읽음" 을 구분해 남긴다.
    //    빈 배열은 정상(잡담)이므로, **뭔가 들어 있는데 못 읽은 경우만** 경고한다.
    const hasContent = JSON.stringify(out).length > 20 && !/"tools"\s*:\s*\[\s*\]/.test(JSON.stringify(out));
    if (hasContent) logWarn('chat.unknown_tool_shape', { raw: JSON.stringify(out).slice(0, 300) });
  }

  const calls = [];
  const seenNames = new Set();
  for (const { node, name } of found) {
    if (seenNames.has(name)) continue; // 같은 도구를 한 바퀴에 두 번 부르지 않는다
    seenNames.add(name);
    const args = argsOf(node, name);
    calls.push({ name, args: args && typeof args === 'object' ? args : {} });
  }
  return { tools: calls };
}

// ── 이력 (append-only) ───────────────────────────────────────

/**
 * 🔴 **덮어쓰지 않고 이어붙인다.** 대화는 '현재 상태' 가 아니라 **'일어난 일의 목록'** 이다
 *    (Probius `AuditStore` 와 같은 이유). 통째로 다시 쓰면 동시 쓰기에 한쪽이 사라진다.
 */
/**
 * ⚠️ 상한 (2026-09-22): 이 파일은 감사가 아니라 **대화 맥락**이다 — 무한히 자라면
 *    recall 이 전체를 읽는 비용만 는다. `activityLog.js` 와 같은 방식(한 세대만 민다).
 *    🔴 `orders-audit.jsonl` 은 이 규율의 대상이 **아니다**(돈 기록은 지우지 않는다).
 */
const HISTORY_MAX_BYTES = Math.max(256 * 1024, Number(process.env.CHAT_HISTORY_MAX_BYTES) || 4 * 1024 * 1024);

function appendHistory(entry) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.appendFileSync(HISTORY_FILE, `${JSON.stringify(entry)}\n`);
    if (fs.statSync(HISTORY_FILE).size > HISTORY_MAX_BYTES) {
      // ⚠️ 한 세대만 민다 — 여러 세대를 쌓으면 디스크를 조용히 먹는다
      fs.renameSync(HISTORY_FILE, `${HISTORY_FILE}.1`);
      logWarn('chat.history_rotated', { file: HISTORY_FILE });
    }
  } catch (e) {
    // 기록 실패가 대화를 멈추지는 않지만 **조용하지도 않다**
    logError('chat.history_append_failed', e, {});
  }
}

function readHistory({ limit = 400 } = {}) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    logWarn('chat.history_read_failed', { message: e.message });
    return [];
  }
}

/**
 * 이력을 통째로 지운다.
 * ⚠️ 되돌릴 수 없다. 다만 **대화는 감사 기록이 아니다** — 주문 감사(`orders-audit.jsonl`)는
 *    별도 파일이고 **여기서 안 건드린다**(그건 지우면 안 되는 것이다).
 */
function clearHistory() {
  try {
    const had = fs.existsSync(HISTORY_FILE);
    if (had) fs.rmSync(HISTORY_FILE);
    logInfo('chat.history_cleared', { had });
    return { ok: true, cleared: had };
  } catch (e) {
    logError('chat.history_clear_failed', e, {});
    return { ok: false, error: e.message };
  }
}

/**
 * recall — 과거 대화에서 관련 대목을 찾는다.
 *
 * ⚠️ 임베딩을 쓰지 않는다. **낱말 겹침**으로 고른다 — 이력이 수천 건 규모가 아니고,
 *    임베딩을 넣으면 외부 호출이 하나 더 늘어 실패 지점이 늘어난다.
 *    ★ 나중에 이력이 커지면 그때 바꾼다. **지금 확인할 수 있는 것**을 만든다.
 */
function recall(query, { limit = RECALL_LIMIT, history = null } = {}) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/[^0-9a-z가-힣]+/)
    .filter((t) => t.length >= 2);
  if (!terms.length) return [];

  const rows = history || readHistory();
  const scored = [];
  for (const r of rows) {
    if (r.role !== 'user' && r.role !== 'assistant') continue;
    const text = String(r.text || '');
    const hay = text.toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score += 1;
    if (score) scored.push({ score, at: r.at, role: r.role, text: text.slice(0, 400) });
  }
  // 점수 높은 것 우선, 같으면 최근 것 우선
  scored.sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)));
  return scored.slice(0, limit);
}

// ── 도구 실행 ────────────────────────────────────────────────

/**
 * 도구를 실행한다. 🔴 **실패를 성공으로 만들지 않는다** — `{ok:false, error}` 를 그대로
 * 모델에게 돌려줘서 모델이 "못 받았다" 고 말할 수 있게 한다.
 */
async function runTool(name, args = {}, ctx = {}) {
  switch (name) {
    case 'get_portfolio': {
      const p = await tossPortfolio.getHoldings({ fx: ctx.fx || null });
      return {
        summary: p.summary,
        items: (p.items || []).map((h) => ({
          symbol: h.symbol, name: h.name, market: h.market, currency: h.currency,
          // 🔴 정체 필드 (2026-09-22) — 이게 빠져 있어 모델이 RAM 의 레버리지 여부를 지어냈다
          officialName: h.officialName || null, securityType: h.securityType || null,
          leverageFactor: h.leverageFactor ?? null, listDate: h.listDate || null,
          quantity: h.quantity, avgPrice: h.avgPrice, lastPrice: h.lastPrice,
          profitRate: h.profitRate, dailyRate: h.dailyRate,
        })),
        note: '종목의 정체(사업·레버리지)는 officialName/leverageFactor **만** 근거로 말하라. '
          + '티커 글자에서 추측 금지 — 티커가 비슷한 다른 회사와 혼동하지 말 것. '
          + 'leverageFactor≥2 면 일일 리밸런싱 상품이다(횡보 시 가치 감쇠를 전제로 판단).',
      };
    }
    case 'get_candles': {
      const c = await toss.getCandles(String(args.symbol || ''), {
        interval: args.interval === '1m' ? '1m' : '1d',
        count: Math.min(200, Math.max(10, Number(args.count) || 120)),
      });
      const closes = (c.rows || []).map((r) => r.c).filter(Number.isFinite);
      const ma = (n) => (closes.length >= n ? closes.slice(-n).reduce((a, b) => a + b, 0) / n : null);
      // ⚠️ 봉 200개를 통째로 넘기면 토큰만 태운다 — **계산해서 요약**해 준다
      return {
        bars: closes.length,
        last: closes[closes.length - 1] ?? null,
        ma20: ma(20), ma60: ma(60),
        high: closes.length ? Math.max(...closes) : null,
        low: closes.length ? Math.min(...closes) : null,
        // 🔴 실측: 모델이 이 high/low 를 "52주 고점" 이라 지어 불렀다(상장 3개월 종목에서)
        note: `high/low 는 이 ${closes.length}개 봉 창 안의 값이다 — "52주" 등 더 긴 기간의 이름을 붙이지 말 것.`,
      };
    }
    case 'get_rankings': {
      const r = await toss.getRankings({
        country: String(args.country || 'KR').toUpperCase(),
        type: String(args.type || 'TOP_GAINERS'),
        duration: '1d',
        count: 10,
      });
      return { rows: (r.rows || []).slice(0, 10) };
    }
    case 'get_warnings': {
      const w = await toss.getWarnings(String(args.symbol || ''));
      // 🔴 빈 배열이 **정상**이다(경고 없음). "못 받았다" 와 구분되게 말로 적는다
      return { symbol: args.symbol, warnings: w, note: w.length ? null : '경고 지정 없음' };
    }
    case 'web_search': {
      // 🔴 모델이 준 검색어를 **그대로 쓰지 않는다** — 보유 수량·금액이 섞여 들어올 수 있다.
      //    `buildQuery` 와 같은 원칙: 밖으로 나가는 문자열은 한 곳에서 만든다.
      const safe = sanitizeQuery(String(args.query || ''));
      if (!safe) return { ok: false, error: '검색어가 비어 있거나 전부 걸러졌습니다.' };
      const r = await mcp.searchMarketNews([{ name: safe, symbol: '' }], { maxSubjects: 1 });
      if (!r.ok) return { ok: false, error: r.error, kind: r.kind };
      const hit = r.results[0] || {};
      if (hit.error) return { ok: false, error: hit.error, kind: hit.kind };
      return { query: safe, text: String(hit.text || '').slice(0, 3000) };
    }
    case 'rate_stock': {
      // ⚠️ 한국 종목은 야후 티커가 `.KS` 다 — 6자리 숫자면 붙여 준다(모델이 자주 빠뜨린다)
      const sym = String(args.symbol || '').trim().toUpperCase();
      const ysym = /^\d{6}$/.test(sym) ? `${sym}.KS` : sym;
      const r = await rating.rate(ysym);
      return {
        symbol: r.symbol, name: r.name, type: r.type, total: r.total, opinion: r.opinion,
        confidence: r.confidence, items: r.items,
        strengths: r.strengths, weaknesses: r.weaknesses, oneLiner: r.oneLiner,
        unverified: r.unverified, missingValueMetrics: r.missingValueMetrics,
        stats: r.stats, links: r.links,
        // 🔴 판단이 갈릴 수 있음을 도구 결과에 적어 둔다 — 모델이 혼동하지 않게
        note: '이 점수는 **기업의 질**이다. 지금 사고팔 것인가는 가격·추세와 함께 별도로 판단하라.',
      };
    }
    case 'propose_order': {
      /**
       * 🔴 **계좌로 먼저 막는다** (2026-09-22). 구조 가드가 이 경로를 찾아냈다 —
       *    분석·라우트에는 검증을 붙였는데 **채팅 경로만 빠져 있었다.**
       *    문이 셋인데 둘만 막으면 **안 막는 것**이고, 하필 여기가 사용자가
       *    *"이거 사줘"* 라고 말하면 바로 제안이 만들어지는 자리다.
       * ⚠️ 못 물어봤으면 통과가 아니다 — 모델에게 **왜 막혔는지**를 돌려줘야
       *    "다시 시도" 대신 사용자에게 설명한다.
       */
      const chk = await orderService.checkAccountLimits({
        symbol: args.symbol,
        side: String(args.side || '').toUpperCase(),
        quantity: args.quantity,
        price: args.price,
      });
      if (!chk.ok) {
        return {
          ok: false,
          error: chk.error,
          kind: chk.kind,
          note: chk.kind === 'unknown'
            ? '계좌를 확인하지 못해 제안을 만들지 않았다. **추측해서 다시 시도하지 말고** 사용자에게 알려라.'
            : '계좌 한도를 넘어 제안을 만들지 않았다. 수량을 줄이거나 사용자에게 알려라.',
        };
      }
      // 🔴 빈칸이 있으면 `orderService` 가 거부한다 — 승인 화면이 주문 화면이 되면 안 된다
      const r = orderService.propose(
        {
          symbol: args.symbol,
          side: String(args.side || '').toUpperCase(),
          type: 'LIMIT',
          quantity: args.quantity,
          price: args.price,
          reason: args.reason,
        },
        { source: 'chat' }
      );
      if (!r.ok) return { ok: false, error: r.error, missing: r.missing };
      return {
        ok: true,
        proposalId: r.proposal.id,
        note: '상단 HITL 목록에 등록했습니다. **아직 주문이 아닙니다** — 사람이 승인해야 진행됩니다.',
      };
    }
    case 'propose_conditional_order': {
      /**
       * 🔴 예약도 **계좌로 먼저 막는다** — 즉시 주문과 같은 규율(문이 둘인데 하나만 막으면 안 막는 것).
       *    예산 검사의 가격은 주문가(없으면 감시가) 기준 — 발동 시 그 가격 근처에서 체결된다.
       */
      const chk = await orderService.checkAccountLimits({
        symbol: args.symbol,
        side: String(args.side || '').toUpperCase(),
        quantity: args.quantity,
        price: args.orderPrice ?? args.triggerPrice,
      });
      if (!chk.ok) {
        return {
          ok: false, error: chk.error, kind: chk.kind,
          note: chk.kind === 'unknown'
            ? '계좌를 확인하지 못해 예약 제안을 만들지 않았다. 추측해서 다시 시도하지 말고 사용자에게 알려라.'
            : '계좌 한도를 넘어 예약 제안을 만들지 않았다. 수량을 줄이거나 사용자에게 알려라.',
        };
      }
      const r = orderService.propose(
        {
          symbol: args.symbol,
          side: String(args.side || '').toUpperCase(),
          type: 'LIMIT',
          quantity: args.quantity,
          reason: args.reason,
          conditional: {
            triggerPrice: args.triggerPrice,
            orderPrice: args.orderPrice ?? null,
            orderType: String(args.orderType || 'LIMIT').toUpperCase(),
            expireDate: args.expireDate,
          },
        },
        { source: 'chat' }
      );
      if (!r.ok) return { ok: false, error: r.error, missing: r.missing };
      return {
        ok: true,
        proposalId: r.proposal.id,
        note: '예약 제안을 등록했습니다. **사람이 승인해야 거래소에 예약이 걸립니다** — 승인 후에도 감시가 도달 전엔 체결되지 않습니다.',
      };
    }
    case 'list_conditional_orders': {
      const toss = require('./tossClient');
      const r = await toss.listConditionalOrders({ status: 'OPEN' });
      const rows = (Array.isArray(r?.items) ? r.items : Array.isArray(r) ? r : []).slice(0, 20);
      return { count: rows.length, rows, note: rows.length ? null : '등록된 예약 주문이 없습니다.' };
    }
    case 'get_my_orders': {
      const toss = require('./tossClient');
      const r = await toss.listOrders({});
      const rows = (Array.isArray(r?.items) ? r.items : Array.isArray(r) ? r : []).slice(0, 20)
        .map((o) => ({ symbol: o.symbol, side: o.side ?? o.orderSide, status: o.status, quantity: o.quantity, price: o.price, filledQuantity: o.filledQuantity ?? o.executedQuantity ?? null, at: o.createdAt ?? o.orderedAt ?? null }));
      return { count: rows.length, rows, note: rows.length ? null : '주문 내역이 없습니다.' };
    }
    case 'get_trades': {
      const toss = require('./tossClient');
      const r = await toss.getTrades(String(args.symbol || ''), { count: 30 });
      const rows = (Array.isArray(r?.items) ? r.items : Array.isArray(r) ? r : []).slice(0, 30);
      return {
        symbol: args.symbol, count: rows.length, rows,
        note: '시장 전체의 체결 틱이다(내 계좌 아님). 방향(매수/매도 체결)과 규모로 단기 수급을 읽어라.',
      };
    }
    case 'recall': {
      const hits = recall(String(args.query || ''));
      return { hits, note: hits.length ? null : '관련된 과거 대화를 찾지 못했습니다.' };
    }
    default:
      return { ok: false, error: `알 수 없는 도구: ${name}` };
  }
}

/**
 * 🔴 모델이 만든 검색어에서 **돈·수량으로 보이는 것을 걷어낸다.**
 *
 * 프롬프트로 "넣지 마라" 고 적어 뒀지만 **프롬프트는 가드가 아니다**
 * (오늘 이미 배웠다 — 작은 모델일수록 앞의 지시를 놓친다).
 * ⇒ 밖으로 나가기 직전에 코드가 거른다.
 */
function sanitizeQuery(q) {
  return String(q)
    // 통화 기호가 붙은 금액, 3자리 구분 숫자, `12주`·`100株` 같은 수량 표현
    .replace(/[₩$€¥]\s?[\d,.]+/g, ' ')
    .replace(/\b\d{1,3}(,\d{3})+(\.\d+)?\b/g, ' ')
    // ⚠️ `\b` 는 **ASCII 기준**이라 `32주 보유` 의 `주` 뒤에서 경계가 안 잡힌다
    //    (한글도 공백도 비단어라 경계가 없다). 한글 단위는 **뒤에 한글이 안 오는지**로 가른다.
    .replace(/\b\d+\s*(?:주|株)(?![가-힣])/g, ' ')
    .replace(/\b\d+\s*shares?\b/gi, ' ')
    .replace(/\b\d{5,}\b/g, ' ') // 계좌번호·큰 금액
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 200);
}

// ── 스트리밍 대화 ────────────────────────────────────────────

function partsOf(chunk) {
  return chunk?.candidates?.[0]?.content?.parts || [];
}

/**
 * 한 턴을 돌린다. **콜백으로만** 밖에 내보낸다.
 *
 * @param {object} o
 * @param {string} o.message 사용자 발화
 * @param {function} o.emit `(event, data) => void` — SSE 로 그대로 흘린다
 */
async function chat({ message, emit, fx = null, contextNote = '', userInstruction = '' }) {
  if (!isAiConfigured()) throw new Error('AI 가 설정되지 않았습니다.');
  const text = String(message || '').trim();
  if (!text) throw new Error('메시지가 비어 있습니다.');

  const ai = await createGeminiClient();
  const runtime = getEffectiveAiConfig();
  const turnId = crypto.randomUUID();
  const startedAt = Date.now();

  const history = readHistory();
  appendHistory({ at: new Date().toISOString(), turnId, role: 'user', text });

  /**
   * ★ **묻지 않아도 되는 recall 을 미리 한 번** 한다(사용자 요구: "기존 대화 이력 기반 recall").
   *   도구로도 부를 수 있지만, 모델이 부를 생각을 못 하면 맥락이 통째로 빠진다.
   *   ⚠️ 찾은 게 없으면 **아무것도 싣지 않는다**(빈 섹션은 모델을 헷갈리게 한다).
   */
  const recalled = recall(text, { history });
  if (recalled.length) emit('recall', { count: recalled.length, items: recalled.slice(0, 3) });

  // 최근 대화 몇 턴을 맥락으로(전부 싣지 않는다 — 토큰과 혼선)
  const recent = history.filter((h) => h.role === 'user' || h.role === 'assistant').slice(-8);

  const contents = [];
  for (const h of recent) {
    contents.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: String(h.text || '') }] });
  }
  const preface = [];
  /**
   * 🔴 **사용자 템플릿을 채팅에도 싣는다** (2026-09-22). 분석 경로에는 있었는데
   *    채팅 경로에는 **빠져 있었다** — 사용자: *"내부의 내가 준 템플릿들을 종합하여서
   *    문의에 대한 탐색 소견 … 이 나와야 하는데"*. 템플릿 없이 답하니 나열이 됐다.
   */
  if (userInstruction) preface.push(`## 사용자 지침 (모든 답에 이 관점을 적용하라)\n${String(userInstruction).slice(0, 2000)}`);
  if (contextNote) preface.push(`## 지금 화면 상태\n${contextNote}`);
  if (recalled.length) {
    preface.push(
      '## 과거 대화에서 찾은 것 (recall)\n' +
        recalled.map((r) => `- [${r.at}] ${r.role === 'user' ? '사용자' : '나'}: ${r.text}`).join('\n')
    );
  }
  contents.push({
    role: 'user',
    parts: [{ text: preface.length ? `${preface.join('\n\n')}\n\n## 질문\n${text}` : text }],
  });

  const config = {
    systemInstruction: SYSTEM_PROMPT,
    /**
     * ⚠️ 출력 캡 (2026-09-23) — 이 스트림은 aiService 를 안 거쳐 자동 유도 캡 밖이었다.
     *    게이트웨이 실측에서 output 18,921~20,634토큰(445~820초, 회차 ₩4) 요청이 잡혔다.
     *    채팅 발화는 3,800자 분할 발송이라 4,096토큰(한글 수천 자)이면 충분하다.
     */
    maxOutputTokens: 4096,
    // ⚠️ 게이트웨이는 이것을 **무시한다**(실측: functionCall 0개). 그래도 남겨 둔다 —
    //    GEMINI_API_KEY 직결이면 네이티브로 동작하고, 위 루프가 둘 다 받는다.
    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
    /**
     * 🔴 thinking 을 끈다 (2026-09-23 실측: chars **1** — 답이 1자였다). 어제 structured
     *    경로에서 잡은 그 병이 여기 남아 있었다: thinkingConfig 를 안 보내면 모델 기본
     *    (reasoning ON)이고 생각이 maxOutputTokens 4096 을 먹어 **본문이 안 나온다.**
     *    includeThoughts 스트림은 게이트웨이가 지원하지 않으므로 budget 0 고정이 맞다.
     */
    ...(runtime.includeThoughts && runtime.thinkingBudget > 0
      ? { thinkingConfig: { includeThoughts: true, thinkingBudget: runtime.thinkingBudget } }
      : { thinkingConfig: { thinkingBudget: 0 } }),
  };

  let answer = '';
  /** 🔴 **도구 바퀴 수**다(응답 횟수가 아니다). 0 = 도구 없이 바로 답했다 */
  let rounds = 0;
  let toolCalls = 0;
  let decideFailed = null;

  /** 판단기에게 보여 줄 대화 사본 — 도구 결과가 쌓이면 여기에도 붙는다 */
  const seen = [`## 사용자 발화\n${text}`];
  /**
   * ⚠️ **같은 호출을 두 번 하지 않는다.** 결과를 이미 줬는데도 판단기가 또 부르는 일이
   *    실측 5회 중 1회 있었다(같은 `get_portfolio`). 프롬프트로 막으려 하지 말고
   *    코드가 막는다 — 외부 API 호출이라 그대로 두면 **돈과 시간이 두 배**다.
   * ★ 인자까지 합쳐 구분한다 — `get_candles` 를 종목 둘에 부르는 것은 **정당하다.**
   */
  const calledKeys = new Set();
  /**
   * 🔴 도구 이름·성패를 이력에 남긴다 (2026-09-22, pm2 발견) — 종전엔 rounds/toolCalls
   *    숫자만 남아, 재기동 뒤에는 "어느 도구가 왜 실패했나" 진단이 **원리상 불가능**했다
   *    (컨테이너 로그가 재기동 2회로 사라져 21:09 턴을 영영 못 갈랐다).
   *    ⚠️ 결과 본문은 안 남긴다 — 크기와 개인 금융정보 때문에 이름·성패·에러 문구까지만.
   */
  const toolLog = [];

  // ── ① 도구 바퀴: **스키마로 강제된 판단기**가 정한다 ─────────
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const decision = await decideTools(seen.join('\n\n'));
    if (decision.error) {
      /**
       * 🔴 판단기가 죽어도 대화는 계속한다. 다만 **조용히** 계속하지 않는다 — 두 곳에 알린다:
       *   ① 사용자에게 `notice`
       *   ② **답하는 모델에게도** — 안 알리면 모델은 도구가 없는 줄 모르고 **지어낸다.**
       *     (피어 실측: 라이브에서 판단 호출이 10회 중 3회 실패했는데, 그때 답이 그냥
       *      서술로 나와서 **사용자는 도구가 안 돌았다는 걸 몰랐다.**)
       */
      decideFailed = decision.error;
      emit('notice', { text: `도구 판단에 실패해 도구 없이 답합니다: ${decision.error}` });
      contents.push({
        role: 'user',
        parts: [{
          text: '[시스템] 도구 호출 판단이 실패해 **이번 답에는 어떤 도구도 실행되지 않았습니다.**'
            + ' 보유·시세·차트·뉴스 데이터가 **없습니다.** 추측해서 채우지 말고,'
            + ' 데이터를 가져오지 못했다고 밝히고 다시 시도해 달라고 하세요.',
        }],
      });
      break;
    }
    if (!decision.tools.length) break;

    rounds = round;
    contents.push({ role: 'model', parts: [{ text: '(도구 호출)' }] });
    const resultParts = [];
    for (const call of decision.tools.slice(0, MAX_CALLS_PER_ROUND)) {
      const key = `${call.name}(${JSON.stringify(call.args)})`;
      if (calledKeys.has(key)) {
        // 조용히 건너뛰지 않는다 — 판단기가 왜 또 불렀는지 알 수 있어야 한다
        logWarn('chat.duplicate_tool_skipped', { key });
        continue;
      }
      calledKeys.add(key);
      const callId = crypto.randomUUID().slice(0, 8);
      toolCalls += 1;
      emit('tool_call', { id: callId, name: call.name, args: call.args });
      let result;
      try {
        result = await runTool(call.name, call.args, { fx });
        emit('tool_result', { id: callId, name: call.name, ok: true, preview: preview(result) });
        // ⚠️ 도구가 스스로 {ok:false} 를 돌려주는 경우(runTool 안에서 잡은 실패)도 실패로 센다
        toolLog.push({ name: call.name, ok: result?.ok !== false, ...(result?.ok === false ? { error: String(result.error || '').slice(0, 200) } : {}) });
      } catch (e) {
        // 🔴 실패도 모델에게 돌려준다. 삼키면 모델이 "받았다" 고 착각하고 지어낸다
        result = { ok: false, error: e.message, kind: e.kind || 'unknown' };
        logWarn('chat.tool_failed', { name: call.name, kind: e.kind, message: e.message });
        emit('tool_result', { id: callId, name: call.name, ok: false, error: e.message });
        toolLog.push({ name: call.name, ok: false, error: String(e.message || '').slice(0, 200), kind: e.kind || 'unknown' });
      }
      const line = `[도구 결과] ${call.name}(${JSON.stringify(call.args)})\n${JSON.stringify(result).slice(0, 4000)}`;
      resultParts.push({ text: line });
      seen.push(line);
    }
    if (!resultParts.length) {
      // 전부 중복이라 실행할 게 없었다 — 같은 판단이 반복될 뿐이니 여기서 멈춘다
      logWarn('chat.round_all_duplicates', { round });
      break;
    }
    contents.push({ role: 'user', parts: resultParts });

    if (round === MAX_ROUNDS) {
      // ⚠️ 상한에 걸린 것을 **조용히 넘기지 않는다** — 답이 어중간한 이유를 사람이 알아야 한다
      emit('notice', { text: `도구 호출 상한(${MAX_ROUNDS}바퀴)에 걸려 여기서 멈췄습니다.` });
    }
  }

  // ── ② 사람에게 하는 답: **여기만 스트리밍** ──────────────────
  //    🔴 사용자 요구가 이것이다 — 이 구간이 REST 로 바뀌면 요구사항 위반이다
  /**
   * 🔴 "확인하겠습니다" 로 끝나는 턴 게이트 (2026-09-23 실측: 도구 5회 돌고 최종 발화가
   *    44자 의지 표명 한 문장 — 답이 아니다). 최종 발화가 짧고 미완 선언이면 **딱 한 번**
   *    "지금 가진 결과로 완결하라" 를 붙여 다시 쓴다(재도구 없음 — 루프·비용 통제).
   */
  let retriedFinal = false;
  for (let pass = 1; pass <= 2; pass += 1) {
    const stream = await ai.models.generateContentStream({ model: runtime.model, contents, config });
    for await (const chunk of stream) {
      for (const part of partsOf(chunk)) {
        if (typeof part.text !== 'string' || !part.text) continue;
        if (part.thought) {
          // 사고 과정은 **답과 섞지 않는다** — 화면이 따로 접어 둘 수 있어야 한다
          emit('thinking_delta', { text: part.text });
        } else {
          answer += part.text;
          emit('text_delta', { text: part.text });
        }
      }
    }
    const stub = answer.trim().length < 200 && /(하겠습니다|해보겠습니다|확인해\s*보겠|드리겠습니다)\s*\.?\s*$/.test(answer.trim());
    if (!stub || pass === 2) break;
    retriedFinal = true;
    logWarn('chat.final_stub_retry', { turnId, chars: answer.trim().length });
    emit('notice', { text: '답이 미완으로 끝나 한 번 더 완결을 요청합니다.' });
    contents.push({ role: 'model', parts: [{ text: answer }] });
    contents.push({ role: 'user', parts: [{ text: '[시스템] 방금 답은 "하겠다" 로 끝났고 내용이 없다. **추가 확인 선언 금지** — 지금까지 받은 [도구 결과] 만으로 완결된 답을 써라.' }] });
    answer = '';
  }

  appendHistory({ at: new Date().toISOString(), turnId, role: 'assistant', text: answer, toolCalls, rounds, tools: toolLog });
  logInfo('chat.turn', {
    turnId, rounds, toolCalls, chars: answer.length, recalled: recalled.length,
    toolFailed: toolLog.filter((t) => !t.ok).length,
    retriedFinal,
    // ★ 도구가 **실제로 불렸다는 증거**를 지표에 함께 — 0이면 결과가 스스로 알려준다
    decideFailed: decideFailed || null,
    durationMs: Date.now() - startedAt,
  });
  return { turnId, rounds, toolCalls, chars: answer.length, recalled: recalled.length, decideFailed };
}

/**
 * 모델이 텍스트로 낸 도구 호출을 읽는다.
 *
 * 받아 주는 모양 (모델은 **지시해도 흔든다** — 코드가 흡수한다):
 * ```
 * {"tool":"x","args":{}}            한 건
 * [{"tool":"x"},{"tool":"y"}]       여러 건
 * ```json { ... } ```               코드펜스로 감싼 것
 * ```
 * ⚠️ `name`/`tool`, `args`/`arguments`/`parameters` 를 모두 받는다 —
 *    프롬프트로 한 가지만 쓰게 만드는 것보다 **코드가 흡수하는 쪽**이 싸다
 *    (워크스페이스 규율: *"프롬프트로 못 고치는 것을 프롬프트로 고치려 하지 말 것"*).
 * 🔴 **알 수 없는 도구 이름은 여기서 거르지 않는다** — `runTool` 이 이유를 담아 돌려주고
 *    그게 모델에게 전달돼야 스스로 고친다.
 */
function parseToolCalls(text) {
  let body = String(text || '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(body);
  if (fence) body = fence[1].trim();

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    // 앞뒤에 말이 섞였을 때 **첫 JSON 덩어리**만 떼어 본다
    const m = /[[{][\s\S]*[\]}]/.exec(body);
    if (!m) return [];
    try {
      data = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }

  const list = Array.isArray(data) ? data : [data];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.tool || item.name || '').trim();
    if (!name) continue;
    const args = item.args || item.arguments || item.parameters || {};
    out.push({ name, args: typeof args === 'object' && args ? args : {} });
  }
  return out;
}

/** 도구 결과를 화면에 한 줄로 — 원본을 다 흘리면 채팅창이 잠긴다 */
function preview(result) {
  try {
    const s = JSON.stringify(result);
    return s.length > 240 ? `${s.slice(0, 240)}…` : s;
  } catch {
    return '(표시할 수 없음)';
  }
}

module.exports = {
  chat,
  recall,
  runTool,
  sanitizeQuery,
  readHistory,
  appendHistory,
  clearHistory,
  TOOL_DECLARATIONS,
  SYSTEM_PROMPT,
  parseToolCalls,
  toolCatalog,
  decideTools,
  DECIDE_SCHEMA,
  HISTORY_FILE,
  MAX_ROUNDS,
};
